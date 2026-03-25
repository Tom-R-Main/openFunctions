/**
 * OpenAI Adapter (Responses API) + OpenAI-Compatible Adapters
 *
 * - createOpenAIAdapter: Uses the modern stateful Responses API (OPENAI_API_KEY)
 * - createOpenRouterAdapter: OpenAI-compatible Chat Completions (OPENROUTER_API_KEY)
 *
 * Any OpenAI-compatible provider can be added with createChatCompletionsAdapter().
 */

import type { AIAdapter, AdapterConfig, ChatMessage, ChatOptions, AdapterResponse } from "./types.js";
import type { ToolRegistry } from "../registry.js";

// ─── OpenAI Responses API ──────────────────────────────────────────────────

export function createOpenAIAdapter(config?: Partial<AdapterConfig>): AIAdapter {
  const apiKey = config?.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY not set.\nGet one at: https://platform.openai.com/api-keys"
    );
  }

  const model = config?.model ?? "gpt-5.4";
  const systemPrompt = config?.systemPrompt ?? "You are a helpful assistant with access to tools. Use tools when they're relevant.";
  let previousResponseId: string | undefined;

  return {
    name: config?.name ?? "OpenAI",
    model,

    async chat(messages: ChatMessage[], registry: ToolRegistry, options?: ChatOptions): Promise<AdapterResponse> {
      let input: any;

      if (previousResponseId) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role === "tool") {
          input = [{
            type: "function_call_output",
            call_id: lastMsg.toolCallId!,
            output: lastMsg.content,
          }];
        } else {
          input = lastMsg.content;
          previousResponseId = undefined;
        }
      } else {
        const lastUser = messages.filter((m) => m.role === "user").pop();
        input = lastUser?.content ?? "";
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
        temperature: 0.7,
      };

      if (previousResponseId) {
        body.previous_response_id = previousResponseId;
      } else {
        body.instructions = systemPrompt;
      }

      // Tool choice support
      if (options?.toolChoice === "required") {
        body.tool_choice = "required";
      } else if (typeof options?.toolChoice === "object") {
        body.tool_choice = { type: "function", name: options.toolChoice.name };
      }

      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenAI API error (${response.status}): ${error}`);
      }

      const data = await response.json();
      previousResponseId = data.id;

      for (const item of data.output ?? []) {
        if (item.type === "function_call") {
          return {
            toolCall: {
              id: item.call_id,
              name: item.name,
              args: JSON.parse(item.arguments || "{}"),
            },
          };
        }

        if (item.type === "message") {
          const text = item.content?.find((c: any) => c.type === "output_text")?.text;
          if (text) return { text };
        }
      }

      return { text: "(no response)" };
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
}

/**
 * Generic adapter for any OpenAI-compatible Chat Completions API.
 * Used by OpenRouter and any other compatible provider.
 */
function createChatCompletionsAdapter(config: ChatCompletionsConfig): AIAdapter {
  const { name, model, apiKey, baseUrl } = config;
  const sysPrompt = config.systemPrompt ?? "You are a helpful assistant with access to tools. Use tools when they're relevant.";

  return {
    name,
    model,

    async chat(messages: ChatMessage[], registry: ToolRegistry, options?: ChatOptions): Promise<AdapterResponse> {
      const openaiMessages: any[] = [{
        role: "system",
        content: sysPrompt,
      }];

      for (const msg of messages) {
        if (msg.role === "tool") {
          openaiMessages.push({
            role: "tool",
            tool_call_id: msg.toolCallId!,
            content: msg.content,
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
                arguments: msg.content,
              },
            }],
          });
        } else {
          openaiMessages.push({
            role: msg.role,
            content: msg.content,
          });
        }
      }

      const body: Record<string, unknown> = {
        model,
        messages: openaiMessages,
        tools: registry.toOpenAIFormat(),
        temperature: 0.7,
        max_tokens: 2048,
      };

      // Tool choice support
      if (options?.toolChoice === "required") {
        body.tool_choice = "required";
      } else if (typeof options?.toolChoice === "object") {
        body.tool_choice = { type: "function", function: { name: options.toolChoice.name } };
      }

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
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

      const toolCall = choice.message?.tool_calls?.[0];
      if (toolCall) {
        return {
          toolCall: {
            id: toolCall.id,
            name: toolCall.function.name,
            args: JSON.parse(toolCall.function.arguments || "{}"),
          },
        };
      }

      return { text: choice.message?.content ?? "(no response)" };
    },
  };
}

// ─── OpenRouter ────────────────────────────────────────────────────────────

/**
 * OpenRouter — any model from any provider via a unified API.
 *
 * Env: OPENROUTER_API_KEY
 * Default model: google/gemini-3-flash-preview
 * Browse models: https://openrouter.ai/models
 */
export function createOpenRouterAdapter(config?: Partial<AdapterConfig>): AIAdapter {
  const apiKey = config?.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY not set.\nGet one at: https://openrouter.ai/keys"
    );
  }

  return createChatCompletionsAdapter({
    name: config?.name ?? "OpenRouter",
    model: config?.model ?? "google/gemini-3-flash-preview",
    apiKey,
    baseUrl: "https://openrouter.ai/api/v1",
    systemPrompt: config?.systemPrompt,
  });
}

