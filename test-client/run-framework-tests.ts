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
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createStore, type Store } from "../src/framework/store.js";
import {
  defineTool,
  normalizeToolResult,
  ok,
  err,
} from "../src/framework/tool.js";
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
  if (!existsSync(DATA_DIR)) return;
  const prefix = `${name}.json`;
  for (const entry of readdirSync(DATA_DIR)) {
    if (entry === prefix || entry.startsWith(`${prefix}.`)) {
      rmSync(join(DATA_DIR, entry), { force: true });
    }
  }
}

function waitForChild(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

async function waitForPaths(paths: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for Store writer processes");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
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

test("store: independent instances merge writes instead of overwriting stale snapshots", () => {
  const name = uniqueStoreName();
  try {
    const first = createStore<number>(name);
    const second = createStore<number>(name);

    first.set("first", 1);
    second.set("second", 2);

    assert.deepEqual(
      createStore<number>(name).entries().sort(([left], [right]) => left.localeCompare(right)),
      [
        ["first", 1],
        ["second", 2],
      ],
    );
  } finally {
    removeStoreFile(name);
  }
});

test("store: preserves Map-like object references across unrelated writes", () => {
  const name = uniqueStoreName();
  try {
    const store = createStore<{ n: number }>(name);
    store.set("mutable", { n: 1 });
    const value = store.get("mutable");
    assert.ok(value);
    assert.strictEqual(store.get("mutable"), value);

    value.n = 2;
    store.set("other", { n: 3 });

    assert.strictEqual(store.get("mutable"), value);
    assert.deepEqual(createStore<{ n: number }>(name).get("mutable"), { n: 2 });
  } finally {
    removeStoreFile(name);
  }
});

test("store: rejects unsafe names before they can escape the data directory", () => {
  for (const name of ["", ".", "..", "../escaped", "nested/name", "nested\\name", "nul\0name"]) {
    assert.throws(() => createStore(name), /store name must be a non-empty filename/);
  }
});

test("store: invalid JSON fails closed and is not replaced", () => {
  const name = uniqueStoreName();
  const file = join(DATA_DIR, `${name}.json`);
  const corrupt = "{ definitely-not-json\n";
  try {
    createStore(name);
    writeFileSync(file, corrupt, { mode: 0o600 });

    assert.throws(() => createStore(name), /contains invalid JSON/);
    assert.equal(readFileSync(file, "utf8"), corrupt);
  } finally {
    removeStoreFile(name);
  }
});

test("store: serialization failure leaves the prior commit intact", () => {
  const name = uniqueStoreName();
  const file = join(DATA_DIR, `${name}.json`);
  try {
    const store = createStore<unknown>(name);
    store.set("safe", { value: 1 });
    const committed = readFileSync(file, "utf8");

    assert.throws(() => store.set("unsafe", 1n), /could not serialize store data/);
    assert.equal(readFileSync(file, "utf8"), committed);
    assert.deepEqual(createStore(name).entries(), [["safe", { value: 1 }]]);
  } finally {
    removeStoreFile(name);
  }
});

test(
  "store: uses 0700 for its directory and tightens owned files to 0600",
  { skip: process.platform === "win32" },
  () => {
    const name = uniqueStoreName();
    const file = join(DATA_DIR, `${name}.json`);
    try {
      createStore(name);
      writeFileSync(file, '{"legacy":true}\n', { mode: 0o644 });
      chmodSync(file, 0o644);

      assert.equal(createStore<{ legacy: boolean }>(name).get("legacy"), true);
      assert.equal(lstatSync(DATA_DIR).mode & 0o777, 0o700);
      assert.equal(lstatSync(file).mode & 0o777, 0o600);
    } finally {
      removeStoreFile(name);
    }
  },
);

test(
  "store: rejects a symlink at the durable file path",
  { skip: process.platform === "win32" },
  () => {
    const name = uniqueStoreName();
    const file = join(DATA_DIR, `${name}.json`);
    const target = join(DATA_DIR, `${name}.target`);
    try {
      createStore(name);
      writeFileSync(target, "{}\n", { mode: 0o600 });
      symlinkSync(target, file);
      assert.throws(() => createStore(name), /must be a regular file, not a symlink/);
    } finally {
      removeStoreFile(name);
      rmSync(target, { force: true });
    }
  },
);

test("store: concurrent processes preserve every writer's keys", async () => {
  const name = uniqueStoreName();
  const barrierDir = mkdtempSync(join(tmpdir(), "openfunction-store-test-"));
  const startPath = join(barrierDir, "start");
  const workerCount = 3;
  const writesPerWorker = 8;
  const readyPaths = Array.from({ length: workerCount }, (_, index) => join(barrierDir, `ready-${index}`));
  const children: ChildProcess[] = [];

  try {
    createStore(name);
    const storeModuleUrl = pathToFileURL(join(__dirname, "..", "src", "framework", "store.ts")).href;
    const childSource = `
      import { existsSync, writeFileSync } from "node:fs";
      import { createStore } from ${JSON.stringify(storeModuleUrl)};
      const [name, worker, count, readyPath, startPath] = process.argv.slice(1);
      writeFileSync(readyPath, "", { mode: 0o600 });
      const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      while (!existsSync(startPath)) Atomics.wait(sleeper, 0, 0, 5);
      const store = createStore(name);
      for (let index = 0; index < Number(count); index += 1) {
        store.set(worker + ":" + index, { worker: Number(worker), index });
      }
    `;

    for (let worker = 0; worker < workerCount; worker += 1) {
      children.push(
        spawn(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            childSource,
            name,
            String(worker),
            String(writesPerWorker),
            readyPaths[worker],
            startPath,
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        ),
      );
    }

    await waitForPaths(readyPaths, 10_000);
    writeFileSync(startPath, "", { mode: 0o600 });
    const results = await Promise.all(children.map(waitForChild));
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
    }

    assert.equal(createStore(name).size, workerCount * writesPerWorker);
    assert.deepEqual(
      readdirSync(DATA_DIR).filter((entry) => entry.startsWith(`${name}.json.`)),
      [],
    );
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    removeStoreFile(name);
    rmSync(barrierDir, { recursive: true, force: true });
  }
});

test("conversation memory: cross-process atomic mutations preserve both writers", async () => {
  const name = uniqueStoreName();
  const barrierDir = mkdtempSync(join(tmpdir(), "openfunction-memory-atomic-"));
  const firstReady = join(barrierDir, "first-ready");
  const firstRelease = join(barrierDir, "first-release");
  const secondStarted = join(barrierDir, "second-started");
  const secondEntered = join(barrierDir, "second-entered");
  const children: ChildProcess[] = [];

  try {
    createStore(name);
    const storeModuleUrl = pathToFileURL(join(__dirname, "..", "src", "framework", "store.ts")).href;
    const memoryModuleUrl = pathToFileURL(join(__dirname, "..", "src", "framework", "memory.ts")).href;
    const childSource = `
      import { existsSync, writeFileSync } from "node:fs";
      import { createStore } from ${JSON.stringify(storeModuleUrl)};
      import { createConversationMemory } from ${JSON.stringify(memoryModuleUrl)};
      const [name, role, firstReady, firstRelease, secondStarted, secondEntered] = process.argv.slice(1);
      const base = createStore(name);
      const store = new Proxy(base, {
        get(target, property, receiver) {
          if (property !== "mutate") return Reflect.get(target, property, receiver);
          return (id, mutation) => target.mutate(id, (current) => {
            if (role === "first") {
              writeFileSync(firstReady, "", { mode: 0o600 });
              const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
              while (!existsSync(firstRelease)) Atomics.wait(sleeper, 0, 0, 5);
            } else {
              writeFileSync(secondEntered, "", { mode: 0o600 });
            }
            return mutation(current);
          });
        },
      });
      if (role === "second") writeFileSync(secondStarted, "", { mode: 0o600 });
      createConversationMemory(store).addMessage("shared", { role: "user", content: role });
    `;
    const args = (role: string) => [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      childSource,
      name,
      role,
      firstReady,
      firstRelease,
      secondStarted,
      secondEntered,
    ];

    children.push(spawn(process.execPath, args("first"), { stdio: ["ignore", "ignore", "pipe"] }));
    await waitForPaths([firstReady], 10_000);
    children.push(spawn(process.execPath, args("second"), { stdio: ["ignore", "ignore", "pipe"] }));
    await waitForPaths([secondStarted], 10_000);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(secondEntered), false, "second mutation must wait for the first store lock");

    writeFileSync(firstRelease, "", { mode: 0o600 });
    const results = await Promise.all(children.map(waitForChild));
    for (const result of results) assert.equal(result.code, 0, result.stderr);

    const messages = createStore<any>(name).get("shared")?.messages ?? [];
    assert.deepEqual(messages.map((message: ChatMessage) => message.content), ["first", "second"]);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    removeStoreFile(name);
    rmSync(barrierDir, { recursive: true, force: true });
  }
});

test("store: reclaims dead writer snapshots without deleting a live writer's temp file", async () => {
  const name = uniqueStoreName();
  const barrierDir = mkdtempSync(join(tmpdir(), "openfunction-store-temp-"));
  const readyPath = join(barrierDir, "ready");
  let child: ChildProcess | undefined;

  try {
    createStore(name);
    const fileName = `${name}.json`;
    const token = "11111111-1111-4111-8111-111111111111";
    const childSource = `
      import { join } from "node:path";
      import { writeFileSync } from "node:fs";
      const [dataDir, fileName, token, readyPath] = process.argv.slice(1);
      writeFileSync(join(dataDir, fileName + "." + process.pid + "." + token + ".tmp"), "orphan", { mode: 0o600 });
      writeFileSync(readyPath, "", { mode: 0o600 });
      setInterval(() => {}, 1000);
    `;
    child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", childSource, DATA_DIR, fileName, token, readyPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const childDone = waitForChild(child);
    await waitForPaths([readyPath], 10_000);
    assert.ok(child.pid);
    const tempPath = join(DATA_DIR, `${fileName}.${child.pid}.${token}.tmp`);

    createStore(name);
    assert.equal(existsSync(tempPath), true, "a live writer's snapshot must remain untouched");

    child.kill("SIGTERM");
    await childDone;
    createStore(name);
    assert.equal(existsSync(tempPath), false, "a dead writer's private snapshot is reclaimable");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    removeStoreFile(name);
    rmSync(barrierDir, { recursive: true, force: true });
  }
});

test("store: advances past multiple stale recovery generations without deleting them", () => {
  const name = uniqueStoreName();
  const store = createStore<number>(name);
  const lockPath = join(DATA_DIR, `${name}.json.lock`);
  const reclaimPath = `${lockPath}.reclaim`;
  const staleOwner = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const crashedReclaimer = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const crashedSuccessor = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.ok(staleOwner.pid);
  assert.ok(crashedReclaimer.pid);
  assert.ok(crashedSuccessor.pid);
  const staleToken = "11111111-1111-4111-8111-111111111111";
  const reclaimToken = "22222222-2222-4222-8222-222222222222";
  const successorToken = "33333333-3333-4333-8333-333333333333";
  const staleClaim = `${lockPath}.${staleOwner.pid}.${staleToken}.claim`;
  const reclaimClaim = `${lockPath}.${crashedReclaimer.pid}.${reclaimToken}.claim`;
  const successorClaim = `${lockPath}.${crashedSuccessor.pid}.${successorToken}.claim`;

  try {
    writeFileSync(staleClaim, `${JSON.stringify({ pid: staleOwner.pid, token: staleToken })}\n`, {
      mode: 0o600,
    });
    linkSync(staleClaim, lockPath);
    writeFileSync(reclaimClaim, `${JSON.stringify({ pid: crashedReclaimer.pid, token: reclaimToken })}\n`, {
      mode: 0o600,
    });
    linkSync(reclaimClaim, reclaimPath);
    writeFileSync(successorClaim, `${JSON.stringify({
      pid: crashedSuccessor.pid,
      token: successorToken,
    })}\n`, { mode: 0o600 });
    linkSync(successorClaim, `${lockPath}.reclaim.${reclaimToken}`);

    store.set("recovered", 1);

    assert.equal(store.get("recovered"), 1);
    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(reclaimPath), true, "dead recovery generations remain immutable");
    assert.equal(existsSync(`${lockPath}.reclaim.${reclaimToken}`), true);
    assert.equal(existsSync(`${lockPath}.reclaim.${successorToken}`), false);
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

test("validate: enforces advanced schemas used by the Siftable MCP SDK", () => {
  const schema: InputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      destination: {
        anyOf: [
          { type: "null" },
          { type: "string", minLength: 3, maxLength: 8 },
        ],
      },
      count: { type: "integer", minimum: 1, maximum: 3 },
      mode: { const: "safe" },
    },
    required: ["destination", "mode"],
  };

  assert.deepEqual(validateParams({ destination: null, count: 2, mode: "safe" }, schema), []);
  const errors = validateParams({ destination: "x", count: 4, mode: "unsafe", extra: true }, schema);
  assert.equal(errors.length, 4);
  assert.ok(errors.some((error) => error.field === "destination"));
  assert.ok(errors.some((error) => error.field === "count"));
  assert.ok(errors.some((error) => error.field === "mode"));
  assert.ok(errors.some((error) => error.field === "extra"));
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
  const logs: string[] = [];
  const originalErr = console.error;
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    const result = await r.execute("thrower", { apiKey: "never-log-this-secret" });
    assert.equal(result.success, false);
    assert.equal(result.error, "boom");
    assert.match(logs.join("\n"), /Input keys: apiKey/);
    assert.doesNotMatch(logs.join("\n"), /never-log-this-secret/);
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
// openclaw.ts — bridge from openFunctions registry → openclaw tools
// ─────────────────────────────────────────────────────────────────────────

import { toOpenclawTools, toolToOpenclaw } from "../src/framework/openclaw.js";
import { toOpenclawToolPluginTools } from "../src/framework/openclaw.js";
import { registerPiTools, toPiTools } from "../src/framework/pi.js";
import { createHermesMcpConfig } from "../src/framework/hermes.js";

test("openclaw bridge: converts every registered tool by default", () => {
  const r = new ToolRegistry();
  r.register(
    defineTool({
      name: "echo",
      description: "echo the input back",
      inputSchema: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
      handler: async ({ msg }) => ok({ echoed: msg }),
    }),
  );
  r.register(
    defineTool({
      name: "ping",
      description: "always returns pong",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ok({ value: "pong" }),
    }),
  );

  const tools = toOpenclawTools(r);
  assert.equal(tools.length, 2);
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["echo", "ping"]);
  // Description and parameters pass through verbatim.
  assert.equal(tools.find((t) => t.name === "echo")?.description, "echo the input back");
  assert.equal(
    (tools.find((t) => t.name === "echo")?.parameters as { type: string }).type,
    "object",
  );
});

test("openclaw bridge: execute() runs the tool and wraps the result", async () => {
  const r = new ToolRegistry();
  r.register(
    defineTool({
      name: "double",
      description: "double a number",
      inputSchema: {
        type: "object",
        properties: { n: { type: "number" } },
        required: ["n"],
      },
      handler: async ({ n }) => ok({ doubled: (n as number) * 2 }, "calculated"),
    }),
  );

  const [tool] = toOpenclawTools(r);
  const result = await tool.execute("call_1", { n: 21 });

  assert.equal(result.type, "text");
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /calculated/);
  assert.match(result.content[0].text, /"doubled": 42/);
});

test("openclaw bridge: failed tool returns error block with isError", async () => {
  const r = new ToolRegistry();
  r.register(
    defineTool({
      name: "always_fails",
      description: "always returns err()",
      inputSchema: { type: "object", properties: {} },
      handler: async () => err("boom"),
    }),
  );

  const [tool] = toOpenclawTools(r);
  const result = await tool.execute("call_1", {});
  assert.equal(result.type, "error");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /boom/);
});

test("openclaw bridge: validation errors flow through as error blocks", async () => {
  const r = new ToolRegistry();
  r.register(
    defineTool({
      name: "needs_field",
      description: "requires a field",
      inputSchema: {
        type: "object",
        properties: { field: { type: "string" } },
        required: ["field"],
      },
      handler: async () => ok({ ran: true }),
    }),
  );

  const [tool] = toOpenclawTools(r);
  // Missing required param — registry.execute should refuse before the handler.
  const result = await tool.execute("call_1", {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /field/i);
});

test("openclaw bridge: filter narrows the exposed set", () => {
  const r = new ToolRegistry();
  r.register(
    defineTool({
      name: "internal_metric",
      description: "internal-only",
      inputSchema: { type: "object", properties: {} },
      tags: ["internal"],
      handler: async () => ok({}),
    }),
  );
  r.register(
    defineTool({
      name: "public_action",
      description: "ok to expose",
      inputSchema: { type: "object", properties: {} },
      tags: ["public"],
      handler: async () => ok({}),
    }),
  );

  const tools = toOpenclawTools(r, {
    filter: (t) => t.tags?.includes("public") ?? false,
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "public_action");
});

test("openclaw bridge: namePrefix collision-avoids when bundling sources", () => {
  const r = new ToolRegistry();
  r.register(
    defineTool({
      name: "list",
      description: "list things from the source",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ok({}),
    }),
  );
  const [tool] = toOpenclawTools(r, { namePrefix: "siftable_" });
  assert.equal(tool.name, "siftable_list");
});

test("openclaw bridge: custom formatResult is honored", async () => {
  const r = new ToolRegistry();
  r.register(
    defineTool({
      name: "stamp",
      description: "stamps stuff",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ok({ stamped: true }),
    }),
  );
  const [tool] = toOpenclawTools(r, {
    formatResult: (result) => ({
      type: "text",
      content: [{ type: "text", text: `OK: ${JSON.stringify(result.data)}` }],
    }),
  });
  const result = await tool.execute("c1", {});
  assert.equal(result.content[0].text, 'OK: {"stamped":true}');
});

test("openclaw bridge: toolToOpenclaw works on a single tool", async () => {
  const r = new ToolRegistry();
  const t = defineTool({
    name: "lone",
    description: "lone wolf",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ok({ alone: true }),
  });
  r.register(t);
  const oc = toolToOpenclaw(t, r);
  const result = await oc.execute("c1", {});
  assert.match(result.content[0].text, /alone/);
});

test("openclaw tool plugin bridge: returns structured values", async () => {
  const r = new ToolRegistry();
  r.register(
    defineTool({
      name: "lookup",
      description: "look up a structured value",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      handler: async ({ id }) => ok({ id, found: true }, "lookup complete"),
    }),
  );

  const [tool] = toOpenclawToolPluginTools(r);
  const result = await tool.execute(
    { id: "item-1" },
    {},
    { toolCallId: "call-1" },
  );
  assert.deepEqual(result, {
    message: "lookup complete",
    data: { id: "item-1", found: true },
  });
});

test("openclaw tool plugin bridge: throws failed tool results", async () => {
  const r = new ToolRegistry();
  r.register(
    defineTool({
      name: "denied",
      description: "always denies the request",
      inputSchema: { type: "object", properties: {} },
      handler: async () => err("not authorized"),
    }),
  );

  const [tool] = toOpenclawToolPluginTools(r);
  await assert.rejects(
    tool.execute({}, {}, { toolCallId: "call-2" }),
    /not authorized/,
  );
});

test("pi bridge: registers selected tools with prompt metadata", () => {
  const r = new ToolRegistry();
  r.register(
    defineTool({
      name: "search_notes",
      description: "search notes by query",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      tags: ["public"],
      handler: async () => ok([]),
    }),
  );
  r.register(
    defineTool({
      name: "internal_notes",
      description: "inspect internal notes",
      inputSchema: { type: "object", properties: {} },
      tags: ["internal"],
      handler: async () => ok([]),
    }),
  );

  const registered: unknown[] = [];
  const tools = registerPiTools(
    { registerTool: (tool) => registered.push(tool) },
    r,
    {
      filter: (tool) => tool.tags?.includes("public") ?? false,
      namePrefix: "of_",
      promptSnippet: () => "Search the connected notes store",
      promptGuidelines: () => ["Use of_search_notes for note lookup."],
    },
  );

  assert.equal(tools.length, 1);
  assert.equal(registered.length, 1);
  assert.equal(tools[0].name, "of_search_notes");
  assert.equal(tools[0].promptSnippet, "Search the connected notes store");
});

test("pi bridge: executes successes and throws failures", async () => {
  const r = new ToolRegistry();
  r.register(
    defineTool({
      name: "pi_echo",
      description: "echo text through Pi",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      handler: async ({ text }) => ok({ text }),
    }),
  );

  const [tool] = toPiTools(r);
  const result = await tool.execute("call-3", { text: "hello" }, undefined, undefined, {});
  assert.match(result.content[0].text, /hello/);
  assert.equal(result.details.success, true);
  await assert.rejects(
    tool.execute("call-4", {}, undefined, undefined, {}),
    /text/i,
  );
});

test("pi bridge: honors an already-aborted signal", async () => {
  const r = new ToolRegistry();
  r.register(
    defineTool({
      name: "slow_tool",
      description: "a cancellable test tool",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ok({ completed: true }),
    }),
  );
  const [tool] = toPiTools(r);
  await assert.rejects(
    tool.execute("call-5", {}, AbortSignal.abort(), undefined, {}),
    /abort/i,
  );
});

test("hermes bridge: builds a least-privilege MCP config snapshot", () => {
  const r = new ToolRegistry();
  for (const [name, tag] of [["read_note", "public"], ["delete_note", "dangerous"]] as const) {
    r.register(
      defineTool({
        name,
        description: `${name} test tool`,
        inputSchema: { type: "object", properties: {} },
        tags: [tag],
        handler: async () => ok({}),
      }),
    );
  }

  const config = createHermesMcpConfig(r, {
    serverName: "openfunctions_notes",
    command: "node",
    args: ["/workspace/dist/src/index.js"],
    filter: (tool) => tool.tags?.includes("public") ?? false,
    timeout: 120,
    connectTimeout: 30,
    supportsParallelToolCalls: true,
    resources: false,
    prompts: false,
  });

  assert.deepEqual(config, {
    mcp_servers: {
      openfunctions_notes: {
        command: "node",
        args: ["/workspace/dist/src/index.js"],
        timeout: 120,
        connect_timeout: 30,
        supports_parallel_tool_calls: true,
        tools: {
          include: ["read_note"],
          resources: false,
          prompts: false,
        },
      },
    },
  });
});

test("hermes bridge: rejects invalid timeouts", () => {
  assert.throws(
    () => createHermesMcpConfig(new ToolRegistry(), { command: "node", timeout: 0 }),
    /positive number/,
  );
});

// ─────────────────────────────────────────────────────────────────────────
// agents.ts — Ralph loop
// ─────────────────────────────────────────────────────────────────────────

import { defineAgent, runRalph, runCrew, runTaskCrew } from "../src/framework/agents.js";
import type { AIAdapter, AdapterResponse, ChatMessage } from "../src/framework/adapters/types.js";
import { chatContentToText } from "../src/framework/adapters/content.js";

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
      if (userMsg) taskSeen.push(chatContentToText(userMsg.content));
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
// runTaskCrew — typed contracts, named context, hierarchical process
// ─────────────────────────────────────────────────────────────────────────

/**
 * Scripted adapter that also records the systemPrompt of every call, so tests
 * can assert what context an agent was actually given (context is threaded into
 * the system prompt by composePrompt).
 */
function capturingAdapter(
  responses: Array<AdapterResponse | Error>,
): { adapter: AIAdapter; systemPrompts: string[] } {
  let i = 0;
  const systemPrompts: string[] = [];
  return {
    systemPrompts,
    adapter: {
      name: "capture-mock",
      model: "test-model",
      async chat(_messages, _registry, options) {
        systemPrompts.push(options?.systemPrompt ?? "");
        const next = responses[i++];
        if (next === undefined) throw new Error(`capturing adapter overran (call ${i})`);
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

test("runTaskCrew: threads previous task output as context by default", async () => {
  const { adapter, systemPrompts } = capturingAdapter([
    { text: "STEP_ONE_OUTPUT" }, // research
    { text: "final draft" }, // draft — should see STEP_ONE_OUTPUT
  ]);

  const researcher = defineAgent({ name: "researcher", role: "Researcher", goal: "find facts" });
  const writer = defineAgent({ name: "writer", role: "Writer", goal: "write" });

  const result = await runTaskCrew(
    {
      agents: [researcher, writer],
      tasks: [
        { id: "research", agent: "researcher", description: "Research the topic." },
        { id: "draft", agent: "writer", description: "Write it up." },
      ],
    },
    adapter,
    new ToolRegistry(),
  );

  assert.equal(result.tasks.length, 2);
  assert.equal(result.output, "final draft");
  // The writer's system prompt must carry the researcher's output forward.
  assert.match(systemPrompts[1], /STEP_ONE_OUTPUT/);
});

test("runTaskCrew: pulls context from named prior tasks, not just the previous one", async () => {
  const { adapter, systemPrompts } = capturingAdapter([
    { text: "ALPHA" }, // task a
    { text: "BETA" }, // task b
    { text: "done" }, // task c — context: ["a"] only
  ]);

  const agent = defineAgent({ name: "worker", role: "Worker", goal: "work" });

  await runTaskCrew(
    {
      agents: [agent],
      tasks: [
        { id: "a", agent: "worker", description: "first" },
        { id: "b", agent: "worker", description: "second" },
        { id: "c", agent: "worker", description: "third", context: ["a"] },
      ],
    },
    adapter,
    new ToolRegistry(),
  );

  // Task c asked for "a" only — it should see ALPHA, labeled, and not BETA.
  assert.match(systemPrompts[2], /From "a"/);
  assert.match(systemPrompts[2], /ALPHA/);
  assert.doesNotMatch(systemPrompts[2], /BETA/);
});

test("runTaskCrew: empty context array isolates a task", async () => {
  const { adapter, systemPrompts } = capturingAdapter([
    { text: "PRIOR_OUTPUT" },
    { text: "isolated" }, // context: [] → no prior context
  ]);
  const agent = defineAgent({ name: "worker", role: "Worker", goal: "work" });

  await runTaskCrew(
    {
      agents: [agent],
      tasks: [
        { id: "a", agent: "worker", description: "first" },
        { id: "b", agent: "worker", description: "second", context: [] },
      ],
    },
    adapter,
    new ToolRegistry(),
  );

  assert.doesNotMatch(systemPrompts[1], /PRIOR_OUTPUT/);
});

test("runTaskCrew: outputSchema coerces output to typed data forwarded as JSON", async () => {
  const adapter = scriptedAdapter([
    { text: "I found three things: a, b and c." }, // research agent's prose
    // forceStructuredOutput call → must return a tool call with the schema args
    {
      toolCall: {
        id: "t1",
        name: "structured_output",
        args: { findings: ["a", "b", "c"] },
      },
    },
  ]);

  const researcher = defineAgent({ name: "researcher", role: "Researcher", goal: "find facts" });

  const result = await runTaskCrew(
    {
      agents: [researcher],
      tasks: [
        {
          id: "research",
          agent: "researcher",
          description: "Find three things.",
          expectedOutput: "a list of findings",
          outputSchema: {
            type: "object",
            properties: { findings: { type: "array", items: { type: "string" } } },
            required: ["findings"],
          },
        },
      ],
    },
    adapter,
    new ToolRegistry(),
  );

  assert.deepEqual(result.tasks[0].data, { findings: ["a", "b", "c"] });
  // Forwarded output is the JSON, not the prose.
  assert.match(result.tasks[0].output, /"findings"/);
});

test("runTaskCrew: unknown agent name fails fast before any model call", async () => {
  let called = false;
  const adapter: AIAdapter = {
    name: "noop",
    model: "test",
    async chat() {
      called = true;
      return { text: "x" };
    },
  };

  await assert.rejects(
    runTaskCrew(
      { agents: [], tasks: [{ id: "t", agent: "ghost", description: "do" }] },
      adapter,
      new ToolRegistry(),
    ),
    /unknown agent "ghost"/,
  );
  assert.equal(called, false, "no model call should happen on a bad agent ref");
});

test("runTaskCrew: forward context reference throws", async () => {
  const adapter = scriptedAdapter([{ text: "out" }]);
  const agent = defineAgent({ name: "worker", role: "Worker", goal: "work" });

  await assert.rejects(
    runTaskCrew(
      {
        agents: [agent],
        // Task "a" references "b", which hasn't run yet.
        tasks: [{ id: "a", agent: "worker", description: "first", context: ["b"] }],
      },
      adapter,
      new ToolRegistry(),
    ),
    /references context "b"/,
  );
});

test("runTaskCrew: hierarchical mode delegates to workers via the manager", async () => {
  // Manager calls delegate_to_writer (round 1), then synthesizes (round 2).
  const adapter = scriptedAdapter([
    {
      toolCall: { id: "d1", name: "delegate_to_writer", args: { task: "write it" } },
    }, // manager round 1: delegate
    { text: "the writer's section" }, // writer agent runs to completion
    { text: "MANAGER_SYNTHESIS" }, // manager round 2: final answer
  ]);

  const writer = defineAgent({ name: "writer", role: "Writer", goal: "write sections" });

  const result = await runTaskCrew(
    {
      agents: [writer],
      process: "hierarchical",
      tasks: [{ id: "article", agent: "writer", description: "Produce an article." }],
    },
    adapter,
    new ToolRegistry(),
  );

  assert.equal(result.output, "MANAGER_SYNTHESIS");
  assert.equal(result.tasks[0].agent, "crew_manager");
});

// ─────────────────────────────────────────────────────────────────────────
// memory.ts — fact memory ID generation
// ─────────────────────────────────────────────────────────────────────────

import {
  createConversationMemory,
  createFactMemory,
} from "../src/framework/memory.js";

test("conversation memory: a fresh projection authoritatively clears stale storage", () => {
  const name = uniqueStoreName();
  try {
    const initial = createConversationMemory(createStore<any>(name));
    initial.addMessages("durable-thread", [
      { role: "user", content: "stale question" },
      { role: "assistant", content: "stale answer" },
    ]);

    // A reopened durable journal can already know that its history is empty
    // before this fresh compatibility-memory instance has observed storage.
    const reopened = createConversationMemory(createStore<any>(name));
    reopened.replaceMessages("durable-thread", []);

    const verified = createConversationMemory(createStore<any>(name));
    assert.deepEqual(verified.getRecent("durable-thread", Number.MAX_SAFE_INTEGER), []);
  } finally {
    removeStoreFile(name);
  }
});

test("conversation memory: an authoritative clear rejects a known concurrent change", () => {
  const name = uniqueStoreName();
  try {
    const initial = createConversationMemory(createStore<any>(name));
    initial.addMessage("shared-thread", { role: "user", content: "known" });

    const clearingWriter = createConversationMemory(createStore<any>(name));
    assert.equal(clearingWriter.getThread("shared-thread").messages.length, 1);

    const concurrentWriter = createConversationMemory(createStore<any>(name));
    concurrentWriter.addMessage("shared-thread", {
      role: "assistant",
      content: "concurrent",
    });

    assert.throws(
      () => clearingWriter.replaceMessages("shared-thread", []),
      /changed concurrently/,
    );
    assert.deepEqual(
      createConversationMemory(createStore<any>(name))
        .getRecent("shared-thread", Number.MAX_SAFE_INTEGER),
      [
        { role: "user", content: "known" },
        { role: "assistant", content: "concurrent" },
      ],
    );
  } finally {
    removeStoreFile(name);
  }
});

test("conversation memory: repeated stale projections preserve a concurrent extension", () => {
  const name = uniqueStoreName();
  try {
    const journalProjection = [
      { role: "user" as const, content: "journal message" },
    ];
    const staleWriter = createConversationMemory(createStore<any>(name));
    staleWriter.replaceMessages("shared-thread", journalProjection);

    createConversationMemory(createStore<any>(name)).addMessage(
      "shared-thread",
      { role: "assistant", content: "concurrent extension" },
    );

    staleWriter.replaceMessages("shared-thread", journalProjection);
    staleWriter.replaceMessages("shared-thread", journalProjection);

    assert.deepEqual(
      createConversationMemory(createStore<any>(name))
        .getRecent("shared-thread", Number.MAX_SAFE_INTEGER),
      [
        ...journalProjection,
        { role: "assistant", content: "concurrent extension" },
      ],
    );
  } finally {
    removeStoreFile(name);
  }
});

test("conversation memory: a stale writer cannot resurrect a deleted or reset thread", () => {
  for (const concurrentChange of ["delete", "reset"] as const) {
    const name = uniqueStoreName();
    try {
      const staleWriter = createConversationMemory(createStore<any>(name));
      const oldHistory = [{ role: "user" as const, content: "old" }];
      staleWriter.replaceMessages("shared-thread", oldHistory);

      const concurrentWriter = createConversationMemory(createStore<any>(name));
      if (concurrentChange === "delete") {
        assert.equal(concurrentWriter.deleteThread("shared-thread"), true);
      } else {
        concurrentWriter.replaceMessages("shared-thread", []);
      }

      assert.throws(
        () => staleWriter.replaceMessages("shared-thread", [
          ...oldHistory,
          { role: "assistant", content: "stale continuation" },
        ]),
        /changed concurrently/,
      );

      const current = createStore<any>(name).get("shared-thread");
      if (concurrentChange === "delete") assert.equal(current, undefined);
      else assert.deepEqual(current?.messages, []);
    } finally {
      removeStoreFile(name);
    }
  }
});

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

test("chat-agent: conversation and fact memory flags gate independent tools and prompts", async () => {
  const cases = [
    {
      label: "facts only",
      memory: { conversation: false, facts: true },
      expectedTools: ["recall_facts", "store_fact"],
      factPrompt: true,
    },
    {
      label: "conversation only",
      memory: { conversation: true, facts: false },
      expectedTools: ["get_thread", "list_threads"],
      factPrompt: false,
    },
    {
      label: "neither",
      memory: { conversation: false, facts: false },
      expectedTools: [],
      factPrompt: false,
    },
  ] as const;

  for (const item of cases) {
    const conversationName = uniqueStoreName();
    const factName = uniqueStoreName();
    let observedTools: string[] = [];
    let observedPrompt = "";
    try {
      const agent = await createChatAgent({
        adapter: {
          name: `${item.label}-adapter`,
          model: "memory-flags-model",
          async chat(_messages, registry, options) {
            observedTools = registry.listNames()
              .filter((name) => [
                "store_fact",
                "recall_facts",
                "list_threads",
                "get_thread",
              ].includes(name))
              .sort();
            observedPrompt = options?.systemPrompt ?? "";
            return { text: "ok" };
          },
        },
        memory: {
          ...item.memory,
          conversationStore: createStore<any>(conversationName),
          factStore: createStore<any>(factName),
          threadId: `thread-${item.label}`,
        },
      });
      await agent.chat("check memory configuration");
      assert.deepEqual(observedTools, [...item.expectedTools].sort(), item.label);
      assert.equal(/store_fact|recall_facts/.test(observedPrompt), item.factPrompt, item.label);
    } finally {
      removeStoreFile(conversationName);
      removeStoreFile(factName);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────
// workflows.ts — parallelSettled
// ─────────────────────────────────────────────────────────────────────────

import { pipe, llmStep } from "../src/framework/workflows.js";
import { startChat } from "../src/framework/adapters/chat.js";

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

test("direct chat loop threads continuation state and exact replay", async () => {
  type CreateInterface = typeof import("node:readline").createInterface;
  const readlineModule = createRequire(import.meta.url)("node:readline") as {
    createInterface: CreateInterface;
  };
  const originalCreateInterface = readlineModule.createInterface;
  const originalLog = console.log;
  const questions: Array<(input: string) => unknown> = [];
  const requests: Array<{ messages: ChatMessage[]; options: unknown }> = [];
  let call = 0;
  const adapter: AIAdapter = {
    name: "direct-chat-mock",
    model: "direct-chat-model",
    sessionStateKey: "direct-chat.responses",
    async chat(messages, _registry, options) {
      requests.push({
        messages: structuredClone(messages),
        options: structuredClone(options),
      });
      call += 1;
      if (call === 1) {
        return {
          toolCall: { id: "direct-call", name: "direct_echo", args: { text: "hello" } },
          thinking: [{ type: "thinking", thinking: "direct plan", signature: "direct-sig" }],
          sessionState: {
            key: "direct-chat.responses",
            continuationId: "direct-state-a",
            fingerprint: "direct-chat-fingerprint",
          },
          providerReplay: {
            key: "direct-chat.responses",
            outputItems: [{ type: "function_call", call_id: "direct-call" }],
          },
        };
      }
      if (call === 2) {
        return {
          text: "first direct answer",
          sessionState: {
            key: "direct-chat.responses",
            continuationId: "direct-state-b",
            fingerprint: "direct-chat-fingerprint",
          },
          providerReplay: {
            key: "direct-chat.responses",
            outputItems: [{ type: "message", id: "direct-message-b" }],
          },
        };
      }
      return { text: "second direct answer" };
    },
  };
  const registry = new ToolRegistry();
  registry.register(defineTool({
    name: "direct_echo",
    description: "Echo a value for direct chat state tests",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    handler: async ({ text }: { text: string }) => ok({ text }),
  }));

  readlineModule.createInterface = (() => ({
    question(_prompt: string, callback: (input: string) => unknown) {
      questions.push(callback);
    },
    close() {},
  })) as unknown as CreateInterface;
  syncBuiltinESMExports();
  console.log = () => undefined;
  try {
    await startChat(adapter, registry);
    const firstQuestion = questions.shift();
    assert.ok(firstQuestion);
    await firstQuestion("first direct question");
    const secondQuestion = questions.shift();
    assert.ok(secondQuestion);
    await secondQuestion("second direct question");
  } finally {
    readlineModule.createInterface = originalCreateInterface;
    syncBuiltinESMExports();
    console.log = originalLog;
  }

  assert.equal(requests.length, 3);
  assert.equal(requests[0]?.options, undefined);
  assert.deepEqual(requests[1]?.options, {
    sessionState: {
      key: "direct-chat.responses",
      continuationId: "direct-state-a",
      fingerprint: "direct-chat-fingerprint",
    },
  });
  assert.equal(requests[2]?.options, undefined);
  assert.deepEqual(
    requests[1]?.messages.find((message) => message.role === "assistant")?.providerReplay,
    {
      key: "direct-chat.responses",
      outputItems: [{ type: "function_call", call_id: "direct-call" }],
    },
  );
  assert.deepEqual(
    requests[1]?.messages.find((message) => message.role === "assistant")?.thinkingBlocks,
    [{ type: "thinking", thinking: "direct plan", signature: "direct-sig" }],
  );
  const priorFinal = requests[2]?.messages
    .filter((message) => message.role === "assistant")
    .at(-1);
  assert.deepEqual(priorFinal, {
    role: "assistant",
    content: "first direct answer",
    providerReplay: {
      key: "direct-chat.responses",
      outputItems: [{ type: "message", id: "direct-message-b" }],
    },
  });
});

test("direct chat preserves an unknown tool receipt for the next user turn", async () => {
  type CreateInterface = typeof import("node:readline").createInterface;
  const readlineModule = createRequire(import.meta.url)("node:readline") as {
    createInterface: CreateInterface;
  };
  const originalCreateInterface = readlineModule.createInterface;
  const originalLog = console.log;
  const originalError = console.error;
  const questions: Array<(input: string) => unknown> = [];
  const requests: ChatMessage[][] = [];
  let adapterCalls = 0;
  const adapter: AIAdapter = {
    name: "direct-chat-unknown",
    model: "direct-chat-unknown-model",
    async chat(messages) {
      requests.push(structuredClone(messages));
      adapterCalls += 1;
      if (adapterCalls === 1) {
        return {
          toolCall: {
            id: "direct-unknown-call",
            name: "direct_unknown_effect",
            args: { value: "already attempted" },
          },
        };
      }
      return { text: "continued with receipt" };
    },
  };
  const registry = new ToolRegistry();
  registry.register(defineTool({
    name: "direct_unknown_effect",
    description: "Returns an effect whose outcome requires verification",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    handler: async () => ({
      success: false,
      error: "direct effect outcome is unknown",
      executionOutcome: "unknown" as const,
    }),
  }));

  readlineModule.createInterface = (() => ({
    question(_prompt: string, callback: (input: string) => unknown) {
      questions.push(callback);
    },
    close() {},
  })) as unknown as CreateInterface;
  syncBuiltinESMExports();
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await startChat(adapter, registry);
    const uncertainQuestion = questions.shift();
    assert.ok(uncertainQuestion);
    await uncertainQuestion("perform uncertain direct effect");
    assert.equal(
      adapterCalls,
      1,
      "direct chat must not continue the same turn after an unknown effect",
    );

    const nextQuestion = questions.shift();
    assert.ok(nextQuestion);
    await nextQuestion("continue after verification");
  } finally {
    readlineModule.createInterface = originalCreateInterface;
    syncBuiltinESMExports();
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], [
    { role: "user", content: "perform uncertain direct effect" },
    {
      role: "assistant",
      content: JSON.stringify({ value: "already attempted" }),
      toolCallId: "direct-unknown-call",
      toolName: "direct_unknown_effect",
    },
    {
      role: "tool",
      content: JSON.stringify({
        success: false,
        error: "direct effect outcome is unknown",
        executionOutcome: "unknown",
      }),
      toolCallId: "direct-unknown-call",
      toolName: "direct_unknown_effect",
    },
    { role: "user", content: "continue after verification" },
  ]);
});

test("agent and workflow loops thread continuation state and exact replay", async () => {
  const registry = new ToolRegistry();
  registry.register(defineTool({
    name: "loop_echo",
    description: "Echo a value for direct multi-round caller tests",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    handler: async ({ text }: { text: string }) => ok({ text }),
  }));

  for (const caller of ["agent", "workflow"] as const) {
    const requests: Array<{ messages: ChatMessage[]; options: unknown }> = [];
    let call = 0;
    const adapter: AIAdapter = {
      name: `${caller}-loop-mock`,
      model: `${caller}-loop-model`,
      sessionStateKey: `${caller}.responses`,
      async chat(messages, _registry, options) {
        requests.push({
          messages: structuredClone(messages),
          options: structuredClone(options),
        });
        call += 1;
        if (call === 1) {
          return {
            toolCall: { id: `${caller}-call`, name: "loop_echo", args: { text: caller } },
            thinking: [{
              type: "thinking",
              thinking: `${caller} plan`,
              signature: `${caller}-sig`,
            }],
            sessionState: {
              key: `${caller}.responses`,
              continuationId: `${caller}-state-a`,
              fingerprint: `${caller}-fingerprint`,
            },
            providerReplay: {
              key: `${caller}.responses`,
              outputItems: [{ type: "function_call", call_id: `${caller}-call` }],
            },
          };
        }
        return { text: `${caller} complete` };
      },
    };

    if (caller === "agent") {
      const agent = defineAgent({
        name: "stateful_agent",
        role: "State tester",
        goal: "Complete the state threading test",
        maxRounds: 2,
      });
      await agent.run("run agent loop", adapter, registry);
    } else {
      await llmStep(adapter, registry, "{{input}}")("run workflow loop");
    }

    assert.equal(requests.length, 2);
    const firstOptions = requests[0]?.options as Record<string, unknown> | undefined;
    assert.equal(firstOptions?.resetSession, true);
    assert.equal("sessionState" in (firstOptions ?? {}), false);
    const secondOptions = requests[1]?.options as Record<string, unknown> | undefined;
    assert.equal(secondOptions?.resetSession, false);
    assert.deepEqual(secondOptions?.sessionState, {
      key: `${caller}.responses`,
      continuationId: `${caller}-state-a`,
      fingerprint: `${caller}-fingerprint`,
    });
    assert.deepEqual(
      requests[1]?.messages.find((message) => message.role === "assistant")?.providerReplay,
      {
        key: `${caller}.responses`,
        outputItems: [{ type: "function_call", call_id: `${caller}-call` }],
      },
    );
    assert.deepEqual(
      requests[1]?.messages.find((message) => message.role === "assistant")?.thinkingBlocks,
      [{
        type: "thinking",
        thinking: `${caller} plan`,
        signature: `${caller}-sig`,
      }],
    );
  }
});

test("agent and workflow loops stop on the JSON-normalized unknown tool outcome", async () => {
  const registry = new ToolRegistry();
  let effectCount = 0;
  registry.register(defineTool({
    name: "serialized_unknown_loop_effect",
    description: "Exposes a different result through its JSON boundary",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      effectCount += 1;
      return {
        success: true,
        executionOutcome: "succeeded" as const,
        toJSON() {
          return {
            success: false,
            error: "serialized outcome is unknown",
            executionOutcome: "unknown" as const,
          };
        },
      };
    },
  }));

  for (const caller of ["agent", "workflow"] as const) {
    let adapterCalls = 0;
    const adapter: AIAdapter = {
      name: `${caller}-normalized-outcome`,
      model: "normalized-outcome-model",
      async chat() {
        adapterCalls += 1;
        if (adapterCalls === 1) {
          return {
            toolCall: {
              id: `${caller}-normalized-call`,
              name: "serialized_unknown_loop_effect",
              args: {},
            },
          };
        }
        return { text: "unsafe continuation" };
      },
    };

    if (caller === "agent") {
      const agent = defineAgent({
        name: "normalized_outcome_agent",
        role: "Outcome tester",
        goal: "Stop on uncertain effects",
      });
      await assert.rejects(agent.run("run it", adapter, registry), (error: unknown) => {
        assert.ok(error instanceof RunExecutionError);
        assert.equal(error.toolEffects?.certainty, "unknown");
        assert.equal(
          error.toolEffects?.receipts[0]?.result.executionOutcome,
          "unknown",
        );
        return true;
      });
    } else {
      await assert.rejects(
        llmStep(adapter, registry, "{{input}}")("run it"),
        (error: unknown) => {
          assert.ok(error instanceof RunExecutionError);
          assert.match(error.message, /outcome is unknown/i);
          assert.equal(error.run.status, "failed");
          assert.equal(error.run.stopReason, "error");
          assert.deepEqual(error.toolEffects, {
            state: "partial",
            certainty: "unknown",
            receipts: [{
              name: "serialized_unknown_loop_effect",
              args: {},
              result: {
                success: false,
                error: "serialized outcome is unknown",
                executionOutcome: "unknown",
              },
            }],
            verificationRequired:
              "verify tool side effects before deciding whether any retry is safe",
          });
          return true;
        },
      );
    }
    assert.equal(adapterCalls, 1, `${caller} must not continue after an unknown effect`);
  }
  assert.equal(effectCount, 2);
});

test("workflow LLM step preserves ordered known receipts when a later adapter call fails", async () => {
  const registry = new ToolRegistry();
  let effectCount = 0;
  registry.register(defineTool({
    name: "workflow_known_effect",
    description: "Records known workflow effects before an adapter failure",
    inputSchema: {
      type: "object",
      properties: { sequence: { type: "integer" } },
      required: ["sequence"],
    },
    handler: async ({ sequence }: { sequence: number }) => {
      effectCount += 1;
      return ok({ sequence, effectCount });
    },
  }));

  let adapterCalls = 0;
  const adapter: AIAdapter = {
    name: "workflow-known-effect-failure",
    model: "workflow-known-effect-model",
    async chat() {
      adapterCalls += 1;
      if (adapterCalls <= 2) {
        return {
          toolCall: {
            id: `workflow-known-call-${adapterCalls}`,
            name: "workflow_known_effect",
            args: { sequence: adapterCalls },
          },
        };
      }
      throw new Error("workflow adapter failed after known effects");
    },
  };

  await assert.rejects(
    llmStep(adapter, registry, "{{input}}")("run known effects"),
    (error: unknown) => {
      assert.ok(error instanceof RunExecutionError);
      assert.match(error.message, /adapter failed after known effects/);
      assert.equal(error.run.status, "failed");
      assert.equal(error.run.stopReason, "error");
      assert.deepEqual(error.toolEffects, {
        state: "partial",
        certainty: "known",
        receipts: [
          {
            name: "workflow_known_effect",
            args: { sequence: 1 },
            result: {
              success: true,
              data: { sequence: 1, effectCount: 1 },
              executionOutcome: "succeeded",
            },
          },
          {
            name: "workflow_known_effect",
            args: { sequence: 2 },
            result: {
              success: true,
              data: { sequence: 2, effectCount: 2 },
              executionOutcome: "succeeded",
            },
          },
        ],
      });
      assert.equal(error.toolEffects?.verificationRequired, undefined);
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /adapter failed after known effects/);
      return true;
    },
  );
  assert.equal(adapterCalls, 3);
  assert.equal(effectCount, 2);
});

test("workflow LLM step reports five-round exhaustion with every committed effect", async () => {
  const registry = new ToolRegistry();
  let effectCount = 0;
  registry.register(defineTool({
    name: "workflow_round_limit_effect",
    description: "Records each effect committed before the workflow round limit",
    inputSchema: {
      type: "object",
      properties: { round: { type: "integer" } },
      required: ["round"],
    },
    handler: async ({ round }: { round: number }) => {
      effectCount += 1;
      return ok({ round, effectCount });
    },
  }));

  let adapterCalls = 0;
  const adapter: AIAdapter = {
    name: "workflow-round-limit",
    model: "workflow-round-limit-model",
    async chat() {
      adapterCalls += 1;
      return {
        toolCall: {
          id: `workflow-round-limit-call-${adapterCalls}`,
          name: "workflow_round_limit_effect",
          args: { round: adapterCalls },
        },
      };
    },
  };

  await assert.rejects(
    llmStep(adapter, registry, "{{input}}")("run until the round limit"),
    (error: unknown) => {
      assert.ok(error instanceof RunExecutionError);
      assert.equal(error.message, "Workflow LLM step exceeded max rounds (5)");
      assert.equal(error.run.status, "limit_reached");
      assert.equal(error.run.stopReason, "max_rounds");
      assert.equal(error.run.manifest.limits.maxRounds, 5);
      assert.equal(error.run.error, undefined);
      assert.equal(typeof error.run.completedAt, "string");
      assert.equal(error.cause, undefined);
      assert.deepEqual(error.toolEffects, {
        state: "partial",
        certainty: "known",
        receipts: Array.from({ length: 5 }, (_, index) => ({
          name: "workflow_round_limit_effect",
          args: { round: index + 1 },
          result: {
            success: true,
            data: { round: index + 1, effectCount: index + 1 },
            executionOutcome: "succeeded",
          },
        })),
      });
      return true;
    },
  );
  assert.equal(adapterCalls, 5);
  assert.equal(effectCount, 5);
});

// ─────────────────────────────────────────────────────────────────────────
// adapters/openai.ts + adapters/xai.ts — Responses API session continuity
// ─────────────────────────────────────────────────────────────────────────

import { createOpenAIAdapter } from "../src/framework/adapters/openai.js";
import { createXAIAdapter } from "../src/framework/adapters/xai.js";
import { createHash as createProviderHash } from "node:crypto";
import type {
  AdapterContinuationRecovery as PublicAdapterContinuationRecovery,
  AdapterReplayPayload as PublicAdapterReplayPayload,
  AdapterSessionState as PublicAdapterSessionState,
  ChatOptions as PublicChatOptions,
  ToolCall as PublicToolCall,
} from "../src/framework/adapters/index.js";

interface ProviderFetchScript {
  status?: number;
  body: unknown;
}

/** Injectable provider transport with exact request recording. */
function createProviderFetchMock(responses: ProviderFetchScript[]) {
  const calls: Array<Record<string, unknown>> = [];
  const signals: Array<AbortSignal | undefined> = [];
  const urls: string[] = [];
  let i = 0;
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    if (typeof init?.body !== "string") {
      throw new Error("provider mock expected a JSON request body");
    }
    const next = responses[i++];
    if (!next) throw new Error(`provider mock has no scripted response for call ${i}`);
    urls.push(String(input));
    calls.push(JSON.parse(init.body) as Record<string, unknown>);
    signals.push(init.signal ?? undefined);
    const status = next.status ?? 200;
    const serialized = typeof next.body === "string"
      ? next.body
      : JSON.stringify(next.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return next.body;
      },
      async text() {
        return serialized;
      },
    } as Response;
  }) as typeof fetch;
  return { calls, fetchImpl, signals, urls };
}

function responsesOk(id = "resp_abc123", text = "ok") {
  return {
    id,
    output: [
      {
        id: `reasoning-${id}`,
        type: "reasoning",
        encrypted_content: `encrypted-${id}`,
        summary: [],
      },
      {
        id: `message-${id}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    ],
  };
}

test("openai Responses adapter: uses explicitly supplied continuation state", async () => {
  const firstResponse = responsesOk("resp_abc123");
  const mock = createProviderFetchMock([
    { body: firstResponse },
    { body: responsesOk("resp_next") },
  ]);
  const adapter = createOpenAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl });
  const registry = new ToolRegistry();
  const controller = new AbortController();

  const first = await adapter.chat([{ role: "user", content: "first" }], registry);
  assert.equal(first.sessionState?.key, "openai.responses");
  assert.equal(first.sessionState?.continuationId, "resp_abc123");
  assert.match(first.sessionState?.fingerprint ?? "", /^[a-f0-9]{64}$/);
  assert.equal(
    first.providerReplay?.outputItems,
    firstResponse.output,
    "the provider-native output array must be retained verbatim",
  );
  await adapter.chat(
    [
      { role: "user", content: "first" },
      {
        role: "assistant",
        content: "ok",
        providerReplay: first.providerReplay,
      },
      { role: "user", content: "second" },
    ],
    registry,
    {
      sessionState: first.sessionState,
      systemPrompt: "Continue under the current harness policy.",
      signal: controller.signal,
    },
  );

  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[0]?.previous_response_id, undefined);
  assert.equal(mock.calls[1]?.previous_response_id, "resp_abc123");
  assert.equal(
    mock.calls[1]?.instructions,
    "Continue under the current harness policy.",
    "OpenAI continuation requests must restate instructions",
  );
  assert.deepEqual(mock.calls[0]?.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(mock.calls[1]?.include, ["reasoning.encrypted_content"]);
  assert.equal(mock.signals[1], controller.signal, "adapter must forward the harness abort signal");
});

test("Responses continuation includes every tool output and following user after replay", async () => {
  for (const provider of ["openai", "xai"] as const) {
    const responseId = `${provider}-parallel-response`;
    const firstResponse = {
      id: responseId,
      output: [
        {
          id: `${provider}-reasoning`,
          type: "reasoning",
          encrypted_content: `${provider}-encrypted`,
          summary: [],
        },
        {
          type: "function_call",
          call_id: `${provider}-call-a`,
          name: "lookup",
          arguments: JSON.stringify({ query: "alpha" }),
        },
        {
          type: "function_call",
          call_id: `${provider}-call-b`,
          name: "lookup",
          arguments: JSON.stringify({ query: "beta" }),
        },
      ],
    };
    const mock = createProviderFetchMock([
      { body: firstResponse },
      { body: responsesOk(`${provider}-after-delta`) },
    ]);
    const adapter = provider === "openai"
      ? createOpenAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl })
      : createXAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl });
    const registry = new ToolRegistry();
    const first = await adapter.chat(
      [{ role: "user", content: "look up alpha and beta" }],
      registry,
    );
    const firstOutput = JSON.stringify({ success: true, data: { value: "alpha" } });
    const secondOutput = JSON.stringify({ success: true, data: { value: "beta" } });
    const history: ChatMessage[] = [
      { role: "user", content: "look up alpha and beta" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: `${provider}-call-a`, name: "lookup", args: { query: "alpha" } },
          { id: `${provider}-call-b`, name: "lookup", args: { query: "beta" } },
        ],
        providerReplay: first.providerReplay,
      },
      {
        role: "tool",
        content: firstOutput,
        toolCallId: `${provider}-call-a`,
        toolName: "lookup",
      },
      {
        role: "tool",
        content: secondOutput,
        toolCallId: `${provider}-call-b`,
        toolName: "lookup",
      },
      { role: "user", content: "now summarize both results" },
    ];

    await adapter.chat(history, registry, { sessionState: first.sessionState });

    assert.equal(mock.calls[1]?.previous_response_id, responseId);
    assert.deepEqual(mock.calls[1]?.input, [
      {
        type: "function_call_output",
        call_id: `${provider}-call-a`,
        output: firstOutput,
      },
      {
        type: "function_call_output",
        call_id: `${provider}-call-b`,
        output: secondOutput,
      },
      { role: "user", content: "now summarize both results" },
    ]);
  }
});

test("Responses continuation falls back to full replay without an aligned boundary", async () => {
  for (const provider of ["openai", "xai"] as const) {
    const firstResponse = responsesOk(`${provider}-unaligned`, "prior answer");
    const mock = createProviderFetchMock([
      { body: firstResponse },
      { body: responsesOk(`${provider}-stateless`) },
    ]);
    const adapter = provider === "openai"
      ? createOpenAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl })
      : createXAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl });
    const registry = new ToolRegistry();
    const first = await adapter.chat([{ role: "user", content: "first" }], registry);

    await adapter.chat([
      { role: "user", content: "first" },
      { role: "assistant", content: "prior answer" },
      { role: "user", content: "second" },
    ], registry, { sessionState: first.sessionState });

    assert.equal(mock.calls[1]?.previous_response_id, undefined);
    assert.deepEqual(mock.calls[1]?.input, [
      { role: "user", content: "first" },
      { role: "assistant", content: "prior answer" },
      { role: "user", content: "second" },
    ]);
  }
});

test("Responses adapters reconstruct full tool history when continuation state is absent", async () => {
  const replayItems = responsesOk("resp_prior", "prior answer").output;
  const history: ChatMessage[] = [
    { role: "user", content: "look up alpha" },
    {
      role: "assistant",
      content: "a normalized substitute that must not be serialized",
      providerReplay: {
        key: "openai.responses",
        outputItems: replayItems,
      },
    },
    { role: "user", content: "summarize it" },
  ];
  const expectedInput = [
    { role: "user", content: "look up alpha" },
    ...replayItems,
    { role: "user", content: "summarize it" },
  ];

  for (const provider of ["openai", "xai"] as const) {
    const mock = createProviderFetchMock([{ body: responsesOk(`resp_${provider}`) }]);
    const adapter = provider === "openai"
      ? createOpenAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl })
      : createXAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl });
    const providerHistory = history.map((message) => message.providerReplay
      ? {
          ...message,
          providerReplay: { ...message.providerReplay, key: `${provider}.responses` },
        }
      : message);
    await adapter.chat(providerHistory, new ToolRegistry());
    assert.deepEqual(
      mock.calls[0]?.input,
      expectedInput,
      `${provider} must replay raw reasoning and message phases exactly`,
    );
    assert.equal(mock.calls[0]?.previous_response_id, undefined);
  }
});

test("Responses adapters validate and serialize legacy normalized tool history", async () => {
  const history: ChatMessage[] = [
    { role: "user", content: "look up alpha" },
    {
      role: "assistant",
      content: JSON.stringify({ query: "alpha" }),
      toolCallId: "call-alpha",
      toolName: "lookup",
    },
    {
      role: "tool",
      content: JSON.stringify({ success: true, value: 42 }),
      toolCallId: "call-alpha",
      toolName: "lookup",
    },
  ];
  const expectedInput = [
    { role: "user", content: "look up alpha" },
    {
      type: "function_call",
      call_id: "call-alpha",
      name: "lookup",
      arguments: JSON.stringify({ query: "alpha" }),
    },
    {
      type: "function_call_output",
      call_id: "call-alpha",
      output: JSON.stringify({ success: true, value: 42 }),
    },
  ];

  for (const provider of ["openai", "xai"] as const) {
    const mock = createProviderFetchMock([{ body: responsesOk(`${provider}-legacy`) }]);
    const adapter = provider === "openai"
      ? createOpenAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl })
      : createXAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl });
    await adapter.chat(history, new ToolRegistry());
    assert.deepEqual(mock.calls[0]?.input, expectedInput);
  }
});

test("Responses adapters: reset and oneShot isolate the last fresh user input", async () => {
  const foreignState: PublicAdapterSessionState = {
    key: "foreign.responses",
    continuationId: "foreign-continuation",
    fingerprint: "foreign-fingerprint",
  };

  for (const provider of ["openai", "xai"] as const) {
    const mock = createProviderFetchMock([
      { body: responsesOk(`${provider}-reset`) },
      { body: responsesOk(`${provider}-one-shot`) },
    ]);
    const adapter = provider === "openai"
      ? createOpenAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl })
      : createXAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl });
    const registry = new ToolRegistry();

    const reset = await adapter.chat(
      [
        { role: "user", content: "old secret history" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "fresh reset input" },
        { role: "assistant", content: "ignored tail" },
      ],
      registry,
      { resetSession: true, sessionState: foreignState },
    );
    const oneShot = await adapter.chat(
      [
        { role: "user", content: "older history" },
        { role: "assistant", content: "older answer" },
        { role: "user", content: "fresh one-shot input" },
      ],
      registry,
      { oneShot: true, sessionState: foreignState },
    );

    assert.equal(mock.calls[0]?.input, "fresh reset input");
    assert.equal(mock.calls[1]?.input, "fresh one-shot input");
    assert.equal(mock.calls[0]?.previous_response_id, undefined);
    assert.equal(mock.calls[1]?.previous_response_id, undefined);
    assert.equal(reset.sessionState?.continuationId, `${provider}-reset`);
    assert.match(reset.sessionState?.fingerprint ?? "", /^[a-f0-9]{64}$/);
    assert.equal(oneShot.sessionState, undefined);
  }
});

test("Responses adapter fingerprints are stable and bind protocol, model, and endpoint", async () => {
  const registry = new ToolRegistry();
  const sameA = createProviderFetchMock([{ body: responsesOk("same-a") }]);
  const sameB = createProviderFetchMock([{ body: responsesOk("same-b") }]);
  const otherModel = createProviderFetchMock([{ body: responsesOk("other-model") }]);
  const otherProtocol = createProviderFetchMock([{ body: responsesOk("other-protocol") }]);

  const stateA = (await createOpenAIAdapter({
    apiKey: "test-key",
    model: "shared-model",
    fetchImpl: sameA.fetchImpl,
  }).chat([{ role: "user", content: "a" }], registry)).sessionState;
  const stateB = (await createOpenAIAdapter({
    apiKey: "test-key",
    model: "shared-model",
    fetchImpl: sameB.fetchImpl,
  }).chat([{ role: "user", content: "b" }], registry)).sessionState;
  const modelState = (await createOpenAIAdapter({
    apiKey: "test-key",
    model: "different-model",
    fetchImpl: otherModel.fetchImpl,
  }).chat([{ role: "user", content: "c" }], registry)).sessionState;
  const protocolState = (await createXAIAdapter({
    apiKey: "test-key",
    model: "shared-model",
    fetchImpl: otherProtocol.fetchImpl,
  }).chat([{ role: "user", content: "d" }], registry)).sessionState;

  assert.equal(stateA?.fingerprint, stateB?.fingerprint);
  assert.equal(
    stateA?.fingerprint,
    createProviderHash("sha256").update(JSON.stringify({
      endpoint: "https://api.openai.com/v1/responses",
      key: "openai.responses",
      model: "shared-model",
      version: 1,
    })).digest("hex"),
  );
  assert.notEqual(stateA?.fingerprint, modelState?.fingerprint);
  assert.notEqual(stateA?.fingerprint, protocolState?.fingerprint);
});

test("OpenAI fingerprint mismatch disables continuation and replays exact history", async () => {
  const firstResponse = responsesOk("model-a-response", "model A answer");
  const firstMock = createProviderFetchMock([{ body: firstResponse }]);
  const changedMock = createProviderFetchMock([{ body: responsesOk("model-b-response") }]);
  const registry = new ToolRegistry();
  const first = await createOpenAIAdapter({
    apiKey: "test-key",
    model: "model-a",
    fetchImpl: firstMock.fetchImpl,
  }).chat([{ role: "user", content: "first" }], registry);

  await createOpenAIAdapter({
    apiKey: "test-key",
    model: "model-b",
    fetchImpl: changedMock.fetchImpl,
  }).chat([
    { role: "user", content: "first" },
    {
      role: "assistant",
      content: "model A answer",
      providerReplay: first.providerReplay,
    },
    { role: "user", content: "second" },
  ], registry, { sessionState: first.sessionState });

  assert.equal(changedMock.calls[0]?.previous_response_id, undefined);
  assert.deepEqual(changedMock.calls[0]?.input, [
    { role: "user", content: "first" },
    ...firstResponse.output,
    { role: "user", content: "second" },
  ]);
});

test("xai Responses adapter: uses explicitly supplied continuation state", async () => {
  const firstResponse = responsesOk("xai-first");
  const mock = createProviderFetchMock([
    { body: firstResponse },
    { body: responsesOk("xai-same-prompt") },
    { body: responsesOk("xai-changed-prompt") },
  ]);
  const adapter = createXAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl });
  const registry = new ToolRegistry();
  const history: ChatMessage[] = [
    { role: "user", content: "first" },
  ];
  const first = await adapter.chat(history, registry, { systemPrompt: "policy A" });
  assert.match(first.sessionState?.instructionsSha256 ?? "", /^[a-f0-9]{64}$/);
  const followup: ChatMessage[] = [
    ...history,
    {
      role: "assistant",
      content: "ok",
      providerReplay: first.providerReplay,
    },
    { role: "user", content: "second" },
  ];

  await adapter.chat(followup, registry, {
    sessionState: first.sessionState,
    systemPrompt: "policy A",
  });
  const changed = await adapter.chat(followup, registry, {
    sessionState: first.sessionState,
    systemPrompt: "policy B",
  });

  assert.equal(mock.calls[1]?.previous_response_id, "xai-first");
  assert.equal(mock.calls[1]?.instructions, undefined);
  assert.deepEqual(mock.calls[1]?.include, ["reasoning.encrypted_content"]);
  assert.equal(
    mock.calls[2]?.previous_response_id,
    undefined,
    "a changed xAI prompt must invalidate provider continuation",
  );
  assert.equal(mock.calls[2]?.instructions, "policy B");
  assert.deepEqual(mock.calls[2]?.input, [
    { role: "user", content: "first" },
    ...firstResponse.output,
    { role: "user", content: "second" },
  ]);
  assert.notEqual(
    changed.sessionState?.instructionsSha256,
    first.sessionState?.instructionsSha256,
  );
});

test("Responses adapters recover a missing continuation once by exact stateless replay", async () => {
  for (const provider of ["openai", "xai"] as const) {
    const staleId = `${provider}-stale`;
    const firstResponse = responsesOk(staleId, "prior answer");
    const mock = createProviderFetchMock([
      { body: firstResponse },
      {
        status: 404,
        body: {
          error: {
            code: "previous_response_not_found",
            message: `Previous response ${staleId} was not found`,
          },
        },
      },
      { body: responsesOk(`${provider}-recovered`, "recovered answer") },
    ]);
    const adapter = provider === "openai"
      ? createOpenAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl })
      : createXAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl });
    const registry = new ToolRegistry();
    const first = await adapter.chat([{ role: "user", content: "first" }], registry);
    const history: ChatMessage[] = [
      { role: "user", content: "first" },
      {
        role: "assistant",
        content: "prior answer",
        providerReplay: first.providerReplay,
      },
      { role: "user", content: "second" },
    ];

    const recovered = await adapter.chat(history, registry, { sessionState: first.sessionState });

    assert.equal(mock.calls.length, 3, `${provider} must perform exactly one recovery request`);
    assert.equal(mock.calls[1]?.previous_response_id, staleId);
    assert.equal(mock.calls[1]?.input, "second");
    assert.equal(mock.calls[2]?.previous_response_id, undefined);
    assert.deepEqual(mock.calls[2]?.input, [
      { role: "user", content: "first" },
      ...firstResponse.output,
      { role: "user", content: "second" },
    ]);
    assert.deepEqual(recovered.continuationRecovery, {
      reason: "missing_or_expired",
      failedContinuationId: staleId,
    });
    assert.equal(recovered.sessionState?.continuationId, `${provider}-recovered`);
    if (provider === "openai") {
      assert.equal(typeof mock.calls[1]?.instructions, "string");
      assert.equal(mock.calls[2]?.instructions, mock.calls[1]?.instructions);
    } else {
      assert.equal(mock.calls[1]?.instructions, undefined);
      assert.equal(typeof mock.calls[2]?.instructions, "string");
    }
  }
});

test("Responses adapters never replay unrelated provider errors", async () => {
  for (const provider of ["openai", "xai"] as const) {
    const firstResponse = responsesOk(`${provider}-live`);
    const mock = createProviderFetchMock([
      { body: firstResponse },
      {
        status: 400,
        body: { error: { message: "previous_response_id is invalid for this request shape" } },
      },
    ]);
    const adapter = provider === "openai"
      ? createOpenAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl })
      : createXAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl });
    const registry = new ToolRegistry();
    const first = await adapter.chat([{ role: "user", content: "first" }], registry);

    await assert.rejects(
      adapter.chat([{ role: "user", content: "second" }], registry, {
        sessionState: first.sessionState,
      }),
      /invalid for this request shape/,
    );
    assert.equal(mock.calls.length, 2);
  }
});

test("Responses adapters reject malformed tool and replay history before fetch", async () => {
  for (const provider of ["openai", "xai"] as const) {
    const mock = createProviderFetchMock([]);
    const adapter = provider === "openai"
      ? createOpenAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl })
      : createXAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl });
    const registry = new ToolRegistry();

    await assert.rejects(
      adapter.chat([{
        role: "tool",
        content: "{}",
        toolCallId: "call-without-name",
      }], registry),
      /toolName must be a non-empty string/,
    );
    await assert.rejects(
      adapter.chat([{
        role: "assistant",
        content: "{not-json",
        toolCallId: "call-bad-json",
        toolName: "lookup",
      }], registry),
      /tool arguments must be valid JSON/,
    );

    const sparseItems: unknown[] = new Array(1);
    await assert.rejects(
      adapter.chat([
        { role: "user", content: "first" },
        {
          role: "assistant",
          content: "ignored",
          providerReplay: {
            key: `${provider}.responses`,
            outputItems: sparseItems,
          },
        },
      ], registry),
      /contains a sparse array/,
    );
    assert.equal(mock.calls.length, 0);
  }
});

test("Responses adapters preserve mixed preamble text and tool calls", async () => {
  for (const provider of ["openai", "xai"] as const) {
    const output = [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "I will check that now." }],
      },
      {
        type: "function_call",
        call_id: `${provider}-mixed-call`,
        name: "lookup",
        arguments: JSON.stringify({ query: "alpha" }),
      },
    ];
    const mock = createProviderFetchMock([{
      body: { id: `${provider}-mixed`, output },
    }]);
    const adapter = provider === "openai"
      ? createOpenAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl })
      : createXAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl });

    const response = await adapter.chat(
      [{ role: "user", content: "check alpha" }],
      new ToolRegistry(),
    );

    assert.equal(response.text, "I will check that now.");
    assert.deepEqual(response.toolCall, {
      id: `${provider}-mixed-call`,
      name: "lookup",
      args: { query: "alpha" },
    });
    assert.equal(response.providerReplay?.outputItems, output);
  }
});

test("Responses adapters fail closed on missing tool arguments and stateful response ids", async () => {
  for (const provider of ["openai", "xai"] as const) {
    const missingArguments = createProviderFetchMock([{
      body: {
        id: `${provider}-bad-call`,
        output: [{
          type: "function_call",
          call_id: `${provider}-call-without-arguments`,
          name: "dangerous_tool",
        }],
      },
    }]);
    const malformedAdapter = provider === "openai"
      ? createOpenAIAdapter({ apiKey: "test-key", fetchImpl: missingArguments.fetchImpl })
      : createXAIAdapter({ apiKey: "test-key", fetchImpl: missingArguments.fetchImpl });
    await assert.rejects(
      malformedAdapter.chat([{ role: "user", content: "run it" }], new ToolRegistry()),
      /arguments must be a non-empty JSON object string/,
    );

    const missingIds = createProviderFetchMock([
      { body: { output: responsesOk(`${provider}-unused`).output } },
      { body: { output: responsesOk(`${provider}-one-shot-unused`).output } },
    ]);
    const idAdapter = provider === "openai"
      ? createOpenAIAdapter({ apiKey: "test-key", fetchImpl: missingIds.fetchImpl })
      : createXAIAdapter({ apiKey: "test-key", fetchImpl: missingIds.fetchImpl });
    await assert.rejects(
      idAdapter.chat([{ role: "user", content: "stateful" }], new ToolRegistry()),
      /response id must be a non-empty string/,
    );
    const oneShot = await idAdapter.chat(
      [{ role: "user", content: "one shot" }],
      new ToolRegistry(),
      { oneShot: true },
    );
    assert.equal(oneShot.text, "ok");
    assert.equal(oneShot.sessionState, undefined);
  }
});

test("Responses adapters surface refusal content while retaining it for replay", async () => {
  for (const provider of ["openai", "xai"] as const) {
    const output = [{
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "refusal", refusal: "I cannot help with that." }],
    }];
    const mock = createProviderFetchMock([{
      body: { id: `${provider}-refusal`, output },
    }]);
    const adapter = provider === "openai"
      ? createOpenAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl })
      : createXAIAdapter({ apiKey: "test-key", fetchImpl: mock.fetchImpl });

    const response = await adapter.chat(
      [{ role: "user", content: "request" }],
      new ToolRegistry(),
    );
    assert.equal(response.text, "I cannot help with that.");
    assert.equal(response.providerReplay?.outputItems, output);
  }
});

test("adapter barrel exposes provider continuation and replay contracts", () => {
  const replay: PublicAdapterReplayPayload = {
    key: "openai.responses",
    outputItems: [],
  };
  const recovery: PublicAdapterContinuationRecovery = {
    reason: "missing_or_expired",
    failedContinuationId: "resp-old",
  };
  const state: PublicAdapterSessionState = {
    key: replay.key,
    continuationId: "resp-new",
    fingerprint: "fingerprint",
  };
  const toolCall: PublicToolCall = { id: "call", name: "tool", args: {} };
  const options: PublicChatOptions = { sessionState: state };

  assert.equal(options.sessionState?.key, replay.key);
  assert.equal(recovery.failedContinuationId, "resp-old");
  assert.equal(toolCall.name, "tool");
});

// ─────────────────────────────────────────────────────────────────────────
// chat-agent.ts — uses adapter injection (config.adapter) for unit testing
// ─────────────────────────────────────────────────────────────────────────

import { createChatAgent } from "../src/framework/chat-agent.js";
import { createChatAgentHttpServer } from "../src/framework/chat-agent-http.js";
import { RunExecutionError } from "../src/framework/runs.js";
import {
  digestJson,
  InMemorySessionEventStore,
  SessionKernel,
  type SessionEvent,
  type SessionEventStore,
} from "../src/framework/session.js";
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function resetCrashBoundaryStore(inner: InMemorySessionEventStore): {
  store: SessionEventStore;
  arm(): void;
} {
  let failNextReset = false;
  return {
    store: {
      read(sessionId) {
        return inner.read(sessionId);
      },
      append(event) {
        if (failNextReset && event.type === "session/reset") {
          failNextReset = false;
          throw new Error("simulated crash before reset journal commit");
        }
        inner.append(event);
      },
    },
    arm() {
      failNextReset = true;
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

test("chat-agent: durable sessions reject non-atomic conversation stores", async () => {
  const conversationName = uniqueStoreName();
  const factName = uniqueStoreName();
  try {
    const atomic = createStore<any>(conversationName);
    const legacy: Store<any> = {
      get: atomic.get,
      set: atomic.set,
      delete: atomic.delete,
      getAll: atomic.getAll,
      entries: atomic.entries,
      get size() {
        return atomic.size;
      },
      has: atomic.has,
      clear: atomic.clear,
    };

    await assert.rejects(
      () => createChatAgent({
        adapter: mockAdapter([{ text: "unused" }]),
        memory: {
          threadId: "durable-thread",
          conversationStore: legacy,
          factStore: createStore<any>(factName),
        },
        session: {
          id: "non-atomic-projection",
          threadId: "durable-thread",
          store: new InMemorySessionEventStore(),
        },
      }),
      /require a conversation Store with atomic mutate\(\) support/,
    );
  } finally {
    removeStoreFile(conversationName);
    removeStoreFile(factName);
  }
});

test("chat-agent: session journal is the model-history source of truth", async () => {
  const observedRequests: ChatMessage[][] = [];
  const adapter: AIAdapter = {
    name: "journal-mock",
    model: "journal-model",
    async chat(messages) {
      observedRequests.push(structuredClone(messages));
      return { text: "journal answer" };
    },
  };
  const store = new InMemorySessionEventStore();
  const agent = await createChatAgent({
    adapter,
    memory: false,
    session: { id: "journal-session", store },
  });

  const result = await agent.chat("journal question");
  const events = agent.getSessionEvents();
  const eventTypes = events.map((event) => event.type);
  const request = events.find((event) => event.type === "model/request-prepared");

  assert.equal(result.text, "journal answer");
  assert.deepEqual(eventTypes, [
    "session/started",
    "turn/started",
    "message/appended",
    "step/started",
    "model/request-prepared",
    "model/response-received",
    "message/appended",
    "step/completed",
    "turn/completed",
  ]);
  assert.ok(request && request.type === "model/request-prepared");
  assert.equal(request.data.history.throughSeq, request.seq - 1);
  assert.equal(request.data.history.messageCount, observedRequests[0]?.length);
  assert.equal(request.data.history.sha256, digestJson(observedRequests[0]));
  assert.equal("messages" in request.data, false, "request events must not duplicate full history");
  assert.equal("systemPrompt" in request.data, false, "request events must not store raw prompts");
  assert.deepEqual(agent.getHistory(), [
    { role: "user", content: "journal question" },
    { role: "assistant", content: "journal answer" },
  ]);
  assert.equal(events.at(-1)?.runId, result.run.manifest.runId);
  assert.equal(events.at(-1)?.correlationId, result.run.manifest.correlationId);
});

test("chat-agent: durable reopen restores its recorded thread and rejects thread bleed", async () => {
  const store = new InMemorySessionEventStore();
  const sessionId = "durable-thread-reopen";
  const first = await createChatAgent({
    adapter: mockAdapter([{ text: "answer one" }]),
    memory: false,
    session: { id: sessionId, threadId: "thread-a", store },
  });
  await first.chat("question one");

  const observed: ChatMessage[][] = [];
  const reopened = await createChatAgent({
    adapter: {
      name: "reopen-mock",
      model: "reopen-model",
      async chat(messages) {
        observed.push(structuredClone(messages));
        return { text: "answer two" };
      },
    },
    memory: false,
    session: { id: sessionId, store },
  });
  const result = await reopened.chat("question two");

  assert.equal(result.metadata.threadId, "thread-a");
  assert.deepEqual(observed[0], [
    { role: "user", content: "question one" },
    { role: "assistant", content: "answer one" },
    { role: "user", content: "question two" },
  ]);
  await assert.rejects(
    createChatAgent({
      adapter: mockAdapter([{ text: "must not run" }]),
      memory: false,
      session: { id: sessionId, threadId: "thread-b", store },
    }),
    /session journal belongs to thread thread-a, not thread-b/,
  );
});

test("chat-agent: repairs a failed memory projection before switching threads", async () => {
  const data = new Map<string, any>();
  let failedWrites = 0;
  let failNextWrite = true;
  const conversationStore = {
    get: (id: string) => data.get(id),
    set(id: string, value: any) {
      if (failNextWrite) {
        failNextWrite = false;
        failedWrites += 1;
        throw new Error("injected projection failure");
      }
      data.set(id, structuredClone(value));
    },
    delete: (id: string) => data.delete(id),
    getAll: () => [...data.values()],
    entries: () => [...data.entries()],
    get size() {
      return data.size;
    },
    has: (id: string) => data.has(id),
    clear: () => data.clear(),
  };
  const observed: ChatMessage[][] = [];
  let calls = 0;
  const agent = await createChatAgent({
    adapter: {
      name: "projection-mock",
      model: "projection-model",
      async chat(messages) {
        observed.push(structuredClone(messages));
        calls += 1;
        return { text: `answer ${calls}` };
      },
    },
    memory: {
      conversationStore,
      factStore: conversationStore,
      threadId: "thread-a",
    },
  });

  await agent.chat("question a1");
  await agent.chat("question b1", { threadId: "thread-b" });
  await agent.chat("question a2", { threadId: "thread-a" });

  assert.equal(failedWrites, 1);
  assert.deepEqual(observed[2], [
    { role: "user", content: "question a1" },
    { role: "assistant", content: "answer 1" },
    { role: "user", content: "question a2" },
  ]);
});

test("chat-agent: startup projection repair preserves a concurrent thread extension", async () => {
  const conversationName = uniqueStoreName();
  const factName = uniqueStoreName();
  const sessionStore = new InMemorySessionEventStore();
  const session = { id: "projection-cas-session", threadId: "shared-thread", store: sessionStore };
  try {
    const first = await createChatAgent({
      adapter: mockAdapter([{ text: "journal answer" }]),
      memory: {
        threadId: "shared-thread",
        conversationStore: createStore<any>(conversationName),
        factStore: createStore<any>(factName),
      },
      session,
    });
    await first.chat("journal question");

    createConversationMemory(createStore<any>(conversationName)).addMessage(
      "shared-thread",
      { role: "user", content: "concurrent live extension" },
    );

    await createChatAgent({
      adapter: mockAdapter([{ text: "unused" }]),
      memory: {
        threadId: "shared-thread",
        conversationStore: createStore<any>(conversationName),
        factStore: createStore<any>(factName),
      },
      session,
    });

    const persisted = createStore<any>(conversationName).get("shared-thread");
    assert.deepEqual(persisted?.messages.map((message: ChatMessage) => message.content), [
      "journal question",
      "journal answer",
      "concurrent live extension",
    ]);
  } finally {
    removeStoreFile(conversationName);
    removeStoreFile(factName);
  }
});

test("chat-agent: max-round exhaustion retains executed tool receipts and continuation", async () => {
  let effectCount = 0;
  let adapterCalls = 0;
  const observed: Array<{ messages: ChatMessage[]; state: unknown }> = [];
  const continuation = {
    key: "limit.responses",
    continuationId: "tool-response",
    fingerprint: digestJson("limit-fingerprint"),
  };
  const adapter: AIAdapter = {
    name: "limit-mock",
    model: "limit-model",
    sessionStateKey: continuation.key,
    async chat(messages, _registry, options) {
      observed.push({
        messages: structuredClone(messages),
        state: structuredClone(options?.sessionState),
      });
      adapterCalls += 1;
      if (adapterCalls === 1) {
        return {
          toolCall: { id: "effect-1", name: "perform_effect", args: {} },
          sessionState: continuation,
          providerReplay: {
            key: continuation.key,
            outputItems: [{ type: "function_call", call_id: "effect-1" }],
          },
        };
      }
      return { text: "The prior effect is still recorded." };
    },
  };
  const performEffect = defineTool({
    name: "perform_effect",
    description: "Perform one observable test effect",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      effectCount += 1;
      return ok({ effectCount });
    },
  });
  const agent = await createChatAgent({
    adapter,
    tools: [performEffect],
    memory: false,
    maxToolRounds: 1,
  });

  const limited = await agent.chat("perform it");
  assert.equal(limited.text, "(exceeded max tool calling rounds)");
  assert.equal(limited.run.status, "limit_reached");
  assert.equal(limited.run.toolEffects?.state, "partial");
  assert.equal(limited.run.toolEffects?.certainty, "known");
  assert.deepEqual(limited.run.toolEffects?.receipts.map((receipt) => ({
    name: receipt.name,
    outcome: receipt.result.executionOutcome,
  })), [{ name: "perform_effect", outcome: "succeeded" }]);
  assert.equal(effectCount, 1);
  assert.deepEqual(agent.getHistory().map((message) => message.role), [
    "user",
    "assistant",
    "tool",
  ]);

  await agent.chat("what happened?");
  assert.deepEqual(observed[1].messages.map((message) => message.role), [
    "user",
    "assistant",
    "tool",
    "user",
  ]);
  assert.deepEqual(observed[1].state, continuation);
});

test("chat-agent HTTP: known partial tool effects return 409 and are non-retryable", async () => {
  let adapterCalls = 0;
  let effectCount = 0;
  const effect = defineTool({
    name: "http_known_partial_effect",
    description: "Performs one known effect before an adapter failure",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      effectCount += 1;
      return ok({ effectCount });
    },
  });
  const agent = await createChatAgent({
    adapter: {
      name: "http-known-partial",
      model: "test-model",
      async chat() {
        adapterCalls += 1;
        if (adapterCalls === 1) {
          return {
            toolCall: {
              id: "http-known-partial-call",
              name: effect.name,
              args: {},
            },
          };
        }
        throw new Error("adapter failed after the effect committed");
      },
    },
    tools: [effect],
    memory: false,
  });
  const server = createChatAgentHttpServer(agent);

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const response = await fetch(`http://127.0.0.1:${address.port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "perform the effect" }),
    });
    const body = await response.json() as {
      retryable?: boolean;
      toolEffects?: {
        state: string;
        certainty: string;
        receipts: Array<{
          name: string;
          result: { success: boolean; executionOutcome?: string };
        }>;
      };
    };

    assert.equal(response.status, 409);
    assert.equal(body.retryable, false);
    assert.equal(body.toolEffects?.state, "partial");
    assert.equal(body.toolEffects?.certainty, "known");
    assert.deepEqual(body.toolEffects?.receipts, [{
      name: effect.name,
      args: {},
      result: {
        success: true,
        data: { effectCount: 1 },
        executionOutcome: "succeeded",
      },
    }]);
    assert.equal(effectCount, 1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});

test("chat-agent: normalized tool result is identical in history, journal, and receipts", async () => {
  const deceptiveResult = {
    success: true,
    executionOutcome: "succeeded" as const,
    toJSON() {
      return {
        success: false,
        error: "serialized result requires verification",
        executionOutcome: "unknown" as const,
        data: { source: "serialized" },
      };
    },
  };
  assert.deepEqual(normalizeToolResult("deceptive_result", deceptiveResult), {
    result: {
      success: false,
      error: "serialized result requires verification",
      executionOutcome: "unknown",
      data: { source: "serialized" },
    },
    modelContent: JSON.stringify({
      success: false,
      error: "serialized result requires verification",
      executionOutcome: "unknown",
      data: { source: "serialized" },
    }),
    outcome: "unknown",
  });

  const tool = defineTool({
    name: "deceptive_result",
    description: "Returns a result transformed by the JSON boundary",
    inputSchema: { type: "object", properties: {} },
    handler: async () => deceptiveResult,
  });
  const agent = await createChatAgent({
    adapter: mockAdapter([{
      toolCall: { id: "deceptive-call", name: tool.name, args: {} },
    }]),
    tools: [tool],
    memory: false,
  });

  await assert.rejects(agent.chat("run the deceptive tool"), (error: unknown) => {
    assert.ok(error instanceof RunExecutionError);
    assert.equal(error.toolEffects?.certainty, "unknown");
    assert.deepEqual(error.toolEffects?.receipts[0]?.result, {
      success: false,
      data: { source: "serialized" },
      error: "serialized result requires verification",
      executionOutcome: "unknown",
    });
    return true;
  });

  const resultEvent = agent.getSessionEvents().find(
    (event) => event.type === "tool/result" && event.data.toolCallId === "deceptive-call",
  );
  assert.equal(resultEvent?.type, "tool/result");
  if (resultEvent?.type !== "tool/result") return;
  assert.equal(resultEvent.data.outcome, "unknown");
  assert.deepEqual(resultEvent.data.result, {
    success: false,
    error: "serialized result requires verification",
    executionOutcome: "unknown",
    data: { source: "serialized" },
  });
  const modelContent = resultEvent.data.modelContent;
  if (modelContent === undefined) assert.fail("tool result event must retain model content");
  assert.deepEqual(JSON.parse(modelContent), resultEvent.data.result);
  const toolMessage = agent.getHistory().find(
    (message) => message.role === "tool" && message.toolCallId === "deceptive-call",
  );
  assert.equal(toolMessage?.content, modelContent);
});

test("chat-agent: terminalization failure cannot mask known partial effects", async () => {
  const inner = new InMemorySessionEventStore();
  let failRollbackOnce = true;
  const store: SessionEventStore = {
    read(sessionId) {
      return inner.read(sessionId);
    },
    append(event) {
      if (
        failRollbackOnce
        && event.type === "history/replaced"
        && event.data.reason === "turn_failed_partial_effects"
      ) {
        failRollbackOnce = false;
        throw new Error("rollback journal failed once");
      }
      inner.append(event);
    },
  };
  let effectCount = 0;
  let adapterCalls = 0;
  const effect = defineTool({
    name: "terminalization_known_effect",
    description: "Performs one effect before terminalization fails",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      effectCount += 1;
      return ok({ effectCount });
    },
  });
  const agent = await createChatAgent({
    adapter: {
      name: "terminalization-failure",
      model: "terminalization-model",
      async chat() {
        adapterCalls += 1;
        if (adapterCalls === 1) {
          return {
            toolCall: {
              id: "terminalization-call",
              name: effect.name,
              args: {},
            },
          };
        }
        throw new Error("adapter failed after known effect");
      },
    },
    tools: [effect],
    memory: false,
    session: { id: "terminalization-failure-session", store },
  });

  await assert.rejects(agent.chat("perform the effect"), (error: unknown) => {
    assert.ok(error instanceof RunExecutionError);
    assert.match(error.message, /adapter failed after known effect/);
    assert.equal(error.toolEffects?.state, "partial");
    assert.equal(error.toolEffects?.certainty, "known");
    assert.deepEqual(error.toolEffects?.receipts, [{
      name: effect.name,
      args: {},
      result: {
        success: true,
        data: { effectCount: 1 },
        executionOutcome: "succeeded",
      },
    }]);
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(
      error.cause.errors.some((cause) => (
        cause instanceof Error && /rollback journal failed once/.test(cause.message)
      )),
      true,
    );
    return true;
  });
  assert.equal(effectCount, 1);
  const events = agent.getSessionEvents();
  assert.equal(events.some((event) => event.type === "tool/result"), true);
  assert.equal(events.at(-1)?.type, "turn/failed");
});

test("chat-agent: completion-journal failure retains a structured known-effect error", async () => {
  const inner = new InMemorySessionEventStore();
  let failCompletionOnce = true;
  const store: SessionEventStore = {
    read(sessionId) {
      return inner.read(sessionId);
    },
    append(event) {
      if (failCompletionOnce && event.type === "turn/completed") {
        failCompletionOnce = false;
        throw new Error("turn completion journal failed once");
      }
      inner.append(event);
    },
  };
  let effectCount = 0;
  const effect = defineTool({
    name: "completion_commit_effect",
    description: "Performs one effect before the completion commit",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      effectCount += 1;
      return ok({ effectCount });
    },
  });
  const agent = await createChatAgent({
    adapter: mockAdapter([
      {
        toolCall: {
          id: "completion-commit-call",
          name: effect.name,
          args: {},
        },
      },
      { text: "model response that did not durably complete" },
    ]),
    tools: [effect],
    memory: false,
    session: { id: "completion-commit-session", store },
  });

  await assert.rejects(agent.chat("perform then answer"), (error: unknown) => {
    assert.ok(error instanceof RunExecutionError);
    assert.match(error.message, /turn completion journal failed once/);
    assert.equal(error.run.status, "failed");
    assert.equal(error.toolEffects?.state, "partial");
    assert.equal(error.toolEffects?.certainty, "known");
    assert.deepEqual(error.toolEffects?.receipts, [{
      name: effect.name,
      args: {},
      result: {
        success: true,
        data: { effectCount: 1 },
        executionOutcome: "succeeded",
      },
    }]);
    return true;
  });
  assert.equal(effectCount, 1);
  const events = agent.getSessionEvents();
  assert.equal(events.some((event) => event.type === "turn/completed"), false);
  assert.equal(events.at(-1)?.type, "turn/failed");
});

test("chat-agent: failed step admission closes the turn and permits the next turn", async () => {
  const inner = new InMemorySessionEventStore();
  let failStepStartOnce = true;
  const store: SessionEventStore = {
    read(sessionId) {
      return inner.read(sessionId);
    },
    append(event) {
      if (failStepStartOnce && event.type === "step/started") {
        failStepStartOnce = false;
        throw new Error("step admission journal failed once");
      }
      inner.append(event);
    },
  };
  let adapterCalls = 0;
  const agent = await createChatAgent({
    adapter: {
      name: "step-admission-failure",
      model: "step-admission-model",
      async chat() {
        adapterCalls += 1;
        return { text: "second turn succeeded" };
      },
    },
    memory: false,
    session: { id: "step-admission-failure-session", store },
  });

  await assert.rejects(agent.chat("first turn"), (error: unknown) => {
    assert.ok(error instanceof RunExecutionError);
    assert.match(error.message, /step admission journal failed once/);
    assert.equal(error.run.status, "failed");
    return true;
  });
  assert.equal(adapterCalls, 0);
  assert.equal(agent.getSessionEvents().at(-1)?.type, "turn/failed");
  assert.deepEqual(agent.getHistory(), []);

  const second = await agent.chat("second turn");
  assert.equal(second.text, "second turn succeeded");
  assert.equal(adapterCalls, 1);
  assert.equal(agent.getSessionEvents().at(-1)?.type, "turn/completed");
});

test("chat-agent: retains aligned continuation and replay after an uncertain tool outcome", async () => {
  const observedStates: unknown[] = [];
  let call = 0;
  const unserializable = defineTool({
    name: "unserializable_after_state",
    description: "Returns a value that cannot be serialized into model history",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ok({ value: 1n }),
  });
  const adapter: AIAdapter = {
    name: "stateful-mock",
    model: "stateful-model",
    sessionStateKey: "stateful.responses",
    async chat(_messages, _registry, options) {
      observedStates.push(options?.sessionState);
      call += 1;
      if (call === 1) {
        return {
          text: "first answer",
          sessionState: {
            key: "stateful.responses",
            continuationId: "continuation-a",
            fingerprint: "stateful-fingerprint",
          },
          providerReplay: {
            key: "stateful.responses",
            outputItems: [{ type: "message", id: "message-a" }],
          },
        };
      }
      if (call === 2) {
        return {
          toolCall: { id: "call-b", name: "unserializable_after_state", args: {} },
          sessionState: {
            key: "stateful.responses",
            continuationId: "continuation-b",
            fingerprint: "stateful-fingerprint",
          },
          providerReplay: {
            key: "stateful.responses",
            outputItems: [{ type: "function_call", call_id: "call-b" }],
          },
          continuationRecovery: {
            reason: "missing_or_expired",
            failedContinuationId: "expired-continuation",
          },
        };
      }
      return { text: "third answer" };
    },
  };
  const agent = await createChatAgent({
    adapter,
    memory: false,
    tools: [unserializable],
  });

  await agent.chat("first");
  await assert.rejects(agent.chat("second"), (error: unknown) => {
    assert.ok(error instanceof RunExecutionError);
    assert.match(
      error.message,
      /outcomes are unknown; verify side effects before deciding whether any retry is safe/i,
    );
    assert.equal(error.toolEffects?.certainty, "unknown");
    assert.equal(error.toolEffects?.state, "partial");
    assert.equal(
      error.toolEffects?.verificationRequired,
      "verify tool side effects before deciding whether any retry is safe",
    );
    assert.deepEqual(error.toolEffects?.receipts.map((receipt) => ({
      name: receipt.name,
      outcome: receipt.result.executionOutcome,
    })), [{ name: "unserializable_after_state", outcome: "unknown" }]);
    return true;
  });
  await agent.chat("third");

  assert.equal(observedStates[0], undefined);
  assert.deepEqual(observedStates[1], {
    key: "stateful.responses",
    continuationId: "continuation-a",
    fingerprint: "stateful-fingerprint",
  });
  assert.deepEqual(observedStates[2], {
    key: "stateful.responses",
    continuationId: "continuation-b",
    fingerprint: "stateful-fingerprint",
  });
  const retainedHistory = agent.getHistory();
  assert.deepEqual(retainedHistory.slice(0, 4), [
    { role: "user", content: "first" },
    {
      role: "assistant",
      content: "first answer",
      providerReplay: {
        key: "stateful.responses",
        outputItems: [{ type: "message", id: "message-a" }],
      },
    },
    { role: "user", content: "second" },
    {
      role: "assistant",
      content: "{}",
      toolCallId: "call-b",
      toolName: "unserializable_after_state",
      providerReplay: {
        key: "stateful.responses",
        outputItems: [{ type: "function_call", call_id: "call-b" }],
      },
    },
  ]);
  assert.equal(retainedHistory[4]?.role, "tool");
  assert.equal(retainedHistory[4]?.toolCallId, "call-b");
  assert.match(String(retainedHistory[4]?.content), /outcome is unknown.*serializ/i);
  assert.deepEqual(retainedHistory.slice(5), [
    { role: "user", content: "third" },
    { role: "assistant", content: "third answer" },
  ]);
  const events = agent.getSessionEvents();
  const stateUpdates = events.filter((event) => event.type === "adapter/state-updated");
  assert.deepEqual(stateUpdates.map((event) => event.data.state.continuationId), [
    "continuation-a",
    "continuation-b",
    "continuation-b",
  ]);
  assert.equal(events.some((event) => event.type === "adapter/state-cleared"), false);
  const responseEvent = events.filter(
    (event) => event.type === "model/response-received",
  )[1];
  assert.ok(responseEvent?.type === "model/response-received");
  assert.equal("sessionState" in responseEvent.data, false);
  assert.deepEqual(responseEvent.data.providerReplay, {
    key: "stateful.responses",
    outputItems: [{ type: "function_call", call_id: "call-b" }],
  });
  assert.deepEqual(responseEvent.data.continuationRecovery, {
    reason: "missing_or_expired",
    failedContinuationId: "expired-continuation",
  });
});

test("chat-agent: receipt persistence failure preserves unknown effects without retrying the tool", async () => {
  const inner = new InMemorySessionEventStore();
  let failNextToolResult = true;
  const store: SessionEventStore = {
    read(sessionId) {
      return inner.read(sessionId);
    },
    append(event: SessionEvent) {
      if (failNextToolResult && event.type === "tool/result") {
        failNextToolResult = false;
        throw new Error("injected tool receipt append failure");
      }
      inner.append(event);
    },
  };
  let effectCount = 0;
  const effect = defineTool({
    name: "uncertain_receipt_effect",
    description: "Performs an effect before losing its acknowledgement",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      effectCount += 1;
      throw new Error("effect acknowledgement lost");
    },
  });
  const adapter = mockAdapter([
    { toolCall: { id: "receipt-call", name: "uncertain_receipt_effect", args: {} } },
    { text: "continued after verification" },
  ]);
  const agent = await createChatAgent({
    adapter,
    memory: false,
    tools: [effect],
    session: { id: "receipt-persistence-failure", store },
  });

  await assert.rejects(agent.chat("perform the effect"), (error: unknown) => {
    assert.ok(error instanceof RunExecutionError);
    assert.equal(error.run.status, "failed");
    assert.equal(error.toolEffects?.certainty, "unknown");
    assert.equal(error.toolEffects?.receipts.length, 1);
    assert.equal(
      error.toolEffects?.receipts[0]?.result.executionOutcome,
      "unknown",
    );
    assert.match(
      error.toolEffects?.receipts[0]?.result.error ?? "",
      /durable tool result receipt was not recorded/i,
    );
    return true;
  });

  assert.equal(effectCount, 1);
  const recoveredEvents = agent.getSessionEvents();
  const recoveredResult = recoveredEvents.find(
    (event) => event.type === "tool/result" && event.data.toolCallId === "receipt-call",
  );
  assert.equal(recoveredResult?.type, "tool/result");
  if (recoveredResult?.type === "tool/result") {
    assert.equal(recoveredResult.data.outcome, "unknown");
  }
  const terminal = recoveredEvents.at(-1);
  assert.equal(terminal?.type, "turn/interrupted");
  if (terminal?.type === "turn/interrupted") {
    assert.equal(terminal.data.recovered, true);
  }

  const resumed = await agent.chat("continue after verification");
  assert.equal(resumed.text, "continued after verification");
  assert.equal(effectCount, 1, "journal recovery must never retry the tool");
});

test("chat-agent: persists an uncertain effect receipt before a fresh agent can resume", async () => {
  const storeName = uniqueStoreName();
  const conversationStore = createStore<any>(storeName);
  let effectCount = 0;
  const effect = defineTool({
    name: "persist_uncertain_effect",
    description: "Performs one effect and returns a deliberately unserializable receipt",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      effectCount += 1;
      return ok({ effectCount, value: 1n });
    },
  });

  try {
    const first = await createChatAgent({
      adapter: mockAdapter([{
        toolCall: { id: "effect-call", name: "persist_uncertain_effect", args: {} },
      }]),
      tools: [effect],
      memory: {
        conversation: true,
        facts: false,
        conversationStore,
        threadId: "effect-thread",
      },
    });
    await assert.rejects(
      first.chat("perform the effect"),
      /outcomes are unknown; verify side effects before deciding whether any retry is safe/i,
    );
    await first.close();

    const persisted = conversationStore.get("effect-thread") as
      | { messages: ChatMessage[] }
      | undefined;
    assert.deepEqual(persisted?.messages.map((message) => message.role), [
      "user",
      "assistant",
      "tool",
    ]);
    assert.match(String(persisted?.messages[2]?.content), /outcome is unknown.*serializ/i);

    const observed: ChatMessage[][] = [];
    const second = await createChatAgent({
      adapter: {
        name: "resume-after-effect",
        model: "resume-model",
        async chat(messages) {
          observed.push(structuredClone(messages));
          return { text: "resumed without rerunning the effect" };
        },
      },
      tools: [],
      memory: {
        conversation: true,
        facts: false,
        conversationStore,
        threadId: "effect-thread",
      },
    });
    await second.chat("continue after verification");

    assert.equal(effectCount, 1);
    assert.deepEqual(observed[0]?.slice(0, 3).map((message) => message.role), [
      "user",
      "assistant",
      "tool",
    ]);
    assert.match(String(observed[0]?.[2]?.content), /outcome is unknown.*serializ/i);
  } finally {
    removeStoreFile(storeName);
  }
});

test("chat-agent: failed turns remain auditable but leave the active projection clean", async () => {
  const adapter = mockAdapter([new Error("journal failure")]);
  const agent = await createChatAgent({ adapter, memory: false });

  await assert.rejects(agent.chat("do not orphan me"), /journal failure/);

  assert.deepEqual(agent.getHistory(), []);
  const events = agent.getSessionEvents();
  assert.equal(events.some((event) => event.type === "message/appended"), true);
  assert.equal(events.some((event) => event.type === "history/replaced"), true);
  assert.equal(events.at(-1)?.type, "turn/failed");
});

test("chat-agent: concurrent callers are serialized across the shared journal", async () => {
  let active = 0;
  let maxActive = 0;
  const adapter: AIAdapter = {
    name: "serial-mock",
    model: "serial-model",
    async chat(messages) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const latest = messages.at(-1);
      active -= 1;
      return { text: `answer:${String(latest?.content)}` };
    },
  };
  const agent = await createChatAgent({ adapter, memory: false });

  const [first, second] = await Promise.all([
    agent.chat("first"),
    agent.chat("second"),
  ]);

  assert.equal(maxActive, 1);
  assert.equal(first.text, "answer:first");
  assert.equal(second.text, "answer:second");
  assert.deepEqual(agent.getHistory().map((message) => message.content), [
    "first",
    "answer:first",
    "second",
    "answer:second",
  ]);
  const turns = agent.getSessionEvents().filter((event) => event.type === "turn/started");
  assert.equal(turns.length, 2);
  assert.notEqual(turns[0]?.turnId, turns[1]?.turnId);
});

test("chat-agent: closing a stream early interrupts the turn and restores history", async () => {
  const store = new InMemorySessionEventStore();
  const adapter: AIAdapter = {
    name: "early-close-mock",
    model: "early-close-model",
    sessionStateKey: "early-close.responses",
    async chat() {
      return {
        text: "visible before close",
        sessionState: {
          key: "early-close.responses",
          continuationId: "continuation-before-close",
          fingerprint: "early-close-fingerprint",
        },
      };
    },
  };
  const agent = await createChatAgent({
    adapter,
    memory: false,
    session: { id: "early-close-session", store },
  });

  const iterator = agent.chat("do not retain me", { stream: true })[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value?.type, "text");
  await iterator.return?.();

  assert.deepEqual(agent.getHistory(), []);
  const events = agent.getSessionEvents();
  const stepTerminal = [...events].reverse().find((event) => event.type === "step/completed");
  assert.ok(stepTerminal?.type === "step/completed");
  assert.equal(stepTerminal.data.outcome, "interrupted");
  assert.equal(events.at(-3)?.type, "history/replaced");
  assert.equal(events.at(-2)?.type, "adapter/state-cleared");
  assert.equal(events.at(-1)?.type, "turn/interrupted");

  const replayed = new SessionKernel({ sessionId: "early-close-session", store });
  assert.equal(replayed.getAdapterSessionState("early-close.responses"), undefined);
  assert.equal(replayed.recoverInterrupted().length, 0, "early close must leave no open work");
});

test("chat-agent: abort restores state A and replay after receiving state B", async () => {
  const observedStates: unknown[] = [];
  let call = 0;
  const adapter: AIAdapter = {
    name: "abort-restore-mock",
    model: "abort-restore-model",
    sessionStateKey: "abort-restore.responses",
    async chat(_messages, _registry, options) {
      observedStates.push(options?.sessionState);
      call += 1;
      if (call === 1) {
        return {
          text: "state A answer",
          sessionState: {
            key: "abort-restore.responses",
            continuationId: "state-a",
            fingerprint: "abort-restore-fingerprint",
          },
          providerReplay: {
            key: "abort-restore.responses",
            outputItems: [{ type: "message", id: "message-a" }],
          },
        };
      }
      if (call === 2) {
        return {
          text: "state B answer",
          sessionState: {
            key: "abort-restore.responses",
            continuationId: "state-b",
            fingerprint: "abort-restore-fingerprint",
          },
          providerReplay: {
            key: "abort-restore.responses",
            outputItems: [{ type: "message", id: "message-b" }],
          },
        };
      }
      return { text: "answer after abort" };
    },
  };
  const agent = await createChatAgent({ adapter, memory: false });
  await agent.chat("establish A");

  const controller = new AbortController();
  const iterator = agent.chat("attempt B", {
    stream: true,
    signal: controller.signal,
  })[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.deepEqual(first.value, { type: "text", text: "state B answer" });
  controller.abort(new Error("abort state B"));
  await assert.rejects(iterator.next(), /abort state B/);

  await agent.chat("after abort");
  assert.deepEqual(observedStates, [
    undefined,
    {
      key: "abort-restore.responses",
      continuationId: "state-a",
      fingerprint: "abort-restore-fingerprint",
    },
    {
      key: "abort-restore.responses",
      continuationId: "state-a",
      fingerprint: "abort-restore-fingerprint",
    },
  ]);
  assert.deepEqual(agent.getHistory(), [
    { role: "user", content: "establish A" },
    {
      role: "assistant",
      content: "state A answer",
      providerReplay: {
        key: "abort-restore.responses",
        outputItems: [{ type: "message", id: "message-a" }],
      },
    },
    { role: "user", content: "after abort" },
    { role: "assistant", content: "answer after abort" },
  ]);
  const updates = agent.getSessionEvents().filter(
    (event) => event.type === "adapter/state-updated",
  );
  assert.deepEqual(updates.map((event) => event.data.state.continuationId), [
    "state-a",
    "state-b",
    "state-a",
  ]);
});

test("chat-agent: closing at a tool-call chunk never starts the tool", async () => {
  let executions = 0;
  const sideEffect = defineTool({
    name: "side_effect",
    description: "counts executions",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      executions += 1;
      return ok({ executions });
    },
  });
  const agent = await createChatAgent({
    adapter: mockAdapter([{ toolCall: { id: "call-close", name: "side_effect", args: {} } }]),
    tools: [sideEffect],
    memory: false,
  });

  const iterator = agent.chat("start a tool", { stream: true })[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value?.type, "tool_call");
  await iterator.return?.();

  assert.equal(executions, 0);
  assert.equal(
    agent.getSessionEvents().some((event) => event.type === "tool/execution-started"),
    false,
  );
  assert.equal(agent.getSessionEvents().at(-1)?.type, "turn/interrupted");
  assert.deepEqual(agent.getHistory(), []);
});

test("chat-agent: a pre-aborted turn is never admitted", async () => {
  let adapterCalls = 0;
  const adapter: AIAdapter = {
    name: "pre-abort-mock",
    model: "pre-abort-model",
    async chat() {
      adapterCalls += 1;
      return { text: "should not run" };
    },
  };
  const agent = await createChatAgent({ adapter, memory: false });
  const controller = new AbortController();
  controller.abort(new Error("cancel before admission"));

  await assert.rejects(
    agent.chat("never admit", { signal: controller.signal }),
    /cancel before admission/,
  );
  assert.equal(adapterCalls, 0);
  assert.deepEqual(agent.getHistory(), []);
  assert.deepEqual(agent.getSessionEvents().map((event) => event.type), ["session/started"]);
});

test("chat-agent: abort removes a queued turn without poisoning FIFO progress", async () => {
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  let adapterCalls = 0;
  const adapter: AIAdapter = {
    name: "queued-abort-mock",
    model: "queued-abort-model",
    async chat(messages) {
      adapterCalls += 1;
      if (adapterCalls === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return { text: `answer:${String(messages.at(-1)?.content)}` };
    },
  };
  const agent = await createChatAgent({ adapter, memory: false });
  const first = agent.chat("first");
  await firstStarted.promise;

  const controller = new AbortController();
  const cancelled = agent.chat("cancelled while queued", { signal: controller.signal });
  await nextEventLoopTurn();
  controller.abort(new Error("cancel queued turn"));
  await assert.rejects(cancelled, /cancel queued turn/);
  assert.equal(
    agent.getSessionEvents().filter((event) => event.type === "turn/started").length,
    1,
    "cancelled queued work must never be admitted",
  );

  const third = agent.chat("third");
  releaseFirst.resolve();
  assert.equal((await first).text, "answer:first");
  assert.equal((await third).text, "answer:third");
  assert.equal(adapterCalls, 2);
});

test("chat-agent: abort after a model response interrupts and clears continuation state", async () => {
  const started = deferred<void>();
  const response = deferred<AdapterResponse>();
  let observedSignal: AbortSignal | undefined;
  const adapter: AIAdapter = {
    name: "inflight-abort-mock",
    model: "inflight-abort-model",
    sessionStateKey: "inflight.responses",
    async chat(_messages, _registry, options) {
      observedSignal = options?.signal;
      started.resolve();
      return response.promise;
    },
  };
  const agent = await createChatAgent({ adapter, memory: false });
  const controller = new AbortController();
  const turn = agent.chat("abort after response", { signal: controller.signal });
  await started.promise;
  controller.abort(new Error("operator cancelled"));
  response.resolve({
    text: "late answer",
    sessionState: {
      key: "inflight.responses",
      continuationId: "late-continuation",
      fingerprint: "inflight-fingerprint",
    },
  });

  await assert.rejects(turn, (error: unknown) => {
    assert.ok(error instanceof RunExecutionError);
    assert.match(error.message, /operator cancelled/);
    assert.equal(error.run.status, "cancelled");
    assert.equal(error.run.cancellation?.effects, "none");
    return true;
  });
  assert.equal(observedSignal, controller.signal);
  assert.deepEqual(agent.getHistory(), []);
  const events = agent.getSessionEvents();
  assert.equal(events.some((event) => event.type === "turn/failed"), false);
  assert.equal(events.some((event) => event.type === "adapter/state-updated"), true);
  assert.equal(events.at(-2)?.type, "adapter/state-cleared");
  assert.equal(events.at(-1)?.type, "turn/interrupted");
});

test("chat-agent: abort waits for started tools before interrupting the turn", async () => {
  const toolStarted = deferred<void>();
  const releaseTool = deferred<void>();
  const slow = defineTool({
    name: "slow_abortable_boundary",
    description: "Waits so cancellation can be observed at the harness boundary",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      toolStarted.resolve();
      await releaseTool.promise;
      return ok({ finished: true });
    },
  });
  const adapter = mockAdapter([{
    toolCall: { id: "call-abort", name: "slow_abortable_boundary", args: {} },
  }]);
  const agent = await createChatAgent({ adapter, tools: [slow], memory: false });
  const controller = new AbortController();
  let turnSettled = false;
  const turn = agent.chat("run and abort", { signal: controller.signal }).finally(() => {
    turnSettled = true;
  });
  await toolStarted.promise;
  controller.abort(new Error("stop after tool start"));
  await nextEventLoopTurn();
  assert.equal(turnSettled, false, "started tool must settle before turn closure");

  releaseTool.resolve();
  await assert.rejects(turn, (error: unknown) => {
    assert.ok(error instanceof RunExecutionError);
    assert.match(error.message, /stop after tool start/);
    assert.equal(error.run.status, "cancelled");
    assert.equal(error.run.cancellation?.effects, "partial");
    return true;
  });
  const events = agent.getSessionEvents();
  const resultIndex = events.findIndex((event) => event.type === "tool/result");
  const stepIndex = events.findIndex((event) => event.type === "step/completed");
  const turnIndex = events.findIndex((event) => event.type === "turn/interrupted");
  assert.ok(resultIndex >= 0 && resultIndex < stepIndex);
  assert.ok(stepIndex < turnIndex);
  assert.equal(events[stepIndex]?.type, "step/completed");
  if (events[stepIndex]?.type === "step/completed") {
    assert.equal(events[stepIndex].data.outcome, "interrupted");
  }
  assert.deepEqual(agent.getHistory(), [
    { role: "user", content: "run and abort" },
    {
      role: "assistant",
      content: "{}",
      toolCallId: "call-abort",
      toolName: "slow_abortable_boundary",
    },
    {
      role: "tool",
      content: JSON.stringify({ success: true, data: { finished: true } }),
      toolCallId: "call-abort",
      toolName: "slow_abortable_boundary",
    },
  ]);
});

test("chat-agent: parallel tool failures settle every started execution before turn failure", async () => {
  const slowStarted = deferred<void>();
  const releaseSlow = deferred<void>();
  const store = new InMemorySessionEventStore();
  const unserializable = defineTool({
    name: "unserializable",
    description: "returns a value the event journal cannot encode",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ok({ value: 1n }),
  });
  const slow = defineTool({
    name: "slow",
    description: "waits for explicit release",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      slowStarted.resolve();
      await releaseSlow.promise;
      return ok({ finished: true });
    },
  });
  const agent = await createChatAgent({
    adapter: mockAdapter([{
      toolCalls: [
        { id: "call-bad", name: "unserializable", args: {} },
        { id: "call-slow", name: "slow", args: {} },
      ],
    }]),
    tools: [unserializable, slow],
    memory: false,
    session: { id: "parallel-failure-session", store },
  });

  let turnSettled = false;
  const turn = agent.chat("run both").finally(() => {
    turnSettled = true;
  });
  await slowStarted.promise;
  await nextEventLoopTurn();
  assert.equal(turnSettled, false, "turn must await the still-running sibling tool");

  releaseSlow.resolve();
  await assert.rejects(
    turn,
    /outcomes are unknown; verify side effects before deciding whether any retry is safe/i,
  );

  const events = agent.getSessionEvents();
  const resultEvents = events.filter((event) => event.type === "tool/result");
  assert.deepEqual(resultEvents.map((event) => event.data.toolCallId).sort(), [
    "call-bad",
    "call-slow",
  ]);
  const unknown = resultEvents.find((event) => event.data.toolCallId === "call-bad");
  assert.equal(unknown?.data.outcome, "unknown");
  const lastResultIndex = Math.max(...resultEvents.map((event) => events.indexOf(event)));
  const stepTerminalIndex = events.findIndex((event) => event.type === "step/completed");
  const turnTerminalIndex = events.findIndex((event) => event.type === "turn/failed");
  assert.ok(lastResultIndex < stepTerminalIndex);
  assert.ok(stepTerminalIndex < turnTerminalIndex);
  const lengthAtFailure = events.length;
  await nextEventLoopTurn();
  assert.equal(agent.getSessionEvents().length, lengthAtFailure, "no tool may append after closure");
  const retained = agent.getHistory();
  assert.deepEqual(retained.map((message) => message.role), [
    "user",
    "assistant",
    "tool",
    "tool",
  ]);
  assert.equal(retained[2]?.toolCallId, "call-bad");
  assert.match(String(retained[2]?.content), /outcome is unknown.*serializ/i);
  assert.equal(retained[3]?.toolCallId, "call-slow");

  const replayed = new SessionKernel({ sessionId: "parallel-failure-session", store });
  assert.equal(replayed.recoverInterrupted().length, 0, "failed turn must close all tool state");
});

test("chat-agent: reset serializes behind an active turn", async () => {
  const started = deferred<void>();
  const response = deferred<AdapterResponse>();
  const adapter: AIAdapter = {
    name: "reset-queue-mock",
    model: "reset-queue-model",
    async chat() {
      started.resolve();
      return response.promise;
    },
  };
  const agent = await createChatAgent({ adapter, memory: false });
  const turn = agent.chat("finish before reset");
  await started.promise;

  let resetSettled = false;
  assert.throws(() => agent.reset(), /use resetAsync\(\)/);
  const reset = agent.resetAsync().then(() => {
    resetSettled = true;
  });
  await nextEventLoopTurn();
  assert.equal(resetSettled, false);

  response.resolve({ text: "finished" });
  await turn;
  await reset;
  assert.deepEqual(agent.getHistory(), []);
  const types = agent.getSessionEvents().map((event) => event.type);
  assert.ok(types.indexOf("turn/completed") < types.indexOf("session/reset"));
});

test("chat-agent: stable reset reopens the same durable journal with empty history", async () => {
  const store = new InMemorySessionEventStore();
  const session = {
    id: "stable-reset-session",
    threadId: "stable-reset-thread",
    store,
  };
  const first = await createChatAgent({
    adapter: mockAdapter([{ text: "before reset" }]),
    memory: false,
    session,
  });
  await first.chat("remember this");
  assert.equal(first.getHistory().length, 2);

  await first.reset();
  assert.deepEqual(first.getHistory(), []);
  assert.equal(first.getSessionEvents().at(-1)?.type, "session/reset");
  await first.close();

  const reopened = await createChatAgent({
    adapter: mockAdapter([{ text: "after reset" }]),
    memory: false,
    session,
  });
  assert.deepEqual(reopened.getHistory(), []);
  assert.equal(await reopened.ingestExternalMessage("resume instruction", { id: "mail-1" }), true);
  assert.equal(await reopened.ingestExternalMessage("duplicate", { id: "mail-1" }), false);
  assert.deepEqual(reopened.getHistory(), [{ role: "user", content: "resume instruction" }]);
  await reopened.close();

  const reopenedAgain = await createChatAgent({
    adapter: mockAdapter([{ text: "unused" }]),
    memory: false,
    session,
  });
  assert.equal(await reopenedAgain.ingestExternalMessage("duplicate after reopen", { id: "mail-1" }), false);
  assert.deepEqual(reopenedAgain.getHistory(), [{ role: "user", content: "resume instruction" }]);
});

test("chat-agent: an explicit memory thread remains pinned across reset and delete", async () => {
  const conversationName = uniqueStoreName();
  const sessionStore = new InMemorySessionEventStore();
  const session = { id: "memory-thread-reset-session", store: sessionStore };
  const memory = {
    threadId: "memory-stable-thread",
    facts: false,
    conversationStore: createStore<any>(conversationName),
  };
  try {
    const first = await createChatAgent({
      adapter: mockAdapter([{ text: "before memory-thread reset" }]),
      memory,
      session,
    });
    await first.chat("remember this on the stable memory thread");
    await first.resetAsync();
    assert.equal(first.getSessionEvents().at(-1)?.type, "session/reset");
    const resetEvent = first.getSessionEvents().at(-1);
    if (resetEvent?.type === "session/reset") {
      assert.equal(resetEvent.data.threadId, "memory-stable-thread");
    }
    await first.close();

    const reopened = await createChatAgent({
      adapter: mockAdapter([{ text: "unused" }]),
      memory,
      session,
    });
    assert.deepEqual(reopened.getHistory(), []);
    assert.equal(reopened.deleteThread("memory-stable-thread"), true);
    const deleteReset = reopened.getSessionEvents().at(-1);
    assert.equal(deleteReset?.type, "session/reset");
    if (deleteReset?.type === "session/reset") {
      assert.equal(deleteReset.data.threadId, "memory-stable-thread");
    }
    await reopened.close();

    const reopenedAfterDelete = await createChatAgent({
      adapter: mockAdapter([{ text: "unused" }]),
      memory,
      session,
    });
    assert.deepEqual(reopenedAfterDelete.getHistory(), []);
  } finally {
    removeStoreFile(conversationName);
  }
});

test("chat-agent: reset crash between projection and journal commit restores the authoritative history", async () => {
  const conversationName = uniqueStoreName();
  const factName = uniqueStoreName();
  const inner = new InMemorySessionEventStore();
  const boundary = resetCrashBoundaryStore(inner);
  const threadId = "reset-crash-thread";
  const session = { id: "reset-crash-session", threadId, store: boundary.store };

  try {
    const first = await createChatAgent({
      adapter: mockAdapter([{ text: "old answer" }]),
      memory: {
        threadId,
        conversationStore: createStore<any>(conversationName),
        factStore: createStore<any>(factName),
      },
      session,
    });
    await first.chat("old question");

    boundary.arm();
    await assert.rejects(
      first.resetAsync(),
      /simulated crash before reset journal commit/,
    );
    assert.deepEqual(
      createStore<any>(conversationName).get(threadId)?.messages,
      [],
      "the compatibility projection is cleared before attempting the journal reset",
    );
    assert.equal(
      inner.read(session.id).some((event) => event.type === "session/reset"),
      false,
      "the injected crash leaves the authoritative reset uncommitted",
    );

    const observed: ChatMessage[][] = [];
    const reopened = await createChatAgent({
      adapter: {
        name: "reset-crash-reopen",
        model: "test-model",
        async chat(messages) {
          observed.push(structuredClone(messages));
          return { text: `answer-${observed.length}` };
        },
      },
      memory: {
        threadId,
        conversationStore: createStore<any>(conversationName),
        factStore: createStore<any>(factName),
      },
      session,
    });
    assert.equal(
      createStore<any>(conversationName).get(threadId)?.messages.length,
      2,
      "startup repairs the prematurely cleared projection from the old journal",
    );

    await reopened.chat("question elsewhere", { threadId: "other-thread" });
    await reopened.chat("question after reopen", { threadId });
    assert.deepEqual(observed[1]?.slice(0, 2), [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
    ]);
  } finally {
    removeStoreFile(conversationName);
    removeStoreFile(factName);
  }
});

test("chat-agent: deleting a pinned durable thread preserves its reopen identity", async () => {
  const conversationName = uniqueStoreName();
  const factName = uniqueStoreName();
  const store = new InMemorySessionEventStore();
  const pinnedThreadId = "pinned-delete-thread";
  const session = {
    id: "pinned-delete-session",
    threadId: pinnedThreadId,
    store,
  };

  try {
    const first = await createChatAgent({
      adapter: mockAdapter([{ text: "old answer" }]),
      memory: {
        threadId: pinnedThreadId,
        conversationStore: createStore<any>(conversationName),
        factStore: createStore<any>(factName),
      },
      session,
    });
    await first.chat("old question");
    assert.deepEqual(first.listThreads(), [pinnedThreadId]);

    assert.equal(await first.deleteThread(pinnedThreadId), true);
    assert.deepEqual(first.getHistory(), []);
    assert.deepEqual(first.listThreads(), []);
    const reset = first.getSessionEvents().at(-1);
    assert.ok(reset?.type === "session/reset");
    assert.equal(reset.data.threadId, pinnedThreadId);
    await first.close();

    const observedRequests: ChatMessage[][] = [];
    const reopened = await createChatAgent({
      adapter: {
        name: "pinned-delete-reopen",
        model: "test-model",
        async chat(messages) {
          observedRequests.push(structuredClone(messages));
          return { text: "new answer" };
        },
      },
      memory: {
        threadId: pinnedThreadId,
        conversationStore: createStore<any>(conversationName),
        factStore: createStore<any>(factName),
      },
      session,
    });
    assert.deepEqual(reopened.getHistory(), []);

    const result = await reopened.chat("new question");
    assert.equal(result.metadata.threadId, pinnedThreadId);
    assert.deepEqual(observedRequests[0], [
      { role: "user", content: "new question" },
    ]);
    await reopened.close();
  } finally {
    removeStoreFile(conversationName);
    removeStoreFile(factName);
  }
});

test("chat-agent: pinned delete crash between projection and journal commit restores the thread", async () => {
  const conversationName = uniqueStoreName();
  const factName = uniqueStoreName();
  const inner = new InMemorySessionEventStore();
  const boundary = resetCrashBoundaryStore(inner);
  const threadId = "delete-crash-thread";
  const session = { id: "delete-crash-session", threadId, store: boundary.store };

  try {
    const first = await createChatAgent({
      adapter: mockAdapter([{ text: "old delete answer" }]),
      memory: {
        threadId,
        conversationStore: createStore<any>(conversationName),
        factStore: createStore<any>(factName),
      },
      session,
    });
    await first.chat("old delete question");

    boundary.arm();
    await assert.rejects(
      first.deleteThreadAsync(threadId),
      /simulated crash before reset journal commit/,
    );
    assert.equal(
      createStore<any>(conversationName).has(threadId),
      false,
      "the compatibility projection is deleted before attempting the journal reset",
    );
    assert.equal(
      inner.read(session.id).some((event) => event.type === "session/reset"),
      false,
      "the injected crash leaves the authoritative delete uncommitted",
    );

    const observed: ChatMessage[][] = [];
    const reopened = await createChatAgent({
      adapter: {
        name: "delete-crash-reopen",
        model: "test-model",
        async chat(messages) {
          observed.push(structuredClone(messages));
          return { text: `answer-${observed.length}` };
        },
      },
      memory: {
        threadId,
        conversationStore: createStore<any>(conversationName),
        factStore: createStore<any>(factName),
      },
      session,
    });
    assert.equal(
      createStore<any>(conversationName).get(threadId)?.messages.length,
      2,
      "startup repairs the prematurely deleted projection from the old journal",
    );

    await reopened.chat("question elsewhere", { threadId: "other-delete-thread" });
    await reopened.chat("question after reopen", { threadId });
    assert.deepEqual(observed[1]?.slice(0, 2), [
      { role: "user", content: "old delete question" },
      { role: "assistant", content: "old delete answer" },
    ]);
  } finally {
    removeStoreFile(conversationName);
    removeStoreFile(factName);
  }
});

test("chat-agent: stable reset cannot resurrect cleared conversation memory", async () => {
  const observedRequests: ChatMessage[][] = [];
  const adapter: AIAdapter = {
    name: "stable-reset-memory",
    model: "test-model",
    async chat(messages) {
      observedRequests.push(structuredClone(messages));
      return { text: `answer-${observedRequests.length}` };
    },
  };
  const agent = await createChatAgent({
    adapter,
    memory: {
      threadId: "thread-A",
      conversationStore: createStore<any>(uniqueStoreName()),
      factStore: createStore<any>(uniqueStoreName()),
    },
  });

  await agent.chat("secret-old", { threadId: "thread-A" });
  await agent.reset({ threadId: "thread-A" });
  await agent.chat("question-B", { threadId: "thread-B" });
  await agent.chat("question-A-new", { threadId: "thread-A" });

  assert.equal(
    JSON.stringify(observedRequests.at(-1)).includes("secret-old"),
    false,
    "switching back to a stably reset thread must not rehydrate its old projection",
  );
});

test("chat-agent: reset to another identity clears that thread's stale projection", async () => {
  const conversationName = uniqueStoreName();
  const factName = uniqueStoreName();
  const conversationStore = createStore<any>(conversationName);
  try {
    const seeded = createConversationMemory(conversationStore);
    seeded.addMessages("thread-B", [
      { role: "user", content: "stale-B" },
      { role: "assistant", content: "old-answer" },
    ]);

    const observed: ChatMessage[][] = [];
    const agent = await createChatAgent({
      adapter: {
        name: "reset-destination",
        model: "test-model",
        async chat(messages) {
          observed.push(structuredClone(messages));
          return { text: `answer-${observed.length}` };
        },
      },
      memory: {
        threadId: "thread-A",
        conversationStore,
        factStore: createStore<any>(factName),
      },
    });

    await agent.chat("question-A");
    agent.reset({ threadId: "thread-B" });
    await agent.chat("question-C", { threadId: "thread-C" });
    await agent.chat("question-B-new", { threadId: "thread-B" });

    assert.deepEqual(observed.at(-1), [
      { role: "user", content: "question-B-new" },
    ]);
  } finally {
    removeStoreFile(conversationName);
    removeStoreFile(factName);
  }
});

test("chat-agent: deleteThread serializes behind an active turn", async () => {
  const started = deferred<void>();
  const response = deferred<AdapterResponse>();
  const conversationStore = createStore<any>(uniqueStoreName());
  const factStore = createStore<any>(uniqueStoreName());
  const adapter: AIAdapter = {
    name: "delete-queue-mock",
    model: "delete-queue-model",
    async chat() {
      started.resolve();
      return response.promise;
    },
  };
  const agent = await createChatAgent({
    adapter,
    memory: { conversationStore, factStore, threadId: "active" },
  });
  const turn = agent.chat("finish before deletion");
  await started.promise;

  let deletionSettled = false;
  assert.throws(() => agent.deleteThread("active"), /use deleteThreadAsync\(\)/);
  const deletion = agent.deleteThreadAsync("active").then((removed) => {
    deletionSettled = true;
    return removed;
  });
  await nextEventLoopTurn();
  assert.equal(deletionSettled, false);

  response.resolve({ text: "finished" });
  await turn;
  assert.equal(await deletion, true);
  assert.deepEqual(agent.getHistory(), []);
  assert.equal(agent.getSessionEvents().at(-1)?.type, "session/reset");
});

test("chat-agent: destroy serializes behind an active turn", async () => {
  const started = deferred<void>();
  const response = deferred<AdapterResponse>();
  const adapter: AIAdapter = {
    name: "destroy-queue-mock",
    model: "destroy-queue-model",
    async chat() {
      started.resolve();
      return response.promise;
    },
  };
  const agent = await createChatAgent({ adapter, memory: false });
  const turn = agent.chat("finish before destroy");
  await started.promise;

  let destroySettled = false;
  const destroy = agent.destroy().then(() => {
    destroySettled = true;
  });
  await nextEventLoopTurn();
  assert.equal(destroySettled, false);

  response.resolve({ text: "finished" });
  await turn;
  await destroy;
  const types = agent.getSessionEvents().map((event) => event.type);
  assert.ok(types.indexOf("turn/completed") < types.indexOf("session/destroyed"));
  assert.equal(types.at(-1), "session/destroyed");
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
  assert.deepEqual(
    agent.getHistory(),
    [],
    "an empty response must not leave an orphan user message in model history",
  );
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
  assert.equal(await agent.deleteThread("alpha"), true);
  assert.deepEqual(agent.listThreads(), ["beta"]);

  // Delete the active thread — agent should rotate to a fresh thread
  const activeBefore = "beta";
  assert.equal(await agent.deleteThread(activeBefore), true);
  assert.equal(agent.getHistory().length, 0);
  assert.deepEqual(agent.listThreads(), []);
  const anonymousReset = agent.getSessionEvents().at(-1);
  assert.ok(anonymousReset?.type === "session/reset");
  assert.notEqual(
    anonymousReset.data.threadId,
    activeBefore,
    "an unpinned active thread should still rotate to a fresh identity",
  );

  // Deleting a missing thread returns false
  assert.equal(await agent.deleteThread("never-existed"), false);
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

    // The incomplete turn is not a valid conversation pair. Neither the
    // orphan user message nor the synthetic placeholder should be persisted.
    const thread = conversationStore.get("test-thread") as
      | { messages: Array<{ role: string; content: string }> }
      | undefined;
    assert.equal(thread, undefined);
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
