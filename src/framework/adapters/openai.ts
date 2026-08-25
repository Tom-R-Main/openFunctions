/**
 * OpenAI Adapter (Responses API) + OpenAI-Compatible Adapters
 *
 * - createOpenAIAdapter: Uses the modern stateful Responses API (OPENAI_API_KEY)
 * - createOpenRouterAdapter: OpenAI-compatible Chat Completions (OPENROUTER_API_KEY)
 *
 * Any OpenAI-compatible provider can be added with createChatCompletionsAdapter().
 */

import { createHash } from "node:crypto";
import type {
  AIAdapter,
  AdapterConfig,
  AdapterContinuationRecovery,
  AdapterReplayPayload,
  AdapterSessionState,
  ChatMessage,
  ChatOptions,
  AdapterResponse,
  ReasoningEffort,
} from "./types.js";
import type { ToolRegistry } from "../registry.js";
import { resolveModelSelection, type ModelSelection } from "../models.js";
import { chatContentToText, imageDataUrl, normalizeChatContent } from "./content.js";

// ─── OpenAI Responses API ──────────────────────────────────────────────────

const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";

export function createOpenAIAdapter(config?: Partial<AdapterConfig>): AIAdapter {
  const apiKey = config?.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY not set.\nGet one at: https://platform.openai.com/api-keys"
    );
  }

  const modelSelection = resolveModelSelection("openai", {
    role: config?.modelRole ?? "expert",
    model: config?.model,
    reasoningEffort: config?.reasoningEffort,
  });
  const { model, reasoningEffort } = modelSelection;
  const systemPrompt = config?.systemPrompt ?? "You are a helpful assistant with access to tools. Use tools when they're relevant.";
  const sessionStateKey = "openai.responses";
  const sessionFingerprint = adapterFingerprint(sessionStateKey, model, OPENAI_RESPONSES_ENDPOINT);
  const doFetch = config?.fetchImpl ?? fetch;

  return {
    name: config?.name ?? "OpenAI",
    model,
    modelSelection,
    sessionStateKey,

    async chat(messages: ChatMessage[], registry: ToolRegistry, options?: ChatOptions): Promise<AdapterResponse> {
      const ignoreSuppliedState = options?.oneShot === true || options?.resetSession === true;
      const suppliedState = ignoreSuppliedState ? undefined : options?.sessionState;
      if (suppliedState && suppliedState.key !== sessionStateKey) {
        throw new Error(`OpenAI adapter received session state for ${suppliedState.key}`);
      }
      const eligiblePreviousResponseId = suppliedState?.fingerprint === sessionFingerprint
        ? suppliedState.continuationId
        : undefined;
      const continuationDelta = eligiblePreviousResponseId === undefined
        ? undefined
        : continuationInput(messages, sessionStateKey, "OpenAI");
      const previousResponseId = continuationDelta === undefined
        ? undefined
        : eligiblePreviousResponseId;
      let input: unknown;
      const useSession = previousResponseId !== undefined;

      if (ignoreSuppliedState) {
        input = lastFreshUserInput(messages, "OpenAI");
      } else if (useSession && continuationDelta !== undefined) {
        input = continuationDelta;
      } else {
        input = responsesInputFromHistory(messages, sessionStateKey, "OpenAI");
      }

      const tools = registry.getAll().map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      }));

      const body: Record<string, unknown> = {
        model,
        input,
        tools,
        include: ["reasoning.encrypted_content"],
        // Disable parallel tool calls — adapter only returns one tool_call
        // per round; running multiple in parallel orphans the rest. See
        // anthropic.ts for the same conservative fix.
        parallel_tool_calls: false,
      };

      if (reasoningEffort === "none") {
        body.temperature = 0.7;
      } else {
        body.reasoning = { effort: reasoningEffort };
      }

      if (useSession) {
        body.previous_response_id = previousResponseId;
      }
      // Responses does not carry `instructions` forward when chaining with
      // previous_response_id, so assert the harness policy on every request.
      body.instructions = options?.systemPrompt ?? systemPrompt;

      // Tool choice support
      if (options?.toolChoice === "required") {
        body.tool_choice = "required";
      } else if (typeof options?.toolChoice === "object") {
        body.tool_choice = { type: "function", name: options.toolChoice.name };
      }

      const send = (requestBody: Record<string, unknown>) => doFetch(OPENAI_RESPONSES_ENDPOINT, {
        method: "POST",
        signal: options?.signal,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });

      let continuationRecovery: AdapterContinuationRecovery | undefined;
      let response = await send(body);
      if (!response.ok) {
        const error = await response.text();
        if (!previousResponseId || !isMissingContinuationError(error, previousResponseId)) {
          throw new Error(`OpenAI API error (${response.status}): ${error}`);
        }
        continuationRecovery = {
          reason: "missing_or_expired",
          failedContinuationId: previousResponseId,
        };
        const retryBody: Record<string, unknown> = {
          ...body,
          input: responsesInputFromHistory(messages, sessionStateKey, "OpenAI"),
        };
        delete retryBody.previous_response_id;
        response = await send(retryBody);
        if (!response.ok) {
          const retryError = await response.text();
          throw new Error(`OpenAI API error (${response.status}): ${retryError}`);
        }
      }

      const data: unknown = await response.json();
      const outputItems = responseOutputItems(data, "OpenAI");
      const providerReplay: AdapterReplayPayload = { key: sessionStateKey, outputItems };
      const responseId = responseIdentifier(data);
      if (!options?.oneShot && responseId === undefined) {
        throw new Error("OpenAI response id must be a non-empty string");
      }
      const nextSessionState: AdapterSessionState | undefined =
        !options?.oneShot && responseId !== undefined
          ? {
              key: sessionStateKey,
              continuationId: responseId,
              fingerprint: sessionFingerprint,
            }
          : undefined;
      const withProviderState = (parsed: AdapterResponse): AdapterResponse => ({
        ...parsed,
        providerReplay,
        ...(nextSessionState === undefined ? {} : { sessionState: nextSessionState }),
        ...(continuationRecovery === undefined ? {} : { continuationRecovery }),
      });

      const parsedCalls: NonNullable<AdapterResponse["toolCalls"]> = [];
      const textParts: string[] = [];
      for (const item of outputItems) {
        if (!isRecord(item)) continue;
        if (item.type === "function_call") {
          parsedCalls.push({
            id: requiredString(item.call_id, "OpenAI function call id"),
            name: requiredString(item.name, "OpenAI function call name"),
            args: parseToolArguments(item.arguments, "OpenAI function call arguments"),
          });
          continue;
        }

        if (item.type === "message") {
          const text = outputMessageText(item);
          if (text) textParts.push(text);
        }
      }

      if (parsedCalls.length > 0 || textParts.length > 0) {
        return withProviderState({
          ...(textParts.length === 0 ? {} : { text: textParts.join("") }),
          ...(parsedCalls.length === 1
            ? { toolCall: parsedCalls[0] }
            : parsedCalls.length > 1
              ? { toolCalls: parsedCalls }
              : {}),
        });
      }

      return withProviderState({ text: "(no response)" });
    },
  };
}

// ─── OpenAI-Compatible Chat Completions (shared by OpenRouter, xAI, etc.) ──

interface ChatCompletionsConfig {
  name: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  systemPrompt?: string;
  reasoningEffort?: ReasoningEffort;
  modelSelection?: ModelSelection;
  fetchImpl?: typeof fetch;
}

/**
 * Generic adapter for any OpenAI-compatible Chat Completions API.
 * Used by OpenRouter and any other compatible provider.
 */
function createChatCompletionsAdapter(config: ChatCompletionsConfig): AIAdapter {
  const { name, model, apiKey, baseUrl, reasoningEffort, modelSelection } = config;
  const doFetch = config.fetchImpl ?? fetch;
  const sysPrompt = config.systemPrompt ?? "You are a helpful assistant with access to tools. Use tools when they're relevant.";

  return {
    name,
    model,
    ...(modelSelection && { modelSelection }),

    async chat(messages: ChatMessage[], registry: ToolRegistry, options?: ChatOptions): Promise<AdapterResponse> {
      const openaiMessages: any[] = [{
        role: "system",
        content: options?.systemPrompt ?? sysPrompt,
      }];

      for (const msg of messages) {
        if (msg.role === "tool") {
          openaiMessages.push({
            role: "tool",
            tool_call_id: msg.toolCallId!,
            content: chatContentToText(msg.content),
          });
        } else if (msg.role === "assistant" && msg.toolCalls?.length) {
          // Parallel tool calls — one assistant message carrying every call.
          openaiMessages.push({
            role: "assistant",
            content: null,
            tool_calls: msg.toolCalls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          });
        } else if (msg.role === "assistant" && msg.toolCallId) {
          openaiMessages.push({
            role: "assistant",
            content: null,
            tool_calls: [{
              id: msg.toolCallId,
              type: "function",
              function: {
                name: msg.toolName!,
                arguments: chatContentToText(msg.content),
              },
            }],
          });
        } else {
          openaiMessages.push({
            role: msg.role,
            content: chatCompletionsContent(msg.content),
          });
        }
      }

      const body: Record<string, unknown> = {
        model,
        messages: openaiMessages,
        tools: registry.toOpenAIFormat(),
        // Allow the model to fan out — the agent loop executes parallel tool
        // calls concurrently and returns one tool result per call id.
        parallel_tool_calls: true,
        // max_tokens is intentionally omitted: a hardcoded cap truncates real
        // answers (and reasoning models spend output tokens on thinking too).
        // Matches codex-cli / t3-code, which let the model answer to its limit.
      };

      // Temperature is only meaningful for non-reasoning turns — reasoning
      // models reject or ignore it (opencode strips it, codex never sends it).
      if (!reasoningEffort || reasoningEffort === "none") {
        body.temperature = 0.7;
      }

      // Reasoning effort. OpenRouter's unified `reasoning` field normalizes
      // across model families: OpenAI-style `effort`, Anthropic-style thinking
      // budgets, and Gemini all accept `{ effort }`. `none` disables it.
      if (reasoningEffort && reasoningEffort !== "none") {
        body.reasoning = { effort: reasoningEffort };
      }

      // Tool choice support
      if (options?.toolChoice === "required") {
        body.tool_choice = "required";
      } else if (typeof options?.toolChoice === "object") {
        body.tool_choice = { type: "function", function: { name: options.toolChoice.name } };
      }

      const response = await doFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal: options?.signal,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`${name} API error (${response.status}): ${error}`);
      }

      const data = await response.json();
      const choice = data.choices?.[0];
      if (!choice) throw new Error(`No response from ${name}`);

      const rawToolCalls: any[] = choice.message?.tool_calls ?? [];
      const parsedCalls = rawToolCalls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments || "{}"),
      }));
      // A lone call stays on `toolCall` (single-call path unchanged); only a
      // genuine fan-out uses `toolCalls`.
      if (parsedCalls.length === 1) return { toolCall: parsedCalls[0] };
      if (parsedCalls.length > 1) return { toolCalls: parsedCalls };

      return { text: choice.message?.content ?? "(no response)" };
    },
  };
}

function responsesInputContent(content: ChatMessage["content"]): unknown {
  if (typeof content === "string") return content;
  return [{
    role: "user",
    content: content.map((part) =>
      part.type === "text"
        ? { type: "input_text", text: part.text }
        : { type: "input_image", image_url: imageDataUrl(part), detail: part.detail ?? "auto" }
    ),
  }];
}

function responsesInputFromHistory(
  messages: ChatMessage[],
  replayKey: string,
  provider: string,
): unknown[] {
  const input: unknown[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const label = `${provider} history[${index}]`;
    if (message.role === "tool") {
      assertToolResultMessage(message, label);
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: chatContentToText(message.content),
      });
      continue;
    }
    if (message.role === "user") {
      assertNoToolMetadata(message, label);
      input.push({
        role: "user",
        content: responsesMessageContent(message.content),
      });
      continue;
    }
    if (message.providerReplay?.key === replayKey) {
      assertReplayPayload(message.providerReplay, label);
      input.push(...message.providerReplay.outputItems);
      continue;
    }
    assertAssistantToolMetadata(message, label);
    if (message.role === "assistant" && message.toolCalls?.length) {
      for (const call of message.toolCalls) {
        assertToolCall(call, label);
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.args),
        });
      }
      continue;
    }
    if (message.role === "assistant" && message.toolCallId) {
      const argumentsText = chatContentToText(message.content);
      parseToolArguments(argumentsText, `${label} tool arguments`);
      input.push({
        type: "function_call",
        call_id: message.toolCallId,
        name: message.toolName,
        arguments: argumentsText,
      });
      continue;
    }
    input.push({
      role: "assistant",
      content: chatContentToText(message.content),
    });
  }
  return input;
}

function lastFreshUserInput(messages: ChatMessage[], provider: string): unknown {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    assertNoToolMetadata(message, `${provider} history[${index}]`);
    return responsesInputContent(message.content);
  }
  throw new Error(`${provider} one-shot/reset calls require a fresh user message`);
}

function continuationInput(
  messages: ChatMessage[],
  replayKey: string,
  provider: string,
): unknown | undefined {
  let boundaryIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || message.providerReplay?.key !== replayKey) continue;
    assertReplayPayload(message.providerReplay, `${provider} history[${index}]`);
    boundaryIndex = index;
    break;
  }
  if (boundaryIndex < 0 || boundaryIndex === messages.length - 1) return undefined;

  const suffix = messages.slice(boundaryIndex + 1);
  if (suffix.length === 1 && suffix[0]!.role === "user") {
    const message = suffix[0]!;
    assertNoToolMetadata(message, `${provider} continuation[0]`);
    return responsesInputContent(message.content);
  }

  const input: unknown[] = [];
  for (let index = 0; index < suffix.length; index += 1) {
    const message = suffix[index]!;
    const label = `${provider} continuation[${index}]`;
    if (message.role === "tool") {
      assertToolResultMessage(message, label);
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: chatContentToText(message.content),
      });
      continue;
    }
    if (message.role === "user") {
      assertNoToolMetadata(message, label);
      input.push({
        role: "user",
        content: responsesMessageContent(message.content),
      });
      continue;
    }
    return undefined;
  }
  return input;
}

function responsesMessageContent(content: ChatMessage["content"]): unknown {
  if (typeof content === "string") return content;
  const message = responsesInputContent(content);
  if (!Array.isArray(message) || !isRecord(message[0])) {
    throw new Error("Responses multimodal content could not be normalized");
  }
  return message[0].content;
}

function assertNoToolMetadata(message: ChatMessage, label: string): void {
  if (
    message.toolCallId !== undefined ||
    message.toolName !== undefined ||
    (message.toolCalls !== undefined && message.toolCalls.length > 0) ||
    message.providerReplay !== undefined
  ) {
    throw new Error(`${label} user message cannot contain assistant provider/tool metadata`);
  }
}

function assertToolResultMessage(message: ChatMessage, label: string): asserts message is ChatMessage & {
  toolCallId: string;
  toolName: string;
} {
  requiredString(message.toolCallId, `${label} toolCallId`);
  requiredString(message.toolName, `${label} toolName`);
  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    throw new Error(`${label} tool result cannot contain assistant toolCalls`);
  }
  if (message.providerReplay !== undefined) {
    throw new Error(`${label} tool result cannot contain assistant providerReplay`);
  }
}

function assertAssistantToolMetadata(message: ChatMessage, label: string): void {
  const hasId = message.toolCallId !== undefined;
  const hasName = message.toolName !== undefined;
  if (hasId !== hasName) {
    throw new Error(`${label} assistant tool call requires both toolCallId and toolName`);
  }
  if (message.toolCalls?.length && (hasId || hasName)) {
    throw new Error(`${label} cannot mix toolCalls with toolCallId/toolName`);
  }
  if (hasId) {
    requiredString(message.toolCallId, `${label} toolCallId`);
    requiredString(message.toolName, `${label} toolName`);
  }
}

function assertToolCall(call: { id: string; name: string; args: Record<string, unknown> }, label: string): void {
  requiredString(call.id, `${label} tool call id`);
  requiredString(call.name, `${label} tool call name`);
  if (!isRecord(call.args)) throw new Error(`${label} tool call args must be an object`);
  assertJsonSafe(call.args, `${label} tool call args`);
}

function assertReplayPayload(payload: AdapterReplayPayload, label: string): void {
  requiredString(payload.key, `${label} providerReplay.key`);
  if (!Array.isArray(payload.outputItems)) {
    throw new Error(`${label} providerReplay.outputItems must be an array`);
  }
  assertJsonSafe(payload.outputItems, `${label} providerReplay.outputItems`);
}

function responseOutputItems(data: unknown, provider: string): unknown[] {
  if (!isRecord(data) || !Array.isArray(data.output)) {
    throw new Error(`${provider} response output must be an array`);
  }
  assertJsonSafe(data.output, `${provider} response output`);
  return data.output;
}

function responseIdentifier(data: unknown): string | undefined {
  if (!isRecord(data) || typeof data.id !== "string" || data.id.trim().length === 0) return undefined;
  return data.id;
}

function outputMessageText(item: Record<string, unknown>): string | undefined {
  if (!Array.isArray(item.content)) return undefined;
  const text = item.content
    .filter((part): part is Record<string, unknown> =>
      isRecord(part) && (part.type === "output_text" || part.type === "refusal")
    )
    .map((part) => part.type === "refusal"
      ? (typeof part.refusal === "string" ? part.refusal : "")
      : (typeof part.text === "string" ? part.text : ""))
    .join("");
  return text.length > 0 ? text : undefined;
}

function parseToolArguments(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty JSON object string`);
  }
  const serialized = value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${label} must encode an object`);
  assertJsonSafe(parsed, label);
  return parsed;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertJsonSafe(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${label} is not JSON-safe`);
  if (seen.has(value)) throw new Error(`${label} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new Error(`${label} contains a sparse array`);
      assertJsonSafe(value[index], `${label}[${index}]`, seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} contains a non-plain object`);
    }
    for (const [key, item] of Object.entries(value)) {
      assertJsonSafe(item, `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function isMissingContinuationError(error: string, continuationId: string): boolean {
  const normalized = error.toLowerCase();
  const mentionsContinuation =
    /previous[_\s-]?response(?:[_\s-]?id)?/.test(normalized) ||
    normalized.includes(continuationId.toLowerCase());
  return mentionsContinuation && /(not[_\s-]?found|expired|does not exist|no longer (?:exists|available))/.test(normalized);
}

function adapterFingerprint(key: string, model: string, endpoint: string): string {
  return sha256(JSON.stringify({ endpoint, key, model, version: 1 }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function chatCompletionsContent(content: ChatMessage["content"]): unknown {
  if (typeof content === "string") return content;
  return normalizeChatContent(content).map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image_url", image_url: { url: imageDataUrl(part), detail: part.detail ?? "auto" } }
  );
}

// ─── OpenRouter ────────────────────────────────────────────────────────────

/**
 * OpenRouter — any model from any provider via a unified API.
 *
 * Env: OPENROUTER_API_KEY
 * Default role: instant (currently google/gemini-3.7-flash)
 * Browse models: https://openrouter.ai/models
 */
export function createOpenRouterAdapter(config?: Partial<AdapterConfig>): AIAdapter {
  const apiKey = config?.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY not set.\nGet one at: https://openrouter.ai/keys"
    );
  }

  const modelSelection = resolveModelSelection("openrouter", {
    role: config?.modelRole ?? "instant",
    model: config?.model,
    reasoningEffort: config?.reasoningEffort,
  });

  return createChatCompletionsAdapter({
    name: config?.name ?? "OpenRouter",
    model: modelSelection.model,
    apiKey,
    baseUrl: "https://openrouter.ai/api/v1",
    systemPrompt: config?.systemPrompt,
    reasoningEffort: modelSelection.reasoningEffort,
    modelSelection,
    fetchImpl: config?.fetchImpl,
  });
}
