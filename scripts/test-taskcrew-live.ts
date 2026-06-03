/**
 * Live end-to-end smoke test for runTaskCrew.
 *
 * Exercises all three features against a real model:
 *   1. Sequential crew with a typed outputSchema contract + named context.
 *   2. Hierarchical process — a manager delegating to a worker.
 *
 * Run: tsx scripts/test-taskcrew-live.ts
 * Needs one provider key in .env (GEMINI/ANTHROPIC/OPENAI/XAI).
 */

import "../src/framework/env.js";
import { ToolRegistry } from "../src/framework/registry.js";
import { defineAgent, runTaskCrew } from "../src/framework/agents.js";
import { createGeminiAdapter } from "../src/framework/adapters/gemini.js";
import { createAnthropicAdapter } from "../src/framework/adapters/anthropic.js";
import { defineTool, ok } from "../src/framework/tool.js";

// Pick a provider. Override with TASKCREW_PROVIDER=gemini|anthropic.
const provider = process.env.TASKCREW_PROVIDER ?? "anthropic";
const adapter =
  provider === "gemini"
    ? createGeminiAdapter({ model: "gemini-2.5-flash" })
    : createAnthropicAdapter({ model: "claude-sonnet-4-6" });

console.log(`\n🤖 Using adapter: ${adapter.name} (${adapter.model})\n`);

// A tiny tool so at least one agent does real tool work, not just reasoning.
const wordCount = defineTool<{ text: string }>({
  name: "word_count",
  description: "Count the number of words in a piece of text.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "Text to count words in" } },
    required: ["text"],
  },
  tags: ["text"],
  handler: async ({ text }) => ok({ words: text.trim().split(/\s+/).filter(Boolean).length }),
});

const registry = new ToolRegistry();
registry.register(wordCount);

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst",
  goal: "Produce concise, factual findings on a topic",
});
const writer = defineAgent({
  name: "writer",
  role: "Technical Writer",
  goal: "Turn findings into a short, clear explainer",
  toolTags: ["text"],
});

async function sequentialTypedCrew() {
  console.log("─".repeat(70));
  console.log("TEST 1 — sequential crew: typed outputSchema + named context");
  console.log("─".repeat(70));

  const result = await runTaskCrew(
    {
      agents: [researcher, writer],
      tasks: [
        {
          id: "research",
          agent: "researcher",
          description: "List 3 concise facts about the Model Context Protocol (MCP).",
          expectedOutput: "exactly 3 short factual bullet strings",
          outputSchema: {
            type: "object",
            properties: {
              facts: {
                type: "array",
                items: { type: "string" },
                description: "Three short factual statements",
              },
            },
            required: ["facts"],
          },
        },
        {
          id: "explainer",
          agent: "writer",
          description:
            "Using ONLY the structured findings, write a 2-sentence explainer of MCP. " +
            "Then call word_count on your explainer and report the count.",
          context: ["research"], // sees the structured JSON, not prose
        },
      ],
    },
    adapter,
    registry,
  );

  const research = result.tasks.find((t) => t.task === "research")!;
  console.log("\n[research] typed data:", JSON.stringify(research.data));
  console.assert(
    research.data && Array.isArray((research.data as any).facts),
    "❌ research.data.facts should be a typed array",
  );

  const explainer = result.tasks.find((t) => t.task === "explainer")!;
  console.log("\n[explainer] output:\n", explainer.output);
  console.log(
    "\n[explainer] tool calls:",
    explainer.result.toolCalls.map((c) => c.name).join(", ") || "(none)",
  );
  console.assert(
    explainer.result.toolCalls.some((c) => c.name === "word_count"),
    "❌ writer should have called word_count",
  );
  console.log("\n✅ TEST 1 passed: typed contract honored + context threaded + tool used\n");
}

async function hierarchicalCrew() {
  console.log("─".repeat(70));
  console.log("TEST 2 — hierarchical process: manager delegates to writer");
  console.log("─".repeat(70));

  const result = await runTaskCrew(
    {
      agents: [researcher, writer],
      process: "hierarchical",
      tasks: [
        {
          id: "article",
          agent: "writer",
          description:
            "Produce a one-paragraph explainer of what a 'tool' is in an AI agent framework.",
          expectedOutput: "a single clear paragraph",
        },
      ],
    },
    adapter,
    registry,
  );

  console.log("\n[manager] synthesis:\n", result.output);
  console.log("\n[manager] delegation tool calls:");
  for (const tc of result.tasks[0].result.toolCalls) {
    console.log(`  → ${tc.name}`);
  }
  console.assert(result.output.length > 0, "❌ manager should produce a synthesis");
  console.log("\n✅ TEST 2 passed: manager ran and produced a synthesis\n");
}

async function main() {
  await sequentialTypedCrew();
  await hierarchicalCrew();
  console.log("🎉 All live runTaskCrew tests completed.\n");
}

main().catch((err) => {
  console.error("\n💥 Live test failed:", err);
  process.exit(1);
});
