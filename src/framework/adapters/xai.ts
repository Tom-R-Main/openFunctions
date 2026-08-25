/**
 * xAI Adapter (Grok)
 *
 * Uses xAI's Responses API (stateful, like OpenAI's Responses API).
 *
 * Env: XAI_API_KEY
 * Default role: expert (currently grok-4.5)
 * Console: https://console.x.ai
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
} from "./types.js";
import type { ToolRegistry } from "../registry.js";
import { resolveModelSelection } from "../models.js";
import { chatContentToText, imageDataUrl } from "./content.js";

const XAI_RESPONSES_ENDPOINT = "https://api.x.ai/v1/responses";

export function createXAIAdapter(config?: Partial<AdapterConfig>): AIAdapter {
  const apiKey = config?.apiKey ?? process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "XAI_API_KEY not set.\nGet one at: https://console.x.ai"
    );
  }

  const modelSelection = resolveModelSelection("xai", {
    role: config?.modelRole ?? "expert",
    model: config?.model,
    reasoningEffort: config?.reasoningEffort,
  });
  const { model, reasoningEffort } = modelSelection;
  const systemPrompt = config?.systemPrompt ?? "You are a helpful assistant with access to tools. Use tools when they're relevant.";
  const sessionStateKey = "xai.responses";
  const sessionFingerprint = adapterFingerprint(sessionStateKey, model, XAI_RESPONSES_ENDPOINT);
  const doFetch = config?.fetchImpl ?? fetch;

  return {
    name: config?.name ?? "Grok",
    model,
    modelSelection,
    sessionStateKey,

    async chat(messages: ChatMessage[], registry: ToolRegistry, options?: ChatOptions): Promise<AdapterResponse> {
      const instructions = options?.systemPrompt ?? systemPrompt;
      const instructionsSha256 = sha256(instructions);
      const ignoreSuppliedState = options?.oneShot === true || options?.resetSession === true;
      const suppliedState = ignoreSuppliedState ? undefined : options?.sessionState;
      if (suppliedState && suppliedState.key !== sessionStateKey) {
        throw new Error(`xAI adapter received session state for ${suppliedState.key}`);
      }
      const eligiblePreviousResponseId =
        suppliedState?.fingerprint === sessionFingerprint &&
        suppliedState.instructionsSha256 === instructionsSha256
          ? suppliedState.continuationId
          : undefined;
      const continuationDelta = eligiblePreviousResponseId === undefined
        ? undefined
        : continuationInput(messages, sessionStateKey, "xAI");
      const previousResponseId = continuationDelta === undefined
        ? undefined
        : eligiblePreviousResponseId;
      let input: unknown;
      const useSession = previousResponseId !== undefined;

      if (ignoreSuppliedState) {
        input = lastFreshUserInput(messages, "xAI");
      } else if (useSession && continuationDelta !== undefined) {
        input = continuationDelta;
      } else {
        input = responsesInputFromHistory(messages, sessionStateKey, "xAI");
      }

      // Build tool definitions
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
        // See anthropic.ts — adapter is single-call, so disable parallel
        // tool calls to avoid orphaned tool_use_ids on the next round.
        parallel_tool_calls: false,
      };

      body.reasoning = {
        effort: reasoningEffort === "none" || reasoningEffort === "minimal"
          ? "low"
          : reasoningEffort === "xhigh" || reasoningEffort === "max"
            ? "high"
            : reasoningEffort,
      };

      if (useSession) {
        // xAI doesn't allow instructions + previous_response_id together
        body.previous_response_id = previousResponseId;
      } else {
        body.instructions = instructions;
      }

      // Tool choice support
      if (options?.toolChoice === "required") {
        body.tool_choice = "required";
      } else if (typeof options?.toolChoice === "object") {
        body.tool_choice = { type: "function", name: options.toolChoice.name };
      }

      const send = (requestBody: Record<string, unknown>) => doFetch(XAI_RESPONSES_ENDPOINT, {
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
          throw new Error(`xAI API error (${response.status}): ${error}`);
        }
        continuationRecovery = {
          reason: "missing_or_expired",
          failedContinuationId: previousResponseId,
        };
        const retryBody: Record<string, unknown> = {
          ...body,
          input: responsesInputFromHistory(messages, sessionStateKey, "xAI"),
          instructions,
        };
        delete retryBody.previous_response_id;
        response = await send(retryBody);
        if (!response.ok) {
          const retryError = await response.text();
          throw new Error(`xAI API error (${response.status}): ${retryError}`);
        }
      }

      const data: unknown = await response.json();
      const outputItems = responseOutputItems(data, "xAI");
      const providerReplay: AdapterReplayPayload = { key: sessionStateKey, outputItems };
      const responseId = responseIdentifier(data);
      if (!options?.oneShot && responseId === undefined) {
        throw new Error("xAI response id must be a non-empty string");
      }
      const nextSessionState: AdapterSessionState | undefined =
        !options?.oneShot && responseId !== undefined
          ? {
              key: sessionStateKey,
              continuationId: responseId,
              fingerprint: sessionFingerprint,
              instructionsSha256,
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
            id: requiredString(item.call_id, "xAI function call id"),
            name: requiredString(item.name, "xAI function call name"),
            args: parseToolArguments(item.arguments, "xAI function call arguments"),
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
