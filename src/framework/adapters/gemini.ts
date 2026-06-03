/**
 * Gemini Adapter (Google AI Studio)
 *
 * Env: GEMINI_API_KEY (free at https://aistudio.google.com/apikey)
 * Default model: gemini-3-flash-preview
 */

import type { AIAdapter, AdapterConfig, ChatMessage, ChatOptions, AdapterResponse } from "./types.js";
import type { ToolRegistry } from "../registry.js";
import { safeJsonParse } from "./util.js";
import { chatContentToText, imageBase64, imageMime, normalizeChatContent } from "./content.js";

export function createGeminiAdapter(config?: Partial<AdapterConfig>): AIAdapter {
  const apiKey = config?.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY not set.\nGet a free key at: https://aistudio.google.com/apikey"
    );
  }

  const model = config?.model ?? process.env.GEMINI_MODEL ?? "gemini-3-flash-preview";
  const systemPrompt = config?.systemPrompt ?? "You are a helpful assistant with access to tools. Use tools when they're relevant.";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  return {
    name: config?.name ?? "Gemini",
    model,

    async chat(messages: ChatMessage[], registry: ToolRegistry, options?: ChatOptions): Promise<AdapterResponse> {
      const contents: any[] = [];
      for (const msg of messages) {
        if (msg.role === "tool") {
          // Gemini matches function responses by name. Multiple responses for a
          // parallel turn must share ONE function-role content — merge into the
          // open one rather than emitting consecutive function messages.
          const fr = {
            functionResponse: {
              name: msg.toolName!,
              response: safeJsonParse(chatContentToText(msg.content), { result: chatContentToText(msg.content) }),
            },
          };
          const last = contents[contents.length - 1];
          if (last && last.role === "function") last.parts.push(fr);
          else contents.push({ role: "function", parts: [fr] });
          continue;
        }
        // Assistant tool calls must be replayed as functionCall parts, NOT as
        // text — otherwise Gemini sees no call preceding the functionResponse.
        if (msg.role === "assistant" && (msg.toolCalls?.length || msg.toolCallId)) {
          const calls = msg.toolCalls?.length
            ? msg.toolCalls
            : [{ id: msg.toolCallId!, name: msg.toolName!, args: safeJsonParse(chatContentToText(msg.content), {}) as Record<string, unknown> }];
          contents.push({
            role: "model",
            parts: calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })),
          });
          continue;
        }
        contents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: normalizeChatContent(msg.content).map((part) =>
            part.type === "text"
              ? { text: part.text }
              : { inlineData: { mimeType: imageMime(part), data: imageBase64(part) } }
          ),
        });
      }

      const body: Record<string, unknown> = {
        contents,
        tools: [{ functionDeclarations: registry.toGeminiFormat() }],
        // maxOutputTokens omitted on purpose: Gemini counts thinking tokens
        // against it, so a low cap truncates reasoning models before they answer.
        generationConfig: { temperature: 0.7 },
        systemInstruction: {
          parts: [{ text: options?.systemPrompt ?? systemPrompt }],
        },
      };

      // Tool choice support
      if (options?.toolChoice) {
        const mode = options.toolChoice === "required" ? "ANY"
          : typeof options.toolChoice === "object" ? "ANY"
          : "AUTO";
        body.toolConfig = { functionCallingConfig: { mode } };
      }

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Gemini API error (${response.status}): ${error}`);
      }

      const data = await response.json();
      const candidate = data.candidates?.[0]?.content;
      if (!candidate) throw new Error("No response from Gemini");

      // Gemini commonly emits a preamble text part alongside a functionCall
      // ("I'll look that up..." then the tool call). Capture both — when
      // both are present the text is preamble; when text is alone it's
      // the final response.
      const textParts =
        candidate.parts
          ?.filter((p: any) => typeof p.text === "string")
          .map((p: any) => p.text as string)
          .join("\n")
          .trim() ?? "";
      // Gemini can emit several functionCall parts in one turn (parallel
      // function calling). Match results back by name (Gemini's contract).
      const fnCalls = (candidate.parts ?? [])
        .filter((p: any) => p.functionCall)
        .map((p: any, i: number) => ({
          id: p.functionCall.id ?? `gemini-${i}`,
          name: p.functionCall.name,
          args: p.functionCall.args ?? {},
        }));

      if (fnCalls.length === 1) return { toolCall: fnCalls[0], ...(textParts && { text: textParts }) };
      if (fnCalls.length > 1) return { toolCalls: fnCalls, ...(textParts && { text: textParts }) };

      return { text: textParts || "(no response)" };
    },
  };
}
