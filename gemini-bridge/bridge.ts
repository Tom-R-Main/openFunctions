/**
 * OpenFunction — Gemini Bridge
 *
 * Converts your OpenFunction tools into Gemini function calling schemas
 * and executes them when Gemini decides to call a function.
 *
 * This is the "composability proof" — the same tool definitions you
 * wrote for MCP also work with Google's AI, zero rewriting needed.
 */

import { registry } from "../src/framework/index.js";
import type { ToolResult } from "../src/framework/types.js";

// ── Register all tools ─────────────────────────────────────────────────────
import { studyTrackerTools } from "../src/examples/study-tracker/tools.js";
import { bookmarkManagerTools } from "../src/examples/bookmark-manager/tools.js";
import { quizGeneratorTools } from "../src/examples/quiz-generator/tools.js";
import { myTools } from "../src/my-tools/index.js";

registry.registerAll(studyTrackerTools);
registry.registerAll(bookmarkManagerTools);
registry.registerAll(quizGeneratorTools);
registry.registerAll(myTools);

// ─── Schema Conversion ────────────────────────────────────────────────────

/**
 * Get all tools in Gemini function declaration format.
 *
 * Gemini expects:
 * {
 *   functionDeclarations: [
 *     { name: "...", description: "...", parameters: { type: "object", properties: {...} } }
 *   ]
 * }
 */
export function getGeminiToolDeclarations() {
  return {
    functionDeclarations: registry.toGeminiFormat(),
  };
}

/**
 * Execute a function call from Gemini and return the result.
 *
 * When Gemini responds with a function call, pass the name and args here.
 * Returns a FunctionResponse that you send back to Gemini.
 */
export async function executeGeminiFunctionCall(
  name: string,
  args: Record<string, unknown>,
): Promise<{ name: string; response: ToolResult }> {
  const result = await registry.execute(name, args);
  return { name, response: result };
}

/**
 * Print the Gemini schema for inspection.
 * Useful for debugging or copy-pasting into AI Studio.
 */
export function printGeminiSchema() {
  const declarations = getGeminiToolDeclarations();
  console.log("\n=== Gemini Function Declarations ===\n");
  console.log(JSON.stringify(declarations, null, 2));
  console.log(`\nTotal: ${declarations.functionDeclarations.length} functions\n`);
}
