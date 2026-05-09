/**
 * Anthropic Adapter (Claude)
 *
 * Env: ANTHROPIC_API_KEY
 * Default model: claude-sonnet-4-6
 */

import type { AIAdapter, AdapterConfig, ChatMessage, ChatOptions, AdapterResponse } from "./types.js";
import type { ToolRegistry } from "../registry.js";
import { safeJsonParse } from "./util.js";

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

    async chat(messages: ChatMessage[], registry: ToolRegistry, options?: ChatOptions): Promise<AdapterResponse> {
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
                input: safeJsonParse(msg.content, {}),
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

      const tools = registry.toAnthropicFormat();
      const body: Record<string, unknown> = {
        model,
        max_tokens: 2048,
        system: options?.systemPrompt ?? systemPrompt,
        messages: anthropicMessages,
        tools,
      };

      // Tool choice + disable parallel tool use.
      // Without disable_parallel_tool_use, Anthropic may emit multiple
      // tool_use blocks in one assistant turn. Our adapter only returns
      // the first tool call (single-call AdapterResponse), which leaves
      // the other tool_use_ids without matching tool_results — the next
      // call then 400s with "tool_use_id was not found".
      // Conservative fix: serialize tool calls. A future change can
      // extend AdapterResponse to carry multiple calls per round.
      if (tools.length > 0) {
        const toolChoice: Record<string, unknown> = {
          type: "auto",
          disable_parallel_tool_use: true,
        };
        if (options?.toolChoice === "required") {
          toolChoice.type = "any";
        } else if (typeof options?.toolChoice === "object") {
          toolChoice.type = "tool";
          toolChoice.name = options.toolChoice.name;
        }
        body.tool_choice = toolChoice;
      }

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

      // Anthropic responses can contain both a text block (preamble like
      // "Let me check that...") AND a tool_use block in the same turn.
      // Capture both — when both are present the text is preamble; when
      // text is alone it's the final response.
      const blocks: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> =
        data.content ?? [];
      const textBlock = blocks.find((b) => b.type === "text");
      const toolUseBlock = blocks.find((b) => b.type === "tool_use");

      if (toolUseBlock) {
        return {
          toolCall: {
            id: toolUseBlock.id!,
            name: toolUseBlock.name!,
            args: (toolUseBlock.input as Record<string, unknown>) ?? {},
          },
          ...(textBlock?.text && { text: textBlock.text }),
        };
      }

      return { text: textBlock?.text ?? "(no response)" };
    },
  };
}
