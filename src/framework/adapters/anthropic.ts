/**
 * Anthropic Adapter (Claude)
 *
 * Env: ANTHROPIC_API_KEY
 * Default model: claude-sonnet-4-6
 */

import type { AIAdapter, AdapterConfig, ChatMessage, AdapterResponse } from "./types.js";
import type { ToolRegistry } from "../registry.js";

export function createAnthropicAdapter(config?: Partial<AdapterConfig>): AIAdapter {
  const apiKey = config?.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY not set.\nGet one at: https://console.anthropic.com/settings/keys"
    );
  }

  const model = config?.model ?? "claude-sonnet-4-6";
  const systemPrompt = config?.systemPrompt ?? "You are a helpful assistant with access to tools. Use tools when they're relevant.";

  return {
    name: config?.name ?? "Claude",
    model,

    async chat(messages: ChatMessage[], registry: ToolRegistry): Promise<AdapterResponse> {
      // Convert messages to Anthropic format
      const anthropicMessages: any[] = [];

      for (const msg of messages) {
        if (msg.role === "user") {
          anthropicMessages.push({
            role: "user",
            content: msg.content,
          });
        } else if (msg.role === "assistant") {
          // If this assistant message preceded a tool call, we need the tool_use block
          if (msg.toolCallId && msg.toolName) {
            anthropicMessages.push({
              role: "assistant",
              content: [{
                type: "tool_use",
                id: msg.toolCallId,
                name: msg.toolName,
                input: JSON.parse(msg.content),
              }],
            });
          } else {
            anthropicMessages.push({
              role: "assistant",
              content: msg.content,
            });
          }
        } else if (msg.role === "tool") {
          anthropicMessages.push({
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: msg.toolCallId!,
              content: msg.content,
            }],
          });
        }
      }

      const body = {
        model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: anthropicMessages,
        tools: registry.toAnthropicFormat(),
      };

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Anthropic API error (${response.status}): ${error}`);
      }

      const data = await response.json();

      // Check for tool use in response content blocks
      const toolUseBlock = data.content?.find((b: any) => b.type === "tool_use");
      if (toolUseBlock) {
        return {
          toolCall: {
            id: toolUseBlock.id,
            name: toolUseBlock.name,
            args: toolUseBlock.input ?? {},
          },
        };
      }

      // Text response
      const textBlock = data.content?.find((b: any) => b.type === "text");
      return { text: textBlock?.text ?? "(no response)" };
    },
  };
}
