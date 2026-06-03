/**
 * OpenFunction — AI Adapter Interface
 *
 * Every AI provider implements this interface. The chat loop is shared —
 * only the API call format differs between providers.
 */

import type { ToolRegistry } from "../registry.js";

/** Text or multimodal content in a conversation message. */
export type TextContentPart = { type: "text"; text: string };
export type ImageContentPart = {
  type: "image";
  /** MIME type such as image/png or image/jpeg. */
  mime: string;
  /** Base64 data URL. Prefer this at provider boundaries. */
  dataUrl?: string;
  /** Optional local path, for UI/protocol layers that encode at send time. */
  path?: string;
  /** Optional provider detail hint. */
  detail?: "auto" | "low" | "high";
};
export type ContentPart = TextContentPart | ImageContentPart;
export type ChatContent = string | ContentPart[];

/**
 * Reasoning effort levels, normalized across providers.
 *
 * - OpenAI / OpenRouter / Codex map these straight to their `effort` field.
 * - Anthropic has no effort levels — adapters translate the level to an
 *   extended-thinking `budget_tokens` value. `none`/`minimal` disable thinking.
 */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** A single tool/function call requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** A message in the conversation */
export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: ChatContent;
  toolCallId?: string;
  toolName?: string;
  /**
   * Multiple tool calls emitted in ONE assistant turn (parallel tool calling).
   * Set instead of the single `toolCallId`/`toolName` pair when a turn fanned
   * out. Adapters that support parallel calls reconstruct the provider-native
   * shape from this; the matching `tool` results follow as consecutive
   * `role:"tool"` messages (one per call id).
   */
  toolCalls?: ToolCall[];
  /**
   * Provider-native reasoning blocks emitted on the SAME assistant turn that
   * produced a tool call, stored verbatim so they can be replayed on the next
   * request. Anthropic extended thinking REQUIRES the original thinking block
   * (with its signature) to lead the assistant message that contains the
   * tool_use; dropping it 400s the follow-up turn. Opaque to everyone but the
   * adapter that produced it.
   */
  thinkingBlocks?: unknown[];
}

/** What the adapter returns after calling the AI */
export interface AdapterResponse {
  /** Text response from the AI (if any) */
  text?: string;

  /** Single tool call the AI wants to make (if any). */
  toolCall?: ToolCall;

  /**
   * Multiple tool calls from one turn (parallel tool calling). Adapters set
   * this only when the model returned more than one call; a lone call still
   * comes back as `toolCall` so the single-call path is unchanged.
   */
  toolCalls?: ToolCall[];

  /**
   * Provider-native reasoning blocks (e.g. Anthropic thinking/redacted_thinking)
   * accompanying a tool call. The agent loop stores these on the assistant
   * history message so the adapter can replay them on the next request. Opaque.
   */
  thinking?: unknown[];
}

/** Configuration for an adapter */
export interface AdapterConfig {
  /** Display name (e.g. "Gemini", "OpenAI") */
  name: string;

  /** Model to use */
  model: string;

  /** API key */
  apiKey: string;

  /** Custom system prompt (overrides the default) */
  systemPrompt?: string;

  /**
   * Reasoning effort for models that support it. Adapters translate this to
   * their provider-native control (OpenAI/OpenRouter `reasoning.effort`,
   * Anthropic extended-thinking `budget_tokens`). Ignored by models that
   * don't expose reasoning.
   */
  reasoningEffort?: ReasoningEffort;
}

/** Options for controlling AI behavior on a per-call basis */
export interface ChatOptions {
  /** Control tool calling: "auto" (default), "required" (must call a tool), or specific tool name */
  toolChoice?: "auto" | "required" | { name: string };
  /** Override the system prompt for this specific call (used by agents) */
  systemPrompt?: string;
  /**
   * Treat this call as independent — adapters that maintain stateful
   * session context (OpenAI/xAI Responses API previousResponseId) will
   * neither read nor write their session state for this call. Used by
   * forceStructuredOutput so a one-shot extraction does not pollute or
   * get polluted by the surrounding conversation on the same adapter.
   */
  oneShot?: boolean;
  /**
   * Reset the adapter's stateful session before this call, then proceed
   * normally (the new response id IS saved for subsequent calls). Use
   * this on the first call of a logically separate conversation so
   * stateful adapters (OpenAI/xAI Responses API) don't accidentally
   * thread the new conversation onto whatever was cached. Different
   * from oneShot, which skips state entirely.
   */
  resetSession?: boolean;
}

/** An AI provider adapter */
export interface AIAdapter {
  /** Provider name for display */
  readonly name: string;

  /** Model being used */
  readonly model: string;

  /**
   * Send a conversation to the AI with tools available.
   * Returns either a text response or a tool call request.
   */
  chat(
    messages: ChatMessage[],
    registry: ToolRegistry,
    options?: ChatOptions,
  ): Promise<AdapterResponse>;
}

/** Factory function type for creating adapters */
export type AdapterFactory = (config?: Partial<AdapterConfig>) => AIAdapter;
