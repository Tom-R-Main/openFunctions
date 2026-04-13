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
import type { ChatMessage } from "./adapters/types.js";
import type { Store } from "./store.js";

// ─── Memory Config ─────────────────────────────────────────────────────────

export interface MemoryConfig {
  /** Enable conversation memory (default: true) */
  conversation?: boolean;
  /** Enable fact memory (default: true) */
  facts?: boolean;
  /** Thread ID for conversation persistence (auto-generated if omitted) */
  threadId?: string;
  /** Custom store for conversation threads */
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

  /** Model override (e.g., "gemini-2.5-flash", "gpt-5.4-pro") */
  model?: string;

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
    result: { success: boolean; data?: unknown; error?: string };
  }>;

  /** Number of LLM rounds consumed */
  rounds: number;

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
  toolResult?: { name: string; success: boolean; data?: unknown; error?: string };

  /** Final result (for type: "done") */
  result?: ChatResult;
}

// ─── Chat Options ──────────────────────────────────────────────────────────

export interface ChatAgentChatOptions {
  /** Enable streaming response (returns AsyncIterable<ChatStreamChunk>) */
  stream?: boolean;

  /** Override system prompt for this turn only */
  systemPrompt?: string;

  /** Override thread ID for this turn */
  threadId?: string;
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
  chat(message: string, options?: ChatAgentChatOptions & { stream?: false }): Promise<ChatResult>;

  /** Send a message and stream the response */
  chat(message: string, options: ChatAgentChatOptions & { stream: true }): AsyncIterable<ChatStreamChunk>;

  /** Send a message (unified signature) */
  chat(message: string, options?: ChatAgentChatOptions): Promise<ChatResult> | AsyncIterable<ChatStreamChunk>;

  /** Start an interactive CLI session */
  interactive(): Promise<void>;

  /** Start an HTTP server */
  serve(options?: ServeOptions): Promise<void>;

  /** Get current conversation history */
  getHistory(): ChatMessage[];

  /** Clear conversation history and start a new thread */
  reset(): void;

  /** Shut down — disconnect providers, clean up */
  destroy(): Promise<void>;
}
