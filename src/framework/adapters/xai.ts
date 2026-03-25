/**
 * xAI Adapter (Grok)
 *
 * Uses xAI's Responses API (stateful, like OpenAI's Responses API).
 *
 * Env: XAI_API_KEY
 * Default model: grok-4.20-0309-reasoning
 * Console: https://console.x.ai
 */

import type { AIAdapter, AdapterConfig, ChatMessage, AdapterResponse } from "./types.js";
import type { ToolRegistry } from "../registry.js";

export function createXAIAdapter(config?: Partial<AdapterConfig>): AIAdapter {
  const apiKey = config?.apiKey ?? process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "XAI_API_KEY not set.\nGet one at: https://console.x.ai"
    );
  }

  const model = config?.model ?? "grok-4.20-0309-reasoning";
  const systemPrompt = config?.systemPrompt ?? "You are a helpful assistant with access to tools. Use tools when they're relevant.";
  let previousResponseId: string | undefined;

  return {
    name: config?.name ?? "Grok",
    model,

    async chat(messages: ChatMessage[], registry: ToolRegistry): Promise<AdapterResponse> {
      // Build input for xAI Responses API
      let input: any;

      if (previousResponseId) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role === "tool") {
          // Send tool result back referencing the previous response
          input = [{
            type: "function_call_output",
            call_id: lastMsg.toolCallId!,
            output: lastMsg.content,
          }];
        } else {
          // New user message — start fresh conversation turn
          input = lastMsg.content;
          previousResponseId = undefined;
        }
      } else {
        // First message or after reset
        const lastUser = messages.filter((m) => m.role === "user").pop();
        input = lastUser?.content ?? "";
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
        temperature: 0.7,
      };

      if (previousResponseId) {
        // xAI doesn't allow instructions + previous_response_id together
        body.previous_response_id = previousResponseId;
      } else {
        body.instructions = systemPrompt;
      }

      const response = await fetch("https://api.x.ai/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`xAI API error (${response.status}): ${error}`);
      }

      const data = await response.json();
      previousResponseId = data.id;

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
