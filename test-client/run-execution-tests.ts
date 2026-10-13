import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ToolRegistry } from "../src/framework/registry.js";
import { capabilityDigest } from "../src/framework/executor.js";
import { ExecutionJournal } from "../src/framework/execution-journal.js";
import { defineTool, ok } from "../src/framework/tool.js";
import type { ToolDefinition } from "../src/framework/types.js";
import type { ExecutionJournalEvent, ToolExecutionContext } from "../src/framework/execution-types.js";

function fixture(handler: ToolDefinition["handler"], extra: Partial<ToolDefinition> = {}) {
  return defineTool({ name: "fixture_effect", description: "An independently observed fixture effect",
    inputSchema: { type: "object", properties: { value: { type: "integer", minimum: 1 } }, required: ["value"], additionalProperties: false },
    handler, ...extra });
}

test("admission rejects malformed arguments, unknown tools, and pre-start cancellation without effects", async () => {
  let effects = 0;
  const registry = new ToolRegistry();
  registry.register(fixture(async () => { effects++; return ok(effects); }));
  const signal = AbortSignal.abort();
  for (const [name, args, context] of [
    ["fixture_effect", { value: 0 }, {}], ["missing", { value: 1 }, {}],
    ["fixture_effect", { value: 1 }, { signal }], ["fixture_effect", null, {}],
    ["fixture_effect", { value: Number.POSITIVE_INFINITY }, {}],
  ] as [string, Record<string, unknown>, ToolExecutionContext][]) {
    const execution = await registry.executeDetailed(name, args, context);
    assert.equal(execution.receipt.phase, "not_started");
    assert.equal(execution.receipt.admission, "rejected");
  }
  assert.equal(effects, 0);
});

test("authority references supplied without a validating policy cannot authorize required tools", async () => {
  let effects = 0;
  const registry = new ToolRegistry();
  registry.register(fixture(async () => { effects++; return ok(effects); }, {
    contract: { version: "1", useWhen: [], doNotUseWhen: [], sideEffects: ["fixture"], commitmentClass: "C1", idempotency: "non_idempotent", requiresAuthority: true },
  }));
  const execution = await registry.executeDetailed("fixture_effect", { value: 1 }, { actor: { kind: "local_user", id: "test" }, authorityGrantRefs: ["model-made-reference"] });
  assert.equal(execution.receipt.phase, "not_started");
  assert.ok(execution.receipt.reasonCodes.includes("approval_required"));
  assert.equal(effects, 0);
});

test("projected callers retain governed policy and reject captured stale catalog", async () => {
  let effects = 0;
  const registry = new ToolRegistry({ mode: "governed", policy: { authorize: ({ context }) => ({ decision: context.actor?.id === "trusted" ? "allow" : "deny" }) } });
  const tool = fixture(async () => { effects++; return ok(effects); });
  registry.register(tool);
  const projected = registry.project({ names: [tool.name] });
  assert.equal((await projected.executeDetailed(tool.name, { value: 1 })).receipt.phase, "not_started");
  registry.unregister(tool.name);
  registry.register({ ...tool, description: "Changed reviewed implementation specification" });
  assert.equal((await projected.executeDetailed(tool.name, { value: 1 }, { actor: { kind: "host", id: "trusted" } })).receipt.phase, "not_started");
  assert.equal((await projected.executeDetailed(tool.name, { value: 1 }, {
    actor: { kind: "host", id: "trusted" },
    expectedCapabilityDigest: capabilityDigest(registry.get(tool.name)!),
  })).receipt.phase, "not_started", "Caller expectations cannot replace the projected catalog ceiling");
  assert.equal(effects, 0);
});

test("removed tools are unavailable from existing projections", async () => {
  const registry = new ToolRegistry();
  registry.register(fixture(async () => ok("effect")));
  const projected = registry.project({});
  registry.unregister("fixture_effect");
  assert.equal((await projected.executeDetailed("fixture_effect", { value: 1 })).receipt.phase, "not_started");
});

test("projection policies cannot extend expired root authority or erase a valid binding", async () => {
  let effects = 0;
  const registry = new ToolRegistry({ mode: "governed", clock: () => 1000, policy: {
    authorize: () => ({ decision: "allow", authorityGrantRefs: ["root-grant"], expiresAt: 1 }),
  } });
  registry.register(fixture(async () => { effects++; return ok(effects); }));
  const projected = registry.project({}, { authorize: () => ({ decision: "allow", expiresAt: 5000 }) });
  assert.equal((await projected.executeDetailed("fixture_effect", { value: 1 })).receipt.phase, "not_started");
  assert.equal(effects, 0);
  const bound = new ToolRegistry({ policy: { authorize: () => ({ decision: "allow", authorizationContextId: "trusted-policy-binding" }) } });
  bound.register(fixture(async () => ok("effect"), {
    contract: { version: "1", useWhen: [], doNotUseWhen: [], sideEffects: ["fixture"], commitmentClass: "C1", idempotency: "non_idempotent", requiresAuthority: true },
  }));
  assert.equal((await bound.project({}, { authorize: () => ({ decision: "allow" }) }).executeDetailed("fixture_effect", { value: 1 })).outcome, "succeeded");
});

test("queued invocation reauthorizes after grant revocation", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let allowed = true;
  let effects = 0;
  const registry = new ToolRegistry({ mode: "governed", policy: { authorize: () => ({ decision: allowed ? "allow" : "deny" }) } });
  registry.register(fixture(async ({ value }) => { effects++; if (value === 1) await held; return ok(value); }));
  const first = registry.executeDetailed("fixture_effect", { value: 1 });
  // Wait for the independently visible first effect, without timing assumptions.
  while (effects === 0) await new Promise(resolve => setImmediate(resolve));
  const second = registry.executeDetailed("fixture_effect", { value: 2 });
  await new Promise(resolve => setImmediate(resolve));
  allowed = false;
  release();
  assert.equal((await first).outcome, "succeeded");
  assert.equal((await second).receipt.phase, "not_started");
  assert.equal(effects, 1);
});

test("serialization hooks execute once and the journal, model, and caller agree", async () => {
  let hooks = 0;
  const events: ExecutionJournalEvent[] = [];
  const registry = new ToolRegistry({ journal: { record: event => { events.push(event); } } });
  registry.register(fixture(async () => ok({ toJSON() { hooks++; return { committed: true }; } })));
  const execution = await registry.executeDetailed("fixture_effect", { value: 1 });
  assert.equal(hooks, 1);
  assert.deepEqual(JSON.parse(execution.modelContent), execution.result);
  assert.deepEqual(events.at(-1)?.data.result, execution.result);
  assert.equal(events.at(-1)?.data.modelContent, execution.modelContent);
});

test("revocation during durable start prevents handler entry and retains a not-started receipt", async () => {
  let allowed = true;
  let effects = 0;
  const registry = new ToolRegistry({ mode: "governed",
    policy: { authorize: () => ({ decision: allowed ? "allow" : "deny" }) },
    journal: { record: event => { if (event.type === "started") allowed = false; } },
  });
  registry.register(fixture(async () => { effects++; return ok(effects); }));
  const execution = await registry.executeDetailed("fixture_effect", { value: 1 });
  assert.equal(effects, 0);
  assert.equal(execution.receipt.phase, "not_started");
  assert.equal(execution.receipt.admission, "rejected");
});

test("policy I/O failure after durable intent is not an unknown physical effect", async () => {
  let calls = 0;
  let effects = 0;
  const registry = new ToolRegistry({ mode: "governed", policy: {
    authorize: () => { calls++; if (calls === 3) throw new Error("Policy backend disconnected"); return { decision: "allow" }; },
  } });
  registry.register(fixture(async () => { effects++; return ok(effects); }));
  const execution = await registry.executeDetailed("fixture_effect", { value: 1 });
  assert.equal(effects, 0);
  assert.equal(execution.receipt.phase, "not_started");
  assert.equal(execution.outcome, "failed");
});

test("throws and invalid outputs remain unknown after independently observed effects", async () => {
  for (const behavior of ["throw", "bigint", "cycle", "schema"] as const) {
    let effect = false;
    const registry = new ToolRegistry();
    registry.register(fixture(async () => {
      effect = true;
      if (behavior === "throw") throw new Error("Response lost after committing");
      if (behavior === "bigint") return ok(BigInt(1));
      if (behavior === "cycle") { const cycle: Record<string, unknown> = {}; cycle.self = cycle; return ok(cycle); }
      return ok({ invalid: true });
    }, behavior === "schema" ? { outputSchema: { type: "object", properties: { changed: { type: "boolean" } }, required: ["changed"] } } : {}));
    const execution = await registry.executeDetailed("fixture_effect", { value: 1 });
    assert.equal(effect, true);
    assert.equal(execution.outcome, "unknown");
    assert.notEqual(execution.receipt.phase, "not_started");
    assert.ok(execution.receipt.reconciliation);
  }
});

test("late cancellation preserves a committed canonical result and reaches the handler", async () => {
  const controller = new AbortController();
  let boundSignal: AbortSignal | undefined;
  const registry = new ToolRegistry();
  registry.register(fixture(async (_params, context) => {
    boundSignal = context?.signal;
    controller.abort();
    return ok({ committed: true });
  }));
  const execution = await registry.executeDetailed("fixture_effect", { value: 1 }, { signal: controller.signal });
  assert.equal(boundSignal?.aborted, true);
  assert.equal(execution.result.success, true);
  assert.equal(execution.outcome, "succeeded");
  assert.equal(execution.receipt.cancellationObserved, true);
});

test("known failures retain certainty with an output schema and malformed rich payloads stay unknown", async () => {
  const registry = new ToolRegistry();
  registry.register(fixture(async () => ({ success: false, error: "Independently rejected before mutation" }), {
    outputSchema: { type: "object", properties: { committed: { type: "boolean" } }, required: ["committed"] },
  }));
  assert.equal((await registry.executeDetailed("fixture_effect", { value: 1 })).outcome, "failed");
  registry.register(fixture(async () => ({ success: true, structuredContent: null } as unknown as Awaited<ReturnType<ToolDefinition["handler"]>>)));
  assert.equal((await registry.executeDetailed("fixture_effect", { value: 1 })).outcome, "unknown");
});

test("journal failure before handler entry produces no effect", async () => {
  let effects = 0;
  const registry = new ToolRegistry({ logger: {}, journal: { record: event => { if (event.type === "started") throw new Error("Disk unavailable"); } } });
  registry.register(fixture(async () => { effects++; return ok(effects); }));
  const execution = await registry.executeDetailed("fixture_effect", { value: 1 });
  assert.equal(effects, 0);
  assert.equal(execution.receipt.phase, "not_started");
});

test("result persistence failure preserves useful data and truthful delivery uncertainty", async () => {
  let effects = 0;
  const registry = new ToolRegistry({ logger: {}, journal: { record: event => { if (event.type === "settled") throw new Error("Disk unavailable"); } } });
  registry.register(fixture(async () => { effects++; return ok({ committed: true }); }));
  const execution = await registry.executeDetailed("fixture_effect", { value: 1 });
  assert.equal(effects, 1);
  assert.equal(execution.outcome, "unknown");
  assert.deepEqual(execution.result.data, { committed: true });
  assert.equal(execution.receipt.errorCategory, "journal_delivery_failed");
});

test("durable recorded execution reopens exactly and recovery is effect-free", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "of-executor-"));
  try {
    const journal = new ExecutionJournal({ rootDir, streamId: "test", scopeDigest: "workspace-test" });
    let effects = 0;
    const registry = new ToolRegistry({ journal });
    registry.register(fixture(async () => { effects++; return ok({ committed: true }); }));
    const execution = await registry.executeDetailed("fixture_effect", { value: 1 });
    const reopened = new ExecutionJournal({ rootDir, streamId: "test", scopeDigest: "workspace-test" });
    const recovered = reopened.getExecution(execution.receipt.executionId);
    assert.equal(recovered?.state, "settled");
    assert.equal(recovered?.settled?.modelContent, execution.modelContent);
    assert.deepEqual(recovered?.settled?.result, execution.result);
    assert.equal(effects, 1);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("explicit stale capability is denied even with valid arguments and policy", async () => {
  let effects = 0;
  const registry = new ToolRegistry();
  const tool = fixture(async () => { effects++; return ok(effects); });
  const captured = capabilityDigest(tool);
  registry.register(tool);
  tool.description = "Changed after host discovery";
  assert.equal((await registry.executeDetailed(tool.name, { value: 1 }, { expectedCapabilityDigest: captured })).receipt.phase, "not_started");
  assert.equal(effects, 0);
});

test("implicit recursion fails instead of deadlocking; trusted nested calls keep actor/scope", async () => {
  const registry = new ToolRegistry();
  registry.register(fixture(async () => ok("child")));
  registry.register(fixture(async (_params, context) => {
    const rejected = await registry.executeDetailed("fixture_effect", { value: 1 });
    assert.equal(rejected.receipt.phase, "not_started");
    return registry.withChildExecution(async () => {
      const attemptedWidening = await registry.executeDetailed("fixture_effect", { value: 1 }, { scope: { workspaceRoot: "/outside" } });
      assert.equal(attemptedWidening.receipt.phase, "not_started");
      const child = await registry.executeDetailed("fixture_effect", { value: 1 });
      assert.deepEqual(child.receipt.scope, context?.scope);
      return ok(child.result.data);
    });
  }, { name: "parent_effect" }));
  assert.equal((await registry.executeDetailed("parent_effect", { value: 1 }, { scope: { workspaceRoot: "/fixture" } })).outcome, "succeeded");
});

test("renewal lane progresses while an ordinary exclusive effect is in flight", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let started!: () => void;
  const admitted = new Promise<void>(resolve => { started = resolve; });
  const registry = new ToolRegistry();
  registry.register(fixture(async () => { started(); await pending; return ok("effect"); }));
  const effect = registry.executeDetailed("fixture_effect", { value: 1 });
  await admitted;
  const renew = registry.createRenewalRunner(fixture(async () => ok("renewed"), { name: "lease_renew" }));
  assert.equal((await renew({ value: 1 })).result.data, "renewed");
  finish();
  assert.equal((await effect).outcome, "succeeded");
});

test("pipeline uncertainty reaches result observers before the next queued effect",async()=>{
 let entered!:()=>void;let release!:()=>void;let uncertain=false;let laterEffects=0;
 const entry=new Promise<void>(resolve=>entered=resolve),barrier=new Promise<void>(resolve=>release=resolve);
 const registry=new ToolRegistry({
   policy:{authorize:()=>uncertain ? {decision:"deny",reasonCodes:["reconciliation_required"]}:{decision:"allow"}},
   logger:{error:()=>{throw new Error("Diagnostic sink failed after handler entry");}},
   journal:{record:()=>{},onSettled:execution=>{if(execution.outcome === "unknown")uncertain=true;}},
 });
 registry.register({name:"uncertain_first",description:"Enter then lose the execution pipeline",inputSchema:{type:"object",properties:{}},handler:async()=>{entered();await barrier;throw new Error("Effect response lost");}});
 registry.register({name:"queued_later",description:"Must not run after uncertainty",inputSchema:{type:"object",properties:{}},handler:async()=>{laterEffects++;return {success:true};}});
 const first=registry.executeDetailed("uncertain_first",{});await entry;
 const next=registry.executeDetailed("queued_later",{});release();
 const [result,denied]=await Promise.all([first,next]);
 assert.equal(result.outcome,"unknown");assert.equal(uncertain,true);assert.equal(denied.receipt.phase,"not_started");assert.equal(laterEffects,0);
});
