#!/usr/bin/env tsx
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionKernel, InMemorySessionEventStore, JsonlSessionEventStore, digestJson, type SessionEvent } from "../src/framework/session.js";
import type { ToolExecutionReceipt } from "../src/framework/execution-types.js";

const call = { id: "call-1", name: "write", args: { value: 2 } };
const context = { turnId: "turn-1", stepId: "step-1", runId: "run-1", correlationId: "correlation-1" };
function declared(session = new SessionKernel({ sessionId: "v2" })): SessionKernel {
  session.append({ type: "turn/started", data: {}, turnId: context.turnId, runId: context.runId, correlationId: context.correlationId });
  session.append({ type: "step/started", data: {}, ...context });
  session.append({ type: "model/request-prepared", data: {
    history: { throughSeq: session.getEventCount(), messageCount: session.getHistory().length, sha256: digestJson(session.getHistory()) },
    systemPromptSha256: digestJson("prompt"),
    tools: { names: [call.name], sha256: digestJson([{ name: call.name }]) },
  }, ...context });
  session.append({ type: "model/response-received", data: { toolCall: call }, ...context });
  session.appendMessage({ role: "assistant", toolCallId: call.id, toolName: call.name, content: JSON.stringify(call.args) }, context);
  session.append({ type: "tool/call", data: { call }, ...context });
  return session;
}
function receipt(overrides: Partial<ToolExecutionReceipt> = {}): ToolExecutionReceipt {
  return {
    schemaVersion: 1, executionId: "execution-1", callId: call.id, toolName: call.name,
    runId: context.runId, correlationId: context.correlationId,
    inputDigest: digestJson(call.args), capabilityDigest: digestJson({ name: call.name }),
    admission: "rejected", reasonCodes: ["policy_denied"], authorityGrantRefs: [],
    phase: "not_started", executionOutcome: "failed", requestedAt: 1, finishedAt: 2,
    cancellationObserved: false, deadlineObserved: false,
    idempotency: { disposition: "not_requested" }, replayPolicy: "never", artifactRefs: [],
    verification: { state: "not_requested", evidenceRefs: [] }, ...overrides,
  };
}
function result(session: SessionKernel, bound: ToolExecutionReceipt): void {
  const value = { success: false, error: "denied", executionOutcome: "failed" };
  session.append({ type: "tool/result", data: {
    toolCallId: call.id, toolName: call.name, outcome: "failed", result: value,
    modelContent: "EXACT denied receipt", receipt: bound,
  }, ...context });
}

test("session v2: bound rejection can settle without a fake execution start", () => {
  const session = declared();
  result(session, receipt());
  assert.ok(session.getEvents().every((event) => event.schemaVersion === 2));
  assert.equal(session.getEvents().filter((event) => event.type === "tool/execution-started").length, 0);
  const replayed = new SessionKernel({ sessionId: "v2", store: new InMemorySessionEventStore(session.getEvents()) });
  replayed.recoverInterrupted();
  assert.equal(replayed.getHistory().find((message) => message.role === "tool")?.content, "EXACT denied receipt");
});

test("session v2: forged rejection binding and contradictory outcome fail closed", () => {
  for (const changed of [
    { callId: "other" }, { toolName: "other" }, { inputDigest: digestJson({ value: 3 }) },
    { runId: "other" }, { correlationId: "other" }, { phase: "settled" },
    { admission: "allowed" }, { executionOutcome: "succeeded" },
  ] as Partial<ToolExecutionReceipt>[]) {
    const session = declared();
    assert.throws(() => result(session, receipt(changed)), /receipt|execution-started/);
    assert.equal(session.getEvents().at(-1)?.type, "tool/call");
  }
});

test("session v2: execution identity and capability cannot change after actual start", () => {
  for (const changed of [{ executionId: "other" }, { capabilityDigest: "other" }]) {
    const session = declared();
    session.append({ type: "tool/execution-started", data: { call, receipt: receipt({ admission: "allowed", phase: "started", executionOutcome: "unknown" }) }, ...context });
    assert.throws(() => result(session, receipt({ admission: "allowed", phase: "settled", ...changed })), /identity|capability/);
  }
});

test("session v2: v1 started crash is read unchanged and recovers as unknown without effects", () => {
  const original = declared();
  original.append({ type: "tool/execution-started", data: { call }, ...context });
  const legacy = original.getEvents().map((event) => ({ ...event, schemaVersion: 1 as const })) as SessionEvent[];
  const bytes = JSON.stringify(legacy);
  const recovered = new SessionKernel({ sessionId: "v2", store: new InMemorySessionEventStore(legacy) });
  assert.equal(JSON.stringify(recovered.getEvents()), bytes);
  const added = recovered.recoverInterrupted();
  assert.ok(added.every((event) => event.schemaVersion === 2));
  const settlement = added.find((event) => event.type === "tool/result");
  assert.equal(settlement?.type === "tool/result" ? settlement.data.outcome : undefined, "unknown");
  assert.equal(JSON.stringify(recovered.getEvents().slice(0, legacy.length)), bytes);
  const replay = new SessionKernel({ sessionId: "v2", store: new InMemorySessionEventStore(recovered.getEvents()) });
  assert.deepEqual(replay.recoverInterrupted(), []);
});

test("session v2: pre-upgrade copy preserves exact original bytes including torn tail", (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-v2-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = new SessionKernel({ sessionId: "legacy" });
  const legacy = original.getEvents().map((event) => ({ ...event, schemaVersion: 1 }));
  const file = join(root, `${createHash("sha256").update("legacy").digest("hex")}.jsonl`);
  const bytes = Buffer.from(`${JSON.stringify(legacy[0], null, 0)}\n{"torn":`, "utf8");
  writeFileSync(file, bytes, { mode: 0o600 });
  const upgraded = new SessionKernel({ sessionId: "legacy", store: new JsonlSessionEventStore({ rootDir: root }) });
  assert.deepEqual(readFileSync(file), bytes);
  upgraded.appendMessage({ role: "user", content: "new message" });
  assert.deepEqual(readFileSync(`${file}.pre-v2`), bytes);
  assert.equal(statSync(`${file}.pre-v2`).mode & 0o777, 0o600);
  const after = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(after.map((event) => event.schemaVersion), [1, 2]);
  upgraded.appendMessage({ role: "user", content: "another" });
  assert.deepEqual(readFileSync(`${file}.pre-v2`), bytes);
});

test("session v2: unsafe pre-upgrade destination blocks upgrade without modifying v1", (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-v2-unsafe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, `${createHash("sha256").update("legacy").digest("hex")}.jsonl`);
  const started = new SessionKernel({ sessionId: "legacy" }).getEvents()[0];
  const bytes = Buffer.from(`${JSON.stringify({ ...started, schemaVersion: 1 })}\n`);
  writeFileSync(file, bytes, { mode: 0o600 });
  symlinkSync(file, `${file}.pre-v2`);
  const upgraded = new SessionKernel({ sessionId: "legacy", store: new JsonlSessionEventStore({ rootDir: root }) });
  assert.throws(() => upgraded.appendMessage({ role: "user", content: "blocked" }), /symbolic link/);
  assert.deepEqual(readFileSync(file), bytes);
  assert.equal(upgraded.getEvents().length, 1);
});


test("session v2: no-dispatch settlement keeps durable intent actor and scope binding", () => {
  const session = declared();
  session.append({ type: "tool/execution-started", data: { call, receipt: receipt({ admission: "allowed", phase: "started", executionOutcome: "unknown", actor: { kind: "host", id: "trusted" }, scope: { workspaceId: "workspace" } }) }, ...context });
  assert.throws(() => result(session, receipt({ actor: { kind: "host", id: "trusted" }, scope: { workspaceId: "other" } })), /actor\/scope binding/);
  assert.throws(() => result(session, receipt({ actor: { kind: "host", id: "forged" }, scope: { workspaceId: "workspace" } })), /actor\/scope binding/);
  result(session, receipt({ actor: { kind: "host", id: "trusted" }, scope: { workspaceId: "workspace" } }));
  const events = session.getEvents();
  assert.throws(() => new InMemorySessionEventStore(events.map((event) => ({ ...event, schemaVersion: 1 })) as SessionEvent[]), /bound v2 not-started rejection/);
});
