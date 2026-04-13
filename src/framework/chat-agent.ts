/**
 * ChatAgent — Composable AI Chat Agent
 *
 * Composes tools, memory, context providers, and AI adapters into
 * a single configurable, embeddable agent.
 *
 * @example
 * ```ts
 * import { createChatAgent } from "./framework/index.js";
 *
 * // Programmatic
 * const agent = await createChatAgent({ provider: "gemini" });
 * const result = await agent.chat("Create a task to review the PR");
 *
 * // Interactive CLI
 * await agent.interactive();
 *
 * // HTTP server
 * await agent.serve({ port: 3000 });
 * ```
 */

import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { ChatMessage } from "./adapters/types.js";
import type { AIAdapter } from "./adapters/types.js";
import type { ToolRegistry } from "./registry.js";
import type { ConnectedProvider } from "./context.js";
import { connectProvider, contextPrompt } from "./context.js";
import {
  createConversationMemory,
  createFactMemory,
  createMemoryTools,
} from "./memory.js";
import type { ConversationMemory, FactMemory } from "./memory.js";
import { registry as globalRegistry } from "./registry.js";
import {
  resolveAdapter,
  resolveContextProviders,
  resolveSystemPrompt,
  buildAgentRegistry,
} from "./chat-agent-resolve.js";
import type {
  ChatAgentConfig,
  ChatAgent,
  ChatResult,
  ChatStreamChunk,
  ChatAgentChatOptions,
  ServeOptions,
  MemoryConfig,
} from "./chat-agent-types.js";

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Create a composable chat agent.
 *
 * Wires together tools, memory, context providers, and an AI adapter
 * into a single agent that can be used programmatically, as a CLI,
 * or as an HTTP server.
 *
 * ```ts
 * const agent = await createChatAgent({
 *   provider: "gemini",
 *   memory: true,
 *   providers: ["execufunction"],
 * });
 * ```
 */
export async function createChatAgent(
  config: ChatAgentConfig = {},
): Promise<ChatAgent> {
  // 1. Build the agent's tool registry (clone/filter from source)
  const agentRegistry = buildAgentRegistry(config, globalRegistry);

  // 2. Set up memory (default: ON)
  let conversationMemory: ConversationMemory | undefined;
  let factMemory: FactMemory | undefined;
  let threadId: string | undefined;
  const memoryEnabled = resolveMemoryEnabled(config.memory);

  if (memoryEnabled) {
    const memConfig = typeof config.memory === "object" ? config.memory : {};
    conversationMemory = createConversationMemory(memConfig.conversationStore);
    factMemory = createFactMemory(memConfig.factStore);
    threadId = memConfig.threadId ?? randomUUID();

    // Register memory tools into the agent's registry
    agentRegistry.registerAll(createMemoryTools(conversationMemory, factMemory));
  }

  // 3. Connect context providers
  const connectedProviders: ConnectedProvider[] = [];
  let contextBlock: string | undefined;

  if (config.providers && config.providers.length > 0) {
    const resolved = await resolveContextProviders(config.providers);
    for (const provider of resolved) {
      try {
        const connected = await connectProvider(provider, agentRegistry);
        connectedProviders.push(connected);
      } catch (error) {
        const name = provider.metadata.name;
        const msg = error instanceof Error ? error.message : "unknown error";
        console.warn(`⚠️  ${name}: failed to connect — ${msg}`);
      }
    }

    // Build context block for system prompt
    if (connectedProviders.length > 0) {
      contextBlock = await contextPrompt(connectedProviders);
      if (contextBlock === "") contextBlock = undefined;
    }
  }

  // 4. Build system prompt
  const systemPrompt = config.raw
    ? resolveSystemPrompt(
        { prompt: "You are a helpful assistant." },
        agentRegistry,
      )
    : resolveSystemPrompt(config, agentRegistry, {
        contextBlock,
        memoryEnabled,
      });

  // 5. Create the adapter
  const adapter = resolveAdapter(config, systemPrompt);

  // 6. Return the agent
  return new ChatAgentImpl({
    name: config.name ?? "agent",
    adapter,
    registry: agentRegistry,
    systemPrompt,
    conversationMemory,
    factMemory,
    connectedProviders,
    threadId: threadId ?? randomUUID(),
    maxToolRounds: config.maxToolRounds ?? 10,
  });
}

// ─── Implementation ────────────────────────────────────────────────────────

interface ChatAgentInternals {
  name: string;
  adapter: AIAdapter;
  registry: ToolRegistry;
  systemPrompt: string;
  conversationMemory?: ConversationMemory;
  factMemory?: FactMemory;
  connectedProviders: ConnectedProvider[];
  threadId: string;
  maxToolRounds: number;
}

class ChatAgentImpl implements ChatAgent {
  readonly name: string;
  readonly provider: string;
  readonly model: string;

  private adapter: AIAdapter;
  private registry: ToolRegistry;
  private systemPrompt: string;
  private conversationMemory?: ConversationMemory;
  private factMemory?: FactMemory;
  private connectedProviders: ConnectedProvider[];
  private threadId: string;
  private maxToolRounds: number;
  private history: ChatMessage[] = [];

  constructor(internals: ChatAgentInternals) {
    this.name = internals.name;
    this.adapter = internals.adapter;
    this.registry = internals.registry;
    this.systemPrompt = internals.systemPrompt;
    this.conversationMemory = internals.conversationMemory;
    this.factMemory = internals.factMemory;
    this.connectedProviders = internals.connectedProviders;
    this.threadId = internals.threadId;
    this.maxToolRounds = internals.maxToolRounds;
    this.provider = internals.adapter.name;
    this.model = internals.adapter.model;
  }

  // ── chat() with overloads ──────────────────────────────────────────────

  chat(message: string, options?: ChatAgentChatOptions & { stream?: false }): Promise<ChatResult>;
  chat(message: string, options: ChatAgentChatOptions & { stream: true }): AsyncIterable<ChatStreamChunk>;
  chat(message: string, options?: ChatAgentChatOptions): Promise<ChatResult> | AsyncIterable<ChatStreamChunk> {
    if (options?.stream) {
      return this.chatStream(message, options);
    }
    return this.chatAsync(message, options);
  }

  private async chatAsync(
    message: string,
    options?: ChatAgentChatOptions,
  ): Promise<ChatResult> {
    const currentThreadId = options?.threadId ?? this.threadId;
    const promptOverride = options?.systemPrompt;

    // Add user message to history
    this.history.push({ role: "user", content: message });

    // Persist to conversation memory
    if (this.conversationMemory) {
      this.conversationMemory.addMessage(currentThreadId, {
        role: "user",
        content: message,
      });
    }

    // Run the tool-calling loop
    const toolCalls: ChatResult["toolCalls"] = [];
    let rounds = 0;
    let maxRounds = this.maxToolRounds;
    let finalText = "";

    while (maxRounds-- > 0) {
      rounds++;
      const response = await this.adapter.chat(this.history, this.registry, {
        systemPrompt: promptOverride ?? this.systemPrompt,
      });

      // Tool call
      if (response.toolCall) {
        const { id, name, args } = response.toolCall;

        // Track assistant's tool call in history
        this.history.push({
          role: "assistant",
          content: JSON.stringify(args),
          toolCallId: id,
          toolName: name,
        });

        // Execute the tool
        const result = await this.registry.execute(name, args);
        const resultStr = JSON.stringify(result);

        // Track tool result in history
        this.history.push({
          role: "tool",
          content: resultStr,
          toolCallId: id,
          toolName: name,
        });

        toolCalls.push({
          name,
          args,
          result: {
            success: result.success,
            data: result.data,
            error: result.error,
          },
        });

        continue;
      }

      // Text response — done
      if (response.text) {
        finalText = response.text;
        this.history.push({ role: "assistant", content: response.text });
      }

      break;
    }

    if (!finalText && maxRounds < 0) {
      finalText = "(exceeded max tool calling rounds)";
    }

    // Persist assistant response to memory
    if (this.conversationMemory && finalText) {
      this.conversationMemory.addMessage(currentThreadId, {
        role: "assistant",
        content: finalText,
      });
    }

    return {
      text: finalText,
      toolCalls,
      rounds,
      metadata: {
        provider: this.provider,
        model: this.model,
        threadId: currentThreadId,
      },
    };
  }

  // ── Simulated streaming ────────────────────────────────────────────────

  private async *chatStream(
    message: string,
    options?: ChatAgentChatOptions,
  ): AsyncIterable<ChatStreamChunk> {
    const currentThreadId = options?.threadId ?? this.threadId;
    const promptOverride = options?.systemPrompt;

    this.history.push({ role: "user", content: message });

    if (this.conversationMemory) {
      this.conversationMemory.addMessage(currentThreadId, {
        role: "user",
        content: message,
      });
    }

    const toolCalls: ChatResult["toolCalls"] = [];
    let rounds = 0;
    let maxRounds = this.maxToolRounds;
    let finalText = "";

    while (maxRounds-- > 0) {
      rounds++;
      const response = await this.adapter.chat(this.history, this.registry, {
        systemPrompt: promptOverride ?? this.systemPrompt,
      });

      if (response.toolCall) {
        const { id, name, args } = response.toolCall;

        yield { type: "tool_call", toolCall: { name, args } };

        this.history.push({
          role: "assistant",
          content: JSON.stringify(args),
          toolCallId: id,
          toolName: name,
        });

        const result = await this.registry.execute(name, args);
        const resultStr = JSON.stringify(result);

        this.history.push({
          role: "tool",
          content: resultStr,
          toolCallId: id,
          toolName: name,
        });

        const toolCallEntry = {
          name,
          args,
          result: {
            success: result.success,
            data: result.data,
            error: result.error,
          },
        };
        toolCalls.push(toolCallEntry);

        yield {
          type: "tool_result",
          toolResult: {
            name,
            success: result.success,
            data: result.data,
            error: result.error,
          },
        };

        continue;
      }

      if (response.text) {
        finalText = response.text;
        this.history.push({ role: "assistant", content: response.text });
        yield { type: "text", text: response.text };
      }

      break;
    }

    if (!finalText && maxRounds < 0) {
      finalText = "(exceeded max tool calling rounds)";
      yield { type: "text", text: finalText };
    }

    if (this.conversationMemory && finalText) {
      this.conversationMemory.addMessage(currentThreadId, {
        role: "assistant",
        content: finalText,
      });
    }

    yield {
      type: "done",
      result: {
        text: finalText,
        toolCalls,
        rounds,
        metadata: {
          provider: this.provider,
          model: this.model,
          threadId: currentThreadId,
        },
      },
    };
  }

  // ── Interactive CLI ────────────────────────────────────────────────────

  async interactive(): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const toolCount = this.registry.listNames().length;

    console.log(`\n╔══════════════════════════════════════════════════╗`);
    console.log(`║         openFunctions — AI Chat                  ║`);
    console.log(`╚══════════════════════════════════════════════════╝\n`);
    console.log(`  Agent:    ${this.name}`);
    console.log(`  Provider: ${this.provider}`);
    console.log(`  Model:    ${this.model}`);
    console.log(`  Tools:    ${toolCount} registered`);
    console.log(`  Memory:   ${this.conversationMemory ? "on" : "off"}`);
    console.log(`  Thread:   ${this.threadId}\n`);
    console.log(`Type a message to chat. The AI can call your tools.`);
    console.log(`Commands: "reset", "history", "facts", "quit"\n`);

    const ask = () => {
      rl.question("You: ", async (input) => {
        const trimmed = input.trim();
        if (!trimmed || trimmed === "quit" || trimmed === "exit") {
          console.log("\nGoodbye!\n");
          rl.close();
          process.exit(0);
        }

        if (trimmed === "reset") {
          this.reset();
          console.log("\n  (conversation reset)\n");
          ask();
          return;
        }

        if (trimmed === "history") {
          const turns = this.history.filter((m) => m.role === "user").length;
          console.log(`\n  ${turns} turn(s) in current session\n`);
          ask();
          return;
        }

        if (trimmed === "facts") {
          if (!this.factMemory) {
            console.log("\n  Memory is disabled\n");
          } else {
            const facts = this.factMemory.getAllFacts();
            if (facts.length === 0) {
              console.log("\n  No stored facts\n");
            } else {
              console.log(`\n  ${facts.length} stored fact(s):`);
              for (const f of facts) {
                console.log(`  - ${f.content}`);
              }
              console.log();
            }
          }
          ask();
          return;
        }

        try {
          // Use streaming for interactive mode — show tool calls as they happen
          for await (const chunk of this.chatStream(trimmed)) {
            switch (chunk.type) {
              case "tool_call":
                console.log(
                  `\n  [Tool Call] ${chunk.toolCall!.name}(${JSON.stringify(chunk.toolCall!.args)})`,
                );
                break;
              case "tool_result":
                console.log(
                  `  [Result]   ${JSON.stringify(chunk.toolResult!.data ?? chunk.toolResult!.error)}`,
                );
                break;
              case "text":
                console.log(`\n${this.provider}: ${chunk.text}\n`);
                break;
            }
          }
        } catch (err) {
          console.error(
            `\n  Error: ${err instanceof Error ? err.message : err}\n`,
          );
        }

        ask();
      });
    };

    ask();
  }

  // ── HTTP serve ─────────────────────────────────────────────────────────

  async serve(options?: ServeOptions): Promise<void> {
    const { serveChatAgent } = await import("./chat-agent-http.js");
    return serveChatAgent(this, options);
  }

  // ── State management ───────────────────────────────────────────────────

  getHistory(): ChatMessage[] {
    return [...this.history];
  }

  reset(): void {
    this.history = [];
    this.threadId = randomUUID();
  }

  async destroy(): Promise<void> {
    for (const provider of this.connectedProviders) {
      try {
        await provider.disconnect?.();
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function resolveMemoryEnabled(memory: ChatAgentConfig["memory"]): boolean {
  if (memory === false) return false;
  if (memory === undefined || memory === true) return true;
  // MemoryConfig — enabled if at least one subsystem is on
  return memory.conversation !== false || memory.facts !== false;
}
