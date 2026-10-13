#!/usr/bin/env tsx
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createChatAgent } from "../src/framework/chat-agent.js";
import { createChatAgentHttpServer } from "../src/framework/chat-agent-http.js";
import { ToolRegistry } from "../src/framework/registry.js";
import { SessionKernel, InMemorySessionEventStore, type SessionEvent } from "../src/framework/session.js";
import { RunExecutionError } from "../src/framework/runs.js";
import { defineTool } from "../src/framework/tool.js";
import type { AIAdapter, AdapterResponse, ChatMessage, ChatOptions } from "../src/framework/adapters/types.js";
import type { ToolExecutionContext } from "../src/framework/execution-types.js";

function adapter(responses: AdapterResponse[], requests: ChatMessage[][] = [], options: ChatOptions[] = []): AIAdapter {
  return {
    name: "offline", model: "fixture", sessionStateKey: "fixture.state",
    async chat(messages, _registry, config) {
      requests.push(structuredClone(messages));
      options.push(config ?? {});
      return responses.shift() ?? { text: "done" };
    },
  };
}
const definition = { name: "write", description: "Offline effect", inputSchema: { type: "object" as const, properties: { n: { type: "integer" as const } }, required: ["n"] } };

test("chat executor: policy rejection produces a bound v2 receipt without handler or execution start", async () => {
  let calls = 0;
  const registry = new ToolRegistry({ mode: "governed", policy: { authorize: () => ({ decision: "deny", reasonCodes: ["fixture_denied"] }) } });
  registry.register(defineTool({ ...definition, handler: async () => { calls++; return { success: true }; } }));
  const agent = await createChatAgent({ tools: registry, memory: false, adapter: adapter([{ toolCall: { id: "denied", name: "write", args: { n: 1 } } }]) });
  const answer = await agent.chat("write");
  assert.equal(calls, 0);
  assert.equal(answer.toolCalls[0].result.success, false);
  const events = agent.getSessionEvents();
  assert.equal(events.filter((event) => event.type === "tool/execution-started").length, 0);
  const settlement = events.find((event) => event.type === "tool/result");
  assert.ok(settlement?.type === "tool/result");
  assert.equal(settlement.schemaVersion, 2);
  assert.equal(settlement.data.receipt?.phase, "not_started");
  assert.equal(settlement.data.receipt?.admission, "rejected");
  assert.equal(settlement.data.receipt?.callId, "denied");
});

test("chat executor: malformed arguments never produce a fake start", async () => {
  let calls = 0;
  const tool = defineTool({ ...definition, handler: async () => { calls++; return { success: true }; } });
  const agent = await createChatAgent({ tools: [tool], memory: false, adapter: adapter([{ toolCall: { id: "invalid", name: "write", args: { n: "1" } } }]) });
  await agent.chat("write");
  assert.equal(calls, 0);
  assert.equal(agent.getSessionEvents().filter((event) => event.type === "tool/execution-started").length, 0);
});

test("chat executor: records durable start before dispatch and preserves one normalization", async () => {
  let normalized = 0;
  let seen: ToolExecutionContext | undefined;
  let agent: Awaited<ReturnType<typeof createChatAgent>>;
  const tool = defineTool({ ...definition, handler: async (_args, context) => {
    seen = context;
    assert.equal(agent.getSessionEvents().at(-1)?.type, "tool/execution-started");
    return { success: true, toJSON() { normalized++; return { success: true, data: { value: 1 } }; } };
  } });
  agent = await createChatAgent({ tools: [tool], memory: false, executionContext: { actor: { kind: "host", id: "trusted-host" }, authorityGrantRefs: ["grant-1"] }, adapter: adapter([{ toolCall: { id: "actual", name: "write", args: { n: 1 } } }]) });
  const result = await agent.chat("write", { executionContext: { scope: { workspaceId: "workspace-1" } } });
  assert.equal(normalized, 1);
  assert.equal(seen?.actor?.id, "trusted-host");
  assert.equal(seen?.callId, "actual");
  assert.equal(seen?.scope?.workspaceId, "workspace-1");
  assert.equal(seen?.runId, result.run.manifest.runId);
  const settled = agent.getSessionEvents().find((event) => event.type === "tool/result");
  assert.ok(settled?.type === "tool/result");
  const modelMessage = agent.getHistory().find((message) => message.role === "tool");
  assert.equal(modelMessage?.content, settled.data.modelContent);
  assert.equal(settled.data.receipt?.phase, "settled");
});

test("chat executor: HTTP identity comes from the trusted resolver rather than body fields", async (t) => {
  let actor: string | undefined;
  const tool = defineTool({ ...definition, handler: async (_args, context) => { actor = context?.actor?.id; return { success: true }; } });
  const agent = await createChatAgent({ tools: [tool], memory: false, adapter: adapter([{ toolCall: { id: "http", name: "write", args: { n: 1 } } }]) });
  const server = createChatAgentHttpServer(agent, { resolveExecutionContext: (request) => ({ actor: { kind: "host", id: String(request.headers["x-fixture-identity"]) } }) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/chat`, { method: "POST", headers: { "Content-Type": "application/json", "x-fixture-identity": "authenticated-fixture" }, body: JSON.stringify({ message: "write", actor: { id: "forged" }, executionContext: { actor: { id: "forged" }, authorityGrantRefs: ["forged"] } }) });
  assert.equal(response.status, 200);
  assert.equal(actor, "authenticated-fixture");
});

test("history budget: retains complete tool exchanges and clears continuation atomically", async () => {
  const requests: ChatMessage[][] = [];
  const options: ChatOptions[] = [];
  const state = { key: "fixture.state", continuationId: "continuation", fingerprint: "fingerprint" };
  const tool = defineTool({ ...definition, handler: async () => ({ success: true, data: { artifactRef: "artifact-1" } }) });
  const native = { key: "fixture.native", outputItems: [{ type: "function_call", id: "tool-native" }] };
  const agent = await createChatAgent({ tools: [tool], memory: false, historyBudget: { maxMessages: 6 }, adapter: adapter([
    { text: "old", sessionState: state },
    { toolCall: { id: "grouped", name: "write", args: { n: 1 } }, providerReplay: native, thinking: [{ signature: "exact" }], sessionState: state },
    { text: "tool done", sessionState: state },
    { text: "latest", sessionState: state },
  ], requests, options) });
  await agent.chat("old user");
  await agent.chat("tool user");
  await agent.chat("new user");
  const latest = requests.at(-1)!;
  assert.equal(latest.length, 5);
  assert.equal(latest[0].content, "tool user");
  assert.deepEqual(latest[1].providerReplay, native);
  assert.deepEqual(latest[1].thinkingBlocks, [{ signature: "exact" }]);
  assert.equal(latest[2].toolCallId, "grouped");
  assert.ok(String(latest[2].content).includes("artifact-1"));
  assert.equal(options.at(-1)?.sessionState, undefined);
  const compaction = agent.getSessionEvents().find((event) => event.type === "history/replaced" && event.data.reason === "model_history_budget");
  assert.ok(compaction?.type === "history/replaced");
  assert.equal(compaction.data.clearAdapterStates, true);
  assert.ok(agent.getSessionEvents().some((event) => event.type === "message/appended" && event.data.message.content === "old user"));
});

test("history budget: complete active turns fail explicitly when irreducible rather than splitting calls", async () => {
  let effects = 0;
  const requests: ChatMessage[][] = [];
  const tool = defineTool({ ...definition, handler: async () => { effects++; return { success: true, data: { value: "saved" } }; } });
  const agent = await createChatAgent({ tools: [tool], memory: false, historyBudget: { maxMessages: 2 }, adapter: adapter([{ toolCall: { id: "too-large", name: "write", args: { n: 1 } } }], requests) });
  await assert.rejects(agent.chat("write"), /history budget/);
  assert.equal(effects, 1);
  assert.equal(requests.length, 1);
  assert.equal(agent.getHistory().filter((message) => message.role === "tool").length, 1);
});


test("chat provenance: actual adapter usage and limits are recorded without inferred measurements", async () => {
  const agent = await createChatAgent({ memory: false, adapter: adapter([{ text: "done", usage: { inputTokens: 17, outputTokens: 3, cachedInputTokens: 5 }, requestLimits: { maxOutputTokens: 100 } }]) });
  await agent.chat("measure");
  const event = agent.getSessionEvents().find((event) => event.type === "model/response-received");
  assert.ok(event?.type === "model/response-received");
  assert.equal(event.data.usage?.totalTokens, undefined);
  assert.deepEqual(event.data.usage, { inputTokens: 17, outputTokens: 3, cachedInputTokens: 5 });
  assert.deepEqual(event.data.requestLimits, { maxOutputTokens: 100 });
});


test("chat cancellation: a bound v2 no-dispatch receipt supersedes durable started intent without false effects", async () => {
  const cancellation = new AbortController();
  let handlerCalls = 0;
  const registry = new ToolRegistry({ journal: { record(event) {
    if (event.type === "started") cancellation.abort(new Error("cancel after durable intent before handler"));
  } } });
  registry.register(defineTool({ ...definition, handler: async () => { handlerCalls++; return { success: true }; } }));
  const agent = await createChatAgent({ memory: false, tools: registry, adapter: adapter([{ toolCall: { id: "cancelled-intent", name: "write", args: { n: 1 } } }]) });
  await assert.rejects(agent.chat("write", { signal: cancellation.signal }), (error: unknown) => {
    assert.ok(error instanceof RunExecutionError);
    assert.equal(error.run.cancellation?.effects, "none");
    assert.equal(error.toolEffects, undefined);
    return true;
  });
  assert.equal(handlerCalls, 0);
  const events = agent.getSessionEvents();
  assert.ok(events.some((event) => event.type === "tool/execution-started"));
  const settled = events.find((event) => event.type === "tool/result");
  assert.ok(settled?.type === "tool/result");
  assert.equal(settled.data.outcome, "failed");
  assert.equal(settled.data.receipt?.phase, "not_started");
  assert.equal(settled.data.receipt?.admission, "rejected");
  assert.equal(settled.data.recovered, undefined);
  const mixed = events.map((event, index) => index === 0 ? { ...event, schemaVersion: 1 as const } : event) as SessionEvent[];
  const replayed = new SessionKernel({ sessionId: mixed[0].sessionId, store: new InMemorySessionEventStore(mixed) });
  assert.deepEqual(replayed.recoverInterrupted(), []);
  assert.equal(handlerCalls, 0);
  const replayedResult = replayed.getEvents().find((event) => event.type === "tool/result");
  assert.ok(replayedResult?.type === "tool/result");
  assert.equal(replayedResult.data.modelContent, settled.data.modelContent);
});
