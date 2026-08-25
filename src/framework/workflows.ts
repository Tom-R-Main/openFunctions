/**
 * OpenFunction — Workflows
 *
 * Deterministic, code-driven pipelines for composing tool executions.
 * Unlike agents (which are LLM-driven), workflows are developer-defined:
 * you specify the exact sequence, branching, and parallelism.
 *
 * @example
 * ```ts
 * // Simple pipeline: search → summarize → save
 * const research = pipe(toolStep(registry, "search_web"))
 *   .then(async (result) => result.data?.text ?? "")
 *   .then(llmStep(adapter, registry, "Summarize: {{input}}"))
 *   .then(async (summary) => registry.execute("save_note", { text: summary }));
 *
 * await research.run({ query: "TypeScript generics" });
 * ```
 */

import type { ToolResult } from "./types.js";
import type { ToolRegistry } from "./registry.js";
import type {
  AIAdapter,
  AdapterSessionState,
  ChatMessage,
} from "./adapters/types.js";
import { validatedAdapterToolCalls } from "./adapters/types.js";
import { normalizeToolResult, uncertainToolExecution } from "./tool.js";
import {
  completeRun,
  createRunManifest,
  failRun,
  RunExecutionError,
  type RunRecord,
  type RunToolEffectReceipt,
} from "./runs.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single step in a workflow — any async function from input to output */
export type Step<TIn = unknown, TOut = unknown> = (input: TIn) => Promise<TOut>;

/** Result of a single branch in parallelSettled — discriminated union per branch. */
export type ParallelResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error };

/** A constructed workflow that can be executed */
export interface Workflow<TIn = unknown, TOut = unknown> {
  /** Execute the workflow with an initial input */
  run(input: TIn): Promise<TOut>;

  /** Chain another step after this workflow */
  then<TNext>(step: Step<TOut, TNext>): Workflow<TIn, TNext>;

  /**
   * Run multiple steps in parallel on the same input. Throws on the first
   * rejection, losing partial results. Use parallelSettled when steps are
   * independent and you want to inspect failures.
   */
  parallel<TResults extends unknown[]>(
    ...steps: { [K in keyof TResults]: Step<TOut, TResults[K]> }
  ): Workflow<TIn, TResults>;

  /**
   * Like parallel(), but each step's result is wrapped in a ParallelResult
   * discriminated union — { ok: true, value } or { ok: false, error }. No
   * step rejection bubbles up; callers inspect each result individually.
   */
  parallelSettled<TResults extends unknown[]>(
    ...steps: { [K in keyof TResults]: Step<TOut, TResults[K]> }
  ): Workflow<TIn, { [K in keyof TResults]: ParallelResult<TResults[K]> }>;

  /** Conditionally branch based on a key derived from the current output */
  branch<TNext>(
    condition: (input: TOut) => string,
    branches: Record<string, Step<TOut, TNext>>,
    fallback?: Step<TOut, TNext>,
  ): Workflow<TIn, TNext>;
}

// ─── Workflow Builder ───────────────────────────────────────────────────────

/**
 * Create a workflow starting from an initial step.
 * Chain additional steps with .then(), .parallel(), and .branch().
 */
export function pipe<TIn, TOut>(step: Step<TIn, TOut>): Workflow<TIn, TOut> {
  return createWorkflow(step);
}

function createWorkflow<TIn, TOut>(
  execute: Step<TIn, TOut>,
): Workflow<TIn, TOut> {
  return {
    run: execute,

    then<TNext>(nextStep: Step<TOut, TNext>): Workflow<TIn, TNext> {
      return createWorkflow(async (input: TIn) => {
        const intermediate = await execute(input);
        return nextStep(intermediate);
      });
    },

    parallel<TResults extends unknown[]>(
      ...steps: { [K in keyof TResults]: Step<TOut, TResults[K]> }
    ): Workflow<TIn, TResults> {
      return createWorkflow(async (input: TIn) => {
        const intermediate = await execute(input);
        const results = await Promise.all(
          steps.map((s) => (s as Step<TOut, unknown>)(intermediate)),
        );
        return results as TResults;
      });
    },

    parallelSettled<TResults extends unknown[]>(
      ...steps: { [K in keyof TResults]: Step<TOut, TResults[K]> }
    ): Workflow<TIn, { [K in keyof TResults]: ParallelResult<TResults[K]> }> {
      return createWorkflow(async (input: TIn) => {
        const intermediate = await execute(input);
        const settled = await Promise.allSettled(
          steps.map((s) => (s as Step<TOut, unknown>)(intermediate)),
        );
        const results = settled.map((r) =>
          r.status === "fulfilled"
            ? { ok: true as const, value: r.value }
            : {
                ok: false as const,
                error:
                  r.reason instanceof Error
                    ? r.reason
                    : new Error(String(r.reason)),
              },
        );
        return results as { [K in keyof TResults]: ParallelResult<TResults[K]> };
      });
    },

    branch<TNext>(
      condition: (input: TOut) => string,
      branches: Record<string, Step<TOut, TNext>>,
      fallback?: Step<TOut, TNext>,
    ): Workflow<TIn, TNext> {
      return createWorkflow(async (input: TIn) => {
        const intermediate = await execute(input);
        const key = condition(intermediate);
        const branchStep = branches[key] ?? fallback;
        if (!branchStep) {
          throw new Error(
            `Workflow branch: no handler for key "${key}" and no fallback provided. ` +
              `Available branches: ${Object.keys(branches).join(", ")}`,
          );
        }
        return branchStep(intermediate);
      });
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create a step that executes a registered tool.
 * Convenience wrapper around registry.execute().
 *
 * @example
 * ```ts
 * const search = toolStep(registry, "search_web");
 * const result = await search({ query: "TypeScript" });
 * ```
 */
export function toolStep(
  registry: ToolRegistry,
  toolName: string,
): Step<Record<string, unknown>, ToolResult> {
  return async (params) => registry.execute(toolName, params);
}

function attachWorkflowToolEffects(
  run: RunRecord,
  receipts: RunToolEffectReceipt[],
): RunRecord {
  if (receipts.length === 0) return run;
  const copiedReceipts = receipts.map((receipt) => ({
    name: receipt.name,
    args: { ...receipt.args },
    result: { ...receipt.result },
  }));
  const certainty = copiedReceipts.some(
    (receipt) => receipt.result.executionOutcome === "unknown",
  ) ? "unknown" as const : "known" as const;
  return {
    ...run,
    toolEffects: {
      state: "partial",
      certainty,
      receipts: copiedReceipts,
      ...(certainty === "unknown"
        ? { verificationRequired: "verify tool side effects before deciding whether any retry is safe" }
        : {}),
    },
  };
}

/**
 * Create a step that calls an AI adapter for a single completion.
 * Useful for inserting an LLM call in the middle of a workflow.
 *
 * The template can include {{input}} which is replaced with the step's input.
 *
 * @example
 * ```ts
 * const summarize = llmStep(adapter, registry, "Summarize this: {{input}}");
 * const summary = await summarize("Long text here...");
 * ```
 */
export function llmStep(
  adapter: AIAdapter,
  registry: ToolRegistry,
  promptTemplate: string,
): Step<string, string> {
  return async (input: string) => {
    const prompt = promptTemplate.replace(/\{\{input\}\}/g, input);
    const messages: ChatMessage[] = [{ role: "user", content: prompt }];
    const receipts: RunToolEffectReceipt[] = [];

    // Run with tool support — the LLM may call tools to answer
    const maxRoundLimit = 5;
    let maxRounds = maxRoundLimit;
    let rounds = 0;
    let sessionState: AdapterSessionState | undefined;
    let run = createRunManifest({
      actor: { kind: "agent", name: "workflow_llm_step" },
      adapter,
      instructions: prompt,
      tools: registry.getAll(),
      maxRounds: maxRoundLimit,
    });
    try {
      while (maxRounds-- > 0) {
        rounds += 1;
        const response = await adapter.chat(messages, registry, {
          resetSession: rounds === 1,
          ...(sessionState === undefined ? {} : { sessionState }),
        });
        sessionState = response.sessionState;

        const calls = validatedAdapterToolCalls(response);
        if (calls.length > 0) {
          messages.push(calls.length === 1
            ? {
                role: "assistant",
                content: JSON.stringify(calls[0].args),
                toolCallId: calls[0].id,
                toolName: calls[0].name,
                ...(response.thinking && { thinkingBlocks: response.thinking }),
                ...(response.providerReplay === undefined
                  ? {}
                  : { providerReplay: response.providerReplay }),
              }
            : {
                role: "assistant",
                content: "",
                toolCalls: calls,
                ...(response.thinking && { thinkingBlocks: response.thinking }),
                ...(response.providerReplay === undefined
                  ? {}
                  : { providerReplay: response.providerReplay }),
              });

          const settledResults = await Promise.allSettled(
            calls.map((call) => registry.execute(call.name, call.args)),
          );
          const executions = settledResults.map((settled, index) =>
            settled.status === "rejected"
              ? uncertainToolExecution(settled.reason)
              : normalizeToolResult(calls[index].name, settled.value)
          );
          for (let index = 0; index < calls.length; index += 1) {
            const call = calls[index];
            const execution = executions[index];
            const result = execution.result;
            receipts.push({
              name: call.name,
              args: { ...call.args },
              result: {
                success: result.success,
                ...(Object.prototype.hasOwnProperty.call(result, "data")
                  ? { data: result.data }
                  : {}),
                ...(result.error === undefined ? {} : { error: result.error }),
                executionOutcome: execution.outcome,
              },
            });
            messages.push({
              role: "tool",
              content: execution.modelContent,
              toolCallId: call.id,
              toolName: call.name,
            });
          }
          if (executions.some((execution) => execution.outcome === "unknown")) {
            throw new Error("Tool execution outcome is unknown; verify side effects before retrying");
          }
          continue;
        }

        return response.text ?? "";
      }

      run = completeRun(run, { limitReached: true });
      run = attachWorkflowToolEffects(run, receipts);
      throw new RunExecutionError(
        `Workflow LLM step exceeded max rounds (${maxRoundLimit})`,
        run,
      );
    } catch (error) {
      if (error instanceof RunExecutionError) throw error;
      run = failRun(run, error);
      run = attachWorkflowToolEffects(run, receipts);
      throw new RunExecutionError(
        `Workflow LLM step failed: ${error instanceof Error ? error.message : String(error)}`,
        run,
        { cause: error },
      );
    }
  };
}
