#!/usr/bin/env tsx
/**
 * OpenFunction — Framework Internals Test Runner
 *
 * Tests pure framework modules (store, validate, registry, tool) using
 * Node's built-in test runner. Zero new dependencies — just node:test
 * and node:assert/strict.
 *
 * Run: tsx test-client/run-framework-tests.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createStore } from "../src/framework/store.js";
import { defineTool, ok, err } from "../src/framework/tool.js";
import { ToolRegistry } from "../src/framework/registry.js";
import {
  validateParams,
  formatValidationErrors,
} from "../src/framework/validate.js";
import type { InputSchema } from "../src/framework/types.js";

// ── Resolve .data dir for cleanup ─────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, "..", ".data");

/** Make a unique store name for a single test, with deterministic cleanup. */
let storeCounter = 0;
function uniqueStoreName(): string {
  storeCounter += 1;
  return `__test_store_${Date.now()}_${process.pid}_${storeCounter}`;
}

function removeStoreFile(name: string): void {
  const file = join(DATA_DIR, `${name}.json`);
  if (existsSync(file)) {
    rmSync(file, { force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// store.ts
// ─────────────────────────────────────────────────────────────────────────

test("store: get returns undefined for missing key", () => {
  const name = uniqueStoreName();
  try {
    const s = createStore<{ v: number }>(name);
    assert.equal(s.get("missing"), undefined);
    assert.equal(s.size, 0);
  } finally {
    removeStoreFile(name);
  }
});

test("store: set + get round-trips a value and persists across createStore calls", () => {
  const name = uniqueStoreName();
  try {
    const s1 = createStore<{ v: number }>(name);
    s1.set("a", { v: 1 });
    assert.deepEqual(s1.get("a"), { v: 1 });

    // Reload from disk — should still be there
    const s2 = createStore<{ v: number }>(name);
    assert.deepEqual(s2.get("a"), { v: 1 });
  } finally {
    removeStoreFile(name);
  }
});

test("store: delete removes the key and returns existed-flag", () => {
  const name = uniqueStoreName();
  try {
    const s = createStore<string>(name);
    s.set("k", "v");
    assert.equal(s.delete("k"), true);
    assert.equal(s.get("k"), undefined);
    assert.equal(s.delete("k"), false);
  } finally {
    removeStoreFile(name);
  }
});

test("store: getAll and entries return all items", () => {
  const name = uniqueStoreName();
  try {
    const s = createStore<{ n: number }>(name);
    s.set("a", { n: 1 });
    s.set("b", { n: 2 });
    s.set("c", { n: 3 });

    const all = s.getAll().sort((x, y) => x.n - y.n);
    assert.deepEqual(all, [{ n: 1 }, { n: 2 }, { n: 3 }]);

    const entries = s.entries().sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(entries, [
      ["a", { n: 1 }],
      ["b", { n: 2 }],
      ["c", { n: 3 }],
    ]);
  } finally {
    removeStoreFile(name);
  }
});

test("store: has and size reflect current state", () => {
  const name = uniqueStoreName();
  try {
    const s = createStore<number>(name);
    assert.equal(s.has("x"), false);
    assert.equal(s.size, 0);

    s.set("x", 1);
    s.set("y", 2);
    assert.equal(s.has("x"), true);
    assert.equal(s.has("y"), true);
    assert.equal(s.has("z"), false);
    assert.equal(s.size, 2);

    s.delete("x");
    assert.equal(s.has("x"), false);
    assert.equal(s.size, 1);
  } finally {
    removeStoreFile(name);
  }
});

test("store: clear removes everything", () => {
  const name = uniqueStoreName();
  try {
    const s = createStore<number>(name);
    s.set("a", 1);
    s.set("b", 2);
    s.clear();
    assert.equal(s.size, 0);
    assert.deepEqual(s.getAll(), []);
  } finally {
    removeStoreFile(name);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// validate.ts
// ─────────────────────────────────────────────────────────────────────────

test("validate: passes when params match the schema", () => {
  const schema: InputSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "integer" },
    },
    required: ["name"],
  };
  const errs = validateParams({ name: "Alice", age: 30 }, schema);
  assert.deepEqual(errs, []);
});

test("validate: reports missing required fields", () => {
  const schema: InputSchema = {
    type: "object",
    properties: { name: { type: "string", description: "Your name" } },
    required: ["name"],
  };
  const errs = validateParams({}, schema);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].field, "name");
  assert.match(errs[0].message, /Required parameter "name" is missing/);
  assert.match(errs[0].message, /Your name/); // includes description hint
});

test("validate: reports type mismatch", () => {
  const schema: InputSchema = {
    type: "object",
    properties: { count: { type: "number" } },
  };
  const errs = validateParams({ count: "not a number" }, schema);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].field, "count");
  assert.match(errs[0].message, /must be number/);
});

test("validate: reports invalid enum value", () => {
  const schema: InputSchema = {
    type: "object",
    properties: {
      color: { type: "string", enum: ["red", "green", "blue"] },
    },
  };
  const errs = validateParams({ color: "purple" }, schema);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /must be one of: red, green, blue/);
});

test("validate: integer accepts whole numbers but rejects floats", () => {
  const schema: InputSchema = {
    type: "object",
    properties: { n: { type: "integer" } },
  };
  assert.deepEqual(validateParams({ n: 3 }, schema), []);
  const bad = validateParams({ n: 3.5 }, schema);
  assert.equal(bad.length, 1);
  assert.match(bad[0].message, /must be an integer/);
});

test("validate: ignores extra (non-schema) params", () => {
  const schema: InputSchema = {
    type: "object",
    properties: { a: { type: "string" } },
  };
  const errs = validateParams({ a: "hi", extra: 123 }, schema);
  assert.deepEqual(errs, []);
});

test("validate: validates array item types", () => {
  const schema: InputSchema = {
    type: "object",
    properties: {
      tags: { type: "array", items: { type: "string" } },
    },
  };
  assert.deepEqual(validateParams({ tags: ["a", "b"] }, schema), []);
  const bad = validateParams({ tags: ["a", 2] }, schema);
  assert.equal(bad.length, 1);
  assert.match(bad[0].field, /tags\[1\]/);
});

test("formatValidationErrors: produces a readable multi-line string", () => {
  const out = formatValidationErrors("my_tool", [
    { field: "x", message: "x bad" },
    { field: "y", message: "y bad" },
  ]);
  assert.match(out, /Parameter validation failed for "my_tool"/);
  assert.match(out, /- x bad/);
  assert.match(out, /- y bad/);
});

// ─────────────────────────────────────────────────────────────────────────
// tool.ts — defineTool, ok, err
// ─────────────────────────────────────────────────────────────────────────

test("ok: wraps data with success=true", () => {
  const r = ok({ a: 1 });
  assert.equal(r.success, true);
  assert.deepEqual(r.data, { a: 1 });
  assert.equal(r.message, undefined);
});

test("ok: includes optional message", () => {
  const r = ok({ a: 1 }, "all good");
  assert.equal(r.message, "all good");
});

test("err: wraps an error string with success=false", () => {
  const r = err("nope");
  assert.equal(r.success, false);
  assert.equal(r.error, "nope");
});

test("defineTool: returns the definition unchanged when valid", () => {
  const def = defineTool({
    name: "valid_tool",
    description: "A perfectly valid tool",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ok({ ran: true }),
  });
  assert.equal(def.name, "valid_tool");
  assert.equal(typeof def.handler, "function");
});

test("defineTool: rejects non-snake_case names", () => {
  assert.throws(
    () =>
      defineTool({
        name: "BadName",
        description: "valid description",
        inputSchema: { type: "object", properties: {} },
        handler: async () => ok({}),
      }),
    /must be snake_case/,
  );

  assert.throws(
    () =>
      defineTool({
        name: "1starts_with_digit",
        description: "valid description",
        inputSchema: { type: "object", properties: {} },
        handler: async () => ok({}),
      }),
    /must be snake_case/,
  );

  assert.throws(
    () =>
      defineTool({
        name: "has-dashes",
        description: "valid description",
        inputSchema: { type: "object", properties: {} },
        handler: async () => ok({}),
      }),
    /must be snake_case/,
  );
});

test("defineTool: rejects too-short descriptions", () => {
  assert.throws(
    () =>
      defineTool({
        name: "short_desc",
        description: "hi",
        inputSchema: { type: "object", properties: {} },
        handler: async () => ok({}),
      }),
    /at least 5 characters/,
  );
});

test("defineTool: rejects missing inputSchema.properties", () => {
  assert.throws(
    () =>
      defineTool({
        name: "no_props",
        description: "valid description",
        // @ts-expect-error — intentionally malformed for the test
        inputSchema: { type: "object" },
        handler: async () => ok({}),
      }),
    /needs an inputSchema with properties/,
  );
});

test("defineTool: rejects non-function handler", () => {
  assert.throws(
    () =>
      defineTool({
        name: "no_handler",
        description: "valid description",
        inputSchema: { type: "object", properties: {} },
        // @ts-expect-error — intentionally malformed for the test
        handler: "not a function",
      }),
    /needs a handler function/,
  );
});

// ─────────────────────────────────────────────────────────────────────────
// registry.ts
// ─────────────────────────────────────────────────────────────────────────

function makeTool(name: string, handlerImpl?: () => Promise<unknown>) {
  return defineTool({
    name,
    description: `Test tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    handler: handlerImpl
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (async () => (await handlerImpl()) as any)
      : async () => ok({ name }),
  });
}

test("registry: register adds a tool retrievable via get and listNames", () => {
  const r = new ToolRegistry();
  r.register(makeTool("alpha"));
  assert.ok(r.get("alpha"));
  assert.deepEqual(r.listNames(), ["alpha"]);
});

test("registry: registerAll adds many tools", () => {
  const r = new ToolRegistry();
  r.registerAll([makeTool("a"), makeTool("b"), makeTool("c")]);
  assert.equal(r.getAll().length, 3);
  assert.deepEqual(r.listNames().sort(), ["a", "b", "c"]);
});

test("registry: duplicate registration warns but overwrites", () => {
  const r = new ToolRegistry();
  // Suppress the expected console.warn during this test
  const originalWarn = console.warn;
  let warnings = 0;
  console.warn = () => {
    warnings += 1;
  };
  try {
    r.register(makeTool("dup"));
    r.register(makeTool("dup"));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings, 1);
  assert.equal(r.getAll().length, 1);
});

test("registry: get returns undefined for unknown tool", () => {
  const r = new ToolRegistry();
  assert.equal(r.get("nope"), undefined);
});

test("registry: getByTag filters by tag", () => {
  const r = new ToolRegistry();
  r.register({
    ...makeTool("tagged"),
    tags: ["math"],
  });
  r.register({
    ...makeTool("untagged"),
  });
  r.register({
    ...makeTool("also_math"),
    tags: ["math", "extra"],
  });
  const math = r.getByTag("math").map((t) => t.name).sort();
  assert.deepEqual(math, ["also_math", "tagged"]);
  assert.deepEqual(r.getByTag("nonexistent"), []);
});

test("registry: execute calls the handler and returns its result", async () => {
  const r = new ToolRegistry();
  r.register(
    defineTool<{ x: number }, { doubled: number }>({
      name: "doubler",
      description: "Doubles a number",
      inputSchema: {
        type: "object",
        properties: { x: { type: "number" } },
        required: ["x"],
      },
      handler: async ({ x }) => ok({ doubled: x * 2 }),
    }),
  );

  // Silence the registry's success log
  const originalLog = console.log;
  console.log = () => {};
  try {
    const result = await r.execute("doubler", { x: 21 });
    assert.equal(result.success, true);
    assert.deepEqual(result.data, { doubled: 42 });
  } finally {
    console.log = originalLog;
  }
});

test("registry: execute returns error for unknown tool", async () => {
  const r = new ToolRegistry();
  const result = await r.execute("does_not_exist", {});
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Unknown tool/);
});

test("registry: execute returns validation errors instead of calling handler", async () => {
  const r = new ToolRegistry();
  let called = false;
  r.register(
    defineTool({
      name: "needs_name",
      description: "Requires a name parameter",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      handler: async () => {
        called = true;
        return ok({});
      },
    }),
  );

  // Silence the registry's validation log
  const originalErr = console.error;
  console.error = () => {};
  try {
    const result = await r.execute("needs_name", {});
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /Required parameter "name" is missing/);
    assert.equal(called, false);
  } finally {
    console.error = originalErr;
  }
});

test("registry: execute catches handler exceptions and returns success=false", async () => {
  const r = new ToolRegistry();
  r.register(
    defineTool({
      name: "thrower",
      description: "Always throws",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        throw new Error("boom");
      },
    }),
  );
  // Silence the registry's failure log
  const originalErr = console.error;
  console.error = () => {};
  try {
    const result = await r.execute("thrower", {});
    assert.equal(result.success, false);
    assert.equal(result.error, "boom");
  } finally {
    console.error = originalErr;
  }
});

test("registry: toAnthropicFormat / toGeminiFormat / toOpenAIFormat shape tools correctly", () => {
  const r = new ToolRegistry();
  r.register(
    defineTool({
      name: "shaped",
      description: "Tool with a shaped input",
      inputSchema: {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
      },
      handler: async () => ok({}),
    }),
  );

  const anth = r.toAnthropicFormat();
  assert.equal(anth.length, 1);
  assert.equal(anth[0].name, "shaped");
  assert.equal(anth[0].input_schema.type, "object");

  const gem = r.toGeminiFormat();
  assert.equal(gem[0].name, "shaped");
  assert.equal(gem[0].parameters.type, "object");
  assert.deepEqual(gem[0].parameters.required, ["a"]);

  const oai = r.toOpenAIFormat();
  assert.equal(oai[0].type, "function");
  assert.equal(oai[0].function.name, "shaped");
});

test("validate: integer enum accepts the value (number-typed enums)", () => {
  const errs = validateParams(
    { difficulty: 2 },
    {
      type: "object",
      properties: {
        difficulty: { type: "integer", enum: [1, 2, 3] },
      },
      required: ["difficulty"],
    } as InputSchema,
  );
  assert.deepEqual(errs, []);
});

test("validate: integer enum rejects out-of-set values", () => {
  const errs = validateParams(
    { difficulty: 5 },
    {
      type: "object",
      properties: {
        difficulty: { type: "integer", enum: [1, 2, 3] },
      },
      required: ["difficulty"],
    } as InputSchema,
  );
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /must be one of/);
});

test("registry: register with overwrite:false keeps the existing tool", () => {
  const r = new ToolRegistry();
  const userTool = defineTool({
    name: "shared_name",
    description: "user-defined behavior",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ok({ owner: "user" }),
  });
  const frameworkTool = defineTool({
    name: "shared_name",
    description: "framework-defined behavior",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ok({ owner: "framework" }),
  });

  r.register(userTool);
  r.register(frameworkTool, { overwrite: false });

  // The user's tool must still win — handler should return owner: "user"
  const got = r.get("shared_name")!;
  const result = got.handler({}) as Promise<any>;
  return result.then((res) => {
    assert.equal(res.success, true);
    assert.equal(res.data.owner, "user");
  });
});

test("registry: unregister removes the tool and returns existed-flag", () => {
  const r = new ToolRegistry();
  const t = defineTool({
    name: "removable",
    description: "a tool that gets removed",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ok({ ran: true }),
  });
  r.register(t);
  assert.equal(r.get("removable")?.name, "removable");

  assert.equal(r.unregister("removable"), true);
  assert.equal(r.get("removable"), undefined);
  assert.equal(r.unregister("removable"), false);
  assert.equal(r.unregister("never_registered"), false);
});

// ─────────────────────────────────────────────────────────────────────────
// agents.ts — Ralph loop
// ─────────────────────────────────────────────────────────────────────────

import { defineAgent, runRalph, runCrew } from "../src/framework/agents.js";
import type { AIAdapter, AdapterResponse } from "../src/framework/adapters/types.js";

/**
 * Like mockAdapter (defined later in this file), but defined here so the
 * Ralph tests can use it without forward-reference. Returns scripted
 * AdapterResponses one per call; throws if the script runs out.
 */
function scriptedAdapter(
  responses: Array<AdapterResponse | Error>,
  opts: { name?: string; model?: string } = {},
): AIAdapter {
  let i = 0;
  return {
    name: opts.name ?? "ralph-mock",
    model: opts.model ?? "test-model",
    async chat() {
      const next = responses[i++];
      if (next === undefined) {
        throw new Error(
          `scripted adapter: no more responses (call ${i}); ralph likely overran`,
        );
      }
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const noopAgent = defineAgent({
  name: "ralph_test_agent",
  role: "iterator",
  goal: "complete the task",
});

test("runRalph: stops on completionPromise match", async () => {
  // Iteration 1 + 2 are progress reports; iteration 3 contains the marker.
  const adapter = scriptedAdapter([
    { text: "iteration 1: working on it..." },
    { text: "iteration 2: still progressing..." },
    { text: "all done — <promise>RALPH_DONE</promise>" },
  ]);

  const result = await runRalph(
    noopAgent,
    "do the thing",
    adapter,
    new ToolRegistry(),
    { maxIterations: 5, completionPromise: "<promise>RALPH_DONE</promise>" },
  );

  assert.equal(result.completed, true);
  assert.equal(result.stopReason, "completion_signal");
  assert.equal(result.iterations, 3);
  assert.equal(result.history.length, 3);
  assert.match(result.lastResult.output, /RALPH_DONE/);
});

test("runRalph: hits maxIterations without completing", async () => {
  const adapter = scriptedAdapter([
    { text: "still working" },
    { text: "still working" },
    { text: "still working" },
  ]);

  const result = await runRalph(
    noopAgent,
    "do the thing",
    adapter,
    new ToolRegistry(),
    { maxIterations: 3, completionPromise: "DONE" },
  );

  assert.equal(result.completed, false);
  assert.equal(result.stopReason, "max_iterations");
  assert.equal(result.iterations, 3);
});

test("runRalph: completionCheck callback short-circuits the loop", async () => {
  const adapter = scriptedAdapter([
    { text: "first" },
    { text: "second" },
    { text: "third" },
  ]);

  const result = await runRalph(
    noopAgent,
    "do the thing",
    adapter,
    new ToolRegistry(),
    {
      maxIterations: 5,
      // Stop after the second iteration via custom predicate.
      completionCheck: (_r, iteration) => iteration === 2,
    },
  );

  assert.equal(result.completed, true);
  assert.equal(result.stopReason, "completion_check");
  assert.equal(result.iterations, 2);
});

test("runRalph: onIteration receives each result with 1-indexed iteration", async () => {
  const adapter = scriptedAdapter([
    { text: "a" },
    { text: "b — DONE" },
  ]);

  const seen: Array<{ iteration: number; output: string }> = [];
  await runRalph(
    noopAgent,
    "task",
    adapter,
    new ToolRegistry(),
    {
      maxIterations: 5,
      completionPromise: "DONE",
      onIteration: (iteration, result) => {
        seen.push({ iteration, output: result.output });
      },
    },
  );

  assert.deepEqual(seen, [
    { iteration: 1, output: "a" },
    { iteration: 2, output: "b — DONE" },
  ]);
});

test("runRalph: throws on invalid maxIterations", async () => {
  const adapter = scriptedAdapter([{ text: "x" }]);
  await assert.rejects(
    runRalph(noopAgent, "x", adapter, new ToolRegistry(), {
      maxIterations: 0,
    }),
    /maxIterations must be > 0/,
  );
});

test("runRalph: prepends iteration context unless disabled", async () => {
  const taskSeen: string[] = [];
  // Custom adapter that records the user message it received.
  const recordingAdapter: AIAdapter = {
    name: "recorder",
    model: "test",
    async chat(messages) {
      const userMsg = messages.find((m) => m.role === "user");
      if (userMsg) taskSeen.push(userMsg.content);
      return { text: "DONE" };
    },
  };

  await runRalph(noopAgent, "build it", recordingAdapter, new ToolRegistry(), {
    maxIterations: 1,
    completionPromise: "DONE",
  });
  assert.match(taskSeen[0], /\[Ralph iteration 1 of 1\]/);
  assert.match(taskSeen[0], /build it/);

  // includeIterationContext: false → identical prompt every time.
  taskSeen.length = 0;
  await runRalph(noopAgent, "build it", recordingAdapter, new ToolRegistry(), {
    maxIterations: 1,
    completionPromise: "DONE",
    includeIterationContext: false,
  });
  assert.equal(taskSeen[0], "build it");
});

test("runCrew: ralph mode loops sequential crew until completion", async () => {
  // Two-agent crew (research → write). Each iteration fires both agents.
  // Iteration 1: writer says "draft 1"; iteration 2: writer signals DONE.
  const adapter = scriptedAdapter([
    { text: "research findings 1" }, // iteration 1, agent 1
    { text: "draft 1, not done yet" }, // iteration 1, agent 2 (last → checked)
    { text: "research findings 2" }, // iteration 2, agent 1
    { text: "final answer — RALPH_DONE" }, // iteration 2, agent 2 → triggers stop
  ]);

  const researcher = defineAgent({
    name: "researcher",
    role: "Researcher",
    goal: "find facts",
  });
  const writer = defineAgent({
    name: "writer",
    role: "Writer",
    goal: "produce final output",
  });

  const result = await runCrew(
    {
      agents: [researcher, writer],
      mode: "ralph",
      ralph: { maxIterations: 5, completionPromise: "RALPH_DONE" },
    },
    "Write a one-line answer",
    adapter,
    new ToolRegistry(),
  );

  assert.ok(result.ralph, "ralph summary present");
  assert.equal(result.ralph!.completed, true);
  assert.equal(result.ralph!.stopReason, "completion_signal");
  assert.equal(result.ralph!.iterations, 2);
  assert.equal(result.ralph!.history.length, 2);
  // Each iteration should record both agents.
  assert.equal(result.ralph!.history[0].agentResults.length, 2);
  assert.match(result.output, /RALPH_DONE/);
});

test("runCrew: ralph mode requires options.ralph", async () => {
  const adapter = scriptedAdapter([{ text: "x" }]);
  await assert.rejects(
    runCrew(
      { agents: [noopAgent], mode: "ralph" },
      "task",
      adapter,
      new ToolRegistry(),
    ),
    /requires options\.ralph/,
  );
});

// ─────────────────────────────────────────────────────────────────────────
// memory.ts — fact memory ID generation
// ─────────────────────────────────────────────────────────────────────────

import { createFactMemory } from "../src/framework/memory.js";

test("fact memory: storing after deletes does not collide with existing IDs", () => {
  const name = uniqueStoreName();
  try {
    const facts = createFactMemory(createStore(name));
    const a = facts.storeFact("first");
    const b = facts.storeFact("second");
    const c = facts.storeFact("third");

    // Delete the middle fact — old size+1 counter would have re-issued id "3"
    // and silently overwritten c on the next storeFact.
    facts.deleteFact(b.id);
    const d = facts.storeFact("fourth");

    const ids = new Set([a.id, b.id, c.id, d.id]);
    assert.equal(ids.size, 4, "all four facts should have distinct IDs");

    // c must still be retrievable; old bug would have overwritten it
    const all = facts.getAllFacts();
    assert.ok(
      all.some((f) => f.id === c.id && f.content === "third"),
      "third fact should not be overwritten by the post-delete store",
    );
  } finally {
    removeStoreFile(name);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// workflows.ts — parallelSettled
// ─────────────────────────────────────────────────────────────────────────

import { pipe } from "../src/framework/workflows.js";

test("workflow parallel: throws on first rejection (loses partial results)", async () => {
  const wf = pipe(async (n: number) => n).parallel(
    async (n) => n * 2,
    async () => {
      throw new Error("boom");
    },
    async (n) => n + 100,
  );
  await assert.rejects(wf.run(5), /boom/);
});

test("workflow parallelSettled: collects all outcomes without throwing", async () => {
  const wf = pipe(async (n: number) => n).parallelSettled(
    async (n) => n * 2,
    async () => {
      throw new Error("middle blew up");
    },
    async (n) => n + 100,
  );

  const results = await wf.run(5);
  assert.equal(results.length, 3);
  assert.deepEqual(results[0], { ok: true, value: 10 });
  assert.equal(results[1].ok, false);
  if (!results[1].ok) {
    assert.match(results[1].error.message, /middle blew up/);
  }
  assert.deepEqual(results[2], { ok: true, value: 105 });
});

// ─────────────────────────────────────────────────────────────────────────
// adapters/openai.ts + adapters/xai.ts — Responses API session continuity
// ─────────────────────────────────────────────────────────────────────────

import { createOpenAIAdapter } from "../src/framework/adapters/openai.js";
import { createXAIAdapter } from "../src/framework/adapters/xai.js";

/** Replace global.fetch with a recorder that returns scripted JSON. */
function withFetchMock(
  responses: Array<Record<string, unknown>>,
  fn: (calls: Array<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const calls: Array<Record<string, unknown>> = [];
  const original = global.fetch;
  let i = 0;
  // @ts-expect-error — narrowed mock signature
  global.fetch = async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body));
    const next = responses[i++] ?? responses[responses.length - 1];
    return {
      ok: true,
      status: 200,
      async json() {
        return next;
      },
      async text() {
        return JSON.stringify(next);
      },
    } as Response;
  };
  return fn(calls).finally(() => {
    global.fetch = original;
  });
}

const RESPONSES_OK = {
  id: "resp_abc123",
  output: [
    { type: "message", content: [{ type: "output_text", text: "ok" }] },
  ],
};

test("openai Responses adapter: keeps previous_response_id on user follow-up", async () => {
  await withFetchMock([RESPONSES_OK, RESPONSES_OK], async (calls) => {
    const adapter = createOpenAIAdapter({ apiKey: "test-key" });
    const registry = new ToolRegistry();

    await adapter.chat([{ role: "user", content: "first" }], registry);
    await adapter.chat(
      [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ],
      registry,
    );

    assert.equal(calls.length, 2);
    assert.equal(
      calls[0].previous_response_id,
      undefined,
      "first call has no previous_response_id",
    );
    assert.equal(
      calls[1].previous_response_id,
      "resp_abc123",
      "follow-up call must include previous_response_id so OpenAI threads context",
    );
  });
});

test("openai Responses adapter: resetSession clears state then writes fresh", async () => {
  // First call → caches "session_a"
  // Second call (resetSession) → must NOT use session_a; new id "session_b"
  //   gets written for subsequent calls
  // Third call → must thread on top of session_b, not session_a
  await withFetchMock(
    [
      { ...RESPONSES_OK, id: "session_a" },
      { ...RESPONSES_OK, id: "session_b" },
      { ...RESPONSES_OK, id: "session_c" },
    ],
    async (calls) => {
      const adapter = createOpenAIAdapter({ apiKey: "test-key" });
      const registry = new ToolRegistry();

      await adapter.chat([{ role: "user", content: "first" }], registry);
      await adapter.chat(
        [{ role: "user", content: "fresh start" }],
        registry,
        { resetSession: true },
      );
      await adapter.chat(
        [
          { role: "user", content: "fresh start" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "follow up" },
        ],
        registry,
      );

      assert.equal(calls[0].previous_response_id, undefined);
      assert.equal(
        calls[1].previous_response_id,
        undefined,
        "resetSession must wipe the cached id before this call",
      );
      assert.equal(
        calls[2].previous_response_id,
        "session_b",
        "subsequent calls must thread on top of the post-reset id",
      );
    },
  );
});

test("openai Responses adapter: oneShot calls do not pollute session state", async () => {
  // First call → returns id "session_1"
  // Second call (oneShot) → returns id "extraction_77"; must NOT update state
  // Third call → must still thread on top of "session_1", not "extraction_77"
  await withFetchMock(
    [
      { ...RESPONSES_OK, id: "session_1" },
      { ...RESPONSES_OK, id: "extraction_77" },
      { ...RESPONSES_OK, id: "session_2" },
    ],
    async (calls) => {
      const adapter = createOpenAIAdapter({ apiKey: "test-key" });
      const registry = new ToolRegistry();

      await adapter.chat([{ role: "user", content: "first" }], registry);
      await adapter.chat(
        [{ role: "user", content: "extract this" }],
        registry,
        { oneShot: true },
      );
      await adapter.chat(
        [
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "third" },
        ],
        registry,
      );

      assert.equal(calls.length, 3);
      assert.equal(calls[0].previous_response_id, undefined);
      // oneShot must not read the cached id from the previous turn
      assert.equal(
        calls[1].previous_response_id,
        undefined,
        "oneShot call must not include previous_response_id",
      );
      // ...and must not have overwritten the cached id either
      assert.equal(
        calls[2].previous_response_id,
        "session_1",
        "third call must thread onto session_1, not the oneShot id",
      );
    },
  );
});

test("xai Responses adapter: keeps previous_response_id on user follow-up", async () => {
  await withFetchMock([RESPONSES_OK, RESPONSES_OK], async (calls) => {
    const adapter = createXAIAdapter({ apiKey: "test-key" });
    const registry = new ToolRegistry();

    await adapter.chat([{ role: "user", content: "first" }], registry);
    await adapter.chat(
      [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ],
      registry,
    );

    assert.equal(calls[1].previous_response_id, "resp_abc123");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// chat-agent.ts — uses adapter injection (config.adapter) for unit testing
// ─────────────────────────────────────────────────────────────────────────

import { createChatAgent } from "../src/framework/chat-agent.js";
// AIAdapter / AdapterResponse already imported earlier in the Ralph section.

/** Build a mock adapter from a sequence of scripted responses. */
function mockAdapter(
  responses: Array<AdapterResponse | Error>,
  opts: { name?: string; model?: string } = {},
): AIAdapter {
  let i = 0;
  return {
    name: opts.name ?? "mock",
    model: opts.model ?? "test-model",
    async chat() {
      const next = responses[i++];
      if (next === undefined) {
        throw new Error(`mock adapter: no more scripted responses (call ${i})`);
      }
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test("chat-agent: adapter injection bypasses provider resolution", async () => {
  const adapter = mockAdapter([{ text: "hello back" }]);
  const agent = await createChatAgent({ adapter, memory: false });
  assert.equal(agent.provider, "mock");
  assert.equal(agent.model, "test-model");
  const result = await agent.chat("hi");
  assert.equal(result.text, "hello back");
});

test("chat-agent: adapter error rolls back history (no orphan user turn)", async () => {
  const adapter = mockAdapter([new Error("simulated 429")]);
  const agent = await createChatAgent({ adapter, memory: false });

  await assert.rejects(agent.chat("hi"), /simulated 429/);

  // History must be empty after a failed turn, otherwise the next call
  // would push a second consecutive user message and providers would 400.
  assert.equal(
    agent.getHistory().length,
    0,
    "history should be empty after failed turn",
  );
});

test("chat-agent: agent recovers cleanly after an adapter error", async () => {
  const adapter = mockAdapter([
    new Error("transient blip"),
    { text: "second-call-ok" },
  ]);
  const agent = await createChatAgent({ adapter, memory: false });

  await assert.rejects(agent.chat("first"), /transient blip/);
  const result = await agent.chat("second");
  assert.equal(result.text, "second-call-ok");

  // History should contain exactly: user("second") + assistant("second-call-ok")
  const hist = agent.getHistory();
  assert.equal(hist.length, 2);
  assert.equal(hist[0].role, "user");
  assert.equal(hist[0].content, "second");
  assert.equal(hist[1].role, "assistant");
});

test("chat-agent: streaming yields preamble text alongside tool calls", async () => {
  // Mock adapter that returns preamble text + tool call in one round,
  // then a final response on round 2 after the tool result.
  const calculator = defineTool({
    name: "calc_double",
    description: "doubles a number",
    inputSchema: {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    },
    handler: async ({ n }) => ok({ doubled: (n as number) * 2 }),
  });

  const adapter = mockAdapter([
    {
      text: "Let me calculate that for you.",
      toolCall: { id: "tc_1", name: "calc_double", args: { n: 21 } },
    },
    { text: "The answer is 42." },
  ]);

  const agent = await createChatAgent({
    adapter,
    tools: [calculator],
    memory: false,
  });

  const events: Array<{ type: string; text?: string }> = [];
  for await (const chunk of agent.chat("double 21", { stream: true })) {
    if (chunk.type === "text" || chunk.type === "tool_call") {
      events.push({ type: chunk.type, text: chunk.text });
    }
  }

  // Expect: preamble text, then tool_call, then final text
  assert.equal(events[0].type, "text");
  assert.equal(events[0].text, "Let me calculate that for you.");
  assert.equal(events[1].type, "tool_call");
  // events[2] would be tool_result (filtered out above)
  // Find the final text (last text event)
  const finalText = events.filter((e) => e.type === "text").pop();
  assert.equal(finalText?.text, "The answer is 42.");

  // History must NOT contain the preamble — providers reject
  // assistant text + tool result on the next message.
  const hist = agent.getHistory();
  const preambleInHistory = hist.some(
    (m) => m.role === "assistant" && m.content === "Let me calculate that for you.",
  );
  assert.equal(preambleInHistory, false, "preamble must not be persisted to history");
});

test("chat-agent: streaming adapter error rolls back history", async () => {
  const adapter = mockAdapter([new Error("stream blip")]);
  const agent = await createChatAgent({ adapter, memory: false });

  await assert.rejects(async () => {
    for await (const _ of agent.chat("hi", { stream: true })) {
      // drain
    }
  }, /stream blip/);

  assert.equal(agent.getHistory().length, 0);
});

test("chat-agent: empty model response surfaces a meaningful placeholder", async () => {
  // Model returns neither toolCall nor text — old code returned text:""
  // silently; new code returns "(empty response from model)".
  const adapter = mockAdapter([{}]);
  const agent = await createChatAgent({ adapter, memory: false });

  const result = await agent.chat("hi");
  assert.equal(result.text, "(empty response from model)");
});

test("chat-agent: listThreads + deleteThread round-trip persisted threads", async () => {
  const conversationStore = createStore<any>(uniqueStoreName());
  const factStore = createStore<any>(uniqueStoreName());
  const adapter = mockAdapter([{ text: "ok" }, { text: "ok" }]);
  const agent = await createChatAgent({
    adapter,
    memory: { conversationStore, factStore, threadId: "alpha" },
  });

  await agent.chat("hi", { threadId: "alpha" });
  await agent.chat("hi", { threadId: "beta" });

  const threads = agent.listThreads().sort();
  assert.deepEqual(threads, ["alpha", "beta"]);

  // Delete a non-active thread
  assert.equal(agent.deleteThread("alpha"), true);
  assert.deepEqual(agent.listThreads(), ["beta"]);

  // Delete the active thread — agent should rotate to a fresh thread
  const activeBefore = "beta";
  assert.equal(agent.deleteThread(activeBefore), true);
  assert.equal(agent.getHistory().length, 0);
  assert.deepEqual(agent.listThreads(), []);

  // Deleting a missing thread returns false
  assert.equal(agent.deleteThread("never-existed"), false);
});

test("chat-agent: switching threadId rehydrates history from memory", async () => {
  // Persist a fake conversation under "thread-A".
  const conversationStore = createStore<any>(uniqueStoreName());
  const factStore = createStore<any>(uniqueStoreName());
  conversationStore.set("thread-A", {
    id: "thread-A",
    messages: [
      { role: "user", content: "first message" },
      { role: "assistant", content: "first response" },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const adapter = mockAdapter([{ text: "fresh response" }]);
  const agent = await createChatAgent({
    adapter,
    memory: { conversationStore, factStore, threadId: "thread-B" },
  });

  // Agent starts on thread-B; calling chat() with thread-A should
  // pull the prior messages into history before the new turn.
  await agent.chat("second message", { threadId: "thread-A" });

  const hist = agent.getHistory();
  // Expected: [user "first", assistant "first response",
  //            user "second message", assistant "fresh response"]
  assert.equal(hist.length, 4);
  assert.equal(hist[0].content, "first message");
  assert.equal(hist[1].content, "first response");
  assert.equal(hist[2].content, "second message");
  assert.equal(hist[3].content, "fresh response");
});

test("chat-agent: synthetic placeholders not persisted to long-term memory", async () => {
  const adapter = mockAdapter([{}]);
  const conversationStore = createStore<any>(uniqueStoreName());
  const factStore = createStore<any>(uniqueStoreName());
  try {
    const agent = await createChatAgent({
      adapter,
      memory: { conversationStore, factStore, threadId: "test-thread" },
    });
    const result = await agent.chat("hi");
    assert.equal(result.text, "(empty response from model)");

    // The user message should be persisted, but the synthetic
    // assistant placeholder should NOT be — otherwise the model
    // would see its own placeholder on the next call and might mimic.
    const thread = conversationStore.get("test-thread") as
      | { messages: Array<{ role: string; content: string }> }
      | undefined;
    assert.ok(thread, "thread should exist");
    const assistantMsgs = thread!.messages.filter((m) => m.role === "assistant");
    assert.equal(
      assistantMsgs.length,
      0,
      "no synthetic assistant turn should be persisted",
    );
  } finally {
    // Best-effort cleanup — store names are unique per test
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Custom runner — uses node:test programmatically so we can exit non-zero
// on failure without a separate CLI flag.
// ─────────────────────────────────────────────────────────────────────────

// The `test()` calls above register tests with Node's default test runner.
// When this script is executed via `tsx`, those tests run automatically and
// the process exits non-zero if any fail. Nothing more to wire up.
