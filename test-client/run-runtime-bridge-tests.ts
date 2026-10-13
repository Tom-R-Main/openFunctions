import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/framework/registry.js";
import { defineTool, ok } from "../src/framework/tool.js";
import { toPiTools } from "../src/framework/pi.js";
import { toOpenclawTools, toOpenclawToolPluginTools } from "../src/framework/openclaw.js";
import type { ToolExecutionReceipt } from "../src/framework/execution-types.js";

const schema = { type: "object", properties: {} } as const;

test("native bridges preserve text and images and explicitly project unsupported resource content", async () => {
  const registry = new ToolRegistry();
  registry.register(defineTool({
    name: "rich_content", description: "Return rich blocks", inputSchema: schema,
    handler: async () => ({ success: true, content: [
      { type: "text", text: "caption" },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      { type: "resource", resource: { uri: "file:///proof.txt", mimeType: "text/plain", text: "proof" } },
      { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
    ] }),
  }));
  const [pi] = toPiTools(registry);
  const piResult = await pi.execute("pi-rich", {}, undefined, undefined, {});
  const [openclaw] = toOpenclawTools(registry);
  const clawResult = await openclaw.execute("claw-rich", {});
  assert.deepEqual(clawResult.content, piResult.content);
  assert.deepEqual(piResult.content.slice(0, 2), [
    { type: "text", text: "caption" },
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
  ]);
  assert.match(JSON.stringify(piResult.content[2]), /proof.txt.*not supported.*proof/);
  assert.match(JSON.stringify(piResult.content[3]), /Unsupported audio content omitted/);
  assert.equal(piResult.details.executionReceipt?.callId, "pi-rich");
  assert.equal(clawResult.details?.executionReceipt.callId, "claw-rich");
  const [plugin] = toOpenclawToolPluginTools(registry);
  const pluginResult = await plugin.execute({}, {}, { toolCallId: "plugin-rich" }) as { content: unknown[]; details: { executionReceipt: ToolExecutionReceipt } };
  assert.deepEqual(pluginResult.content, piResult.content);
  assert.equal(pluginResult.details.executionReceipt.callId, "plugin-rich");
});

test("abort after a committed handler result preserves native result and receipt", async () => {
  const registry = new ToolRegistry(); const controller = new AbortController();
  registry.register(defineTool({
    name: "commit_then_abort", description: "Commit and cancel", inputSchema: schema,
    handler: async (_params, context) => {
      assert.equal(context?.signal?.aborted, false);
      controller.abort(); return ok({ committed: true });
    },
  }));
  const [tool] = toPiTools(registry);
  const result = await tool.execute("commit", {}, controller.signal, undefined, {});
  assert.equal(result.details.success, true);
  assert.deepEqual(result.details.data, { committed: true });
  assert.equal(result.details.executionReceipt?.cancellationObserved, true);
  assert.equal(result.details.executionReceipt?.executionOutcome, "succeeded");
});

test("host trusted resolver supplies execution context; model arguments cannot supply authority", async () => {
  const registry = new ToolRegistry();
  registry.register(defineTool({
    name: "context_probe", description: "Inspect trusted context", inputSchema: schema,
    handler: async (_params, context) => ok({ actor: context?.actor, scope: context?.scope }),
  }));
  const [tool] = toOpenclawTools(registry, {
    resolveExecutionContext: ({ toolCallId }) => {
      assert.equal(toolCallId, "context");
      return { actor: { kind: "host", id: "trusted-app" }, scope: { workspaceId: "allowed" } };
    },
  });
  const result = await tool.execute("context", { actor: { id: "forged" }, scope: { workspaceId: "other" } });
  assert.deepEqual(result.details?.result.data, { actor: { kind: "host", id: "trusted-app" }, scope: { workspaceId: "allowed" } });
});

test("native formatters receive canonical data after one serialization; ordinary details stay compatible", async () => {
  const registry = new ToolRegistry(); let calls = 0; let formatted = 0;
  registry.register(defineTool({
    name: "serialize_once", description: "Observe serialization", inputSchema: schema,
    handler: async () => ok({ toJSON() { calls++; return { stable: true }; } }),
  }));
  const [tool] = toOpenclawTools(registry, { formatResult: (result) => {
    formatted++; assert.deepEqual(result.data, { stable: true });
    return { type: "text", content: [{ type: "text", text: "custom" }] };
  } });
  assert.deepEqual(await tool.execute("serialize", {}), { type: "text", content: [{ type: "text", text: "custom" }] });
  assert.equal(calls, 1); assert.equal(formatted, 1);
});

test("unknown native effects remain explicit and failed Pi calls carry recovery receipts", async () => {
  const registry = new ToolRegistry();
  registry.register(defineTool({
    name: "uncertain_effect", description: "Throw after possible effect", inputSchema: schema,
    handler: async () => { throw new Error("transport disconnected"); },
  }));
  const [claw] = toOpenclawTools(registry);
  const result = await claw.execute("unknown-claw", {});
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /unknown.*verify side effects/i);
  assert.equal(result.details?.executionReceipt.executionOutcome, "unknown");
  const [pi] = toPiTools(registry);
  await assert.rejects(pi.execute("unknown-pi", {}, undefined, undefined, {}), (error: unknown) => {
    assert.match((error as Error).message, /outcome is unknown; verify side effects/);
    const receipt = (error as { executionReceipt: ToolExecutionReceipt }).executionReceipt;
    assert.equal(receipt.executionOutcome, "unknown");
    assert.equal(receipt.callId, "unknown-pi");
    return true;
  });
});
