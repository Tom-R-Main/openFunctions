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
 *   npm run chat -- --no-memory                     # disable persistent memory
 */

// Import register-tools to populate the global registry with all tools
import "../src/register-tools.js";
import { createChatAgent } from "../src/framework/index.js";
import { listPresets } from "../src/framework/prompts.js";

// ── Parse arguments ──────────────────────────────────────────────────────
// Supports: npm run chat -- [provider] [model] [--prompt name-or-string] [--no-memory]

const args = process.argv.slice(2);
let provider: string | undefined;
let modelOverride: string | undefined;
let promptInput: string | undefined;
let noMemory = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--prompt" || args[i] === "-p") {
    promptInput = args[i + 1];
    i++; // skip the value
  } else if (args[i] === "--no-memory") {
    noMemory = true;
  } else if (!provider) {
    provider = args[i].toLowerCase();
  } else if (!modelOverride) {
    modelOverride = args[i];
  }
}

// ── Create agent and start interactive chat ──────────────────────────────

try {
  const agent = await createChatAgent({
    provider,
    model: modelOverride,
    preset: promptInput,
    memory: !noMemory,
  });

  await agent.interactive();
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`\n  ${msg}\n`);

  if (msg.includes("provider") || msg.includes("API key")) {
    console.error("  Usage:");
    console.error("    npm run chat -- gemini");
    console.error("    npm run chat -- gemini gemini-2.5-flash");
    console.error("    npm run chat -- gemini --prompt study-buddy");
    console.error(`    npm run chat -- gemini --prompt "You are a pirate"`);
    console.error("    npm run chat -- --no-memory\n");
    const presets = listPresets();
    if (presets.length > 0) {
      console.error(`  Available presets: ${presets.join(", ")}\n`);
    }
  }

  process.exit(1);
}
