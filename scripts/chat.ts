#!/usr/bin/env tsx
/**
 * OpenFunction — Unified AI Chat
 *
 * Chat with any AI provider using your tools.
 *
 * Usage:
 *   npm run chat                # auto-detect from API keys
 *   npm run chat -- gemini      # Google AI Studio (GEMINI_API_KEY)
 *   npm run chat -- openai      # OpenAI Responses API (OPENAI_API_KEY)
 *   npm run chat -- anthropic   # Anthropic Claude (ANTHROPIC_API_KEY)
 *   npm run chat -- openrouter  # OpenRouter (OPENROUTER_API_KEY)
 */

import { registry } from "../src/framework/index.js";
import {
  createGeminiAdapter,
  createOpenAIAdapter,
  createOpenRouterAdapter,
  createAnthropicAdapter,
  startChat,
} from "../src/framework/adapters/index.js";
import type { AIAdapter } from "../src/framework/adapters/index.js";

// ── Register all tools ────────────────────────────────────────────────────
import { studyTrackerTools } from "../src/examples/study-tracker/tools.js";
import { bookmarkManagerTools } from "../src/examples/bookmark-manager/tools.js";
import { quizGeneratorTools } from "../src/examples/quiz-generator/tools.js";
import { expenseSplitterTools } from "../src/examples/expense-splitter/tools.js";
import { workoutLoggerTools } from "../src/examples/workout-logger/tools.js";
import { recipeKeeperTools } from "../src/examples/recipe-keeper/tools.js";
import { dictionaryTools } from "../src/examples/dictionary/tools.js";
import { aiTools } from "../src/examples/ai-tools/tools.js";
import { utilityTools } from "../src/examples/utilities/tools.js";
import { myTools } from "../src/my-tools/index.js";

registry.registerAll(studyTrackerTools);
registry.registerAll(bookmarkManagerTools);
registry.registerAll(quizGeneratorTools);
registry.registerAll(expenseSplitterTools);
registry.registerAll(workoutLoggerTools);
registry.registerAll(recipeKeeperTools);
registry.registerAll(dictionaryTools);
registry.registerAll(aiTools);
registry.registerAll(utilityTools);
registry.registerAll(myTools);

// ── Select adapter ────────────────────────────────────────────────────────

const provider = process.argv[2]?.toLowerCase();

function createAdapter(): AIAdapter {
  // Explicit provider selection
  if (provider) {
    switch (provider) {
      case "gemini":
        return createGeminiAdapter();
      case "openai":
        return createOpenAIAdapter();
      case "anthropic":
      case "claude":
        return createAnthropicAdapter();
      case "openrouter":
        return createOpenRouterAdapter();
      default:
        console.error(`\n  Unknown provider: "${provider}"`);
        console.error("  Available: gemini, openai, anthropic, openrouter\n");
        process.exit(1);
    }
  }

  // Auto-detect from available API keys
  if (process.env.GEMINI_API_KEY) return createGeminiAdapter();
  if (process.env.OPENAI_API_KEY) return createOpenAIAdapter();
  if (process.env.ANTHROPIC_API_KEY) return createAnthropicAdapter();
  if (process.env.OPENROUTER_API_KEY) return createOpenRouterAdapter();

  console.error("\n  No API key found. Set one of these environment variables:\n");
  console.error("    export GEMINI_API_KEY=...      # Google AI Studio (free)");
  console.error("    export OPENAI_API_KEY=...      # OpenAI");
  console.error("    export ANTHROPIC_API_KEY=...   # Anthropic Claude");
  console.error("    export OPENROUTER_API_KEY=...  # OpenRouter (any model)\n");
  console.error("  Or specify a provider: npm run chat -- gemini\n");
  process.exit(1);
}

const adapter = createAdapter();
startChat(adapter, registry);
