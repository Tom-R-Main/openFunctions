/**
 * OpenFunction — AI Adapter Interface
 *
 * Every AI provider implements this interface. The chat loop is shared —
 * only the API call format differs between providers.
 */

import type { ToolRegistry } from "../registry.js";

/** A message in the conversation */
export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
}

/** What the adapter returns after calling the AI */
export interface AdapterResponse {
  /** Text response from the AI (if any) */
  text?: string;

  /** Tool call the AI wants to make (if any) */
  toolCall?: {
    id: string;
    name: string;
    args: Record<string, unknown>;
  };
}

/** Configuration for an adapter */
export interface AdapterConfig {
  /** Display name (e.g. "Gemini", "OpenAI") */
  name: string;

  /** Model to use */
  model: string;

  /** API key */
  apiKey: string;
}

/** An AI provider adapter */
export interface AIAdapter {
  /** Provider name for display */
  readonly name: string;

  /** Model being used */
  readonly model: string;

  /**
   * Send a conversation to the AI with tools available.
   * Returns either a text response or a tool call request.
   */
  chat(
    messages: ChatMessage[],
    registry: ToolRegistry,
  ): Promise<AdapterResponse>;
}

/** Factory function type for creating adapters */
export type AdapterFactory = (config?: Partial<AdapterConfig>) => AIAdapter;
