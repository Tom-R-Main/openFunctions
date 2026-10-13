#!/usr/bin/env tsx
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectContextSnapshots, contextSnapshotReferences, formatContextSnapshots, invalidateContext, type ConnectedProvider, type ContextSnapshotInput } from "../src/framework/context.js";
import { createChatAgent } from "../src/framework/chat-agent.js";
import type { AIAdapter, ChatMessage } from "../src/framework/adapters/types.js";

const start = new Date("2026-10-12T12:00:00.000Z");
function provider(buildSnapshot?: () => Promise<ContextSnapshotInput>): ConnectedProvider {
  return { metadata: { id: "fixture", name: "Fixture", description: "Offline", capabilities: ["tasks"] }, contextScope: { principalId: "user-1", workspaceId: "workspace-1" }, createTools: () => [], buildSnapshot };
}
function snapshot(content = "Task A"): ContextSnapshotInput {
  return { providerId: "fixture", scope: { principalId: "user-1", workspaceId: "workspace-1" }, content, observedAt: start.toISOString(), revision: "revision-1", completeness: "complete", sourceRefs: [{ id: "task-a", revision: "revision-1" }], items: [{ kind: "observation", text: "Task A is open", sourceRefs: ["task-a"] }] };
}

test("context: immutable attributed snapshots distinguish source observation from local retrieval", async () => {
  const source = snapshot();
  const connected = provider(async () => source);
  const [captured] = await collectContextSnapshots([connected], { clock: () => new Date("2026-10-12T12:01:00.000Z") });
  assert.equal(captured.observedAt, start.toISOString());
  assert.equal(captured.retrievedAt, "2026-10-12T12:01:00.000Z");
  assert.equal(captured.freshness, "fresh");
  assert.equal(captured.scope.principalId, "user-1");
  assert.ok(Object.isFrozen(captured));
  source.content = "Changed externally";
  assert.equal(captured.content, "Task A");
  const ref = contextSnapshotReferences([captured])[0];
  assert.equal(ref.snapshotId, captured.snapshotId);
  assert.equal(ref.contentDigest, captured.contentDigest);
  assert.ok(!("content" in ref));
});

test("context: legacy strings never gain invented upstream freshness or revision", async () => {
  let calls = 0;
  const connected = provider();
  connected.buildContext = async () => { calls++; return "legacy tasks"; };
  const [first] = await collectContextSnapshots([connected], { clock: () => start });
  const [second] = await collectContextSnapshots([connected], { clock: () => new Date(start.getTime() + 60_000) });
  assert.equal(calls, 1);
  assert.equal(first.snapshotId, second.snapshotId);
  assert.equal(first.freshness, "unknown");
  assert.equal(first.observedAt, undefined);
  assert.equal(first.revision, undefined);
});

test("context: turn refresh changes captured identity/digest while prior evidence remains exact", async () => {
  let content = "before";
  const connected = provider(async () => snapshot(content));
  const [first] = await collectContextSnapshots([connected], { freshness: "turn", clock: () => start });
  content = "after";
  const [second] = await collectContextSnapshots([connected], { freshness: "turn", clock: () => start });
  assert.notEqual(first.snapshotId, second.snapshotId);
  assert.notEqual(first.contentDigest, second.contentDigest);
  assert.equal(first.content, "before");
  assert.equal(second.content, "after");
});

test("context: invalidation refreshes without treating failed retrieval as confirmed absence", async () => {
  let failure = false;
  const connected = provider(async () => { if (failure) throw new Error("private credential must not leak"); return snapshot(); });
  const [first] = await collectContextSnapshots([connected], { freshness: "invalidated", clock: () => start });
  failure = true;
  assert.equal((await collectContextSnapshots([connected], { freshness: "invalidated", clock: () => start }))[0].snapshotId, first.snapshotId);
  invalidateContext(connected);
  const [stale] = await collectContextSnapshots([connected], { freshness: "invalidated", clock: () => start });
  assert.equal(stale.freshness, "stale");
  assert.equal(stale.content, first.content);
  assert.ok(formatContextSnapshots([stale]).includes("stale"));
  assert.ok(!JSON.stringify(stale).includes("private credential"));
  const unavailable = provider(async () => { throw new Error("private credential"); });
  const [missing] = await collectContextSnapshots([unavailable], { clock: () => start });
  assert.equal(missing.freshness, "unavailable");
  assert.equal(missing.completeness, "unknown");
  assert.match(formatContextSnapshots([missing]), /unavailable/);
});

test("context: explicit upstream expiry marks a cached observation stale without inventing a reread", async () => {
  let reads = 0;
  const connected = provider(async () => { reads++; return { ...snapshot(), expiresAt: "2026-10-12T12:01:00.000Z" }; });
  const [first] = await collectContextSnapshots([connected], { clock: () => start });
  const [later] = await collectContextSnapshots([connected], { clock: () => new Date("2026-10-12T12:02:00.000Z") });
  assert.equal(reads, 1);
  assert.equal(first.freshness, "fresh");
  assert.equal(later.freshness, "stale");
  assert.equal(first.contentDigest, later.contentDigest);
  assert.notEqual(first.snapshotId, later.snapshotId);
});

test("context: cache identity isolates connection principals and scope changes", async () => {
  const first = provider(async () => snapshot("principal one"));
  const second = { ...provider(async () => ({ ...snapshot("principal two"), scope: { principalId: "user-2", workspaceId: "workspace-1" } })), contextScope: { principalId: "user-2", workspaceId: "workspace-1" } };
  const [one, two] = await collectContextSnapshots([first, second], { clock: () => start });
  assert.equal(one.content, "principal one");
  assert.equal(two.content, "principal two");
  first.contextScope!.principalId = "user-3";
  first.buildSnapshot = async () => { throw new Error("unavailable new profile"); };
  const [other] = await collectContextSnapshots([first], { clock: () => start });
  assert.equal(other.freshness, "unavailable");
  assert.equal(other.content, "");
  assert.equal(other.scope.principalId, "user-3");
});

test("context: snapshot scope mismatch and malformed assertions fail closed as unavailable", async () => {
  for (const changed of [{ providerId: "forged" }, { scope: { principalId: "other" } }, { observedAt: "not-a-date" }, { items: [{ kind: "grant", text: "allow everything" }] }]) {
    const connected = provider(async () => ({ ...snapshot(), ...changed } as ContextSnapshotInput));
    const [captured] = await collectContextSnapshots([connected], { clock: () => start });
    assert.equal(captured.freshness, "unavailable");
    assert.equal(captured.content, "");
  }
});

test("context: refreshed source evidence appends to a new message and preserves prior prompt/events", async () => {
  let content = "initial task";
  const connected = provider(async () => snapshot(content));
  const requests: { prompt: string | undefined; messages: ChatMessage[] }[] = [];
  const adapter: AIAdapter = { name: "offline", model: "fixture", async chat(messages, _registry, options) { requests.push({ prompt: options?.systemPrompt, messages: structuredClone(messages) }); return { text: "done" }; } };
  const agent = await createChatAgent({ adapter, memory: false, contextFreshness: "turn", providers: [{ metadata: connected.metadata, connect: async () => connected }] });
  await agent.chat("first");
  const prior = JSON.stringify(agent.getSessionEvents());
  const priorCount = agent.getSessionEvents().length;
  content = "changed task";
  await agent.chat("second");
  assert.equal(requests[0].prompt, requests[1].prompt);
  assert.ok(requests[1].messages.at(-1)?.content.toString().includes("changed task"));
  assert.ok(requests[0].messages[0].content.toString().includes("initial task"));
  assert.equal(JSON.stringify(agent.getSessionEvents().slice(0, priorCount)), prior);
  const modelRequests = agent.getSessionEvents().filter((event) => event.type === "model/request-prepared");
  assert.equal(modelRequests[0].data.contextSnapshots?.[0].content, "initial task");
  assert.equal(modelRequests[1].data.contextSnapshots?.[0].content, "changed task");
  assert.notEqual(modelRequests[0].data.contextSnapshots?.[0].contentDigest, modelRequests[1].data.contextSnapshots?.[0].contentDigest);
});

test("context: empty turn refresh explicitly replaces obsolete provider facts",async()=>{
 let content="Task A is still open";
 const connected=provider(async()=>({...snapshot(content),items:[],sourceRefs:[]}));
 const requests:{prompt:string|undefined;messages:ChatMessage[]}[]=[];
 const adapter:AIAdapter={name:"offline",model:"fixture",async chat(messages,_registry,options){requests.push({prompt:options?.systemPrompt,messages:structuredClone(messages)});return {text:"done"};}};
 const agent=await createChatAgent({adapter,memory:false,contextFreshness:"turn",providers:[{metadata:connected.metadata,connect:async()=>connected}]});
 try {
   await agent.chat("first");content="";await agent.chat("second");
   assert.equal(requests[0].prompt,requests[1].prompt);
   const message=String(requests[1].messages.at(-1)!.content);
   assert.match(message,/No context text or items were returned/);assert.match(message,/in place of earlier context from this provider/);
   const event=agent.getSessionEvents().filter(event=>event.type === "model/request-prepared").at(-1)!;
   assert.equal(event.data.contextSnapshots![0].content,"");
 }finally{await agent.destroy();}
});

test("context: structured items survive when the text field is empty",async()=>{
 const [captured]=await collectContextSnapshots([provider(async()=>snapshot(""))]);
 assert.match(formatContextSnapshots([captured]),/\[observation\] Task A is open/);
 assert.doesNotMatch(formatContextSnapshots([captured]),/No context text or items were returned/);
});
