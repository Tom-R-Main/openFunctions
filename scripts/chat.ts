#!/usr/bin/env tsx
// Load .env file if it exists (API keys, DATABASE_URL, etc.)
import "../src/framework/env.js";

/**
 * OpenFunction — Unified AI Chat
 *
 * Chat with any AI provider using your tools.
 *
 * Usage:
 *   npm run chat                                    # auto-detect provider + default prompt
 *   npm run chat -- gemini                          # specific provider
 *   npm run chat -- gemini gemini-2.5-flash         # specific model
 *   npm run chat -- gemini --prompt study-buddy     # preset prompt
 *   npm run chat -- gemini --prompt "You are X"     # inline prompt
 */

import { registry } from "../src/framework/index.js";
import {
  createGeminiAdapter,
  createOpenAIAdapter,
  createOpenRouterAdapter,
  createAnthropicAdapter,
  createXAIAdapter,
  startChat,
  resolvePrompt,
  listPresets,
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

// ── Parse arguments ──────────────────────────────────────────────────────
// Supports: npm run chat -- [provider] [model] [--prompt name-or-string]

const args = process.argv.slice(2);
let provider: string | undefined;
let modelOverride: string | undefined;
let promptInput: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--prompt" || args[i] === "-p") {
    promptInput = args[i + 1];
    i++; // skip the value
  } else if (!provider) {
    provider = args[i].toLowerCase();
  } else if (!modelOverride) {
    modelOverride = args[i];
  }
}

// Resolve system prompt (preset name, inline string, or default)
const systemPrompt = resolvePrompt(promptInput, registry);

function createAdapter(): AIAdapter {
  const opts: Record<string, string> = {};
  if (modelOverride) opts.model = modelOverride;
  opts.systemPrompt = systemPrompt;

  // Explicit provider selection
  if (provider) {
    switch (provider) {
      case "gemini":
        return createGeminiAdapter(opts);
      case "openai":
        return createOpenAIAdapter(opts);
      case "anthropic":
      case "claude":
        return createAnthropicAdapter(opts);
      case "openrouter":
        return createOpenRouterAdapter(opts);
      case "xai":
      case "grok":
        return createXAIAdapter(opts);
      default:
        console.error(`\n  Unknown provider: "${provider}"`);
        console.error("  Available: gemini, openai, anthropic, openrouter, xai\n");
        console.error("  Options:");
        console.error("    npm run chat -- gemini gemini-2.5-flash");
        console.error("    npm run chat -- gemini --prompt study-buddy");
        console.error(`    npm run chat -- gemini --prompt "You are a pirate"`);
        console.error(`\n  Available presets: ${listPresets().join(", ") || "(none)"}\n`);
        process.exit(1);
    }
  }

  // Auto-detect from available API keys
  if (process.env.GEMINI_API_KEY) return createGeminiAdapter(opts);
  if (process.env.OPENAI_API_KEY) return createOpenAIAdapter(opts);
  if (process.env.ANTHROPIC_API_KEY) return createAnthropicAdapter(opts);
  if (process.env.OPENROUTER_API_KEY) return createOpenRouterAdapter(opts);
  if (process.env.XAI_API_KEY) return createXAIAdapter(opts);

  console.error("\n  No API key found. Set one of these environment variables:\n");
  console.error("    export GEMINI_API_KEY=...      # Google AI Studio (free)");
  console.error("    export OPENAI_API_KEY=...      # OpenAI");
  console.error("    export ANTHROPIC_API_KEY=...   # Anthropic Claude");
  console.error("    export OPENROUTER_API_KEY=...  # OpenRouter (any model)");
  console.error("    export XAI_API_KEY=...         # xAI Grok\n");
  console.error("  Or specify a provider: npm run chat -- gemini");
  console.error("  With model override:   npm run chat -- gemini gemini-2.5-flash");
  console.error("  With custom prompt:    npm run chat -- gemini --prompt study-buddy\n");
  const presets = listPresets();
  if (presets.length > 0) {
    console.error(`  Available presets: ${presets.join(", ")}\n`);
  }
  process.exit(1);
}

const adapter = createAdapter();
startChat(adapter, registry);
