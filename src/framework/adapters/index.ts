/**
 * OpenFunction — AI Adapters
 *
 * Connect your tools to any AI provider:
 *
 *   npm run chat              # auto-detects from available API keys
 *   npm run chat -- gemini    # Google AI Studio
 *   npm run chat -- openai    # OpenAI (Responses API)
 *   npm run chat -- anthropic # Anthropic Claude
 *   npm run chat -- openrouter# OpenRouter (any model)
 */

export type { AIAdapter, AdapterConfig, ChatMessage, AdapterResponse } from "./types.js";
export { createGeminiAdapter } from "./gemini.js";
export { createOpenAIAdapter, createOpenRouterAdapter } from "./openai.js";
export { createAnthropicAdapter } from "./anthropic.js";
export { createXAIAdapter } from "./xai.js";
export { startChat } from "./chat.js";
