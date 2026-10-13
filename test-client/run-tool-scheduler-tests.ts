import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolScheduler, type BoundToolScheduler } from "../src/framework/tool-scheduler.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function tick() { await new Promise<void>((done) => setImmediate(done)); }

test("parallel-safe admissions are bounded across batches; exclusive is a FIFO barrier", async () => {
  const scheduler = new ToolScheduler({ maxParallel: 2 });
  const starts: string[] = [];
  const a = gate(), b = gate(), writer = gate(), last = gate();
  const run = (name: string, mode: "parallel-safe" | "exclusive", hold: ReturnType<typeof gate>) =>
    scheduler.run(mode, async () => { starts.push(name); await hold.promise; return name; });
  const firstBatch = [run("a", "parallel-safe", a), run("b", "parallel-safe", b)];
  const secondBatch = [run("write", "exclusive", writer), run("last", "parallel-safe", last)];
  assert.deepEqual(starts, ["a", "b"]);
  a.resolve(); await tick();
  assert.deepEqual(starts, ["a", "b"]);
  b.resolve(); await tick();
  assert.deepEqual(starts, ["a", "b", "write"]);
  writer.resolve(); await tick();
  assert.deepEqual(starts, ["a", "b", "write", "last"]);
  last.resolve();
  assert.deepEqual(await Promise.all([...firstBatch, ...secondBatch]), ["a", "b", "write", "last"]);
});

test("default cap is four; invalid caps safely degrade to one", async () => {
  assert.equal(new ToolScheduler().maxParallel, 4);
  for (const cap of [NaN, Infinity, -1, 0, 1.5]) {
    const scheduler = new ToolScheduler({ maxParallel: cap });
    assert.equal(scheduler.maxParallel, 1);
    const first = gate(); let started = 0;
    const a = scheduler.run("parallel-safe", async () => { started++; await first.promise; });
    const b = scheduler.run("parallel-safe", async () => { started++; });
    assert.equal(started, 1);
    first.resolve(); await Promise.all([a, b]);
    assert.equal(started, 2);
  }
});

test("abort removes queued calls, preserves started result, and permits later admissions", async () => {
  const scheduler = new ToolScheduler(); const controller = new AbortController(); const first = gate();
  const starts: number[] = [];
  const a = scheduler.run("exclusive", async () => { starts.push(1); await first.promise; return "effect committed"; }, { signal: controller.signal });
  const b = scheduler.run("exclusive", async () => { starts.push(2); }, { signal: controller.signal });
  const rejected = assert.rejects(b, { name: "AbortError" });
  controller.abort(); await rejected;
  const c = scheduler.run("exclusive", async () => { starts.push(3); });
  first.resolve();
  assert.equal(await a, "effect committed"); await c;
  assert.deepEqual(starts, [1, 3]);
});

test("absolute deadline prevents queued admission using supplied clock", async () => {
  const scheduler = new ToolScheduler(); const hold = gate(); let now = 100; let called = false;
  const a = scheduler.run("exclusive", async () => { await hold.promise; });
  const b = scheduler.run("exclusive", async () => { called = true; }, { deadline: 200, clock: () => now });
  const rejected = assert.rejects(b, { name: "TimeoutError" });
  now = 201; hold.resolve(); await a; await rejected;
  assert.equal(called, false);
});

test("nested trusted reservation does not deadlock and serializes exclusive siblings", async () => {
  const scheduler = new ToolScheduler(); const hold = gate(); const starts: string[] = [];
  let retired!: BoundToolScheduler;
  const result = scheduler.run("exclusive", async (child) => {
    retired = child;
    const first = child.run("exclusive", async (grandchild) => {
      starts.push("first");
      await grandchild.run("exclusive", async () => { starts.push("grandchild"); });
      await hold.promise;
    });
    const second = child.run("exclusive", async () => { starts.push("second"); return 7; });
    await first; return await second;
  });
  await tick(); assert.deepEqual(starts, ["first", "grandchild"]);
  hold.resolve(); assert.equal(await result, 7);
  assert.deepEqual(starts, ["first", "grandchild", "second"]);
  await assert.rejects(retired.run("exclusive", async () => {}), /no longer active/);
});

test("parallel-safe child cannot upgrade to exclusive", async () => {
  const scheduler = new ToolScheduler(); let called = false;
  await scheduler.run("parallel-safe", async (child) => {
    await assert.rejects(child.run("exclusive", async () => { called = true; }), /Cannot upgrade/);
    assert.equal(await child.run("parallel-safe", async () => 8), 8);
  });
  assert.equal(called, false);
});

test("normal direct admission never inherits nested reservation; unawaited child holds barrier", async () => {
  const scheduler = new ToolScheduler(); const hold = gate(); const starts: string[] = [];
  const first = scheduler.run("exclusive", async (child) => {
    void child.run("exclusive", async () => { starts.push("child"); await hold.promise; });
  });
  const second = scheduler.run("exclusive", async () => { starts.push("second"); });
  await tick(); assert.deepEqual(starts, ["child"]);
  hold.resolve(); await Promise.all([first, second]);
  assert.deepEqual(starts, ["child", "second"]);
});

test("nested options cannot weaken inherited cancellation or deadline", async () => {
  const scheduler = new ToolScheduler(); const controller = new AbortController(); let now = 100;
  await scheduler.run("exclusive", async (child) => {
    now = 201;
    await assert.rejects(child.run("exclusive", async () => {}, { deadline: 500 }), { name: "TimeoutError" });
  }, { deadline: 200, clock: () => now });
  await scheduler.run("exclusive", async (child) => {
    controller.abort();
    await assert.rejects(child.run("exclusive", async () => {}, { signal: new AbortController().signal }), { name: "AbortError" });
  }, { signal: controller.signal });
});
