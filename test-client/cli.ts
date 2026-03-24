#!/usr/bin/env tsx
/**
 * OpenFunction — CLI Test Client
 *
 * Test your tools without connecting to any AI.
 * Run: npm run test-tools
 *
 * This imports the same registry your MCP server uses,
 * so if your tools work here, they'll work everywhere.
 */

import * as readline from "node:readline";
import { registry } from "../src/framework/index.js";

// ── Register all tools (same as index.ts) ──────────────────────────────────
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

// ── CLI Interface ──────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function main() {
  const tools = registry.getAll();

  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║         OpenFunction — Tool Test Client          ║");
  console.log("╚══════════════════════════════════════════════════╝\n");
  console.log(`Registered tools (${tools.length}):\n`);

  tools.forEach((tool, i) => {
    console.log(`  ${i + 1}. ${tool.name}`);
    console.log(`     ${tool.description.slice(0, 70)}${tool.description.length > 70 ? "..." : ""}\n`);
  });

  // ── Main loop ──────────────────────────────────────────────────────────

  while (true) {
    console.log("─".repeat(50));
    const toolInput = await ask(
      "\nEnter tool name (or 'list', 'schema <name>', 'quit'): ",
    );

    if (toolInput === "quit" || toolInput === "exit" || toolInput === "q") {
      console.log("\nGoodbye!\n");
      rl.close();
      process.exit(0);
    }

    if (toolInput === "list") {
      tools.forEach((t) => console.log(`  ${t.name}`));
      continue;
    }

    if (toolInput.startsWith("schema ")) {
      const name = toolInput.slice(7).trim();
      const tool = registry.get(name);
      if (!tool) {
        console.log(`\n  Unknown tool: "${name}"\n`);
        continue;
      }
      console.log(`\n${tool.name}:`);
      console.log(`  Description: ${tool.description}`);
      console.log(`  Parameters:`);
      console.log(JSON.stringify(tool.inputSchema, null, 4));
      if (tool.examples?.length) {
        console.log(`  Example input:`, JSON.stringify(tool.examples[0].input));
      }
      continue;
    }

    // ── Execute a tool ─────────────────────────────────────────────────

    const tool = registry.get(toolInput);
    if (!tool) {
      console.log(`\n  Unknown tool: "${toolInput}". Type 'list' to see available tools.\n`);
      continue;
    }

    // Collect parameters
    const params: Record<string, unknown> = {};
    const props = tool.inputSchema.properties;
    const required = new Set(tool.inputSchema.required ?? []);

    console.log(`\n  Parameters for ${tool.name}:\n`);

    for (const [key, schema] of Object.entries(props)) {
      const req = required.has(key) ? " (required)" : " (optional, press Enter to skip)";
      const desc = schema.description ? ` — ${schema.description}` : "";
      const typeHint = schema.type === "array" ? " [comma-separated]" : "";

      const value = await ask(`    ${key}${req}${desc}${typeHint}: `);

      if (!value && !required.has(key)) continue;
      if (!value && required.has(key)) {
        console.log(`\n  ⚠️  "${key}" is required. Aborting this call.\n`);
        break;
      }

      // Parse the value based on type
      if (schema.type === "integer" || schema.type === "number") {
        params[key] = Number(value);
      } else if (schema.type === "boolean") {
        params[key] = value.toLowerCase() === "true" || value === "1";
      } else if (schema.type === "array") {
        try {
          // Try JSON first, then fall back to comma-separated
          params[key] = JSON.parse(value);
        } catch {
          params[key] = value.split(",").map((s) => s.trim());
        }
      } else if (schema.type === "object") {
        try {
          params[key] = JSON.parse(value);
        } catch {
          console.log(`    ⚠️  Could not parse JSON for "${key}", using as string`);
          params[key] = value;
        }
      } else {
        params[key] = value;
      }
    }

    // Execute
    console.log(`\n  Calling ${tool.name}...`);
    console.log(`  Input: ${JSON.stringify(params)}\n`);

    const result = await registry.execute(toolInput, params);

    console.log(`  Result:`);
    console.log(JSON.stringify(result, null, 2));
    console.log();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
