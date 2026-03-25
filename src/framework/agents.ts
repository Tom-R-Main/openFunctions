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
}

export interface CrewOptions {
  /** Ordered list of agents */
  agents: Agent[];
  /** "sequential" threads context, "parallel" runs all at once (default: sequential) */
  mode?: "sequential" | "parallel";
  /** If true, agents can delegate to each other via synthetic tools */
  delegation?: boolean;
}

export interface CrewResult {
  /** Final output from the last agent (sequential) or combined (parallel) */
  output: string;
  /** Per-agent results in execution order */
  agentResults: Array<{ agent: string; result: AgentResult }>;
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

      for (const tool of allTools) {
        const byName = definition.tools?.includes(tool.name);
        const byTag =
          definition.toolTags?.some((tag) => tool.tags?.includes(tag)) ?? false;

        if (byName || byTag || (!definition.tools && !definition.toolTags)) {
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
          { systemPrompt },
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

      return {
        output: "(agent exceeded max rounds)",
        toolCalls,
        rounds,
      };
    },
  };
}

// ─── Crew Runner ────────────────────────────────────────────────────────────

/**
 * Run a crew of agents on a task.
 *
 * In sequential mode, each agent's output becomes context for the next.
 * In parallel mode, all agents run independently on the same task.
 */
export async function runCrew(
  options: CrewOptions,
  task: string,
  adapter: AIAdapter,
  registry: ToolRegistry,
): Promise<CrewResult> {
  const { agents, mode = "sequential", delegation = false } = options;
  const agentResults: CrewResult["agentResults"] = [];

  // Add delegation tools if enabled
  let augmentedRegistry = registry;
  if (delegation && agents.length > 1) {
    augmentedRegistry = new ToolRegistry();
    // Copy all existing tools
    for (const tool of registry.getAll()) {
      augmentedRegistry.register(tool);
    }
    // Add delegation tools for each agent
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
    agentResults.push(...results);
    const combinedOutput = results.map((r) => `[${r.agent}]: ${r.result.output}`).join("\n\n");
    return { output: combinedOutput, agentResults };
  }

  // Sequential mode — thread context
  let context: string | undefined;
  for (const agent of agents) {
    const result = await agent.run(task, adapter, augmentedRegistry, context);
    agentResults.push({ agent: agent.name, result });
    context = result.output; // Pass output as context to next agent
  }

  const lastResult = agentResults[agentResults.length - 1];
  return {
    output: lastResult?.result.output ?? "",
    agentResults,
  };
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
