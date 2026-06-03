/**
 * Anthropic Adapter (Claude)
 *
 * Env: ANTHROPIC_API_KEY
 * Default model: claude-sonnet-4-6
 */

import type { AIAdapter, AdapterConfig, ChatMessage, ChatOptions, AdapterResponse, ReasoningEffort } from "./types.js";
import type { ToolRegistry } from "../registry.js";
import { safeJsonParse } from "./util.js";
import { chatContentToText, imageBase64, imageMime, normalizeChatContent } from "./content.js";

/**
 * Anthropic has no `effort` knob — extended thinking is controlled by a token
 * budget. Translate the normalized effort level to a budget; `none`/`minimal`
 * mean "no thinking". Budgets must be >= 1024 and strictly < max_tokens.
 */
const THINKING_BUDGET: Record<ReasoningEffort, number> = {
  none: 0,
  minimal: 0,
  low: 2048,
  medium: 6144,
  high: 12288,
  xhigh: 24576,
};
/** Output headroom reserved for the answer on top of the thinking budget. */
const ANSWER_HEADROOM = 8192;
/**
 * Anthropic REQUIRES max_tokens (unlike OpenAI/Gemini, which we omit). With no
 * model-metadata DB to derive a per-model cap, use a generous default that
 * won't truncate normal answers — the old 2048 cut real responses short.
 */
const DEFAULT_MAX_TOKENS = 8192;

export function createAnthropicAdapter(config?: Partial<AdapterConfig>): AIAdapter {
  const apiKey = config?.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY not set.\nGet one at: https://console.anthropic.com/settings/keys"
    );
  }

  const model = config?.model ?? "claude-sonnet-4-6";
  const systemPrompt = config?.systemPrompt ?? "You are a helpful assistant with access to tools. Use tools when they're relevant.";
  const thinkingBudget = config?.reasoningEffort ? THINKING_BUDGET[config.reasoningEffort] : 0;
  const thinkingEnabled = thinkingBudget > 0;

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
            content: anthropicContent(msg.content),
          });
        } else if (msg.role === "assistant") {
          // Extended thinking REQUIRES the original thinking block(s) to lead
          // the assistant message that contains the tool_use(s), replayed
          // verbatim (signatures are validated). The agent loop stashes them on
          // `thinkingBlocks`; without this the follow-up turn 400s.
          const preserved = Array.isArray(msg.thinkingBlocks) ? msg.thinkingBlocks : [];
          if (msg.toolCalls?.length) {
            // Parallel: every tool_use block in one assistant turn.
            const toolUses = msg.toolCalls.map((c) => ({
              type: "tool_use",
              id: c.id,
              name: c.name,
              input: c.args,
            }));
            anthropicMessages.push({
              role: "assistant",
              content: preserved.length ? [...preserved, ...toolUses] : toolUses,
            });
          } else if (msg.toolCallId && msg.toolName) {
            const toolUse = {
              type: "tool_use",
              id: msg.toolCallId,
              name: msg.toolName,
              input: safeJsonParse(chatContentToText(msg.content), {}),
            };
            anthropicMessages.push({
              role: "assistant",
              content: preserved.length ? [...preserved, toolUse] : [toolUse],
            });
          } else {
            anthropicMessages.push({
              role: "assistant",
              content: chatContentToText(msg.content),
            });
          }
        } else if (msg.role === "tool") {
          // Anthropic requires all tool_result blocks for a turn's parallel
          // tool_use blocks to arrive in ONE user message — consecutive
          // user-role messages would 400. Merge into the open results message.
          const toolResult = {
            type: "tool_result",
            tool_use_id: msg.toolCallId!,
            content: chatContentToText(msg.content),
          };
          const last = anthropicMessages[anthropicMessages.length - 1];
          const isOpenResultMsg =
            last &&
            last.role === "user" &&
            Array.isArray(last.content) &&
            last.content.every((b: any) => b?.type === "tool_result");
          if (isOpenResultMsg) {
            (last.content as unknown[]).push(toolResult);
          } else {
            anthropicMessages.push({ role: "user", content: [toolResult] });
          }
        }
      }

      const tools = registry.toAnthropicFormat();
      const body: Record<string, unknown> = {
        model,
        // Extended thinking requires max_tokens > budget_tokens; reserve answer
        // headroom on top of the budget when thinking is on.
        max_tokens: thinkingEnabled ? thinkingBudget + ANSWER_HEADROOM : DEFAULT_MAX_TOKENS,
        system: options?.systemPrompt ?? systemPrompt,
        messages: anthropicMessages,
        tools,
      };

      if (thinkingEnabled) {
        body.thinking = { type: "enabled", budget_tokens: thinkingBudget };
      }

      // Tool choice + disable parallel tool use.
      // Without disable_parallel_tool_use, Anthropic may emit multiple
      // tool_use blocks in one assistant turn. Our adapter only returns
      // the first tool call (single-call AdapterResponse), which leaves
      // the other tool_use_ids without matching tool_results — the next
      // call then 400s with "tool_use_id was not found".
      // Conservative fix: serialize tool calls. A future change can
      // extend AdapterResponse to carry multiple calls per round.
      if (tools.length > 0) {
        const toolChoice: Record<string, unknown> = { type: "auto" };
        // Extended thinking is incompatible with forced tool use (type "any"
        // or "tool") AND with parallel tool use — Anthropic requires "auto"
        // and serialized calls so each turn's thinking block can lead. With
        // thinking off, allow fan-out (the loop handles parallel results) and
        // honor the caller's forcing.
        if (thinkingEnabled) {
          toolChoice.disable_parallel_tool_use = true;
        } else if (options?.toolChoice === "required") {
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
      const toolUseBlocks = blocks.filter((b) => b.type === "tool_use");

      if (toolUseBlocks.length) {
        // Preserve thinking/redacted_thinking blocks verbatim so the agent loop
        // can replay them on the assistant turn that continues these calls.
        const thinking = blocks.filter(
          (b) => b.type === "thinking" || b.type === "redacted_thinking"
        );
        const calls = toolUseBlocks.map((b) => ({
          id: b.id!,
          name: b.name!,
          args: (b.input as Record<string, unknown>) ?? {},
        }));
        const extra = {
          ...(textBlock?.text && { text: textBlock.text }),
          ...(thinking.length && { thinking }),
        };
        // A lone call stays on `toolCall`; a real fan-out uses `toolCalls`.
        return calls.length === 1 ? { toolCall: calls[0], ...extra } : { toolCalls: calls, ...extra };
      }

      return { text: textBlock?.text ?? "(no response)" };
    },
  };
}

function anthropicContent(content: ChatMessage["content"]): unknown {
  if (typeof content === "string") return content;
  return normalizeChatContent(content).map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : {
          type: "image",
          source: {
            type: "base64",
            media_type: imageMime(part),
            data: imageBase64(part),
          },
        }
  );
}
