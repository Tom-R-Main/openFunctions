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

import type { ToolResult, ToolDefinition, InputSchema } from "./types.js";
import type { AIAdapter, ChatMessage } from "./adapters/types.js";
import { ToolRegistry } from "./registry.js";
import { composePrompt, autoToolGuide } from "./prompts.js";
import { defineTool, ok } from "./tool.js";
import { forceStructuredOutput } from "./structured.js";

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

// ─── Task Crew ────────────────────────────────────────────────────────────────
//
// The bare `runCrew(task: string)` API threads only the *previous* agent's
// output forward, as a raw string, and gives every agent the same task. A
// `Task` crew adds three things on top, without changing that API:
//
//   1. Typed contracts — each task names its `expectedOutput` and may carry an
//      `outputSchema`; when set, the agent's final answer is coerced to that
//      schema and forwarded as JSON instead of prose (no more stringify-the-
//      world context loss).
//   2. Explicit context — a task pulls context from *named* prior tasks via
//      `context: ["research", "outline"]`, so task #4 can see task #1's result,
//      not just task #3's. Omit for the sequential default (previous task);
//      pass `[]` for an isolated task.
//   3. Hierarchical process — instead of a fixed order, a manager agent
//      decomposes the brief, delegates to the right specialist, and synthesizes
//      the result (crewAI's most-used process). Same task list, different runner.

/** A unit of work in a task crew, bound to the agent that should perform it. */
export interface CrewTask {
  /** Stable id so later tasks can reference this output in their `context`. */
  id: string;
  /** What to do. Becomes the agent's task prompt. */
  description: string;
  /**
   * Which agent runs it — an Agent, or a name resolved against the crew's
   * `agents` list (and the manager, in hierarchical mode).
   */
  agent: Agent | string;
  /**
   * Human description of the desired deliverable. Appended to the prompt to
   * steer format, and used as the extraction hint when `outputSchema` is set.
   */
  expectedOutput?: string;
  /**
   * When set, the agent's final answer is coerced to this JSON Schema and
   * returned on `TaskResult.data`. The structured JSON (not the prose) is what
   * downstream tasks receive as context.
   */
  outputSchema?: InputSchema;
  /**
   * Ids of earlier tasks whose outputs feed into this one as context.
   * - Omit → sequential default: the immediately preceding task's output.
   * - `[]` → no context (isolated task).
   * - `["a", "c"]` → exactly those tasks' outputs, each labeled.
   */
  context?: string[];
}

/** Result of a single task in a task crew. */
export interface TaskResult {
  /** The task id. */
  task: string;
  /** Name of the agent that ran it. */
  agent: string;
  /** The agent's final text output (the JSON string when `outputSchema` set). */
  output: string;
  /** Parsed structured data — present only when the task had an `outputSchema`. */
  data?: Record<string, unknown>;
  /** The underlying agent run (tool calls, rounds, truncated flag). */
  result: AgentResult;
}

export interface TaskCrewOptions {
  /** The ordered task list. */
  tasks: CrewTask[];
  /**
   * Agents available to the crew. Required if any task references its agent by
   * name (rather than by Agent object), and as the worker pool in hierarchical
   * mode.
   */
  agents?: Agent[];
  /**
   * "sequential" runs tasks in order, threading context (default).
   * "hierarchical" hands the whole brief to a manager that delegates to the
   *   workers via synthetic `delegate_to_*` tools and synthesizes the result.
   */
  process?: "sequential" | "hierarchical";
  /**
   * Manager agent for hierarchical mode. Defaults to a generic coordinator.
   * Ignored in sequential mode.
   */
  manager?: Agent;
}

export interface TaskCrewResult {
  /** Final output — last task (sequential) or the manager's synthesis. */
  output: string;
  /** Per-task results in execution order (sequential mode). */
  tasks: TaskResult[];
}

/**
 * Run a crew over a typed task list.
 *
 * @example Sequential with typed handoff
 * ```ts
 * const result = await runTaskCrew({
 *   agents: [researcher, writer],
 *   tasks: [
 *     {
 *       id: "research",
 *       agent: "researcher",
 *       description: "Research the MCP protocol.",
 *       expectedOutput: "5 key findings with sources",
 *       outputSchema: {
 *         type: "object",
 *         properties: { findings: { type: "array", items: { type: "string" } } },
 *         required: ["findings"],
 *       },
 *     },
 *     {
 *       id: "draft",
 *       agent: "writer",
 *       description: "Write a 200-word explainer.",
 *       context: ["research"],   // sees the structured findings JSON
 *     },
 *   ],
 * }, adapter, registry);
 * ```
 *
 * @example Hierarchical
 * ```ts
 * await runTaskCrew(
 *   { agents: [researcher, writer], process: "hierarchical",
 *     tasks: [{ id: "article", agent: "writer",
 *               description: "Produce a researched explainer on MCP." }] },
 *   adapter, registry,
 * );
 * ```
 */
export async function runTaskCrew(
  options: TaskCrewOptions,
  adapter: AIAdapter,
  registry: ToolRegistry,
): Promise<TaskCrewResult> {
  const { tasks, agents = [], process = "sequential" } = options;
  if (tasks.length === 0) throw new Error("runTaskCrew: tasks must be non-empty");

  if (process === "hierarchical") {
    return runHierarchicalTaskCrew(options, adapter, registry);
  }

  // Resolve every task's agent up front so a typo fails fast, before any
  // model calls burn tokens.
  const byName = new Map(agents.map((a) => [a.name, a]));
  const resolved = tasks.map((t) => ({ task: t, agent: resolveAgent(t.agent, byName) }));

  const results: TaskResult[] = [];
  for (let i = 0; i < resolved.length; i++) {
    const { task, agent } = resolved[i];
    const context = buildTaskContext(task, results, i);
    const prompt = task.expectedOutput
      ? `${task.description}\n\nExpected output: ${task.expectedOutput}`
      : task.description;

    const run = await agent.run(prompt, adapter, registry, context);
    results.push(await coerceTaskOutput(task, agent, run, adapter, registry));
  }

  return { output: results[results.length - 1]?.output ?? "", tasks: results };
}

/** Resolve an agent reference (object or name) against the crew roster. */
function resolveAgent(ref: Agent | string, byName: Map<string, Agent>): Agent {
  if (typeof ref !== "string") return ref;
  const agent = byName.get(ref);
  if (!agent) {
    throw new Error(
      `runTaskCrew: task references unknown agent "${ref}". ` +
        `Add it to options.agents (known: ${[...byName.keys()].join(", ") || "none"}).`,
    );
  }
  return agent;
}

/**
 * Build the context string a task sees. Explicit `context` ids pull those
 * tasks' outputs (each labeled by id); omitted `context` defaults to the
 * immediately preceding task; `[]` yields no context.
 */
function buildTaskContext(
  task: CrewTask,
  done: TaskResult[],
  index: number,
): string | undefined {
  if (task.context === undefined) {
    return index > 0 ? done[index - 1].output : undefined;
  }
  if (task.context.length === 0) return undefined;

  const byId = new Map(done.map((r) => [r.task, r]));
  const blocks: string[] = [];
  for (const id of task.context) {
    const prior = byId.get(id);
    if (!prior) {
      // Reference to a task that hasn't run (forward ref or typo). Fail loud
      // rather than silently dropping context the agent was told to rely on.
      throw new Error(
        `runTaskCrew: task "${task.id}" references context "${id}", which has ` +
          `not produced output yet. Context tasks must appear earlier in the list.`,
      );
    }
    blocks.push(`### From "${id}"\n${prior.output}`);
  }
  return blocks.join("\n\n");
}

/**
 * Apply a task's output contract. With an `outputSchema`, coerce the agent's
 * final answer into structured data (forwarded downstream as JSON); otherwise
 * pass the prose through unchanged.
 */
async function coerceTaskOutput(
  task: CrewTask,
  agent: Agent,
  run: AgentResult,
  adapter: AIAdapter,
  registry: ToolRegistry,
): Promise<TaskResult> {
  if (!task.outputSchema || run.truncated) {
    return { task: task.id, agent: agent.name, output: run.output, result: run };
  }

  const structured = await forceStructuredOutput(adapter, {
    schema: task.outputSchema,
    description: task.expectedOutput,
    prompt:
      `Convert the following result into the required structured format. ` +
      `Do not add or invent information.\n\n${run.output}`,
  });

  return {
    task: task.id,
    agent: agent.name,
    output: JSON.stringify(structured.data, null, 2),
    data: structured.data,
    result: run,
  };
}

/**
 * Hierarchical process: a manager agent receives the rendered brief and
 * `delegate_to_*` tools for every worker, decides who does what, and
 * synthesizes the final answer. No fixed task order — the manager drives.
 */
async function runHierarchicalTaskCrew(
  options: TaskCrewOptions,
  adapter: AIAdapter,
  registry: ToolRegistry,
): Promise<TaskCrewResult> {
  const { tasks, agents = [], manager } = options;
  const workers = agents.length
    ? agents
    : // Fall back to the distinct agents named on the tasks.
      dedupeAgents(tasks.map((t) => t.agent).filter((a): a is Agent => typeof a !== "string"));

  if (workers.length === 0) {
    throw new Error(
      "runTaskCrew (hierarchical): no workers to delegate to. Pass options.agents.",
    );
  }

  const boss = manager ?? defaultManager();

  // The manager only delegates — give it delegation tools for each worker,
  // not the workers' raw tools.
  const managerRegistry = new ToolRegistry();
  for (const worker of workers) {
    managerRegistry.register(createDelegationTool(worker, adapter, registry));
  }

  const brief = renderBrief(tasks, workers);
  const run = await boss.run(brief, adapter, managerRegistry);

  return {
    output: run.output,
    tasks: [{ task: "manager", agent: boss.name, output: run.output, result: run }],
  };
}

function dedupeAgents(agents: Agent[]): Agent[] {
  const seen = new Map<string, Agent>();
  for (const a of agents) if (!seen.has(a.name)) seen.set(a.name, a);
  return [...seen.values()];
}

/** Default coordinator used when hierarchical mode gets no explicit manager. */
function defaultManager(): Agent {
  return defineAgent({
    name: "crew_manager",
    role: "Crew Manager",
    goal:
      "Break the brief into the right pieces, delegate each to the best-suited " +
      "specialist, validate their work, and synthesize a single coherent result.",
    backstory:
      "You coordinate a team of specialists. You do not do the specialist work " +
      "yourself — you delegate via the available tools and assemble the answer.",
    maxRounds: 15,
  });
}

/** Render the task list + roster into a brief the manager can act on. */
function renderBrief(tasks: CrewTask[], workers: Agent[]): string {
  const roster = workers
    .map((w) => `- ${w.name}: ${w.definition.role} — ${w.definition.goal}`)
    .join("\n");
  const work = tasks
    .map((t, i) => {
      const want = t.expectedOutput ? ` (deliverable: ${t.expectedOutput})` : "";
      return `${i + 1}. ${t.description}${want}`;
    })
    .join("\n");
  return (
    `You manage these specialists:\n${roster}\n\n` +
    `Accomplish the following by delegating to them:\n${work}\n\n` +
    `Delegate each piece to the most suitable specialist, then synthesize their ` +
    `outputs into one final answer.`
  );
}
