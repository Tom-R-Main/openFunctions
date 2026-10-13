import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FileArtifactStore } from "../src/framework/artifacts.js";
import { ToolRegistry } from "../src/framework/registry.js";
import { createMcpServer } from "../src/framework/server.js";
import { digestJson } from "../src/framework/session.js";
import { WorkAttemptController } from "../src/framework/work/controller.js";
import { createWorkTools } from "../src/framework/work/tools.js";
import { createLocalFixtureBindings } from "../src/framework/work/local-fixture.js";
import { LocalGrantStore } from "../src/framework/work/grants.js";
import { LocalWorkBackend } from "../src/framework/work/local-backend.js";
import type { ToolResult } from "../src/framework/types.js";
import type { WorkControllerOptions } from "../src/framework/work/types.js";

async function setup(t: { after(fn: () => void | Promise<void>): void }, options: { large?: boolean; quota?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "openfunction-output-")); chmodSync(root, 0o700);
  writeFileSync(join(root, "fixture.json"), '{"status":"needs_correction","value":0}\n', { mode: 0o600 });
  writeFileSync(join(root, "verify.mjs"), 'console.log("verified");\n', { mode: 0o600 });
  const bindings = createLocalFixtureBindings({ workspaceRoot: root, fixturePath: "fixture.json", verifierPath: "verify.mjs" });
  if (options.large) {
    mkdirSync(join(root, "inputs"));
    const names = Array.from({ length: 450 }, (_, i) => `inputs/source-${String(i).padStart(4, "0")}-${"x".repeat(50)}.txt`);
    for (const name of names) writeFileSync(join(root, name), "sample");
    const binding = bindings.verificationBindings[0]!;
    binding.inputs = [...binding.inputs, "inputs"];
    binding.specDigest = digestJson({ priorSpec: binding.specDigest, inputs: binding.inputs });
    bindings.verificationStep.specDigest = binding.specDigest;
    bindings.contract.include.push(...names);
  }
  const registry = new ToolRegistry(); registry.registerAll(bindings.tools);
  const backend = new LocalWorkBackend({ rootDir: join(root, "backend"), backendId: "output-test", workspaceId: "test", workItems: [{ workItemId: "job", contract: bindings.contract, plan: { id: "plan", version: 1, state: "active", steps: [bindings.verificationStep] } }] });
  const grants = new LocalGrantStore({ rootDir: join(root, "grants") });
  const config: WorkControllerOptions = { backend, registry, grantResolver: grants, journalRoot: join(root, "journals"), artifactRoot: join(root, "artifacts"), workspaceRoot: root, claimOwner: "output-test", steps: bindings.steps, verificationBindings: bindings.verificationBindings, ...(options.quota === undefined ? {} : { artifactStore: new FileArtifactStore({ rootDir: join(root, "limited-artifacts"), quotaBytes: options.quota }) }) };
  const controller = new WorkAttemptController(config);
  const preview = await controller.prepare("job");
  const common = { expiresAt: Date.now() + 60000, actions: bindings.contract.actions, roots: [root], include: ["fixture.json"], exclude: [], stepBindings: Object.fromEntries(Object.entries(bindings.steps).map(([key, step]) => [key, { toolName: step.toolName, capabilityDigest: step.capabilityDigest }])), acceptanceMethods: ["fixture-readback"], limits: { maxAttempts: 1, maxDurationMs: 60000, maxActions: 20, maxOutputBytes: 1048576 } };
  const executionGrant = grants.issue(preview.binding, { ...common, purpose: "execution" });
  grants.issue(preview.binding, { ...common, purpose: "completion", executionGrantId: executionGrant.id });
  const facade = new ToolRegistry(); facade.registerAll(createWorkTools(controller));
  t.after(async () => { await controller.shutdown(); rmSync(root, { recursive: true, force: true }); });
  return { root, config, controller, facade, backend };
}
function bounded(result: ToolResult): void {
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768);
  assert.ok(Buffer.byteLength(JSON.stringify(result, null, 2)) <= 32768);
}
function artifactId(result: ToolResult): string { return (result.data as { artifactProjection: { artifact: { id: string } } }).artifactProjection.artifact.id; }
async function readCanonical(facade: ToolRegistry, id: string): Promise<ToolResult> {
  const chunks: Buffer[] = []; let offset = 0;
  for (;;) {
    const reply = await facade.execute("of_work_artifact_read", { artifactId: id, offset }); bounded(reply); assert.equal(reply.success, true);
    const data = reply.data as { data: string; length: number; hasMore: boolean };
    chunks.push(Buffer.from(data.data, "base64")); offset += data.length;
    if (!data.hasMore) break;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ToolResult;
}
async function correct(controller: WorkAttemptController): Promise<void> {
  const inspected = await controller.step("inspect", {});
  await controller.step("correct", { expectedDigest: (inspected.result.data as { expectedDigest: string }).expectedDigest });
}

test("small facade replies retain their original shape and legacy controller stubs still work", async t => {
  const { controller, facade, root } = await setup(t);
  assert.deepEqual(await facade.execute("of_work_status", {}), { success: true, data: { state: "prepared", active: false } });
  assert.equal(existsSync(join(root, "artifacts")), false);
  await controller.start("job"); await correct(controller);
  const evidence = await controller.verify("fixture-check");
  const status = await facade.execute("of_work_status", {}); bounded(status);
  assert.deepEqual(status, { success: true, data: await controller.status() });
  assert.deepEqual((status.data as { evidence: unknown[] }).evidence, [evidence]);
  const stub = Object.fromEntries(["prepare", "start", "step", "verify", "status", "reconcile", "finish"].map(name => [name, async () => ({ state: "running" })])) as unknown as Parameters<typeof createWorkTools>[0];
  assert.equal(createWorkTools(stub).length, 7);
  assert.deepEqual(await createWorkTools(stub)[0]!.handler({ workItemId: "job" }), { success: true, data: { state: "running" } });
});

test("large preview, evidence, status, reconciliation and finish replies retain full readable canonical artifacts", async t => {
  const { controller, facade, config } = await setup(t, { large: true });
  const preview = await facade.execute("of_work_prepare", { workItemId: "job" }); bounded(preview);
  assert.equal((await readCanonical(facade, artifactId(preview))).success, true);
  await controller.start("job"); await correct(controller);
  // Preview artifact IDs remain reachable after attempt storage is selected.
  assert.equal((await readCanonical(facade, artifactId(preview))).success, true);
  const verified = await facade.execute("of_work_verify", { stepId: "fixture-check" }); bounded(verified);
  assert.equal((verified.data as { outcome: string }).outcome, "passed");
  assert.equal((verified.data as { before: { inputCount: number } }).before.inputCount, 452);
  const fullEvidence = (await readCanonical(facade, artifactId(verified))).data as { before: { inputManifest: string[] } };
  assert.equal(fullEvidence.before.inputManifest.length, 452);
  const status = await facade.execute("of_work_status", {}); bounded(status);
  const again = await facade.execute("of_work_status", {}); assert.equal(artifactId(again), artifactId(status));
  const storeRoot = join(config.artifactRoot, (status.data as { attemptId: string }).attemptId);
  const count = readdirSync(storeRoot).filter(name => name.endsWith(".artifact")).length;
  await facade.execute("of_work_status", {});
  assert.equal(readdirSync(storeRoot).filter(name => name.endsWith(".artifact")).length, count);
  const reconciled = await facade.execute("of_work_reconcile", {}); bounded(reconciled);
  const finished = await facade.execute("of_work_finish", {}); bounded(finished);
  assert.equal((finished.data as { state: string }).state, "completed");
  await controller.shutdown();
  const recovered = new WorkAttemptController(config); t.after(() => recovered.shutdown());
  const recoveredFacade = new ToolRegistry(); recoveredFacade.registerAll(createWorkTools(recovered));
  const terminal = await recoveredFacade.execute("of_work_status", {}); bounded(terminal);
  assert.equal(artifactId(await recoveredFacade.execute("of_work_status", {})), artifactId(terminal));
  assert.deepEqual((await readCanonical(recoveredFacade, artifactId(status))).data, (await readCanonical(facade, artifactId(status))).data);
});

test("MCP wire evidence/status text and artifact chunks respect the output budget", async t => {
  const { controller, facade } = await setup(t, { large: true }); await controller.start("job"); await correct(controller);
  const server = createMcpServer(facade, { name: "output-tests" });
  const client = new Client({ name: "output-client", version: "1.0" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  for (const [name, args] of [["of_work_verify", { stepId: "fixture-check" }], ["of_work_status", {}]] as const) {
    const wire = await client.callTool({ name, arguments: args });
    assert.ok(Array.isArray(wire.content));
    const text = (wire.content as { type: string; text?: string }[]).filter(part => part.type === "text").map(part => part.text ?? "").join("");
    assert.ok(Buffer.byteLength(text) <= 32768);
    const id = JSON.parse(text).artifactProjection.artifact.id;
    const chunk = await client.callTool({ name: "of_work_artifact_read", arguments: { artifactId: id } });
    assert.ok(Buffer.byteLength((chunk.content as { text: string }[])[0]!.text) <= 32768);
  }
});

test("quota exhaustion reports unavailable output without changing completed work", async t => {
  const { controller, facade, backend } = await setup(t, { large: true, quota: 4096 });
  const preview = await facade.execute("of_work_prepare", { workItemId: "job" }); bounded(preview);
  assert.equal((preview.data as { artifactProjection: { available: boolean } }).artifactProjection.available, false);
  await controller.start("job"); await correct(controller); await controller.verify("fixture-check"); await controller.finish();
  const status = await facade.execute("of_work_status", {}); bounded(status);
  assert.equal(status.success, true);
  assert.equal((status.data as { state: string }).state, "completed");
  assert.match((status.data as { artifactProjection: { reason: string } }).artifactProjection.reason, /quota exhausted/);
  assert.equal((await backend.inspect("job")).state, "completed");
  assert.equal((await controller.status()).state, "completed");
});

test("all facade operations bound stub outputs and preserve failed/unknown certainty", async () => {
  for (const outcome of ["failed", "unknown"] as const) {
    const oversized = { receipt: { executionId: "known-effect", executionOutcome: outcome }, outcome, text: "é".repeat(40000) };
    const stub = Object.fromEntries(["prepare", "start", "step", "verify", "status", "reconcile", "finish"].map(name => [name, async () => oversized])) as unknown as Parameters<typeof createWorkTools>[0];
    for (const tool of createWorkTools(stub)) {
      const result = await tool.handler({}); bounded(result); assert.equal(result.success, false); assert.equal(result.executionOutcome, outcome);
      assert.equal((result.data as { outcome: string }).outcome, outcome);
    }
  }
});

test("artifact reader rejects paths and oversized direct reads", async t => {
  const { controller } = await setup(t, { large: true });
  const output = controller.projectOutput({ success: true, data: await controller.prepare("job") });
  assert.throws(() => controller.readOutputArtifact("../../fixture.json"), /opaque artifact id/);
  assert.throws(() => controller.readOutputArtifact(artifactId(output), { length: 16385 }), /bounds/);
});

test("thrown facade failures are bounded without losing unknown certainty or retrying", async () => {
  for (const message of ["small failure", "é".repeat(40000)]) {
    let calls = 0;
    const stub = Object.fromEntries(["prepare", "start", "step", "verify", "status", "reconcile", "finish"].map(name => [name, async () => { calls++; throw new Error(message); }])) as unknown as Parameters<typeof createWorkTools>[0];
    const registry = new ToolRegistry(); registry.registerAll(createWorkTools(stub));
    for (const tool of registry.getAll()) {
      const params = tool.name === "of_work_prepare" || tool.name === "of_work_start" ? { workItemId: "job" } : tool.name === "of_work_verify" ? { stepId: "fixture-check" } : tool.name === "of_work_step" ? { stepKey: "correct", params: {} } : {};
      const reply = await registry.executeDetailed(tool.name, params); bounded(reply.result);
      assert.equal(reply.outcome, "unknown"); assert.equal(reply.result.success, false);
      assert.equal(reply.result.executionOutcome, "unknown");
      if (message === "small failure") assert.equal(reply.result.error, "Tool execution outcome is unknown: small failure");
    }
    assert.equal(calls, 7);
  }
});

test("a failing projection hook preserves known work and cannot cause redispatch or large output", async () => {
  let calls = 0;
  const canonical = { state: "completed", text: "x".repeat(40000) };
  const stub = { ...Object.fromEntries(["prepare", "start", "step", "verify", "status", "reconcile", "finish"].map(name => [name, async () => { calls++; return canonical; }])), projectOutput: () => { throw new Error("projection failed"); } } as unknown as Parameters<typeof createWorkTools>[0];
  for (const tool of createWorkTools(stub)) {
    const reply = await tool.handler({}); bounded(reply);
    assert.equal(reply.success, true); assert.equal((reply.data as { state: string }).state, "completed");
    assert.equal((reply.data as { artifactProjection: { available: boolean } }).artifactProjection.available, false);
  }
  assert.equal(calls, 7);
});
