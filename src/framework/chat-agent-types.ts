/**
 * ChatAgent — Type Definitions
 *
 * All types for the composable ChatAgent system.
 * The ChatAgent composes tools, memory, context providers, and AI adapters
 * into a single configurable, embeddable agent.
 */

import type { ToolDefinition } from "./types.js";
import type { ToolRegistry } from "./registry.js";
import type { ContextProvider } from "./context.js";
import type { PromptOptions } from "./prompts.js";
import type { AIAdapter, ChatContent, ChatMessage, ReasoningEffort } from "./adapters/types.js";
import type { Store } from "./store.js";
import type { ModelRole } from "./models.js";
import type { OutcomeClaim, RunContext, RunRecord } from "./runs.js";
import type { SessionEvent, SessionEventStore } from "./session.js";

// ─── Memory Config ─────────────────────────────────────────────────────────

export interface MemoryConfig {
  /** Enable conversation memory (default: true) */
  conversation?: boolean;
  /** Enable fact memory (default: true) */
  facts?: boolean;
  /** Thread ID for conversation persistence (auto-generated if omitted) */
  threadId?: string;
  /**
   * Custom store for conversation threads. Durable session projection requires
   * an implementation of Store.mutate() with atomic read-check-write behavior.
   */
  conversationStore?: Store<any>;
  /** Custom store for facts */
  factStore?: Store<any>;
}

// ─── Peer Config (schema-ready for future A2A) ────────────────────────────

export interface PeerConfig {
  /** Peer agent name */
  name: string;
  /** Description of what this peer does (for routing prompts) */
  description: string;
  /** Path to peer's config file */
  config?: string;
  /** URL or reference for future A2A routing */
  endpoint?: string;
  /** Task status trigger (Routa-style state-driven orchestration) */
  trigger?: { taskStatus?: string };
}

// ─── Session Config ────────────────────────────────────────────────────────

/**
 * Event-journal configuration for a chat agent. The journal is always the
 * in-process source of truth for model history; callers can provide a durable
 * store and stable id when the session must survive process restarts.
 */
export interface ChatSessionConfig {
  /** Stable journal id. A new UUID is allocated when omitted. */
  id?: string;

  /** Explicit logical thread identity for durable reopen validation. */
  threadId?: string;

  /** Optional durable or observable event store. Defaults to in-memory. */
  store?: SessionEventStore;

  /**
   * Balance an interrupted prior turn when reopening an existing journal.
   * Recovery never retries a tool whose outcome is uncertain. Default: true.
   */
  recoverInterrupted?: boolean;
}

// ─── Agent Config ──────────────────────────────────────────────────────────

export interface ChatAgentConfig {
  /** Agent name (used in banners and metadata) */
  name?: string;

  /** Load a bundled prompt preset by name (e.g., "study-buddy") */
  preset?: string;

  /** Explicit prompt: inline string, path to .md file, or structured PromptOptions */
  prompt?: string | PromptOptions;

  /** AI provider: "gemini", "openai", "anthropic", "xai", "openrouter" */
  provider?: string;

  /** Model override. Prefer modelRole when a stable workload class is enough. */
  model?: string;

  /** Stable workload class resolved through the dated model policy. */
  modelRole?: ModelRole;

  /**
   * Reasoning effort for models that support it. Forwarded to the adapter,
   * which maps it to the provider-native control (OpenAI/OpenRouter
   * `reasoning.effort`, Anthropic extended-thinking `budget_tokens`).
   */
  reasoningEffort?: ReasoningEffort;

  /**
   * Pre-built adapter. When set, `provider`/`model` are ignored and the
   * built-in adapter resolution is skipped. Useful for tests (mock adapters)
   * or for plugging in a custom AI provider.
   */
  adapter?: AIAdapter;

  /** Explicit tool list or registry (defaults to global registry) */
  tools?: ToolDefinition<any, any>[] | ToolRegistry;

  /** Filter tools by tag (e.g., ["tasks", "calendar"]) */
  toolTags?: string[];

  /** Exclude specific tools by name */
  excludeTools?: string[];

  /** Memory config. Default: ON (conversation + facts). Set false to disable. */
  memory?: boolean | MemoryConfig;

  /** Context providers: string names (e.g., "execufunction") or ContextProvider instances */
  providers?: (string | ContextProvider)[];

  /** Max tool-calling rounds per turn (default: 10) */
  maxToolRounds?: number;

  /** Event-sourced session journal configuration. */
  session?: ChatSessionConfig;

  /** Skip agent reasoning — plain tool calling only (saves tokens) */
  raw?: boolean;

  /** Peer agents for future multi-agent routing (schema-ready) */
  peers?: PeerConfig[];

  /** Inherit from another config (phase 2 — YAML config files) */
  extends?: string;
}

// ─── Chat Results ──────────────────────────────────────────────────────────

export interface ChatResult {
  /** Final text response */
  text: string;

  /** Tool calls made during this turn */
  toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    result: {
      success: boolean;
      data?: unknown;
      error?: string;
      executionOutcome?: "succeeded" | "failed" | "unknown";
    };
  }>;

  /** Number of LLM rounds consumed */
  rounds: number;

  /** Immutable record of this execution attempt. */
  run: RunRecord;

  /** What the run claims it produced. Absent for failed or limited runs. */
  outcome?: OutcomeClaim;

  /** Metadata about the turn */
  metadata: {
    provider: string;
    model: string;
    threadId?: string;
  };
}

export interface ChatStreamChunk {
  /** Event type */
  type: "text" | "tool_call" | "tool_result" | "done";

  /** Incremental text (for type: "text") */
  text?: string;

  /** Tool call info (for type: "tool_call") */
  toolCall?: { name: string; args: Record<string, unknown> };

  /** Tool result (for type: "tool_result") */
  toolResult?: {
    name: string;
    success: boolean;
    data?: unknown;
    error?: string;
    executionOutcome?: "succeeded" | "failed" | "unknown";
  };

  /** Final result (for type: "done") */
  result?: ChatResult;
}

// ─── Chat Options ──────────────────────────────────────────────────────────

export interface ChatAgentChatOptions {
  /** Enable streaming response (returns AsyncIterable<ChatStreamChunk>) */
  stream?: boolean;

  /** Cancel queued or in-flight harness work at safe execution boundaries. */
  signal?: AbortSignal;

  /** Override system prompt for this turn only */
  systemPrompt?: string;

  /** Override thread ID for this turn */
  threadId?: string;

  /** Optional IDs and grants that bind this turn to a larger task graph. */
  run?: RunContext;
}

export interface ChatAgentResetOptions {
  /**
   * Logical thread identity to retain after clearing history. Durable callers
   * should pass their stable thread id so the same journal can be reopened.
   * An agent configured with an explicit session.threadId or memory.threadId
   * returns to that pinned identity when omitted; ephemeral agents generate a
   * new id.
   */
  threadId?: string;
}

export interface ExternalMessageOptions {
  /** Stable, caller-owned id used to make durable inbox delivery idempotent. */
  id: string;
}

// ─── Serve Options ─────────────────────────────────────────────────────────

export interface ServeOptions {
  /** Port to listen on (default: 3000) */
  port?: number;

  /** Host to bind to (default: "localhost") */
  host?: string;

  /** Enable CORS headers (default: false) */
  cors?: boolean;
}

// ─── ChatAgent Interface ───────────────────────────────────────────────────

export interface ChatAgent {
  /** Agent name */
  readonly name: string;

  /** AI provider name */
  readonly provider: string;

  /** AI model name */
  readonly model: string;

  /** Send a message and get a response */
  chat(message: ChatContent, options?: ChatAgentChatOptions & { stream?: false }): Promise<ChatResult>;

  /** Send a message and stream the response */
  chat(message: ChatContent, options: ChatAgentChatOptions & { stream: true }): AsyncIterable<ChatStreamChunk>;

  /** Send a message (unified signature) */
  chat(message: ChatContent, options?: ChatAgentChatOptions): Promise<ChatResult> | AsyncIterable<ChatStreamChunk>;

  /** Start an interactive CLI session */
  interactive(): Promise<void>;

  /** Start an HTTP server */
  serve(options?: ServeOptions): Promise<void>;

  /** Get current conversation history */
  getHistory(): ChatMessage[];

  /** Immutable execution journal backing the projected model history. */
  getSessionEvents(): readonly SessionEvent[];

  /**
   * Clear conversation history immediately, optionally retaining a stable
   * logical thread. Throws while another turn or state mutation is active;
   * use resetAsync() when the operation should wait in the agent's FIFO.
   */
  reset(options?: ChatAgentResetOptions): void;

  /** Queue a reset behind active agent work. */
  resetAsync(options?: ChatAgentResetOptions): Promise<void>;

  /**
   * Append an externally delivered user message exactly once. Returns false
   * when the same stable id was already recorded in this journal.
   */
  ingestExternalMessage(message: ChatContent, options: ExternalMessageOptions): Promise<boolean>;

  /**
   * List all persisted thread IDs known to conversation memory.
   * Returns an empty array when memory is disabled.
   */
  listThreads(): string[];

  /**
   * Delete a persisted thread from conversation memory. Returns true
   * when the thread existed and was removed, false otherwise (or when
   * memory is disabled).
   */
  deleteThread(threadId: string): boolean;

  /** Queue a thread deletion behind active agent work. */
  deleteThreadAsync(threadId: string): Promise<boolean>;

  /** Release provider resources without making the durable session terminal. */
  close(): Promise<void>;

  /** Shut down — disconnect providers, clean up */
  destroy(): Promise<void>;
}
