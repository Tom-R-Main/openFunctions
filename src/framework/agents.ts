/**
 * OpenFunction — Agent System
 *
 * An agent is a persona (role + goal) bound to a subset of tools.
 * A crew runs multiple agents in sequence, threading context between them.
 *
 * Patterns derived from CrewAI (agent definition, sequential crews, delegation)
 * and ExecuFunction (agent loops, prompt composition).
 *
 * @example
 * ```ts
 * const researcher = defineAgent({
 *   name: "researcher",
 *   role: "Research Analyst",
 *   goal: "Find accurate information using available tools",
 *   toolTags: ["search", "web"],
 * });
 *
 * const writer = defineAgent({
 *   name: "writer",
 *   role: "Content Writer",
 *   goal: "Write clear articles based on research findings",
 *   tools: ["save_note"],
 * });
 *
 * const result = await runCrew(
 *   { agents: [researcher, writer], mode: "sequential" },
 *   "Write about the MCP protocol",
 *   adapter, registry,
 * );
 * ```
 */

import type { ToolResult, ToolDefinition } from "./types.js";
import type { AIAdapter, ChatMessage } from "./adapters/types.js";
import { ToolRegistry } from "./registry.js";
import { composePrompt, autoToolGuide } from "./prompts.js";
import { defineTool, ok } from "./tool.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentDefinition {
  /** Unique name (snake_case) */
  name: string;
  /** The agent's role — becomes part of the system prompt */
  role: string;
  /** What the agent is trying to accomplish */
  goal: string;
  /** Optional personality/backstory */
  backstory?: string;
  /** Specific tool names this agent can use */
  tools?: string[];
  /** Tags to pull tools from registry (e.g. ["productivity"]) */
  toolTags?: string[];
  /** Max LLM rounds before forcing a response (default: 10) */
  maxRounds?: number;
}

export interface Agent {
  readonly name: string;
  readonly definition: AgentDefinition;
  /** Run the agent with a task. Returns the final response. */
  run(
    task: string,
    adapter: AIAdapter,
    registry: ToolRegistry,
    context?: string,
  ): Promise<AgentResult>;
}

export interface AgentResult {
  /** The agent's final text output */
  output: string;
  /** Tool calls made during execution */
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: ToolResult }>;
  /** Number of LLM rounds consumed */
  rounds: number;
  /**
   * True when the loop terminated because it hit maxRounds rather than
   * reaching a final text response. Callers (especially crew runners)
   * should check this flag — without it, the sentinel "(agent exceeded
   * max rounds)" string silently becomes the next agent's context.
   */
  truncated?: boolean;
}

export interface CrewOptions {
  /** Ordered list of agents */
  agents: Agent[];
  /**
   * "sequential" threads each agent's output as context for the next.
   * "parallel" runs all agents at once on the same task.
   * "ralph" runs the sequential crew repeatedly until ralph.completionPromise
   *   appears in the last agent's output (or maxIterations is reached).
   * Default: "sequential".
   */
  mode?: "sequential" | "parallel" | "ralph";
  /** If true, agents can delegate to each other via synthetic tools */
  delegation?: boolean;
  /**
   * Required when mode is "ralph". Configures the iterative loop:
   * stopping condition, max iterations, and per-iteration callback.
   */
  ralph?: RalphOptions;
}

export interface CrewResult {
  /** Final output from the last agent (sequential) or combined (parallel) */
  output: string;
  /** Per-agent results in execution order */
  agentResults: Array<{ agent: string; result: AgentResult }>;
  /**
   * Present when mode is "ralph". Reports loop outcome — completion
   * status, stop reason, and per-iteration crew snapshots.
   */
  ralph?: RalphCrewSummary;
}

// ─── Ralph Loop ─────────────────────────────────────────────────────────────

/**
 * Why a Ralph loop terminated.
 *
 * - `completion_signal`: the agent output contained the configured
 *   `completionPromise` string.
 * - `completion_check`: a custom `completionCheck` function returned true.
 * - `max_iterations`: the loop hit `maxIterations` without completing.
 *   This is the failure mode — callers should treat this as "the model
 *   didn't finish in time, decide what to do."
 */
export type RalphStopReason =
  | "completion_signal"
  | "completion_check"
  | "max_iterations";

export interface RalphOptions {
  /**
   * Hard cap on iterations. Required as the safety net — the official
   * Ralph philosophy considers this the primary safety mechanism (the
   * `completionPromise` is for the happy path; `maxIterations` is what
   * stops you when the task is impossible or the model is stuck).
   */
  maxIterations: number;
  /**
   * Phrase that signals completion. The loop stops when the agent's
   * output contains this exact string. Wrap in unique markers
   * (e.g. `<promise>COMPLETE</promise>`) so the model can't trip the
   * check by paraphrasing earlier text.
   */
  completionPromise?: string;
  /**
   * Custom completion check. Runs after each iteration. Return true
   * to stop. Use this when you need richer logic than string match —
   * e.g. check a file exists, run `npm test`, query a store.
   * If both this and `completionPromise` are set, both are checked
   * (string match first, then this).
   */
  completionCheck?: (
    result: AgentResult,
    iteration: number,
  ) => boolean | Promise<boolean>;
  /**
   * Called after each iteration with the result and 1-indexed
   * iteration number. Useful for logging, telemetry, or triggering
   * side effects between iterations.
   */
  onIteration?: (
    iteration: number,
    result: AgentResult,
  ) => void | Promise<void>;
  /**
   * Prepend an "[Ralph iteration N of M]" line to each iteration's
   * task so the model knows it's iterating. Default: true. Set to
   * false for the purest Ralph form (identical prompt every time).
   */
  includeIterationContext?: boolean;
}

export interface RalphResult {
  /** True when stopReason is completion_signal or completion_check. */
  completed: boolean;
  stopReason: RalphStopReason;
  /** Number of iterations actually run (1-based, equals history.length). */
  iterations: number;
  /** Result of the final iteration. */
  lastResult: AgentResult;
  /** All iteration results in order, for inspection or debugging. */
  history: AgentResult[];
}

/**
 * Per-iteration summary returned in CrewResult.ralph when mode is "ralph".
 * Mirrors RalphResult but tracks crew-level outcomes instead of single agents.
 */
export interface RalphCrewSummary {
  completed: boolean;
  stopReason: RalphStopReason;
  iterations: number;
  /**
   * Per-iteration record of what the crew produced. Each entry is the
   * agentResults array from a single sequential crew pass.
   */
  history: Array<{
    iteration: number;
    agentResults: CrewResult["agentResults"];
  }>;
}

// ─── Agent Builder ──────────────────────────────────────────────────────────

/**
 * Define a reusable agent persona.
 * The agent gets a filtered tool set and a system prompt built from
 * its role, goal, and backstory.
 */
export function defineAgent(definition: AgentDefinition): Agent {
  return {
    name: definition.name,
    definition,

    async run(
      task: string,
      adapter: AIAdapter,
      registry: ToolRegistry,
      context?: string,
    ): Promise<AgentResult> {
      // Build a filtered registry for this agent
      const agentRegistry = new ToolRegistry();
      const allTools = registry.getAll();
      // Treat empty arrays the same as "no filter set" — empty arrays are
      // truthy in JS, so a previous `!definition.tools && !definition.toolTags`
      // check would skip the all-tools fallback and an agent declared with
      // tools: [] silently got zero tools.
      const hasNameFilter = (definition.tools?.length ?? 0) > 0;
      const hasTagFilter = (definition.toolTags?.length ?? 0) > 0;

      for (const tool of allTools) {
        const byName = hasNameFilter && definition.tools!.includes(tool.name);
        const byTag =
          hasTagFilter &&
          definition.toolTags!.some((tag) => tool.tags?.includes(tag));

        if (byName || byTag || (!hasNameFilter && !hasTagFilter)) {
          agentRegistry.register(tool);
        }
      }

      // Build system prompt
      const systemPrompt = composePrompt({
        role: `You are ${definition.role}. ${definition.backstory ?? ""}`.trim(),
        rules: [`Your goal: ${definition.goal}`],
        toolGuide: autoToolGuide(agentRegistry),
        context: context ? `Context from previous step:\n${context}` : undefined,
      });

      // Create adapter with custom system prompt
      const messages: ChatMessage[] = [{ role: "user", content: task }];
      const toolCalls: AgentResult["toolCalls"] = [];
      const maxRounds = definition.maxRounds ?? 10;
      let rounds = 0;

      // Agent loop — reason, act, observe, repeat
      while (rounds < maxRounds) {
        rounds++;

        const response = await adapter.chat(
          messages,
          agentRegistry,
          {
            systemPrompt,
            // First call of this agent — reset stateful adapter session
            // so we don't thread onto another agent's prior conversation
            // when the same adapter is shared across a crew.
            resetSession: rounds === 1,
          },
        );

        if (response.toolCall) {
          const { id, name, args } = response.toolCall;

          messages.push({
            role: "assistant",
            content: JSON.stringify(args),
            toolCallId: id,
            toolName: name,
          });

          const result = await agentRegistry.execute(name, args);
          toolCalls.push({ name, args, result });

          messages.push({
            role: "tool",
            content: JSON.stringify(result),
            toolCallId: id,
            toolName: name,
          });
          continue;
        }

        return {
          output: response.text ?? "",
          toolCalls,
          rounds,
        };
      }

      console.warn(
        `⚠️  agent "${definition.name}" hit maxRounds (${maxRounds}) without a final response`,
      );
      return {
        output: "(agent exceeded max rounds)",
        toolCalls,
        rounds,
        truncated: true,
      };
    },
  };
}

// ─── Crew Runner ────────────────────────────────────────────────────────────

/**
 * Run a crew of agents on a task.
 *
 * - "sequential": each agent's output becomes context for the next.
 * - "parallel": all agents run independently on the same task.
 * - "ralph": runs the sequential crew repeatedly until the last agent's
 *   output contains `ralph.completionPromise` or `ralph.maxIterations`
 *   is hit. Between iterations the crew sees its own work via tool
 *   side-effects (stores, files, memory) — the conversation history
 *   resets each iteration. See {@link runRalph} for the single-agent
 *   primitive.
 */
export async function runCrew(
  options: CrewOptions,
  task: string,
  adapter: AIAdapter,
  registry: ToolRegistry,
): Promise<CrewResult> {
  const { agents, mode = "sequential", delegation = false } = options;

  // Add delegation tools if enabled. Done once and reused across all modes.
  let augmentedRegistry = registry;
  if (delegation && agents.length > 1) {
    augmentedRegistry = new ToolRegistry();
    for (const tool of registry.getAll()) {
      augmentedRegistry.register(tool);
    }
    for (const agent of agents) {
      augmentedRegistry.register(
        createDelegationTool(agent, adapter, registry),
      );
    }
  }

  if (mode === "parallel") {
    const results = await Promise.all(
      agents.map(async (agent) => {
        const result = await agent.run(task, adapter, augmentedRegistry);
        return { agent: agent.name, result };
      }),
    );
    const combinedOutput = results
      .map((r) => `[${r.agent}]: ${r.result.output}`)
      .join("\n\n");
    return { output: combinedOutput, agentResults: results };
  }

  if (mode === "ralph") {
    if (!options.ralph) {
      throw new Error("runCrew: mode 'ralph' requires options.ralph");
    }
    return runRalphCrew(agents, task, adapter, augmentedRegistry, options.ralph);
  }

  // Sequential mode (default).
  return runSequentialCrew(agents, task, adapter, augmentedRegistry);
}

/** Single sequential pass through a crew, with context threaded between agents. */
async function runSequentialCrew(
  agents: Agent[],
  task: string,
  adapter: AIAdapter,
  registry: ToolRegistry,
): Promise<CrewResult> {
  const agentResults: CrewResult["agentResults"] = [];
  let context: string | undefined;
  for (const agent of agents) {
    const result = await agent.run(task, adapter, registry, context);
    agentResults.push({ agent: agent.name, result });
    context = result.output;
  }
  const lastResult = agentResults[agentResults.length - 1];
  return {
    output: lastResult?.result.output ?? "",
    agentResults,
  };
}

// ─── Ralph Loop ─────────────────────────────────────────────────────────────

/**
 * Run a single agent in a Ralph loop — same task, repeated until a
 * completion signal appears in the agent's output or `maxIterations`
 * is reached. Between iterations, the agent's *conversation* history
 * resets (each call is a fresh agent.run), but state persists via tool
 * side-effects: stores updated by handlers, facts in fact memory,
 * files written by tools, etc.
 *
 * The Ralph philosophy (after Ralph Wiggum): iteration beats perfection.
 * Don't try to one-shot the task — let the loop refine the work, with
 * each iteration seeing the previous iteration's artifacts.
 *
 * @example
 * ```ts
 * const result = await runRalph(
 *   improveAgent,
 *   "Increase test coverage above 80%. Run `npm test -- --coverage` " +
 *   "after each change. Output <promise>COVERAGE_DONE</promise> when met.",
 *   adapter,
 *   registry,
 *   { maxIterations: 25, completionPromise: "COVERAGE_DONE" },
 * );
 *
 * if (!result.completed) {
 *   console.warn(`Ralph stopped: ${result.stopReason}`);
 * }
 * ```
 */
export async function runRalph(
  agent: Agent,
  task: string,
  adapter: AIAdapter,
  registry: ToolRegistry,
  options: RalphOptions,
): Promise<RalphResult> {
  if (options.maxIterations <= 0) {
    throw new Error("runRalph: maxIterations must be > 0");
  }
  if (!options.completionPromise && !options.completionCheck) {
    console.warn(
      "⚠️  runRalph: no completionPromise or completionCheck set — loop will run all maxIterations regardless of agent output",
    );
  }

  const history: AgentResult[] = [];
  let lastResult: AgentResult | undefined;
  let stopReason: RalphStopReason = "max_iterations";
  let completed = false;

  for (let i = 1; i <= options.maxIterations; i++) {
    const iterationTask = buildRalphIterationTask(task, i, options);
    const result = await agent.run(iterationTask, adapter, registry);
    history.push(result);
    lastResult = result;

    if (options.onIteration) {
      await options.onIteration(i, result);
    }

    if (
      options.completionPromise &&
      result.output.includes(options.completionPromise)
    ) {
      completed = true;
      stopReason = "completion_signal";
      break;
    }

    if (options.completionCheck) {
      const done = await options.completionCheck(result, i);
      if (done) {
        completed = true;
        stopReason = "completion_check";
        break;
      }
    }
  }

  if (!completed) {
    console.warn(
      `⚠️  Ralph loop hit maxIterations (${options.maxIterations}) without completing`,
    );
  }

  return {
    completed,
    stopReason,
    iterations: history.length,
    lastResult: lastResult!,
    history,
  };
}

/**
 * Crew-mode Ralph: runs the sequential crew once per iteration, checks
 * completion against the LAST agent's output. Iterations share state via
 * tool side-effects, same as the single-agent loop.
 */
async function runRalphCrew(
  agents: Agent[],
  task: string,
  adapter: AIAdapter,
  registry: ToolRegistry,
  ralph: RalphOptions,
): Promise<CrewResult> {
  if (ralph.maxIterations <= 0) {
    throw new Error("runCrew (ralph): ralph.maxIterations must be > 0");
  }

  const history: RalphCrewSummary["history"] = [];
  let lastCrewResult: CrewResult | undefined;
  let stopReason: RalphStopReason = "max_iterations";
  let completed = false;

  for (let i = 1; i <= ralph.maxIterations; i++) {
    const iterationTask = buildRalphIterationTask(task, i, ralph);
    const crewResult = await runSequentialCrew(
      agents,
      iterationTask,
      adapter,
      registry,
    );
    history.push({ iteration: i, agentResults: crewResult.agentResults });
    lastCrewResult = crewResult;

    if (ralph.onIteration) {
      // For crew mode, hand the last agent's result to the callback —
      // it's the "deliverable" of the iteration.
      const finalAgent = crewResult.agentResults[crewResult.agentResults.length - 1];
      if (finalAgent) {
        await ralph.onIteration(i, finalAgent.result);
      }
    }

    if (
      ralph.completionPromise &&
      crewResult.output.includes(ralph.completionPromise)
    ) {
      completed = true;
      stopReason = "completion_signal";
      break;
    }

    if (ralph.completionCheck) {
      const finalAgent = crewResult.agentResults[crewResult.agentResults.length - 1];
      if (finalAgent && (await ralph.completionCheck(finalAgent.result, i))) {
        completed = true;
        stopReason = "completion_check";
        break;
      }
    }
  }

  if (!completed) {
    console.warn(
      `⚠️  Ralph crew hit maxIterations (${ralph.maxIterations}) without completing`,
    );
  }

  return {
    output: lastCrewResult?.output ?? "",
    agentResults: lastCrewResult?.agentResults ?? [],
    ralph: {
      completed,
      stopReason,
      iterations: history.length,
      history,
    },
  };
}

function buildRalphIterationTask(
  task: string,
  iteration: number,
  options: RalphOptions,
): string {
  if (options.includeIterationContext === false) return task;
  return `[Ralph iteration ${iteration} of ${options.maxIterations}]\n\n${task}`;
}

// ─── Delegation Tools ───────────────────────────────────────────────────────

function createDelegationTool(
  targetAgent: Agent,
  adapter: AIAdapter,
  registry: ToolRegistry,
): ToolDefinition<any, any> {
  return defineTool<{ task: string; context?: string }>({
    name: `delegate_to_${targetAgent.name}`,
    description:
      `Delegate a task to ${targetAgent.definition.role}. ` +
      `Their goal: ${targetAgent.definition.goal}. ` +
      `Use this when the task is better suited for their expertise.`,
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task to delegate" },
        context: { type: "string", description: "Additional context for the delegate (optional)" },
      },
      required: ["task"],
    },
    handler: async ({ task, context }) => {
      const result = await targetAgent.run(task, adapter, registry, context);
      return ok(
        { agentName: targetAgent.name, output: result.output, toolCalls: result.toolCalls.length },
        `${targetAgent.definition.role} completed the task.`,
      );
    },
  });
}
