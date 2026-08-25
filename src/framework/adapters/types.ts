/**
 * OpenFunction — AI Adapter Interface
 *
 * Every AI provider implements this interface. The chat loop is shared —
 * only the API call format differs between providers.
 */

import type { ToolRegistry } from "../registry.js";
import type { ModelRole, ModelSelection } from "../models.js";

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
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** A single tool/function call requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Exact provider-native output items retained for stateless replay. */
export interface AdapterReplayPayload {
  /** Stable adapter protocol key, such as `openai.responses`. */
  key: string;
  /** JSON-safe provider output items, preserved in original order. */
  outputItems: unknown[];
}

/** Evidence that a missing provider continuation was recovered by exact replay. */
export interface AdapterContinuationRecovery {
  reason: "missing_or_expired";
  failedContinuationId: string;
}

/** Explicit, JSON-safe continuation state owned by the session journal. */
export interface AdapterSessionState {
  /** Stable adapter protocol key, such as `openai.responses`. */
  key: string;
  /** Opaque provider continuation identifier. */
  continuationId: string;
  /** Non-secret hash of the provider protocol, model, and endpoint. */
  fingerprint: string;
  /** Hash of instructions that established providers whose chains retain them. */
  instructionsSha256?: string;
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
  /** Exact provider output associated with this assistant message. */
  providerReplay?: AdapterReplayPayload;
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

  /** Continuation state produced by this response, if the adapter is stateful. */
  sessionState?: AdapterSessionState;

  /** Exact provider-native output to retain with the assistant history item. */
  providerReplay?: AdapterReplayPayload;

  /** Present when an expired/missing continuation was recovered transparently. */
  continuationRecovery?: AdapterContinuationRecovery;
}

/**
 * Validate and normalize the tool-call set returned by an adapter before any
 * handler starts. Adapters are runtime trust boundaries even when their static
 * TypeScript type is correct.
 */
export function validatedAdapterToolCalls(response: AdapterResponse): ToolCall[] {
  if (!isPlainRecord(response)) throw new Error("Adapter response must be an object");
  const toolCall = response.toolCall;
  const toolCalls = response.toolCalls;
  if (toolCall !== undefined && toolCalls !== undefined) {
    throw new Error("Adapter response cannot contain both toolCall and toolCalls");
  }
  if (toolCalls !== undefined && !Array.isArray(toolCalls)) {
    throw new Error("Adapter response toolCalls must be an array");
  }
  const calls: unknown[] = toolCalls !== undefined
    ? toolCalls
    : toolCall === undefined
      ? []
      : [toolCall];
  if (toolCalls !== undefined && calls.length === 0) {
    throw new Error("Adapter response toolCalls must be a non-empty array");
  }

  const ids = new Set<string>();
  calls.forEach((call, index) => {
    if (!isPlainRecord(call)) {
      throw new Error(`Adapter tool call ${index} must be an object`);
    }
    if (typeof call.id !== "string" || call.id.trim() === "") {
      throw new Error(`Adapter tool call ${index} id must be a non-empty string`);
    }
    if (typeof call.name !== "string" || call.name.trim() === "") {
      throw new Error(`Adapter tool call ${call.id} name must be a non-empty string`);
    }
    if (ids.has(call.id)) {
      throw new Error(`Adapter response contains duplicate tool call id ${call.id}`);
    }
    ids.add(call.id);
    if (!isPlainRecord(call.args)) {
      throw new Error(`Adapter tool call ${call.id} args must be a JSON object`);
    }
    assertJsonSafe(call.args, `Adapter tool call ${call.id} args`, new Set<object>());
  });
  return calls as ToolCall[];
}

function assertJsonSafe(value: unknown, label: string, ancestors: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`${label} contains a non-JSON value`);
  }
  if (ancestors.has(value)) throw new Error(`${label} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new Error(`${label} contains a sparse array`);
        assertJsonSafe(value[index], `${label}[${index}]`, ancestors);
      }
      return;
    }
    if (!isPlainRecord(value)) throw new Error(`${label} contains a non-plain object`);
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(`${label} contains symbol keys`);
    }
    for (const key of Object.keys(value)) {
      assertJsonSafe(value[key], `${label}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Configuration for an adapter */
export interface AdapterConfig {
  /** Display name (e.g. "Gemini", "OpenAI") */
  name: string;

  /** Model to use */
  model: string;

  /** Workload role used to resolve the provider's default model. */
  modelRole?: ModelRole;

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

  /** Injectable HTTP transport, primarily for deterministic tests and hosts. */
  fetchImpl?: typeof fetch;
}

/** Options for controlling AI behavior on a per-call basis */
export interface ChatOptions {
  /** Abort the provider request when supported by its transport. */
  signal?: AbortSignal;

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
   * Ignore supplied continuation state for this call and start a fresh
   * provider chain. The returned response can include replacement
   * `sessionState` for the owning session journal to persist. Different
   * from oneShot, which neither reads nor returns continuation state.
   */
  resetSession?: boolean;

  /** Explicit continuation state projected from the owning session journal. */
  sessionState?: AdapterSessionState;
}

/** An AI provider adapter */
export interface AIAdapter {
  /** Provider name for display */
  readonly name: string;

  /** Model being used */
  readonly model: string;

  /** Exact role/model resolution persisted in legible run manifests. */
  readonly modelSelection?: ModelSelection;

  /** Stable key used by the owning session to read/write continuation state. */
  readonly sessionStateKey?: string;

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
