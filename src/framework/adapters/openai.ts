/**
 * OpenAI Adapter (Responses API)
 *
 * Uses the modern stateful Responses API, not the legacy Chat Completions.
 *
 * Env: OPENAI_API_KEY
 * Default model: gpt-5.4
 *
 * Also provides createOpenRouterAdapter() which uses OpenAI-compatible
 * Chat Completions format (OpenRouter doesn't support Responses API).
 */

import type { AIAdapter, AdapterConfig, ChatMessage, AdapterResponse } from "./types.js";
import type { ToolRegistry } from "../registry.js";

export function createOpenAIAdapter(config?: Partial<AdapterConfig>): AIAdapter {
  const apiKey = config?.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY not set.\nGet one at: https://platform.openai.com/api-keys"
    );
  }

  const model = config?.model ?? "gpt-5.4";
  let previousResponseId: string | undefined;

  return {
    name: config?.name ?? "OpenAI",
    model,

    async chat(messages: ChatMessage[], registry: ToolRegistry): Promise<AdapterResponse> {
      // Build the input for the Responses API
      let input: any;

      if (previousResponseId) {
        // Stateful: reference previous response, only send new items
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role === "tool") {
          // Sending tool result back
          input = [{
            type: "function_call_output",
            call_id: lastMsg.toolCallId!,
            output: lastMsg.content,
          }];
        } else {
          // New user message
          input = lastMsg.content;
          previousResponseId = undefined; // Reset for new turn
        }
      } else {
        // First message or after reset — send as string
        const lastUser = messages.filter((m) => m.role === "user").pop();
        input = lastUser?.content ?? "";
      }

      // Build tool definitions — Responses API uses flat format
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
      previousResponseId = data.id; // Track for stateful conversation

      // Parse output items
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

/**
 * OpenRouter Adapter — uses OpenAI-compatible Chat Completions format.
 *
 * Env: OPENROUTER_API_KEY
 * Default model: google/gemini-3-flash-preview
 *
 * OpenRouter supports any model from any provider via a unified API.
 * Browse models at: https://openrouter.ai/models
 */
export function createOpenRouterAdapter(config?: Partial<AdapterConfig>): AIAdapter {
  const apiKey = config?.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY not set.\nGet one at: https://openrouter.ai/keys"
    );
  }

  const model = config?.model ?? "google/gemini-3-flash-preview";

  return {
    name: config?.name ?? "OpenRouter",
    model,

    async chat(messages: ChatMessage[], registry: ToolRegistry): Promise<AdapterResponse> {
      // OpenRouter uses OpenAI Chat Completions format
      const openaiMessages: any[] = [{
        role: "system",
        content: "You are a helpful assistant with access to tools. Use tools when they're relevant.",
      }];

      for (const msg of messages) {
        if (msg.role === "tool") {
          openaiMessages.push({
            role: "tool",
            tool_call_id: msg.toolCallId!,
            content: msg.content,
          });
        } else if (msg.role === "assistant" && msg.toolCallId) {
          // Assistant message that was a tool call
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

      const body = {
        model,
        messages: openaiMessages,
        tools: registry.toOpenAIFormat(),
        temperature: 0.7,
        max_tokens: 2048,
      };

      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenRouter API error (${response.status}): ${error}`);
      }

      const data = await response.json();
      const choice = data.choices?.[0];
      if (!choice) throw new Error("No response from OpenRouter");

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
