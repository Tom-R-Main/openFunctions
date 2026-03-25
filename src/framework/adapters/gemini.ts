/**
 * Gemini Adapter (Google AI Studio)
 *
 * Env: GEMINI_API_KEY (free at https://aistudio.google.com/apikey)
 * Default model: gemini-3-flash-preview
 */

import type { AIAdapter, AdapterConfig, ChatMessage, ChatOptions, AdapterResponse } from "./types.js";
import type { ToolRegistry } from "../registry.js";

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
      const contents = messages.map((msg) => {
        if (msg.role === "tool") {
          return {
            role: "function" as const,
            parts: [{
              functionResponse: {
                name: msg.toolName!,
                response: JSON.parse(msg.content),
              },
            }],
          };
        }
        return {
          role: msg.role === "assistant" ? "model" as const : "user" as const,
          parts: [{ text: msg.content }],
        };
      });

      const body: Record<string, unknown> = {
        contents,
        tools: [{ functionDeclarations: registry.toGeminiFormat() }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
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

      const fnCall = candidate.parts?.find((p: any) => p.functionCall);
      if (fnCall?.functionCall) {
        return {
          toolCall: {
            id: fnCall.functionCall.id ?? `gemini-${Date.now()}`,
            name: fnCall.functionCall.name,
            args: fnCall.functionCall.args ?? {},
          },
        };
      }

      const text = candidate.parts?.find((p: any) => p.text)?.text;
      return { text: text ?? "(no response)" };
    },
  };
}
