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
import type { AIAdapter, ChatMessage } from "./adapters/types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single step in a workflow — any async function from input to output */
export type Step<TIn = unknown, TOut = unknown> = (input: TIn) => Promise<TOut>;

/** A constructed workflow that can be executed */
export interface Workflow<TIn = unknown, TOut = unknown> {
  /** Execute the workflow with an initial input */
  run(input: TIn): Promise<TOut>;

  /** Chain another step after this workflow */
  then<TNext>(step: Step<TOut, TNext>): Workflow<TIn, TNext>;

  /** Run multiple steps in parallel on the same input, collecting results as a tuple */
  parallel<TResults extends unknown[]>(
    ...steps: { [K in keyof TResults]: Step<TOut, TResults[K]> }
  ): Workflow<TIn, TResults>;

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

    // Run with tool support — the LLM may call tools to answer
    let maxRounds = 5;
    while (maxRounds-- > 0) {
      const response = await adapter.chat(messages, registry);

      if (response.toolCall) {
        const { id, name, args } = response.toolCall;
        messages.push({
          role: "assistant",
          content: JSON.stringify(args),
          toolCallId: id,
          toolName: name,
        });

        const result = await registry.execute(name, args);
        messages.push({
          role: "tool",
          content: JSON.stringify(result),
          toolCallId: id,
          toolName: name,
        });
        continue;
      }

      return response.text ?? "";
    }

    return "(exceeded max rounds)";
  };
}
