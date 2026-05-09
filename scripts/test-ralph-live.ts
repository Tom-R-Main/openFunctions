#!/usr/bin/env tsx
/**
 * Live end-to-end test of the Ralph loop with a real LLM.
 *
 * Scenario: an agent must increment a counter to 3 by calling tools.
 * Each iteration, the agent reads + writes shared state through the
 * counter tool. State persists between iterations because tools own
 * the store; the agent's conversation history does not. Once the
 * counter reaches 3, the agent emits the completion phrase and the
 * loop exits.
 *
 * If Ralph works, you will see:
 *   - Multiple iterations (not one-shot)
 *   - The counter value visible to each iteration is what the previous
 *     iteration left behind (state persistence)
 *   - The loop exits cleanly on the completion signal, before
 *     maxIterations is hit
 *
 * Run: tsx scripts/test-ralph-live.ts
 */

import "../src/framework/env.js";
import {
  defineTool,
  defineAgent,
  ok,
  err,
  ToolRegistry,
  runRalph,
  createStore,
} from "../src/framework/index.js";
import { createGeminiAdapter } from "../src/framework/adapters/gemini.js";

// ── Scenario state — owned by the tool, persists across iterations ──────

const counter = createStore<number>("ralph_test_counter");

// Reset for a clean run.
counter.set("value", 0);

// ── Tools ───────────────────────────────────────────────────────────────

const getCounter = defineTool({
  name: "get_counter",
  description: "Read the current counter value.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const value = counter.get("value") ?? 0;
    return ok({ value });
  },
});

const incrementCounter = defineTool({
  name: "increment_counter",
  description: "Increment the counter by 1 and return the new value.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const current = counter.get("value") ?? 0;
    const next = current + 1;
    counter.set("value", next);
    return ok({ value: next });
  },
});

// ── Agent ───────────────────────────────────────────────────────────────

const incrementor = defineAgent({
  name: "ralph_test",
  role: "You are a careful Ralph-loop test agent. You speak in short imperative sentences.",
  goal:
    "Get a counter to value 3 by calling tools. The counter persists between " +
    "iterations of this loop, so on each iteration you should first read the " +
    "current value via get_counter, then call increment_counter exactly once " +
    "to add 1. After incrementing, if the new value is >= 3, you MUST output " +
    "exactly this completion phrase on a line by itself with nothing else: " +
    "<promise>RALPH_DONE</promise>",
});

// ── Run ─────────────────────────────────────────────────────────────────

const registry = new ToolRegistry();
registry.register(getCounter);
registry.register(incrementCounter);

const adapter = createGeminiAdapter();

console.log("\n╔══════════════════════════════════════════════════╗");
console.log("║  Ralph live e2e test — Gemini + counter store    ║");
console.log("╚══════════════════════════════════════════════════╝\n");
console.log(`  Provider: ${adapter.name}`);
console.log(`  Model:    ${adapter.model}`);
console.log(`  Initial counter value: ${counter.get("value")}`);
console.log(`  Goal:     reach value 3, then emit <promise>RALPH_DONE</promise>\n`);

const start = Date.now();
const result = await runRalph(
  incrementor,
  "Run one Ralph iteration: read the counter, increment it once, then report.",
  adapter,
  registry,
  {
    maxIterations: 6,
    completionPromise: "<promise>RALPH_DONE</promise>",
    onIteration: (i, r) => {
      const counterAfter = counter.get("value");
      console.log(
        `  iter ${i}: counter=${counterAfter}, rounds=${r.rounds}, tool calls=${r.toolCalls.length}`,
      );
      console.log(`           output: ${r.output.slice(0, 120).replace(/\n/g, " ")}`);
    },
  },
);
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log("\n──────────────────────────────────────────────────");
console.log(`  Completed:    ${result.completed}`);
console.log(`  Stop reason:  ${result.stopReason}`);
console.log(`  Iterations:   ${result.iterations}`);
console.log(`  Final value:  ${counter.get("value")}`);
console.log(`  Elapsed:      ${elapsed}s`);
console.log();

// ── Assertions ─────────────────────────────────────────────────────────

const failures: string[] = [];

if (!result.completed) {
  failures.push(`expected completed=true, got false (stopReason=${result.stopReason})`);
}
if (result.stopReason !== "completion_signal") {
  failures.push(`expected stopReason="completion_signal", got "${result.stopReason}"`);
}
if (result.iterations < 2) {
  failures.push(
    `expected >= 2 iterations to prove the loop actually loops, got ${result.iterations}`,
  );
}
if ((counter.get("value") ?? 0) < 3) {
  failures.push(
    `expected counter >= 3 (proves state persistence), got ${counter.get("value")}`,
  );
}

if (failures.length === 0) {
  console.log("  ✅ Live Ralph test passed — loop iterated, state persisted, signal stopped it cleanly.\n");
  process.exit(0);
} else {
  console.error("  ❌ Live Ralph test failed:");
  for (const f of failures) console.error(`     - ${f}`);
  console.error();
  process.exit(1);
}
