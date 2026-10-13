import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/framework/registry.js";
import { defineAgent, runCrew } from "../src/framework/agents.js";
import { llmStep, toolStep } from "../src/framework/workflows.js";
import { defineTool, ok } from "../src/framework/tool.js";
import type { AIAdapter, AdapterResponse, ChatMessage } from "../src/framework/adapters/types.js";

const schema = { type: "object", properties: {} } as const;
function adapter(responses: AdapterResponse[], history: ChatMessage[][] = []): AIAdapter {
  return {
    name: "test", model: "fixture",
    async chat(messages) { history.push(structuredClone(messages)); return responses.shift() ?? { text: "done" }; },
  };
}

test("filtered agents retain root execution policy and preserve receipt references", async () => {
  let invoked = false; let checked = 0;
  const registry = new ToolRegistry({ policy: { authorize: ({ context }) => {
    checked++;
    assert.equal(context.actor?.id, "worker");
    assert.equal(context.scope?.workspaceId, "allowed");
    return { decision: "deny", reasonCodes: ["fixture_denied"] };
  } } });
  registry.register(defineTool({ name: "guarded_action", description: "Guarded operation", inputSchema: schema, handler: async () => { invoked = true; return ok({}); } }));
  const worker = defineAgent({ name: "worker", role: "Worker", goal: "Try the guarded action", tools: ["guarded_action"] });
  const result = await worker.run("try", adapter([
    { toolCall: { id: "one", name: "guarded_action", args: {} } }, { text: "Denied" },
  ]), registry, undefined, { executionContext: { scope: { workspaceId: "allowed" } } });
  assert.equal(invoked, false); assert.equal(checked, 1);
  assert.equal(result.toolCalls[0].result.success, false);
  assert.ok(result.toolCalls[0].executionReceiptId);
  assert.equal(result.run.executionReceiptRefs?.[0], result.toolCalls[0].executionReceiptId);
});

test("agent and workflow callers normalize hooks once and retain model-call order", async () => {
  let serialized = 0; const history: ChatMessage[][] = []; const registry = new ToolRegistry();
  for (const name of ["first_read", "second_read"]) registry.register(defineTool({
    name, description: "Serialize read result", inputSchema: schema,
    executionMode: () => "parallel-safe",
    handler: async () => ok({ toJSON() { serialized++; return { name }; } }),
  }));
  const calls = [
    { id: "first", name: "first_read", args: {} }, { id: "second", name: "second_read", args: {} },
  ];
  const worker = defineAgent({ name: "reader", role: "Reader", goal: "Read both" });
  const result = await worker.run("read", adapter([{ toolCalls: calls }, { text: "done" }], history), registry);
  assert.equal(serialized, 2);
  assert.deepEqual(result.toolCalls.map((call) => call.name), ["first_read", "second_read"]);
  assert.deepEqual(history[1].filter((message) => message.role === "tool").map((message) => message.toolCallId), ["first", "second"]);
  await llmStep(adapter([{ toolCalls: calls }, { text: "done" }]), registry, "{{input}}")("read");
  assert.equal(serialized, 4);
  await toolStep(registry, "first_read")({}); assert.equal(serialized, 5);
});

test("synthetic crew delegation inherits private reservation and trusted workspace context", async () => {
  const registry = new ToolRegistry(); let workspace: string | undefined; const observed: string[] = [];
  registry.register(defineTool({ name: "worker_action", description: "Perform worker action", inputSchema: schema,
    handler: async (_params, context) => { workspace = context?.scope?.workspaceId; observed.push("action"); return ok({ done: true }); },
  }));
  const leader = defineAgent({ name: "leader", role: "Leader", goal: "Delegate", tools: ["delegate_to_worker"] });
  const worker = defineAgent({ name: "worker", role: "Worker", goal: "Act", tools: ["worker_action"] });
  const mock: AIAdapter = {
    name: "test", model: "fixture",
    async chat(messages, _registry, options) {
      const role = options?.systemPrompt?.includes("You are Leader") ? "leader" : "worker";
      if (messages.some((message) => message.role === "tool")) return { text: `${role} done` };
      return role === "leader"
        ? { toolCall: { id: "delegate", name: "delegate_to_worker", args: { task: "act" } } }
        : { toolCall: { id: "worker", name: "worker_action", args: {} } };
    },
  };
  // The explicit helper used by the synthetic handler must re-enter the same
  // reservation; the exclusive delegation call would otherwise wait on itself.
  const result = await runCrew({ agents: [leader, worker], delegation: true }, "work", mock, registry);
  assert.match(result.output, /worker done/);
  assert.deepEqual(observed, ["action", "action"]);
  // Also exercise trusted context inheritance without the crew facade.
  const projection = registry.project({});
  projection.register(defineTool({ name: "nested_action", description: "Delegate internally", inputSchema: schema,
    handler: async () => projection.withChildExecution(() => registry.execute("worker_action", {})),
  }));
  await projection.executeDetailed("nested_action", {}, { scope: { workspaceId: "workspace-A" } });
  assert.equal(workspace, "workspace-A");
});

test("unclassified, invalid and throwing classifiers remain exclusive across direct projected calls", async () => {
  for (const classifier of [undefined, () => { throw new Error("classifier failed"); }, (() => "untrusted-value") as unknown as () => "exclusive"]) {
    const registry = new ToolRegistry(); const starts: string[] = [];
    let releaseFirst!: () => void, releaseExclusive!: () => void;
    const firstGate = new Promise<void>((done) => { releaseFirst = done; });
    const exclusiveGate = new Promise<void>((done) => { releaseExclusive = done; });
    registry.register(defineTool({ name: "safe_read", description: "Read without effects", inputSchema: schema, executionMode: "parallel-safe",
      handler: async ({ first }) => { starts.push(first ? "read-first" : "read-last"); if (first) await firstGate; return ok({}); },
    }));
    registry.register(defineTool({ name: "unclassified", description: "Conservatively serialized", inputSchema: schema, executionMode: classifier,
      handler: async () => { starts.push("exclusive"); await exclusiveGate; return ok({}); },
    }));
    const projection = registry.project({});
    const first = registry.executeDetailed("safe_read", { first: true });
    const exclusive = projection.executeDetailed("unclassified", {});
    const last = registry.executeDetailed("safe_read", {});
    await new Promise<void>((done) => setImmediate(done));
    assert.deepEqual(starts, ["read-first"]);
    releaseFirst(); await new Promise<void>((done) => setImmediate(done));
    assert.deepEqual(starts, ["read-first", "exclusive"]);
    releaseExclusive(); await Promise.all([first, exclusive, last]);
    assert.deepEqual(starts, ["read-first", "exclusive", "read-last"]);
  }
});
