#!/usr/bin/env tsx
/**
 * OpenFunction — Parallel Tool Calls + Request-Param Conventions
 *
 * Pure adapter tests with a MOCKED fetch — no live API calls, no keys. Asserts
 * both directions of each adapter:
 *   - parse:   provider response → AdapterResponse (single vs. parallel)
 *   - rebuild: ChatMessage history → provider request body (fan-out shape,
 *              tool-result merging, Anthropic thinking-block preservation)
 *   - params:  max_tokens omitted/required, temperature only off-reasoning,
 *              parallel_tool_calls flags, reasoning/thinking payloads.
 *
 * Run: tsx test-client/run-parallel-tools-tests.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ToolRegistry } from "../src/framework/registry.js";
import { defineTool, ok } from "../src/framework/tool.js";
import { createOpenRouterAdapter } from "../src/framework/adapters/openai.js";
import { createAnthropicAdapter } from "../src/framework/adapters/anthropic.js";
import { createGeminiAdapter } from "../src/framework/adapters/gemini.js";
import type { ChatMessage } from "../src/framework/adapters/types.js";

// ── Mock fetch ─────────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;

/** Stub fetch to capture outgoing request bodies and return a canned payload. */
function mockFetch(responseBody: unknown): { bodies: any[] } {
  const captured: { bodies: any[] } = { bodies: [] };
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    captured.bodies.push(init?.body ? JSON.parse(init.body) : undefined);
    return {
      ok: true,
      status: 200,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    } as unknown as Response;
  }) as typeof fetch;
  return captured;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of ["read_file", "list_dir"]) {
    registry.register(
      defineTool({
        name,
        description: `test ${name}`,
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        handler: async () => ok({ ok: true }),
      }),
    );
  }
  return registry;
}

/** A history with a parallel assistant turn + its two tool results. */
function parallelHistory(): ChatMessage[] {
  return [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "t1", name: "read_file", args: { path: "a" } },
        { id: "t2", name: "list_dir", args: { path: "." } },
      ],
      thinkingBlocks: [{ type: "thinking", thinking: "plan", signature: "sig" }],
    },
    { role: "tool", content: JSON.stringify({ success: true }), toolCallId: "t1", toolName: "read_file" },
    { role: "tool", content: JSON.stringify({ success: true }), toolCallId: "t2", toolName: "list_dir" },
  ];
}

const TEXT_ONLY_OPENAI = { choices: [{ message: { content: "done" } }] };
const TEXT_ONLY_ANTHROPIC = { content: [{ type: "text", text: "done" }] };
const TEXT_ONLY_GEMINI = { candidates: [{ content: { parts: [{ text: "done" }] } }] };

// ═══════════════════════════════════════════════════════════════════════════
// OpenAI / OpenRouter (chat-completions)
// ═══════════════════════════════════════════════════════════════════════════

test("openai: parses two tool_calls into AdapterResponse.toolCalls", async () => {
  mockFetch({
    choices: [{ message: { content: null, tool_calls: [
      { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
      { id: "c2", type: "function", function: { name: "list_dir", arguments: '{"path":"."}' } },
    ] } }],
  });
  try {
    const res = await createOpenRouterAdapter({ apiKey: "test" }).chat([{ role: "user", content: "go" }], buildRegistry());
    assert.equal(res.toolCall, undefined, "fan-out must not use the single field");
    assert.equal(res.toolCalls?.length, 2);
    assert.deepEqual(res.toolCalls?.map((c) => c.name), ["read_file", "list_dir"]);
    assert.deepEqual(res.toolCalls?.[0].args, { path: "a" });
  } finally {
    restoreFetch();
  }
});

test("openai: a lone tool_call stays on the single toolCall field", async () => {
  mockFetch({
    choices: [{ message: { content: null, tool_calls: [
      { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
    ] } }],
  });
  try {
    const res = await createOpenRouterAdapter({ apiKey: "test" }).chat([{ role: "user", content: "go" }], buildRegistry());
    assert.equal(res.toolCalls, undefined);
    assert.equal(res.toolCall?.name, "read_file");
  } finally {
    restoreFetch();
  }
});

test("openai: rebuilds a parallel turn as one assistant msg with N tool_calls + N tool msgs", async () => {
  const cap = mockFetch(TEXT_ONLY_OPENAI);
  try {
    await createOpenRouterAdapter({ apiKey: "test" }).chat(parallelHistory(), buildRegistry());
    const msgs = cap.bodies[0].messages;
    const assistant = msgs.find((m: any) => m.role === "assistant");
    assert.equal(assistant.tool_calls.length, 2);
    assert.deepEqual(assistant.tool_calls.map((c: any) => c.function.name), ["read_file", "list_dir"]);
    assert.equal(msgs.filter((m: any) => m.role === "tool").length, 2);
  } finally {
    restoreFetch();
  }
});

test("openai: parallel_tool_calls on, no max_tokens, temperature only off-reasoning", async () => {
  // No reasoning effort → temperature present, no reasoning payload.
  let cap = mockFetch(TEXT_ONLY_OPENAI);
  try {
    await createOpenRouterAdapter({ apiKey: "test" }).chat([{ role: "user", content: "go" }], buildRegistry());
    assert.equal(cap.bodies[0].parallel_tool_calls, true);
    assert.equal("max_tokens" in cap.bodies[0], false, "max_tokens must be omitted");
    assert.equal(cap.bodies[0].temperature, 0.7);
    assert.equal("reasoning" in cap.bodies[0], false);
  } finally {
    restoreFetch();
  }
  // With reasoning effort → temperature dropped, reasoning payload present.
  cap = mockFetch(TEXT_ONLY_OPENAI);
  try {
    await createOpenRouterAdapter({ apiKey: "test", reasoningEffort: "high" }).chat([{ role: "user", content: "go" }], buildRegistry());
    assert.equal("temperature" in cap.bodies[0], false, "reasoning turns must omit temperature");
    assert.deepEqual(cap.bodies[0].reasoning, { effort: "high" });
  } finally {
    restoreFetch();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Anthropic
// ═══════════════════════════════════════════════════════════════════════════

test("anthropic: parses multiple tool_use blocks + preserves thinking", async () => {
  mockFetch({
    content: [
      { type: "thinking", thinking: "plan", signature: "sig" },
      { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
      { type: "tool_use", id: "t2", name: "list_dir", input: { path: "." } },
    ],
  });
  try {
    const res = await createAnthropicAdapter({ apiKey: "test", reasoningEffort: "high" }).chat([{ role: "user", content: "go" }], buildRegistry());
    assert.equal(res.toolCalls?.length, 2);
    assert.equal(res.thinking?.length, 1, "thinking blocks returned for replay");
  } finally {
    restoreFetch();
  }
});

test("anthropic: rebuild leads with thinking, merges tool_results into one user msg", async () => {
  const cap = mockFetch(TEXT_ONLY_ANTHROPIC);
  try {
    await createAnthropicAdapter({ apiKey: "test", reasoningEffort: "high" }).chat(parallelHistory(), buildRegistry());
    const msgs = cap.bodies[0].messages;
    const assistant = msgs.find((m: any) => m.role === "assistant");
    // thinking block must lead, then the two tool_use blocks.
    assert.equal(assistant.content[0].type, "thinking");
    assert.equal(assistant.content.filter((b: any) => b.type === "tool_use").length, 2);
    // Both tool_results MERGED into a single user message (consecutive 400s).
    const resultMsgs = msgs.filter(
      (m: any) => m.role === "user" && Array.isArray(m.content) && m.content.every((b: any) => b.type === "tool_result"),
    );
    assert.equal(resultMsgs.length, 1, "tool_results must be merged into one message");
    assert.equal(resultMsgs[0].content.length, 2);
  } finally {
    restoreFetch();
  }
});

test("anthropic: thinking on → budget + serialized; thinking off → parallel allowed, default max_tokens", async () => {
  // thinking on
  let cap = mockFetch(TEXT_ONLY_ANTHROPIC);
  try {
    await createAnthropicAdapter({ apiKey: "test", reasoningEffort: "high" }).chat([{ role: "user", content: "go" }], buildRegistry());
    const body = cap.bodies[0];
    assert.equal((body.thinking as any).type, "enabled");
    assert.ok(body.max_tokens > (body.thinking as any).budget_tokens, "max_tokens must exceed the thinking budget");
    assert.equal(body.tool_choice.disable_parallel_tool_use, true, "thinking disables parallel tool use");
  } finally {
    restoreFetch();
  }
  // thinking off
  cap = mockFetch(TEXT_ONLY_ANTHROPIC);
  try {
    await createAnthropicAdapter({ apiKey: "test" }).chat([{ role: "user", content: "go" }], buildRegistry());
    const body = cap.bodies[0];
    assert.equal("thinking" in body, false);
    assert.equal(body.max_tokens, 8192, "non-thinking default max_tokens");
    assert.equal("temperature" in body, false, "anthropic never sends temperature");
    assert.notEqual(body.tool_choice.disable_parallel_tool_use, true, "parallel allowed without thinking");
  } finally {
    restoreFetch();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Gemini
// ═══════════════════════════════════════════════════════════════════════════

test("gemini: parses multiple functionCall parts into toolCalls", async () => {
  mockFetch({
    candidates: [{ content: { parts: [
      { functionCall: { name: "read_file", args: { path: "a" } } },
      { functionCall: { name: "list_dir", args: { path: "." } } },
    ] } }],
  });
  try {
    const res = await createGeminiAdapter({ apiKey: "test" }).chat([{ role: "user", content: "go" }], buildRegistry());
    assert.equal(res.toolCalls?.length, 2);
    assert.deepEqual(res.toolCalls?.map((c) => c.name), ["read_file", "list_dir"]);
  } finally {
    restoreFetch();
  }
});

test("gemini: rebuilds tool calls as functionCall parts + merges functionResponses", async () => {
  const cap = mockFetch(TEXT_ONLY_GEMINI);
  try {
    await createGeminiAdapter({ apiKey: "test" }).chat(parallelHistory(), buildRegistry());
    const contents = cap.bodies[0].contents;
    const model = contents.find((c: any) => c.role === "model");
    // The assistant tool turn must be functionCall parts, NOT text (the bug fix).
    assert.equal(model.parts.length, 2);
    assert.ok(model.parts.every((p: any) => p.functionCall), "must reconstruct functionCall parts");
    // Two functionResponses merged into ONE function-role content.
    const fnContents = contents.filter((c: any) => c.role === "function");
    assert.equal(fnContents.length, 1, "functionResponses must be merged");
    assert.equal(fnContents[0].parts.length, 2);
  } finally {
    restoreFetch();
  }
});

test("gemini: omits maxOutputTokens so reasoning isn't truncated", async () => {
  const cap = mockFetch(TEXT_ONLY_GEMINI);
  try {
    await createGeminiAdapter({ apiKey: "test" }).chat([{ role: "user", content: "go" }], buildRegistry());
    assert.equal("maxOutputTokens" in cap.bodies[0].generationConfig, false);
  } finally {
    restoreFetch();
  }
});
