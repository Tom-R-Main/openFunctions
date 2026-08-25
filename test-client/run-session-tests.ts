import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ChatMessage } from "../src/framework/adapters/types.js";
import {
  digestJson,
  InMemorySessionEventStore,
  JsonlSessionEventStore,
  SessionConcurrencyError,
  SessionInvariantError,
  SessionKernel,
  snapshotJson,
  type ModelResponseSnapshot,
  type SessionEvent,
  type SessionEventContext,
  type SessionEventStore,
} from "../src/framework/session.js";

function modelRequestReferences(
  session: SessionKernel,
  systemPrompt: string,
  tools: Array<{ name: string } & Record<string, unknown>>,
) {
  return {
    history: {
      throughSeq: session.getEvents().length,
      messageCount: session.getHistory().length,
      sha256: digestJson(session.getHistory()),
    },
    systemPromptSha256: digestJson(systemPrompt),
    tools: {
      names: tools.map((tool) => tool.name).sort(),
      sha256: digestJson(tools),
    },
  };
}

function withTempDir(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "openfunction-session-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function sessionPaths(root: string, sessionId: string): { events: string; lock: string } {
  const digest = createHash("sha256").update(sessionId, "utf8").digest("hex");
  return {
    events: join(root, `${digest}.jsonl`),
    lock: join(root, `${digest}.lock`),
  };
}

function deterministicKernel(
  store: SessionEventStore = new InMemorySessionEventStore(),
  sessionId = "session-1",
): SessionKernel {
  let eventIndex = store.read(sessionId).length;
  return new SessionKernel({
    sessionId,
    store,
    clock: () => new Date("2026-08-25T12:00:00.000Z"),
    eventIdFactory: () => `event-${++eventIndex}`,
  });
}

type TurnStepContext = SessionEventContext & { turnId: string; stepId: string };

function appendModelResponse(
  session: SessionKernel,
  context: TurnStepContext,
  data: ModelResponseSnapshot,
): void {
  const calls = data.toolCalls ?? (data.toolCall === undefined ? [] : [data.toolCall]);
  const tools = [...new Set(calls.map((call) => call.name))].map((name) => ({ name }));
  session.append({
    type: "model/request-prepared",
    data: modelRequestReferences(session, "test prompt", tools),
    ...context,
  });
  session.append({ type: "model/response-received", data, ...context });
}

test("replay deterministically reconstructs model history", () => {
  const store = new InMemorySessionEventStore();
  const session = deterministicKernel(store);
  const userMessage: ChatMessage = { role: "user", content: "Inspect this repository" };
  const assistantMessage: ChatMessage = { role: "assistant", content: "Done" };

  session.append({ type: "turn/started", data: { input: userMessage }, turnId: "turn-1" });
  session.appendMessage(userMessage, { turnId: "turn-1" });
  session.append({ type: "step/started", data: { index: 0 }, turnId: "turn-1", stepId: "step-1" });
  session.append({
    type: "model/request-prepared",
    data: {
      ...modelRequestReferences(session, "Be exact", [{ name: "inspect" }]),
      adapter: { name: "test", model: "deterministic" },
    },
    turnId: "turn-1",
    stepId: "step-1",
  });
  session.append({ type: "model/response-received", data: { text: "Done" }, turnId: "turn-1", stepId: "step-1" });
  session.appendMessage(assistantMessage, { turnId: "turn-1", stepId: "step-1" });
  session.append({ type: "step/completed", data: { outcome: "completed" }, turnId: "turn-1", stepId: "step-1" });
  session.append({
    type: "turn/completed",
    data: { rounds: 1, finalText: "Done", assistantTurnComplete: true, runStatus: "completed" },
    turnId: "turn-1",
  });
  session.append({ type: "session/destroyed", data: { reason: "test complete" } });

  const originalEvents = session.getEvents();
  const replayed = deterministicKernel(new InMemorySessionEventStore(originalEvents));

  assert.deepEqual(replayed.getEvents(), originalEvents);
  assert.deepEqual(replayed.getHistory(), [userMessage, assistantMessage]);
  assert.deepEqual(replayed.getHistory(), session.getHistory());
});

test("events and projections are canonical immutable snapshots", () => {
  const session = deterministicKernel();
  const message: ChatMessage = {
    role: "user",
    content: [{ type: "image", mime: "image/png", dataUrl: "data:image/png;base64,abc" }],
  };

  const event = session.appendMessage(message);
  const content = message.content as Array<{ type: "image"; mime: string; dataUrl?: string }>;
  content[0]!.mime = "image/jpeg";
  content.push({ type: "image", mime: "image/gif" });

  assert.deepEqual(session.getHistory(), [
    { role: "user", content: [{ type: "image", mime: "image/png", dataUrl: "data:image/png;base64,abc" }] },
  ]);
  assert(Object.isFrozen(event));
  assert(Object.isFrozen(event.data));
  assert(Object.isFrozen(session.getHistory()));
  assert.throws(() => {
    (event.data as { message: ChatMessage }).message.content = "mutated";
  }, TypeError);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(
    () => session.append({ type: "session/reset", data: { reason: cyclic as unknown as string } }),
    /cycle/,
  );
  assert.throws(
    () => session.append({ type: "session/reset", data: { reason: Number.POSITIVE_INFINITY as unknown as string } }),
    /non-finite/,
  );
  assert.throws(
    () => session.append({ type: "session/reset", data: { reason: (() => undefined) as unknown as string } }),
    /non-JSON value function/,
  );
});

test("canonical snapshots preserve and freeze every JSON key including __proto__", () => {
  const source = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":"kept"},"prototype":"root"}',
  ) as Record<string, unknown>;
  const snapshot = snapshotJson(source);

  assert(Object.prototype.hasOwnProperty.call(snapshot, "__proto__"));
  assert.equal((snapshot as Record<string, { polluted: boolean }>).__proto__.polluted, true);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), source);
  assert.equal(Object.getPrototypeOf(snapshot), Object.prototype);
  assert(Object.isFrozen(snapshot));
  assert(Object.isFrozen((snapshot as Record<string, object>).__proto__));
  assert.equal(digestJson(source), digestJson(JSON.parse(JSON.stringify(source))));
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("provider replay and continuation recovery are audited as immutable JSON snapshots", () => {
  const session = deterministicKernel();
  const context = { turnId: "provider-turn", stepId: "provider-step" };
  const replay = {
    key: "openai.responses",
    outputItems: [{ type: "reasoning", summary: [{ type: "summary_text", text: "checked" }] }],
  };
  session.append({ type: "turn/started", data: {}, turnId: context.turnId });
  session.append({ type: "step/started", data: { index: 0 }, ...context });
  appendModelResponse(session, context, {
    text: "Done",
    providerReplay: replay,
    continuationRecovery: {
      reason: "missing_or_expired",
      failedContinuationId: "response-expired",
    },
  });
  const response = session.getEvents().at(-1)!;
  assert(response.type === "model/response-received");
  const message = {
    role: "assistant",
    content: "Done",
    providerReplay: replay,
  } as ChatMessage & { providerReplay: typeof replay };
  session.appendMessage(message, context);

  replay.key = "mutated";
  (replay.outputItems[0] as { type: string; summary: unknown[] }).summary.push({ text: "mutated" });

  assert.equal(response.data.providerReplay?.key, "openai.responses");
  assert.deepEqual(response.data.providerReplay?.outputItems, [
    { type: "reasoning", summary: [{ type: "summary_text", text: "checked" }] },
  ]);
  const projected = session.getHistory()[0] as ChatMessage & { providerReplay: typeof replay };
  assert.equal(projected.providerReplay.key, "openai.responses");
  assert(Object.isFrozen(projected.providerReplay));
  assert(Object.isFrozen(projected.providerReplay.outputItems));
  assert(Object.isFrozen(projected.providerReplay.outputItems[0]));
  assert.throws(() => {
    projected.providerReplay.outputItems.push({ type: "message", summary: [] });
  }, TypeError);

  const replayed = deterministicKernel(new InMemorySessionEventStore(session.getEvents()));
  assert.deepEqual(replayed.getHistory(), session.getHistory());
});

test("malformed imported message roles and contradictory tool fields fail closed", () => {
  const malformed: Array<{ message: unknown; pattern: RegExp }> = [
    { message: { role: "tool", content: "result" }, pattern: /toolCallId must be a non-empty string/ },
    {
      message: { role: "tool", content: "result", toolCallId: "call-1" },
      pattern: /toolName must be a non-empty string/,
    },
    {
      message: { role: "assistant", content: "{}", toolCallId: "call-1" },
      pattern: /requires both toolCallId and toolName/,
    },
    {
      message: {
        role: "assistant",
        content: "",
        toolCallId: "call-1",
        toolName: "one",
        toolCalls: [{ id: "call-2", name: "two", args: {} }],
      },
      pattern: /both single and parallel tool calls/,
    },
    {
      message: { role: "user", content: "not a result", toolCallId: "call-1", toolName: "one" },
      pattern: /user message cannot contain tool-call fields/,
    },
    {
      message: {
        role: "tool",
        content: "result",
        toolCallId: "call-1",
        toolName: "one",
        toolCalls: [{ id: "call-2", name: "two", args: {} }],
      },
      pattern: /tool message cannot contain assistant toolCalls/,
    },
    {
      message: {
        role: "assistant",
        content: "done",
        providerReplay: { key: "openai.responses", outputItems: "not-an-array" },
      },
      pattern: /outputItems must be an array/,
    },
  ];

  for (const [index, candidate] of malformed.entries()) {
    const session = deterministicKernel(new InMemorySessionEventStore(), `malformed-${index}`);
    assert.throws(
      () => session.replaceHistory([candidate.message as ChatMessage], "imported"),
      candidate.pattern,
    );
    assert.deepEqual(session.getHistory(), []);
  }
});

test("stores reject gaps and duplicate or invalid sequence numbers", () => {
  const session = deterministicKernel();
  session.appendMessage({ role: "user", content: "hello" });
  const events = JSON.parse(JSON.stringify(session.getEvents())) as SessionEvent[];
  (events[1] as { seq: number }).seq = 3;

  assert.throws(
    () => new InMemorySessionEventStore(events),
    (error: unknown) => error instanceof SessionInvariantError && /expected 2, got 3/.test(error.message),
  );
});

test("tool call ids remain bound to one tool name across results and model receipts", () => {
  const resultMismatch = deterministicKernel(
    new InMemorySessionEventStore(),
    "tool-name-result-mismatch",
  );
  const resultContext = { turnId: "turn-result", stepId: "step-result" };
  const call = { id: "call-stable", name: "write_file", args: {} };
  resultMismatch.append({ type: "turn/started", data: {}, turnId: resultContext.turnId });
  resultMismatch.append({ type: "step/started", data: { index: 0 }, ...resultContext });
  appendModelResponse(resultMismatch, resultContext, { toolCall: call });
  resultMismatch.appendMessage({
    role: "assistant",
    content: "{}",
    toolCallId: call.id,
    toolName: call.name,
  }, resultContext);
  resultMismatch.append({ type: "tool/call", data: { call }, ...resultContext });
  resultMismatch.append({ type: "tool/execution-started", data: { call }, ...resultContext });

  const beforeResultMismatch = resultMismatch.getEvents().length;
  assert.throws(
    () => resultMismatch.append({
      type: "tool/result",
      data: {
        toolCallId: call.id,
        toolName: "delete_file",
        outcome: "succeeded",
        result: { success: true },
      },
      ...resultContext,
    }),
    (error: unknown) => error instanceof SessionInvariantError
      && /changed name from write_file to delete_file/.test(error.message),
  );
  assert.equal(resultMismatch.getEvents().length, beforeResultMismatch);

  const receiptMismatch = deterministicKernel(
    new InMemorySessionEventStore(),
    "tool-name-receipt-mismatch",
  );
  const receiptContext = { turnId: "turn-receipt", stepId: "step-receipt" };
  receiptMismatch.append({ type: "turn/started", data: {}, turnId: receiptContext.turnId });
  receiptMismatch.append({ type: "step/started", data: { index: 0 }, ...receiptContext });
  appendModelResponse(receiptMismatch, receiptContext, { toolCall: call });
  receiptMismatch.appendMessage({
    role: "assistant",
    content: "{}",
    toolCallId: call.id,
    toolName: call.name,
  }, receiptContext);
  receiptMismatch.append({ type: "tool/call", data: { call }, ...receiptContext });
  receiptMismatch.append({ type: "tool/execution-started", data: { call }, ...receiptContext });
  receiptMismatch.append({
    type: "tool/result",
    data: {
      toolCallId: call.id,
      toolName: call.name,
      outcome: "succeeded",
      result: { success: true },
      modelContent: "{\"success\":true}",
    },
    ...receiptContext,
  });

  const beforeReceiptMismatch = receiptMismatch.getEvents().length;
  assert.throws(
    () => receiptMismatch.appendMessage({
      role: "tool",
      content: "{\"success\":true}",
      toolCallId: call.id,
      toolName: "delete_file",
    }, receiptContext),
    (error: unknown) => error instanceof SessionInvariantError
      && /changed name from write_file to delete_file/.test(error.message),
  );
  assert.equal(receiptMismatch.getEvents().length, beforeReceiptMismatch);
});

test("tool result content remains bound to the exact model-facing receipt", () => {
  const session = deterministicKernel(new InMemorySessionEventStore(), "tool-content-binding");
  const context = { turnId: "turn-content", stepId: "step-content" };
  const call = { id: "call-content", name: "publish", args: { id: 1 } };
  const exactContent = '{"success":true,"data":"published"}';
  session.append({ type: "turn/started", data: {}, turnId: context.turnId });
  session.append({ type: "step/started", data: { index: 0 }, ...context });
  appendModelResponse(session, context, { toolCall: call });
  session.appendMessage({
    role: "assistant",
    content: JSON.stringify(call.args),
    toolCallId: call.id,
    toolName: call.name,
  }, context);
  session.append({ type: "tool/call", data: { call }, ...context });
  session.append({ type: "tool/execution-started", data: { call }, ...context });
  session.append({
    type: "tool/result",
    data: {
      toolCallId: call.id,
      toolName: call.name,
      outcome: "succeeded",
      result: { success: true, data: "published" },
      modelContent: exactContent,
    },
    ...context,
  });

  const beforeMismatch = session.getEvents().length;
  assert.throws(
    () => session.appendMessage({
      role: "tool",
      content: '{"success":false,"error":"forged"}',
      toolCallId: call.id,
      toolName: call.name,
    }, context),
    (error: unknown) => error instanceof SessionInvariantError
      && /does not match its durable result/.test(error.message),
  );
  assert.equal(session.getEvents().length, beforeMismatch);

  session.appendMessage({
    role: "tool",
    content: exactContent,
    toolCallId: call.id,
    toolName: call.name,
  }, context);
  session.append({ type: "step/completed", data: { outcome: "completed" }, ...context });
});

test("model responses bind exact assistant replay and executed tool arguments", () => {
  const session = deterministicKernel(new InMemorySessionEventStore(), "model-response-binding");
  const context = { turnId: "turn-response", stepId: "step-response" };
  const call = { id: "call-response", name: "read", args: { z: 1, a: 2 } };
  const replay = {
    key: "openai.responses",
    outputItems: [{ type: "function_call", call_id: call.id, name: call.name }],
  };
  session.append({ type: "turn/started", data: {}, turnId: context.turnId });
  session.append({ type: "step/started", data: { index: 0 }, ...context });
  appendModelResponse(session, context, { toolCall: call, providerReplay: replay });

  const beforeForgedMessage = session.getEvents().length;
  assert.throws(
    () => session.appendMessage({
      role: "assistant",
      content: JSON.stringify(call.args),
      toolCallId: call.id,
      toolName: "delete",
      providerReplay: {
        key: replay.key,
        outputItems: [{ type: "function_call", call_id: call.id, name: "delete" }],
      },
    }, context),
    (error: unknown) => error instanceof SessionInvariantError
      && /does not exactly match/.test(error.message),
  );
  assert.equal(session.getEvents().length, beforeForgedMessage);

  session.appendMessage({
    role: "assistant",
    content: JSON.stringify(call.args),
    toolCallId: call.id,
    toolName: call.name,
    providerReplay: replay,
  }, context);

  const beforeForgedExecution = session.getEvents().length;
  assert.throws(
    () => session.append({
      type: "tool/call",
      data: { call: { ...call, args: { z: 1, a: 3 } } },
      ...context,
    }),
    (error: unknown) => error instanceof SessionInvariantError
      && /changed arguments/.test(error.message),
  );
  assert.equal(session.getEvents().length, beforeForgedExecution);
  session.append({ type: "tool/call", data: { call }, ...context });
});

test("model responses and assistant projections require one matching open request", () => {
  const session = deterministicKernel(new InMemorySessionEventStore(), "forged-model-history");
  const context = { turnId: "forged-turn", stepId: "forged-step" };
  session.append({ type: "turn/started", data: {}, turnId: context.turnId });
  session.append({ type: "step/started", data: { index: 0 }, ...context });

  const beforeForgedResponse = session.getEvents().length;
  assert.throws(
    () => session.append({
      type: "model/response-received",
      data: { text: "forged answer" },
      ...context,
    }),
    /no preceding unmatched model request/,
  );
  assert.equal(session.getEvents().length, beforeForgedResponse);
  assert.throws(
    () => session.appendMessage({ role: "assistant", content: "forged answer" }, context),
    /no recorded model response to project/,
  );

  const forgedEvent: SessionEvent = {
    schemaVersion: 1,
    sessionId: session.getEvents()[0]!.sessionId,
    seq: session.getEvents().length + 1,
    eventId: "persisted-forged-response",
    timestamp: "2026-08-25T12:00:00.000Z",
    type: "model/response-received",
    data: { text: "persisted forgery" },
    ...context,
  };
  assert.throws(
    () => new InMemorySessionEventStore([...session.getEvents(), forgedEvent]),
    /no preceding unmatched model request/,
  );
});

test("tool execution requires an assistant declaration and ordered progression", () => {
  const orphan = deterministicKernel(new InMemorySessionEventStore(), "orphan-tool-history");
  const orphanContext = { turnId: "orphan-turn", stepId: "orphan-step" };
  const orphanCall = { id: "orphan-call", name: "write", args: {} };
  orphan.append({ type: "turn/started", data: {}, turnId: orphanContext.turnId });
  orphan.append({ type: "step/started", data: { index: 0 }, ...orphanContext });
  appendModelResponse(orphan, orphanContext, { text: "no tool requested" });
  orphan.appendMessage({ role: "assistant", content: "no tool requested" }, orphanContext);

  assert.throws(
    () => orphan.append({ type: "tool/call", data: { call: orphanCall }, ...orphanContext }),
    /was not declared by an assistant response/,
  );
  assert.throws(
    () => orphan.append({ type: "tool/execution-started", data: { call: orphanCall }, ...orphanContext }),
    /was not declared by an assistant response/,
  );
  assert.throws(
    () => orphan.append({
      type: "tool/result",
      data: {
        toolCallId: orphanCall.id,
        toolName: orphanCall.name,
        outcome: "succeeded",
        modelContent: "{}",
      },
      ...orphanContext,
    }),
    /was not declared by an assistant response/,
  );
  assert.throws(
    () => orphan.appendMessage({
      role: "tool",
      content: "{}",
      toolCallId: orphanCall.id,
      toolName: orphanCall.name,
    }, orphanContext),
    /has no matching open tool call/,
  );

  const ordered = deterministicKernel(new InMemorySessionEventStore(), "ordered-tool-history");
  const context = { turnId: "ordered-turn", stepId: "ordered-step" };
  const call = { id: "ordered-call", name: "write", args: { path: "file.txt" } };
  ordered.append({ type: "turn/started", data: {}, turnId: context.turnId });
  ordered.append({ type: "step/started", data: { index: 0 }, ...context });
  appendModelResponse(ordered, context, { toolCall: call });
  ordered.appendMessage({
    role: "assistant",
    content: JSON.stringify(call.args),
    toolCallId: call.id,
    toolName: call.name,
  }, context);
  assert.throws(
    () => ordered.append({ type: "tool/execution-started", data: { call }, ...context }),
    /no preceding tool\/call event/,
  );
  assert.throws(
    () => ordered.append({
      type: "tool/result",
      data: { toolCallId: call.id, toolName: call.name, outcome: "succeeded" },
      ...context,
    }),
    /no preceding execution-started event/,
  );
  ordered.append({ type: "tool/call", data: { call }, ...context });
  assert.throws(
    () => ordered.append({ type: "tool/call", data: { call }, ...context }),
    /was already recorded/,
  );
  ordered.append({ type: "tool/execution-started", data: { call }, ...context });
  assert.throws(
    () => ordered.append({ type: "tool/execution-started", data: { call }, ...context }),
    /was already started/,
  );
});

test("turn and step lifecycles bind exact run and correlation context", () => {
  const session = deterministicKernel(new InMemorySessionEventStore(), "exact-lifecycle-context");
  const turnContext = {
    turnId: "context-turn",
    runId: "run-a",
    correlationId: "correlation-a",
  };
  const stepContext = { ...turnContext, stepId: "context-step" };
  session.append({ type: "turn/started", data: {}, ...turnContext });

  assert.throws(
    () => session.appendMessage(
      { role: "user", content: "wrong correlation" },
      { ...turnContext, correlationId: "correlation-b" },
    ),
    /crossed turn, step, run, or correlation boundaries/,
  );
  session.appendMessage({ role: "user", content: "bound input" }, turnContext);
  assert.throws(
    () => session.append({
      type: "step/started",
      data: { index: 0 },
      turnId: turnContext.turnId,
      stepId: stepContext.stepId,
      runId: turnContext.runId,
    }),
    /crossed turn, run, or correlation boundaries/,
  );
  session.append({ type: "step/started", data: { index: 0 }, ...stepContext });

  assert.throws(
    () => session.append({
      type: "model/request-prepared",
      data: modelRequestReferences(session, "test prompt", []),
      ...stepContext,
      runId: "run-b",
    }),
    /crossed turn, step, run, or correlation boundaries/,
  );
  session.append({
    type: "model/request-prepared",
    data: modelRequestReferences(session, "test prompt", []),
    ...stepContext,
  });
  assert.throws(
    () => session.append({
      type: "model/response-received",
      data: { text: "bound answer" },
      ...stepContext,
      runId: "run-b",
    }),
    /crossed turn, step, run, or correlation boundaries/,
  );
  session.append({
    type: "model/response-received",
    data: { text: "bound answer" },
    ...stepContext,
  });
  assert.throws(
    () => session.appendMessage(
      { role: "assistant", content: "bound answer" },
      { ...stepContext, correlationId: "correlation-c" },
    ),
    /crossed turn, step, run, or correlation boundaries/,
  );
  session.appendMessage({ role: "assistant", content: "bound answer" }, stepContext);
  assert.throws(
    () => session.append({
      type: "step/completed",
      data: { outcome: "completed" },
      ...stepContext,
      correlationId: "correlation-d",
    }),
    /crossed turn, step, run, or correlation boundaries/,
  );
  session.append({ type: "step/completed", data: { outcome: "completed" }, ...stepContext });
  assert.throws(
    () => session.replaceHistory([], "wrong run", {
      ...turnContext,
      runId: "run-d",
    }),
    /crossed turn, step, run, or correlation boundaries/,
  );
  assert.throws(
    () => session.append({
      type: "turn/completed",
      data: { assistantTurnComplete: true },
      ...turnContext,
      correlationId: "correlation-e",
    }),
    /crossed turn, step, run, or correlation boundaries/,
  );
  session.append({
    type: "turn/completed",
    data: { assistantTurnComplete: true },
    ...turnContext,
  });
});

test("open step and tool work rejects unrelated history mutations", () => {
  const session = deterministicKernel(new InMemorySessionEventStore(), "guarded-open-history");
  const context = { turnId: "guarded-turn", stepId: "guarded-step" };
  const call = { id: "guarded-call", name: "write", args: {} };
  session.append({ type: "turn/started", data: {}, turnId: context.turnId });
  session.appendMessage({ role: "user", content: "write it" }, { turnId: context.turnId });
  session.append({ type: "step/started", data: { index: 0 }, ...context });
  appendModelResponse(session, context, { toolCall: call });
  session.appendMessage({
    role: "assistant",
    content: "{}",
    toolCallId: call.id,
    toolName: call.name,
  }, context);
  session.append({ type: "tool/call", data: { call }, ...context });

  const eventCount = session.getEvents().length;
  assert.throws(
    () => session.replaceHistory([], "forged rollback", context),
    /cannot replace history while step or tool work remains open/,
  );
  assert.throws(
    () => session.switchThread("other-thread", [], "forged switch", context),
    /cannot replace history while step or tool work remains open/,
  );
  assert.throws(
    () => session.replaceHistoryAndClearAdapterStates([], "forged compaction", context),
    /cannot replace history while step or tool work remains open/,
  );
  assert.throws(
    () => session.appendMessage({ role: "user", content: "interleaved" }, context),
    /cannot append a user message while step or tool work remains open/,
  );
  assert.throws(
    () => session.append({ type: "session/reset", data: { reason: "forged reset" } }),
    /cannot reset a session with open work/,
  );
  assert.equal(session.getEvents().length, eventCount);

  session.append({ type: "tool/execution-started", data: { call }, ...context });
  session.append({
    type: "tool/result",
    data: {
      toolCallId: call.id,
      toolName: call.name,
      outcome: "succeeded",
      modelContent: "{}",
    },
    ...context,
  });
  session.appendMessage({
    role: "tool",
    content: "{}",
    toolCallId: call.id,
    toolName: call.name,
  }, context);
  session.append({ type: "step/completed", data: { outcome: "completed" }, ...context });
  session.append({ type: "turn/completed", data: {}, turnId: context.turnId });
  assert.deepEqual(session.getHistory().map((message) => message.role), [
    "user",
    "assistant",
    "tool",
  ]);
});

test("model request records retain only validated constant-size references", () => {
  const session = deterministicKernel();
  const source: ChatMessage = { role: "user", content: "private history content" };
  const prompt = "private raw system prompt";
  const tools = [{ name: "inspect", description: "private complete tool schema" }];
  const context = { turnId: "request-turn", stepId: "request-step" };
  session.appendMessage(source);
  session.append({ type: "turn/started", data: {}, turnId: context.turnId });
  session.append({ type: "step/started", data: { index: 0 }, ...context });

  const request = session.append({
    type: "model/request-prepared",
    data: {
      ...modelRequestReferences(session, prompt, tools),
      options: { toolChoice: "auto" },
    },
    ...context,
  });

  assert.deepEqual(request.data.history, {
    throughSeq: request.seq - 1,
    messageCount: 1,
    sha256: digestJson(session.getHistory()),
  });
  assert.deepEqual(request.data.tools.names, ["inspect"]);
  assert.equal("messages" in request.data, false);
  assert.equal("systemPrompt" in request.data, false);
  assert(!JSON.stringify(request).includes("private history content"));
  assert(!JSON.stringify(request).includes(prompt));
  assert(!JSON.stringify(request).includes("private complete tool schema"));

  session.append({
    type: "model/response-received",
    data: { text: "validated" },
    ...context,
  });
  session.appendMessage({ role: "assistant", content: "validated" }, context);
  session.append({ type: "step/completed", data: { outcome: "completed" }, ...context });
  const mismatchContext = { turnId: context.turnId, stepId: "request-mismatch-step" };
  session.append({ type: "step/started", data: { index: 1 }, ...mismatchContext });

  const countBeforeMismatch = session.getEvents().length;
  assert.throws(
    () => session.append({
      type: "model/request-prepared",
      data: {
        ...modelRequestReferences(session, prompt, tools),
        history: {
          ...modelRequestReferences(session, prompt, tools).history,
          throughSeq: session.getEvents().length - 1,
        },
      },
      ...mismatchContext,
    }),
    /must reference history through sequence/,
  );
  assert.equal(session.getEvents().length, countBeforeMismatch);

  assert.throws(
    () => session.append({
      type: "model/request-prepared",
      data: {
        ...modelRequestReferences(session, prompt, tools),
        history: {
          ...modelRequestReferences(session, prompt, tools).history,
          messageCount: session.getHistory().length + 1,
        },
      },
      ...mismatchContext,
    }),
    /message count does not match/,
  );

  assert.throws(
    () => session.append({
      type: "model/request-prepared",
      data: {
        ...modelRequestReferences(session, prompt, tools),
        history: {
          ...modelRequestReferences(session, prompt, tools).history,
          sha256: "0".repeat(64),
        },
      },
      ...mismatchContext,
    }),
    /history digest does not match/,
  );

  const tamperedEvents = JSON.parse(JSON.stringify(session.getEvents())) as SessionEvent[];
  const persistedRequest = tamperedEvents.find(
    (event): event is Extract<SessionEvent, { type: "model/request-prepared" }> =>
      event.type === "model/request-prepared",
  );
  assert(persistedRequest);
  (persistedRequest.data.history as { sha256: string }).sha256 = "f".repeat(64);
  assert.throws(
    () => deterministicKernel(new InMemorySessionEventStore(tamperedEvents)),
    /history digest does not match/,
  );
});

test("crash recovery records unknown tool outcome and balances open work without retry", () => {
  const store = new InMemorySessionEventStore();
  const crashed = deterministicKernel(store);
  const context = { turnId: "turn-1", stepId: "step-1", runId: "run-1", correlationId: "corr-1" };
  const call = { id: "call-1", name: "write_file", args: { path: "result.txt" } };

  crashed.append({
    type: "turn/started",
    data: {},
    turnId: context.turnId,
    runId: context.runId,
    correlationId: context.correlationId,
  });
  crashed.appendMessage({ role: "user", content: "write it" }, {
    turnId: context.turnId,
    runId: context.runId,
    correlationId: context.correlationId,
  });
  crashed.append({ type: "step/started", data: { index: 0 }, ...context });
  appendModelResponse(crashed, context, { toolCall: call });
  crashed.appendMessage({
    role: "assistant",
    content: JSON.stringify(call.args),
    toolCallId: call.id,
    toolName: call.name,
  }, context);
  crashed.append({ type: "tool/call", data: { call }, ...context });
  crashed.append({ type: "tool/execution-started", data: { call }, ...context });

  const recovered = deterministicKernel(store);
  const appended = recovered.recoverInterrupted("test process crashed");
  const allEvents = recovered.getEvents();
  const unknownResults = allEvents.filter(
    (event) => event.type === "tool/result" && event.data.outcome === "unknown",
  );

  assert.equal(appended.length, 4);
  assert.equal(unknownResults.length, 1);
  assert.deepEqual(unknownResults[0]!.data, {
    error: "Tool execution outcome is unknown after recovery; the tool was not retried.",
    modelContent: "{\"outcome\":\"unknown\",\"error\":\"Tool execution outcome is unknown after recovery; the tool was not retried.\"}",
    outcome: "unknown",
    recovered: true,
    result: {
      error: "Tool execution outcome is unknown after recovery; the tool was not retried.",
      outcome: "unknown",
    },
    toolCallId: "call-1",
    toolName: "write_file",
  });
  assert.match(String(recovered.getHistory().at(-1)?.content), /"outcome":"unknown"/);
  assert.equal(allEvents.at(-2)?.type, "step/completed");
  assert.equal(allEvents.at(-1)?.type, "turn/interrupted");
  assert.equal(recovered.recoverInterrupted().length, 0, "recovery is idempotent and never retries a tool");

  const replayed = deterministicKernel(new InMemorySessionEventStore(allEvents));
  assert.deepEqual(replayed.getHistory(), recovered.getHistory());
  assert.equal(replayed.recoverInterrupted().length, 0);
});

test("recovery closes a step after either an unmatched request or an unprojected response", () => {
  for (const phase of ["request", "response"] as const) {
    const store = new InMemorySessionEventStore();
    const sessionId = `model-${phase}-recovery`;
    const session = deterministicKernel(store, sessionId);
    const context = { turnId: `${phase}-turn`, stepId: `${phase}-step` };
    session.append({ type: "turn/started", data: {}, turnId: context.turnId });
    session.appendMessage({ role: "user", content: "interrupted model call" }, { turnId: context.turnId });
    session.append({ type: "step/started", data: { index: 0 }, ...context });
    session.append({
      type: "model/request-prepared",
      data: modelRequestReferences(session, "test prompt", []),
      ...context,
    });
    if (phase === "response") {
      session.append({
        type: "model/response-received",
        data: { text: "not projected" },
        ...context,
      });
    }

    const recovery = session.recoverInterrupted("model process crashed");
    assert.deepEqual(recovery.map((event) => event.type), [
      "step/completed",
      "history/replaced",
      "turn/interrupted",
    ]);
    assert.deepEqual(session.getHistory(), []);
    assert.equal(deterministicKernel(store, sessionId).recoverInterrupted().length, 0);
  }
});

test("recovery finishes rollback after an empty response step completed", () => {
  const store = new InMemorySessionEventStore();
  const sessionId = "empty-response-post-step-recovery";
  const session = deterministicKernel(store, sessionId);
  const context = { turnId: "empty-turn", stepId: "empty-step" };
  session.append({ type: "turn/started", data: {}, turnId: context.turnId });
  session.appendMessage({ role: "user", content: "empty response" }, { turnId: context.turnId });
  session.append({ type: "step/started", data: { index: 0 }, ...context });
  appendModelResponse(session, context, {});
  session.append({
    type: "step/completed",
    data: { outcome: "completed", reason: "empty_model_response" },
    ...context,
  });

  const recovery = session.recoverInterrupted("crashed before empty turn rollback");
  assert.deepEqual(recovery.map((event) => event.type), [
    "history/replaced",
    "turn/interrupted",
  ]);
  assert.deepEqual(session.getHistory(), []);
  assert.equal(deterministicKernel(store, sessionId).recoverInterrupted().length, 0);
});

test("repeat crash recovery preserves a durable unknown tool receipt", () => {
  const durableStore = new InMemorySessionEventStore();
  const sessionId = "repeat-recovery";
  let crashAfterRecoveredStep = false;
  const crashingStore: SessionEventStore = {
    read(id): readonly SessionEvent[] {
      return durableStore.read(id);
    },
    append(event): void {
      durableStore.append(event);
      if (
        crashAfterRecoveredStep
        && event.type === "step/completed"
        && event.data.outcome === "interrupted"
        && event.data.recovered === true
      ) {
        crashAfterRecoveredStep = false;
        throw new Error("simulated second crash after durable recovery step");
      }
    },
  };
  const session = deterministicKernel(crashingStore, sessionId);
  const context = { turnId: "repeat-turn", stepId: "repeat-step" };
  const call = { id: "repeat-call", name: "mutate", args: {} };
  session.append({ type: "turn/started", data: {}, turnId: context.turnId });
  session.appendMessage({ role: "user", content: "mutate it" }, { turnId: context.turnId });
  session.append({ type: "step/started", data: { index: 0 }, ...context });
  appendModelResponse(session, context, { toolCall: call });
  session.appendMessage({
    role: "assistant",
    content: "{}",
    toolCallId: call.id,
    toolName: call.name,
  }, context);
  session.append({ type: "tool/call", data: { call }, ...context });
  session.append({ type: "tool/execution-started", data: { call }, ...context });

  crashAfterRecoveredStep = true;
  assert.throws(
    () => session.recoverInterrupted("first recovery"),
    /simulated second crash/,
  );

  const afterSecondCrash = deterministicKernel(durableStore, sessionId);
  const durableHistory = afterSecondCrash.getHistory();
  assert.deepEqual(durableHistory.map((message) => message.role), ["user", "assistant", "tool"]);
  assert.match(String(durableHistory.at(-1)?.content), /"outcome":"unknown"/);
  assert.equal(
    afterSecondCrash.getEvents().filter((event) => event.type === "tool/result").length,
    1,
  );

  const secondRecovery = afterSecondCrash.recoverInterrupted("second recovery");
  assert.deepEqual(secondRecovery.map((event) => event.type), ["turn/interrupted"]);
  assert.deepEqual(afterSecondCrash.getHistory(), durableHistory);
  assert.equal(
    afterSecondCrash.getEvents().filter((event) => event.type === "tool/result").length,
    1,
  );
  assert.equal(afterSecondCrash.recoverInterrupted().length, 0);
});

test("repeat crash recovery completes its durable turn rollback decision", () => {
  const durableStore = new InMemorySessionEventStore();
  const sessionId = "repeat-recovery-rollback";
  let crashAfterRecoveredStep = false;
  const crashingStore: SessionEventStore = {
    read(id): readonly SessionEvent[] {
      return durableStore.read(id);
    },
    append(event): void {
      durableStore.append(event);
      if (
        crashAfterRecoveredStep
        && event.type === "step/completed"
        && event.data.recovered === true
      ) {
        crashAfterRecoveredStep = false;
        throw new Error("simulated crash before durable turn rollback");
      }
    },
  };
  const session = deterministicKernel(crashingStore, sessionId);
  const context = { turnId: "rollback-turn", stepId: "rollback-step" };
  session.append({ type: "turn/started", data: {}, turnId: context.turnId });
  session.appendMessage({ role: "user", content: "interrupted input" }, { turnId: context.turnId });
  session.append({ type: "step/started", data: { index: 0 }, ...context });

  crashAfterRecoveredStep = true;
  assert.throws(
    () => session.recoverInterrupted("first recovery"),
    /simulated crash before durable turn rollback/,
  );

  const afterSecondCrash = deterministicKernel(durableStore, sessionId);
  const recoveredStep = afterSecondCrash.getEvents().find(
    (event) => event.type === "step/completed" && event.data.recovered === true,
  );
  assert(recoveredStep?.type === "step/completed");
  assert.equal(recoveredStep.data.rollbackTurn, true);
  assert.deepEqual(afterSecondCrash.getHistory().map((message) => message.role), ["user"]);

  const secondRecovery = afterSecondCrash.recoverInterrupted("second recovery");
  assert.deepEqual(secondRecovery.map((event) => event.type), [
    "history/replaced",
    "turn/interrupted",
  ]);
  assert.deepEqual(afterSecondCrash.getHistory(), []);
  assert.equal(
    afterSecondCrash.getEvents().filter((event) => event.type === "tool/result").length,
    0,
  );
  assert.equal(afterSecondCrash.recoverInterrupted().length, 0);
});

test("crash recovery closes announced tool calls that never began execution", () => {
  for (const recordedCallEvent of [false, true]) {
    const session = deterministicKernel(
      new InMemorySessionEventStore(),
      `not-started-${recordedCallEvent ? "after-call-event" : "after-message"}`,
    );
    const context = { turnId: `turn-${recordedCallEvent}`, stepId: `step-${recordedCallEvent}` };
    const call = { id: `call-${recordedCallEvent}`, name: "write_file", args: { path: "result.txt" } };
    session.append({ type: "turn/started", data: {}, turnId: context.turnId });
    session.appendMessage({ role: "user", content: "write it" }, { turnId: context.turnId });
    session.append({ type: "step/started", data: { index: 0 }, ...context });
    appendModelResponse(session, context, { toolCall: call });
    session.appendMessage({
      role: "assistant",
      content: JSON.stringify(call.args),
      toolCallId: call.id,
      toolName: call.name,
    }, context);
    if (recordedCallEvent) {
      session.append({ type: "tool/call", data: { call }, ...context });
    }

    session.recoverInterrupted("crashed before tool execution");
    const recoveredResult = session.getEvents().find(
      (event) => event.type === "tool/result" && event.data.toolCallId === call.id,
    );
    assert(recoveredResult?.type === "tool/result");
    assert.equal(recoveredResult.data.outcome, "failed");
    assert.equal(
      recoveredResult.data.error,
      "Tool execution did not start before recovery; the tool was not executed.",
    );
    assert.equal(session.getEvents().some((event) => event.type === "tool/execution-started"), false);
    assert.deepEqual(session.getHistory().map((message) => message.role), ["user", "assistant", "tool"]);
    assert.equal(session.getHistory().at(-1)?.content, recoveredResult.data.modelContent);
    assert.equal(session.recoverInterrupted().length, 0);
  }
});

test("crash recovery rolls a user-only turn back before accepting the next user", () => {
  const store = new InMemorySessionEventStore();
  const crashed = deterministicKernel(store);
  const baseline: ChatMessage[] = [
    { role: "user", content: "previous question" },
    { role: "assistant", content: "previous answer" },
  ];
  const context = { turnId: "turn-user-only", stepId: "step-user-only" };
  crashed.replaceHistory(baseline, "seed");
  crashed.append({
    type: "turn/started",
    data: { input: { role: "user", content: "interrupted question" } },
    turnId: context.turnId,
  });
  crashed.appendMessage({ role: "user", content: "interrupted question" }, { turnId: context.turnId });
  crashed.append({ type: "step/started", data: { index: 0 }, ...context });

  const recovered = deterministicKernel(store);
  const recoveryEvents = recovered.recoverInterrupted("model process exited");
  assert.deepEqual(recovered.getHistory(), baseline);
  assert.deepEqual(recoveryEvents.map((event) => event.type), [
    "step/completed",
    "history/replaced",
    "turn/interrupted",
  ]);

  recovered.append({
    type: "turn/started",
    data: { input: { role: "user", content: "next question" } },
    turnId: "turn-next",
  });
  recovered.appendMessage({ role: "user", content: "next question" }, { turnId: "turn-next" });
  assert.deepEqual(recovered.getHistory().map((message) => message.role), ["user", "assistant", "user"]);
});

test("crash recovery projects an already-recorded tool result exactly without retry", () => {
  const store = new InMemorySessionEventStore();
  const crashed = deterministicKernel(store);
  const context = { turnId: "turn-result", stepId: "step-result" };
  const call = { id: "call-result", name: "lookup", args: { query: "value" } };
  const exactModelContent = '{"z":1,"a":2}';

  crashed.append({ type: "turn/started", data: {}, turnId: context.turnId });
  crashed.appendMessage({ role: "user", content: "look it up" }, { turnId: context.turnId });
  crashed.append({ type: "step/started", data: { index: 0 }, ...context });
  appendModelResponse(crashed, context, { toolCall: call });
  crashed.appendMessage({
    role: "assistant",
    content: JSON.stringify(call.args),
    toolCallId: call.id,
    toolName: call.name,
  }, context);
  crashed.append({ type: "tool/call", data: { call }, ...context });
  crashed.append({ type: "tool/execution-started", data: { call }, ...context });
  crashed.append({
    type: "tool/result",
    data: {
      toolCallId: call.id,
      toolName: call.name,
      outcome: "succeeded",
      result: { a: 2, z: 1 },
      modelContent: exactModelContent,
    },
    ...context,
  });

  const recovered = deterministicKernel(store);
  const beforeResultCount = recovered.getEvents().filter((event) => event.type === "tool/result").length;
  const recoveryEvents = recovered.recoverInterrupted("crashed after durable result");
  assert.deepEqual(recoveryEvents.map((event) => event.type), [
    "message/appended",
    "step/completed",
    "turn/interrupted",
  ]);
  assert.equal(recovered.getEvents().filter((event) => event.type === "tool/result").length, beforeResultCount);
  assert.deepEqual(recovered.getHistory().at(-1), {
    role: "tool",
    toolCallId: call.id,
    toolName: call.name,
    content: exactModelContent,
  });
  assert.equal(recovered.recoverInterrupted().length, 0);
});

test("parallel crash recovery emits model-facing tool messages in original call order", () => {
  const session = deterministicKernel();
  const context = { turnId: "turn-parallel", stepId: "step-parallel" };
  const first = { id: "call-first", name: "first", args: {} };
  const second = { id: "call-second", name: "second", args: {} };
  session.append({ type: "turn/started", data: {}, turnId: context.turnId });
  session.appendMessage({ role: "user", content: "run both" }, { turnId: context.turnId });
  session.append({ type: "step/started", data: { index: 0 }, ...context });
  appendModelResponse(session, context, { toolCalls: [first, second] });
  session.appendMessage({ role: "assistant", content: "", toolCalls: [first, second] }, context);
  for (const call of [first, second]) {
    session.append({ type: "tool/call", data: { call }, ...context });
    session.append({ type: "tool/execution-started", data: { call }, ...context });
  }
  session.append({
    type: "tool/result",
    data: {
      toolCallId: second.id,
      toolName: second.name,
      outcome: "succeeded",
      result: { success: true, data: "second finished" },
      modelContent: '{"success":true,"data":"second finished"}',
    },
    ...context,
  });

  session.recoverInterrupted();
  const toolMessages = session.getHistory().filter((message) => message.role === "tool");
  assert.deepEqual(toolMessages.map((message) => message.toolCallId), [first.id, second.id]);
  assert.match(String(toolMessages[0]!.content), /"outcome":"unknown"/);
  assert.equal(toolMessages[1]!.content, '{"success":true,"data":"second finished"}');
});

test("terminal step and turn events require a matching open lifecycle", () => {
  const session = deterministicKernel(new InMemorySessionEventStore(), "matched-lifecycle");

  assert.throws(
    () => session.append({
      type: "step/completed",
      data: { outcome: "completed" },
      stepId: "never-started-step",
    }),
    /cannot complete step never-started-step: no matching step is open/,
  );
  assert.throws(
    () => session.append({
      type: "turn/completed",
      data: { assistantTurnComplete: true },
      turnId: "never-started-turn",
    }),
    /cannot close turn never-started-turn: no matching turn is open/,
  );
  assert.throws(
    () => session.append({
      type: "turn/failed",
      data: { error: "orphan failure" },
      turnId: "never-started-turn",
    }),
    /cannot close turn never-started-turn: no matching turn is open/,
  );
  assert.throws(
    () => session.append({
      type: "turn/interrupted",
      data: { reason: "orphan interruption" },
      turnId: "never-started-turn",
    }),
    /cannot close turn never-started-turn: no matching turn is open/,
  );

  session.append({ type: "turn/started", data: {}, turnId: "turn-a" });
  assert.throws(
    () => session.append({
      type: "turn/completed",
      data: { assistantTurnComplete: true },
      turnId: "turn-b",
    }),
    /cannot close turn turn-b: no matching turn is open/,
  );
  session.append({ type: "step/started", data: { index: 0 }, turnId: "turn-a", stepId: "step-a" });
  assert.throws(
    () => session.append({
      type: "step/completed",
      data: { outcome: "completed" },
      turnId: "turn-a",
      stepId: "step-b",
    }),
    /cannot complete step step-b: no matching step is open/,
  );
  assert.throws(
    () => session.append({
      type: "step/completed",
      data: { outcome: "completed" },
      turnId: "turn-b",
      stepId: "step-a",
    }),
    /cannot complete step step-a: it is not open in turn turn-b/,
  );
  session.append({
    type: "step/completed",
    data: { outcome: "completed" },
    turnId: "turn-a",
    stepId: "step-a",
  });
  assert.throws(
    () => session.append({
      type: "step/completed",
      data: { outcome: "completed" },
      turnId: "turn-a",
      stepId: "step-a",
    }),
    /cannot complete step step-a: no matching step is open/,
  );
  session.append({
    type: "turn/completed",
    data: { assistantTurnComplete: true },
    turnId: "turn-a",
  });
  assert.throws(
    () => session.append({
      type: "turn/failed",
      data: { error: "already closed" },
      turnId: "turn-a",
    }),
    /cannot close turn turn-a: no matching turn is open/,
  );

  const started = deterministicKernel(
    new InMemorySessionEventStore(),
    "persisted-orphan-lifecycle",
  ).getEvents()[0]!;
  const persistedOrphan: SessionEvent = {
    schemaVersion: started.schemaVersion,
    sessionId: started.sessionId,
    seq: 2,
    eventId: "persisted-orphan-step",
    timestamp: started.timestamp,
    type: "step/completed",
    stepId: "never-opened",
    data: { outcome: "completed" },
  };
  assert.throws(
    () => new InMemorySessionEventStore([started, persistedOrphan]),
    /cannot complete step never-opened: no matching step is open/,
  );
});

test("terminal events cannot retire tool work before a model-facing receipt", () => {
  for (const terminal of ["turn/failed", "turn/completed"] as const) {
    const session = deterministicKernel(new InMemorySessionEventStore(), `session-${terminal}`);
    const context = { turnId: `turn-${terminal}`, stepId: `step-${terminal}` };
    const call = { id: `call-${terminal}`, name: "mutate", args: {} };
    session.append({ type: "turn/started", data: {}, turnId: context.turnId });
    session.append({ type: "step/started", data: { index: 0 }, ...context });
    appendModelResponse(session, context, { toolCall: call });
    session.appendMessage({
      role: "assistant",
      content: "{}",
      toolCallId: call.id,
      toolName: call.name,
    }, context);
    session.append({ type: "tool/call", data: { call }, ...context });
    session.append({ type: "tool/execution-started", data: { call }, ...context });
    const beforeForgedReceipt = session.getEvents().length;
    assert.throws(
      () => session.appendMessage({
        role: "tool",
        content: '{"success":true}',
        toolCallId: call.id,
        toolName: call.name,
      }, context),
      /has no durable result to project/,
    );
    assert.equal(session.getEvents().length, beforeForgedReceipt);
    assert.throws(
      () => session.append({
        type: "step/completed",
        data: { outcome: terminal === "turn/failed" ? "failed" : "completed" },
        ...context,
      }),
      /tool calls still lack model-facing result receipts/i,
    );
    if (terminal === "turn/failed") {
      assert.throws(
        () => session.append({ type: terminal, data: { error: "expected failure" }, turnId: context.turnId }),
        /steps or tool calls remain open/i,
      );
    } else {
      assert.throws(
        () => session.append({ type: terminal, data: { reason: "closed" }, turnId: context.turnId }),
        /steps or tool calls remain open/i,
      );
    }

    const recovery = session.recoverInterrupted();
    assert.deepEqual(recovery.map((event) => event.type), [
      "tool/result",
      "message/appended",
      "step/completed",
      "turn/interrupted",
    ]);
    assert.equal(session.getEvents().filter((event) => event.type === "tool/result").length, 1);
    assert.equal(session.getHistory().filter((message) => message.role === "tool").length, 1);
  }
});

test("crash recovery retains an unknown receipt and its aligned continuation atomically", () => {
  const store = new InMemorySessionEventStore();
  const session = deterministicKernel(store, "failed-step-gap");
  const baseline: ChatMessage[] = [
    { role: "user", content: "baseline question" },
    { role: "assistant", content: "baseline answer" },
  ];
  const stateA = {
    key: "openai.responses",
    continuationId: "response-a",
    fingerprint: digestJson("fingerprint-a"),
  };
  const stateB = {
    key: "openai.responses",
    continuationId: "response-b",
    fingerprint: digestJson("fingerprint-b"),
  };
  const context = { turnId: "failed-turn", stepId: "failed-step" };
  const call = { id: "failed-call", name: "mutate", args: {} };
  session.replaceHistory(baseline, "seed");
  session.setAdapterSessionState(stateA);
  session.append({ type: "turn/started", data: {}, turnId: context.turnId });
  session.appendMessage({ role: "user", content: "mutate it" }, { turnId: context.turnId });
  session.append({ type: "step/started", data: { index: 0 }, ...context });
  appendModelResponse(session, context, { toolCall: call });
  session.setAdapterSessionState(stateB, context);
  session.appendMessage({
    role: "assistant",
    content: "{}",
    toolCallId: call.id,
    toolName: call.name,
  }, context);
  session.append({ type: "tool/call", data: { call }, ...context });
  session.append({ type: "tool/execution-started", data: { call }, ...context });
  session.append({
    type: "tool/result",
    data: {
      toolCallId: call.id,
      toolName: call.name,
      outcome: "unknown",
      result: { success: false, error: "outcome unknown" },
      error: "outcome unknown",
      modelContent: '{"success":false,"error":"outcome unknown"}',
    },
    ...context,
  });
  const beforeResultCount = session.getEvents().filter((event) => event.type === "tool/result").length;
  const recovered = deterministicKernel(store, "failed-step-gap");
  const recovery = recovered.recoverInterrupted("crashed before rollback");

  assert.deepEqual(recovered.getHistory(), [
    ...baseline,
    { role: "user", content: "mutate it" },
    {
      role: "assistant",
      content: "{}",
      toolCallId: call.id,
      toolName: call.name,
    },
    {
      role: "tool",
      content: '{"success":false,"error":"outcome unknown"}',
      toolCallId: call.id,
      toolName: call.name,
    },
  ]);
  assert.deepEqual(recovered.getAdapterSessionState("openai.responses"), stateB);
  assert.equal(
    recovered.getEvents().filter((event) => event.type === "tool/result").length,
    beforeResultCount,
  );
  assert.deepEqual(recovery.map((event) => event.type), [
    "message/appended",
    "step/completed",
    "turn/interrupted",
  ]);
});

test("adapter continuation state replays, clears explicitly, and resets independently of history", () => {
  const store = new InMemorySessionEventStore();
  const session = deterministicKernel(store, "adapter-state");
  session.setAdapterSessionState({
    key: "openai.responses",
    continuationId: "response-1",
    fingerprint: digestJson("fingerprint-openai"),
    instructionsSha256: digestJson("openai instructions"),
  });
  session.setAdapterSessionState({
    key: "xai.responses",
    continuationId: "response-2",
    fingerprint: digestJson("fingerprint-xai"),
  });
  session.replaceHistory([{ role: "user", content: "new projection" }], "thread switch projection");
  assert.deepEqual(session.getAdapterSessionState("openai.responses"), {
    key: "openai.responses",
    continuationId: "response-1",
    fingerprint: digestJson("fingerprint-openai"),
    instructionsSha256: digestJson("openai instructions"),
  });

  session.clearAdapterSessionState("openai.responses", "thread switched");
  const replayed = deterministicKernel(store, "adapter-state");
  assert.equal(replayed.getAdapterSessionState("openai.responses"), undefined);
  assert.deepEqual(replayed.getAdapterSessionState("xai.responses"), {
    key: "xai.responses",
    continuationId: "response-2",
    fingerprint: digestJson("fingerprint-xai"),
  });

  replayed.append({ type: "session/reset", data: { reason: "reset" } });
  assert.equal(replayed.getAdapterSessionState("xai.responses"), undefined);
  const afterReset = deterministicKernel(store, "adapter-state");
  assert.equal(afterReset.getAdapterSessionState("openai.responses"), undefined);
  assert.equal(afterReset.getAdapterSessionState("xai.responses"), undefined);
  assert.throws(
    () => afterReset.setAdapterSessionState({
      key: "",
      continuationId: "response",
      fingerprint: digestJson("fingerprint"),
    }),
    /state.key must be a non-empty string/,
  );
  assert.throws(
    () => afterReset.setAdapterSessionState({
      key: "openai.responses",
      continuationId: "response",
      fingerprint: digestJson("fingerprint"),
      instructionsSha256: "not-a-digest",
    }),
    /instructionsSha256 must be a lowercase SHA-256 digest/,
  );
  assert.throws(
    () => afterReset.setAdapterSessionState({
      key: "openai.responses",
      continuationId: "response",
      fingerprint: "",
    }),
    /fingerprint must be a non-empty string/,
  );
});

test("thread switches and compaction replace history and clear continuation state in one event", () => {
  const store = new InMemorySessionEventStore();
  let eventIndex = 0;
  const session = new SessionKernel({
    sessionId: "atomic-thread-transition",
    store,
    metadata: { threadId: "thread-a" },
    clock: () => new Date("2026-08-25T12:00:00.000Z"),
    eventIdFactory: () => `atomic-event-${++eventIndex}`,
  });
  session.replaceHistory([{ role: "user", content: "thread a" }], "seed");
  session.setAdapterSessionState({
    key: "openai.responses",
    continuationId: "response-a",
    fingerprint: digestJson("thread-a-fingerprint"),
  });

  const switched = session.switchThread(
    "thread-b",
    [{ role: "user", content: "thread b" }],
  );
  assert.equal(switched.data.clearAdapterStates, true);
  assert.equal(session.getThreadId(), "thread-b");
  assert.deepEqual(session.getHistory(), [{ role: "user", content: "thread b" }]);
  assert.equal(session.getAdapterSessionState("openai.responses"), undefined);

  session.setAdapterSessionState({
    key: "openai.responses",
    continuationId: "response-b",
    fingerprint: digestJson("thread-b-fingerprint"),
  });
  session.replaceHistoryAndClearAdapterStates(
    [{ role: "user", content: "compacted thread b" }],
    "compaction_applied",
  );
  assert.equal(session.getThreadId(), "thread-b");
  assert.equal(session.getAdapterSessionState("openai.responses"), undefined);

  const replayed = deterministicKernel(store, "atomic-thread-transition");
  assert.equal(replayed.getThreadId(), "thread-b");
  assert.deepEqual(replayed.getHistory(), [{ role: "user", content: "compacted thread b" }]);
  assert.equal(replayed.getAdapterSessionState("openai.responses"), undefined);
});

test("user-only crash recovery restores adapter state captured at turn start", () => {
  const store = new InMemorySessionEventStore();
  const session = deterministicKernel(store, "adapter-user-only-recovery");
  const before = {
    key: "openai.responses",
    continuationId: "response-a",
    fingerprint: digestJson("fingerprint-a"),
    instructionsSha256: digestJson("instructions-a"),
  };
  session.setAdapterSessionState(before);
  session.append({ type: "turn/started", data: {}, turnId: "interrupted-user-only" });
  session.appendMessage(
    { role: "user", content: "interrupted" },
    { turnId: "interrupted-user-only" },
  );
  session.setAdapterSessionState({
    key: "openai.responses",
    continuationId: "response-b",
    fingerprint: digestJson("fingerprint-b"),
    instructionsSha256: digestJson("instructions-b"),
  }, { turnId: "interrupted-user-only" });

  const recoveryEvents = session.recoverInterrupted();
  assert.deepEqual(session.getHistory(), []);
  assert.deepEqual(session.getAdapterSessionState("openai.responses"), before);
  assert.deepEqual(recoveryEvents.map((event) => event.type), [
    "history/replaced",
    "adapter/state-updated",
    "turn/interrupted",
  ]);

  const replayed = deterministicKernel(store, "adapter-user-only-recovery");
  assert.deepEqual(replayed.getAdapterSessionState("openai.responses"), before);
  assert.deepEqual(replayed.getHistory(), []);
});

test("recovery restores prior state when an interrupted turn already rolled back its projection", () => {
  const session = deterministicKernel(new InMemorySessionEventStore(), "adapter-projection-rollback");
  const context = { turnId: "rolled-back-turn", stepId: "rolled-back-step" };
  const before = {
    key: "openai.responses",
    continuationId: "response-a",
    fingerprint: digestJson("fingerprint-a"),
  };
  session.setAdapterSessionState(before);
  session.append({ type: "turn/started", data: {}, turnId: context.turnId });
  session.appendMessage({ role: "user", content: "question" }, { turnId: context.turnId });
  session.append({ type: "step/started", data: { index: 0 }, ...context });
  appendModelResponse(session, context, {
    text: "answer that will be rolled back",
    providerReplay: { key: "openai.responses", outputItems: [{ type: "message" }] },
  });
  session.setAdapterSessionState({
    key: "openai.responses",
    continuationId: "response-b",
    fingerprint: digestJson("fingerprint-b"),
  }, context);
  session.appendMessage({
    role: "assistant",
    content: "answer that will be rolled back",
    providerReplay: { key: "openai.responses", outputItems: [{ type: "message" }] },
  }, context);
  session.append({ type: "step/completed", data: { outcome: "failed" }, ...context });
  session.replaceHistory([], "turn_failed", { turnId: context.turnId });

  session.recoverInterrupted("crashed between history and state rollback");
  assert.deepEqual(session.getHistory(), []);
  assert.deepEqual(session.getAdapterSessionState("openai.responses"), before);
});

test("partial assistant replay and tool recovery retain the aligned adapter state", () => {
  const store = new InMemorySessionEventStore();
  const session = deterministicKernel(store, "adapter-partial-recovery");
  session.setAdapterSessionState({
    key: "openai.responses",
    continuationId: "response-a",
    fingerprint: digestJson("fingerprint-a"),
  });
  const context = { turnId: "partial-turn", stepId: "partial-step" };
  const call = { id: "partial-call", name: "inspect", args: { path: "file.ts" } };
  const replay = {
    key: "openai.responses",
    outputItems: [{ type: "function_call", call_id: call.id, name: call.name }],
  };
  const retained = {
    key: "openai.responses",
    continuationId: "response-b",
    fingerprint: digestJson("fingerprint-b"),
    instructionsSha256: digestJson("instructions-b"),
  };
  session.append({ type: "turn/started", data: {}, turnId: context.turnId });
  session.appendMessage({ role: "user", content: "inspect it" }, { turnId: context.turnId });
  session.append({ type: "step/started", data: { index: 0 }, ...context });
  appendModelResponse(session, context, { toolCall: call, providerReplay: replay });
  session.setAdapterSessionState(retained, context);
  session.appendMessage({
    role: "assistant",
    content: JSON.stringify(call.args),
    toolCallId: call.id,
    toolName: call.name,
    providerReplay: replay,
  } as ChatMessage & { providerReplay: typeof replay }, context);
  session.append({ type: "tool/call", data: { call }, ...context });

  const recoveryEvents = session.recoverInterrupted("crashed before tool start");
  assert.deepEqual(session.getAdapterSessionState("openai.responses"), retained);
  assert.equal(
    recoveryEvents.some((event) => event.type === "adapter/state-updated" || event.type === "adapter/state-cleared"),
    false,
  );
  assert.deepEqual(session.getHistory().map((message) => message.role), ["user", "assistant", "tool"]);

  const replayed = deterministicKernel(store, "adapter-partial-recovery");
  assert.deepEqual(replayed.getAdapterSessionState("openai.responses"), retained);
});

test("recovery rolls an unprojected later response back to its step continuation checkpoint", () => {
  const store = new InMemorySessionEventStore();
  const sessionId = "adapter-unprojected-later-response";
  const session = deterministicKernel(store, sessionId);
  const turnId = "retained-tool-turn";
  const toolContext = { turnId, stepId: "retained-tool-step" };
  const finalContext = { turnId, stepId: "unprojected-final-step" };
  const call = { id: "retained-call", name: "inspect", args: { path: "file.ts" } };
  const stateA = {
    key: "openai.responses",
    continuationId: "response-a",
    fingerprint: digestJson("fingerprint-a"),
  };
  const stateB = {
    key: "openai.responses",
    continuationId: "response-b",
    fingerprint: digestJson("fingerprint-b"),
  };
  const toolContent = '{"success":true,"data":"retained"}';

  session.append({ type: "turn/started", data: {}, turnId });
  session.appendMessage({ role: "user", content: "inspect then summarize" }, { turnId });
  session.append({ type: "step/started", data: { index: 0 }, ...toolContext });
  appendModelResponse(session, toolContext, { toolCall: call });
  session.setAdapterSessionState(stateA, toolContext);
  session.appendMessage({
    role: "assistant",
    content: JSON.stringify(call.args),
    toolCallId: call.id,
    toolName: call.name,
  }, toolContext);
  session.append({ type: "tool/call", data: { call }, ...toolContext });
  session.append({ type: "tool/execution-started", data: { call }, ...toolContext });
  session.append({
    type: "tool/result",
    data: {
      toolCallId: call.id,
      toolName: call.name,
      outcome: "succeeded",
      result: { success: true, data: "retained" },
      modelContent: toolContent,
    },
    ...toolContext,
  });
  session.appendMessage({
    role: "tool",
    content: toolContent,
    toolCallId: call.id,
    toolName: call.name,
  }, toolContext);
  session.append({
    type: "step/completed",
    data: { outcome: "completed", reason: "tool_results" },
    ...toolContext,
  });

  session.append({ type: "step/started", data: { index: 1 }, ...finalContext });
  appendModelResponse(session, finalContext, { text: "summary that was never projected" });
  session.setAdapterSessionState(stateB, finalContext);

  const recovery = session.recoverInterrupted("crashed before assistant projection");
  assert.deepEqual(recovery.map((event) => event.type), [
    "adapter/state-updated",
    "step/completed",
    "turn/interrupted",
  ]);
  assert.deepEqual(session.getAdapterSessionState("openai.responses"), stateA);
  assert.deepEqual(session.getHistory().map((message) => message.role), [
    "user",
    "assistant",
    "tool",
  ]);
  assert.equal(
    session.getHistory().some((message) => message.content === "summary that was never projected"),
    false,
  );

  const replayed = deterministicKernel(store, sessionId);
  assert.deepEqual(replayed.getAdapterSessionState("openai.responses"), stateA);
  assert.deepEqual(replayed.getHistory(), session.getHistory());
  assert.equal(replayed.recoverInterrupted().length, 0);
});

test("same-store appends use incremental validation and rebuild after an external change", (t) => {
  const root = withTempDir(t);
  const sessionId = "incremental-validation";
  const store = new JsonlSessionEventStore({ rootDir: root });
  const internals = store as unknown as {
    readLog(id: string): unknown;
  };
  const originalReadLog = internals.readLog.bind(store);
  let fullLogReads = 0;
  internals.readLog = (id: string): unknown => {
    fullLogReads += 1;
    return originalReadLog(id);
  };

  const session = deterministicKernel(store, sessionId);
  const kernelInternals = session as unknown as { events: SessionEvent[] };
  let priorEventIndexReads = 0;
  kernelInternals.events = new Proxy(kernelInternals.events, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^(?:0|[1-9][0-9]*)$/.test(property)) {
        priorEventIndexReads += 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });

  for (let index = 0; index < 32; index += 1) {
    session.replaceHistory([], `constant-size-event-${index}`);
  }

  assert.equal(fullLogReads, 1, "normal appends reuse the validated JSONL prefix");
  assert.equal(priorEventIndexReads, 0, "kernel validation never rescans prior events");
  assert.equal(session.getEventCount(), 33, "event count does not require copying the journal");

  const external = deterministicKernel(
    new JsonlSessionEventStore({ rootDir: root }),
    sessionId,
  );
  external.replaceHistory([], "external-writer-advanced-log");
  assert.throws(
    () => session.replaceHistory([], "stale-writer-must-not-append"),
    (error: unknown) => error instanceof SessionInvariantError && /expected 35, got 34/.test(error.message),
  );
  assert.equal(fullLogReads, 2, "an external file change invalidates and rebuilds the cache");
});

test("full replay performs no prior-event array scans", () => {
  const source = deterministicKernel(new InMemorySessionEventStore(), "linear-replay-source");
  for (let index = 0; index < 128; index += 1) {
    source.replaceHistory([], `replay-event-${index}`);
  }
  const events = source.getEvents();
  const store: SessionEventStore = {
    read(sessionId) {
      return sessionId === "linear-replay-source" ? events : [];
    },
    append() {
      throw new Error("replay test must not append");
    },
  };
  const arrayPrototype = Array.prototype as unknown as {
    some(
      predicate: (value: unknown, index: number, array: unknown[]) => unknown,
      thisArg?: unknown,
    ): boolean;
  };
  const originalSome = arrayPrototype.some;
  let priorEventScanCallbacks = 0;
  arrayPrototype.some = function instrumentedSome(predicate, thisArg): boolean {
    return originalSome.call(this, (value, index, array) => {
      priorEventScanCallbacks += 1;
      return predicate.call(thisArg, value, index, array);
    });
  };
  const replayed = (() => {
    try {
      return new SessionKernel({ sessionId: "linear-replay-source", store });
    } finally {
      arrayPrototype.some = originalSome;
    }
  })();

  assert.equal(replayed.getEventCount(), events.length);
  assert.equal(priorEventScanCallbacks, 0, "replay validation must not scan prior event arrays");
});

test("JSONL store roundtrips committed events with private paths and permissions", (t) => {
  const parent = withTempDir(t);
  const root = join(parent, "sessions");
  const sessionId = "../../never-use-this-as-a-path";
  const store = new JsonlSessionEventStore({ rootDir: root });
  const session = deterministicKernel(store, sessionId);
  session.appendMessage({ role: "user", content: "persist me" });

  const paths = sessionPaths(root, sessionId);
  const digest = createHash("sha256").update(sessionId).digest("hex");
  assert.deepEqual(readdirSync(root), [`${digest}.jsonl`]);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(paths.events).mode & 0o777, 0o600);
  assert.equal(readFileSync(paths.events, "utf8").split("\n").filter(Boolean).length, 2);

  const replayed = deterministicKernel(new JsonlSessionEventStore({ rootDir: root }), sessionId);
  assert.deepEqual(replayed.getHistory(), [{ role: "user", content: "persist me" }]);
  assert.deepEqual(replayed.getEvents(), session.getEvents());
});

test("JSONL store rejects unsafe pre-existing roots without changing their permissions", (t) => {
  const parent = withTempDir(t);
  const insecure = join(parent, "insecure");
  mkdirSync(insecure, { mode: 0o700 });
  chmodSync(insecure, 0o755);
  assert.throws(
    () => new JsonlSessionEventStore({ rootDir: insecure }),
    /must have mode 0700/,
  );
  assert.equal(statSync(insecure).mode & 0o777, 0o755);

  const file = join(parent, "not-a-directory");
  writeFileSync(file, "not a directory", { mode: 0o600 });
  assert.throws(
    () => new JsonlSessionEventStore({ rootDir: file }),
    /must be a directory/,
  );

  const target = join(parent, "target");
  mkdirSync(target, { mode: 0o700 });
  const link = join(parent, "linked-root");
  symlinkSync(target, link);
  for (const linkedRoot of [link, `${link}/`]) {
    assert.throws(
      () => new JsonlSessionEventStore({ rootDir: linkedRoot }),
      /must not be a symbolic link/,
    );
  }
});

test("JSONL cache detects same-size rewrites and rejects unsafe event paths", (t) => {
  const root = withTempDir(t);
  const sessionId = "event-file-safety";
  const store = new JsonlSessionEventStore({ rootDir: root });
  const session = deterministicKernel(store, sessionId);
  session.appendMessage({ role: "user", content: "alpha" });
  const paths = sessionPaths(root, sessionId);

  const original = readFileSync(paths.events, "utf8");
  const rewritten = original.replace('"content":"alpha"', '"content":"bravo"');
  assert.notEqual(rewritten, original);
  assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(original));
  writeFileSync(paths.events, rewritten, { encoding: "utf8", mode: 0o600 });

  const changed = store.read(sessionId).find((event) => event.type === "message/appended");
  assert(changed?.type === "message/appended");
  assert.equal(changed.data.message.content, "bravo");

  chmodSync(paths.events, 0o644);
  assert.throws(
    () => store.read(sessionId),
    /session event file must have mode 0600/,
  );
  chmodSync(paths.events, 0o600);

  const target = join(root, "event-target.jsonl");
  writeFileSync(target, rewritten, { encoding: "utf8", mode: 0o600 });
  unlinkSync(paths.events);
  symlinkSync(target, paths.events);
  assert.throws(
    () => store.read(sessionId),
    /session event file must not be a symbolic link/,
  );
});

test("JSONL store ignores and replaces one crash-torn final fragment", (t) => {
  const root = withTempDir(t);
  const sessionId = "torn-tail";
  const store = new JsonlSessionEventStore({ rootDir: root });
  const session = deterministicKernel(store, sessionId);
  const paths = sessionPaths(root, sessionId);
  appendFileSync(paths.events, "{\"schemaVersion\":1", { encoding: "utf8" });

  assert.equal(store.read(sessionId).length, 1, "unterminated tail is not a committed event");
  session.appendMessage({ role: "user", content: "after recovery" });

  const contents = readFileSync(paths.events, "utf8");
  assert(contents.endsWith("\n"));
  assert(!contents.includes("{\"schemaVersion\":1{\""));
  assert.equal(store.read(sessionId).length, 2);
  assert.deepEqual(session.getHistory(), [{ role: "user", content: "after recovery" }]);
});

test("JSONL store fails closed on malformed committed middle lines", (t) => {
  const root = withTempDir(t);
  const sessionId = "corrupt-middle";
  const store = new JsonlSessionEventStore({ rootDir: root });
  const session = deterministicKernel(store, sessionId);
  session.appendMessage({ role: "user", content: "valid second event" });
  const paths = sessionPaths(root, sessionId);
  const [first, second] = readFileSync(paths.events, "utf8").trimEnd().split("\n");
  writeFileSync(paths.events, `${first}\nnot-json\n${second}\n`, { encoding: "utf8", mode: 0o600 });

  assert.throws(
    () => store.read(sessionId),
    (error: unknown) => error instanceof SessionInvariantError && /committed session event at line 2/.test(error.message),
  );
});

test("JSONL store surfaces lock contention without reclaiming the lock", (t) => {
  const root = withTempDir(t);
  const sessionId = "contended";
  const store = new JsonlSessionEventStore({ rootDir: root });
  const session = deterministicKernel(store, sessionId);
  const paths = sessionPaths(root, sessionId);
  const lockFd = openSync(paths.lock, "wx", 0o600);
  const before = session.getEvents().length;

  try {
    assert.throws(
      () => session.appendMessage({ role: "user", content: "must not append" }),
      (error: unknown) => error instanceof SessionConcurrencyError,
    );
    assert.equal(session.getEvents().length, before);
    assert(statSync(paths.lock).isFile(), "the contender's lock is left untouched");
  } finally {
    closeSync(lockFd);
    if (existsSync(paths.lock)) unlinkSync(paths.lock);
  }
});

test("JSONL store reclaims a completed lock claim whose owner exited", (t) => {
  const root = withTempDir(t);
  const sessionId = "crashed-writer";
  const store = new JsonlSessionEventStore({ rootDir: root });
  const session = deterministicKernel(store, sessionId);
  const paths = sessionPaths(root, sessionId);
  const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert(exited.pid, "the exited child has a pid");
  const token = "11111111-1111-4111-8111-111111111111";
  const staleClaim = `${paths.lock}.${exited.pid}.${token}.claim`;
  writeFileSync(staleClaim, `${JSON.stringify({ pid: exited.pid, token })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  linkSync(staleClaim, paths.lock);

  session.appendMessage({ role: "user", content: "continued after owner crash" });

  assert(!existsSync(paths.lock));
  assert(!existsSync(staleClaim));
  assert.deepEqual(session.getHistory(), [{ role: "user", content: "continued after owner crash" }]);
});

test("JSONL store serializes stale lock recovery before replacing the owner", (t) => {
  const root = withTempDir(t);
  const sessionId = "concurrent-stale-reclaim";
  const store = new JsonlSessionEventStore({ rootDir: root });
  const session = deterministicKernel(store, sessionId);
  const paths = sessionPaths(root, sessionId);
  const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert(exited.pid, "the exited child has a pid");

  const staleToken = "22222222-2222-4222-8222-222222222222";
  const staleClaim = `${paths.lock}.${exited.pid}.${staleToken}.claim`;
  writeFileSync(staleClaim, `${JSON.stringify({ pid: exited.pid, token: staleToken })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  linkSync(staleClaim, paths.lock);

  // Model a contender paused after acquiring the dedicated recovery gate.
  // A second contender must not unlink the stale lock until that gate is
  // released, or it could delete the first contender's replacement lock.
  const gateToken = "33333333-3333-4333-8333-333333333333";
  const gateClaim = `${paths.lock}.${process.pid}.${gateToken}.claim`;
  const reclaimGate = `${paths.lock}.reclaim.${staleToken}`;
  writeFileSync(gateClaim, `${JSON.stringify({ pid: process.pid, token: gateToken })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  linkSync(gateClaim, reclaimGate);
  const staleIdentity = statSync(paths.lock);
  const before = session.getEvents().length;

  assert.throws(
    () => session.appendMessage({ role: "user", content: "blocked contender" }),
    (error: unknown) => error instanceof SessionConcurrencyError,
  );
  const retainedIdentity = statSync(paths.lock);
  assert.equal(retainedIdentity.dev, staleIdentity.dev);
  assert.equal(retainedIdentity.ino, staleIdentity.ino);
  assert.equal(session.getEvents().length, before);

  unlinkSync(reclaimGate);
  unlinkSync(gateClaim);
  session.appendMessage({ role: "user", content: "continued after serialized recovery" });

  assert(!existsSync(paths.lock));
  assert(!existsSync(staleClaim));
  assert.deepEqual(session.getHistory(), [
    { role: "user", content: "continued after serialized recovery" },
  ]);
});

test("JSONL store advances past a crashed stale-lock reclaimer without replacing its gate", (t) => {
  const root = withTempDir(t);
  const sessionId = "crashed-stale-reclaimer";
  const store = new JsonlSessionEventStore({ rootDir: root });
  const session = deterministicKernel(store, sessionId);
  const paths = sessionPaths(root, sessionId);
  const staleProcess = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const crashedReclaimer = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert(staleProcess.pid, "the stale lock owner has a pid");
  assert(crashedReclaimer.pid, "the crashed reclaimer has a pid");

  const staleToken = "44444444-4444-4444-8444-444444444444";
  const staleClaim = `${paths.lock}.${staleProcess.pid}.${staleToken}.claim`;
  writeFileSync(staleClaim, `${JSON.stringify({ pid: staleProcess.pid, token: staleToken })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  linkSync(staleClaim, paths.lock);

  const reclaimerToken = "55555555-5555-4555-8555-555555555555";
  const reclaimerClaim = `${paths.lock}.${crashedReclaimer.pid}.${reclaimerToken}.claim`;
  const crashedGate = `${paths.lock}.reclaim.${staleToken}`;
  const nextGenerationGate = `${crashedGate}.${reclaimerToken}`;
  writeFileSync(
    reclaimerClaim,
    `${JSON.stringify({ pid: crashedReclaimer.pid, token: reclaimerToken })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  linkSync(reclaimerClaim, crashedGate);
  const crashedGateIdentity = statSync(crashedGate);

  session.appendMessage({ role: "user", content: "continued through next generation" });

  const retainedGateIdentity = statSync(crashedGate);
  assert.equal(retainedGateIdentity.dev, crashedGateIdentity.dev);
  assert.equal(retainedGateIdentity.ino, crashedGateIdentity.ino);
  assert(!existsSync(nextGenerationGate), "the successful reclaimer releases only its leaf gate");
  assert(!existsSync(paths.lock));
  assert(!existsSync(staleClaim));
  assert.deepEqual(session.getHistory(), [
    { role: "user", content: "continued through next generation" },
  ]);
});

test("JSONL append checks contiguous sequence while holding its lock", (t) => {
  const root = withTempDir(t);
  const sessionId = "stale-writer";
  const first = deterministicKernel(new JsonlSessionEventStore({ rootDir: root }), sessionId);
  const stale = deterministicKernel(new JsonlSessionEventStore({ rootDir: root }), sessionId);
  first.appendMessage({ role: "user", content: "first writer wins" });

  assert.throws(
    () => stale.appendMessage({ role: "user", content: "stale writer" }),
    (error: unknown) => error instanceof SessionInvariantError && /expected 3, got 2/.test(error.message),
  );
  assert.equal(new JsonlSessionEventStore({ rootDir: root }).read(sessionId).length, 2);
});
