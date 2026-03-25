/**
 * OpenFunction — Structured Output
 *
 * Force the AI to return JSON matching a schema. Works by creating a
 * synthetic tool whose inputSchema IS the desired output format, then
 * requesting the AI call it. The tool's arguments ARE your structured data.
 *
 * Works across all providers (Gemini, OpenAI, Anthropic, xAI, OpenRouter).
 *
 * @example
 * ```ts
 * const result = await forceStructuredOutput<{
 *   sentiment: "positive" | "negative" | "neutral";
 *   confidence: number;
 * }>(adapter, {
 *   schema: {
 *     type: "object",
 *     properties: {
 *       sentiment: { type: "string", enum: ["positive", "negative", "neutral"] },
 *       confidence: { type: "number", description: "0.0 to 1.0" },
 *     },
 *     required: ["sentiment", "confidence"],
 *   },
 *   prompt: "Analyze the sentiment of: 'I love this framework!'",
 * });
 * // result.data.sentiment === "positive"
 * ```
 */

import type { InputSchema } from "./types.js";
import type { AIAdapter, ChatMessage } from "./adapters/types.js";
import { ToolRegistry } from "./registry.js";
import { defineTool, ok } from "./tool.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StructuredOutputOptions {
  /** JSON Schema describing the desired output shape */
  schema: InputSchema;
  /** The prompt/question to send to the AI */
  prompt: string;
  /** Human-readable description of what you're extracting (helps the AI) */
  description?: string;
  /** Optional system prompt override */
  systemPrompt?: string;
  /** Optional prior conversation for context */
  messages?: ChatMessage[];
}

export interface StructuredResult<T = Record<string, unknown>> {
  /** The parsed structured data */
  data: T;
  /** Raw arguments from the tool call */
  raw: Record<string, unknown>;
}

// ─── Core Function ──────────────────────────────────────────────────────────

/**
 * Force the AI to return structured JSON matching your schema.
 *
 * Uses the "fake tool trick": creates a synthetic tool whose input schema
 * IS your desired output shape, tells the AI to call it, and extracts
 * the arguments as structured data.
 */
export async function forceStructuredOutput<T = Record<string, unknown>>(
  adapter: AIAdapter,
  options: StructuredOutputOptions,
): Promise<StructuredResult<T>> {
  const toolName = "structured_output";
  const description = options.description ?? "Respond with structured data in this exact format.";

  // Create a synthetic tool with the desired output schema
  const syntheticTool = defineTool({
    name: toolName,
    description: `You MUST call this tool to respond. ${description}`,
    inputSchema: options.schema,
    handler: async (params) => ok(params),
  });

  // Create a temporary registry with only the synthetic tool
  const tempRegistry = new ToolRegistry();
  tempRegistry.register(syntheticTool);

  // Build messages
  const messages: ChatMessage[] = [
    ...(options.messages ?? []),
    { role: "user", content: options.prompt },
  ];

  // Call the adapter with tool_choice: required
  const response = await adapter.chat(messages, tempRegistry, {
    toolChoice: "required",
  });

  if (!response.toolCall) {
    throw new Error(
      "AI did not return a tool call. Structured output extraction failed. " +
        "This can happen if the provider doesn't support tool_choice."
    );
  }

  return {
    data: response.toolCall.args as T,
    raw: response.toolCall.args,
  };
}

// ─── Convenience: Reusable Extractor ────────────────────────────────────────

/**
 * Create a reusable extractor for a specific schema.
 * Returns a function that takes a prompt and returns structured data.
 *
 * @example
 * ```ts
 * const extractSentiment = createExtractor<Sentiment>(adapter, {
 *   schema: sentimentSchema,
 *   description: "Extract sentiment analysis",
 * });
 *
 * const r1 = await extractSentiment("I love this!");
 * const r2 = await extractSentiment("This is terrible.");
 * ```
 */
export function createExtractor<T = Record<string, unknown>>(
  adapter: AIAdapter,
  config: Omit<StructuredOutputOptions, "prompt">,
): (prompt: string) => Promise<StructuredResult<T>> {
  return (prompt: string) =>
    forceStructuredOutput<T>(adapter, { ...config, prompt });
}
