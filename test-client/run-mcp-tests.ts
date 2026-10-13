#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolRegistry } from "../src/framework/registry.js";
import { createMcpServer, startServer } from "../src/framework/server.js";
import type { ToolExecution } from "../src/framework/execution-types.js";
import { TOOLS } from "@siftable/mcp-server";
import { createSiftableSdkTools } from "../src/providers/execufunction/sdk-tools.js";
import type { ExfClient } from "../src/providers/execufunction/client.js";

const emptySchema = { type: "object" as const, properties: {} };
function fixtureRegistry() {
  const registry = new ToolRegistry();
  registry.register({
    name: "empty_result", description: "Return undefined legacy data", inputSchema: emptySchema,
    annotations: { readOnlyHint: true },
    handler: async () => ({ success: true }),
  });
  registry.register({
    name: "rich_result", description: "Return structured and resource content", inputSchema: emptySchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
    handler: async () => ({
      success: true,
      structuredContent: { value: 42 },
      content: [
        { type: "text", text: "The answer" },
        { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6N8AAAAASUVORK5CYII=", mimeType: "image/png" },
        { type: "resource_link", name: "Receipt", uri: "file:///receipt.json" },
        { type: "resource", resource: { uri: "file:///note.txt", text: "evidence", mimeType: "text/plain" } },
        { type: "resource", resource: { uri: "file:///receipt.bin", blob: "YmxvYg==", mimeType: "application/octet-stream" } },
      ],
      _meta: { upstream: "kept" },
    }),
  });
  registry.register({
    name: "uncertain_write", description: "A write with an uncertain response", inputSchema: emptySchema,
    annotations: { readOnlyHint: false },
    handler: async () => ({ success: false, error: "connection interrupted", executionOutcome: "unknown" }),
  });
  registry.register({
    name: "throws_after_effect", description: "Simulate throw after the effect", inputSchema: emptySchema,
    handler: async () => { throw new Error("response unavailable"); },
  });
  return registry;
}

if (process.argv.includes("--mcp-fixture")) {
  await startServer(fixtureRegistry(), { name: "protocol-fixture" });
} else {
  test("stdio emits only JSON-RPC and preserves discovery, rich content, and uncertainty", async () => {
    const child = spawn(process.execPath, [
      ...process.execArgv, fileURLToPath(import.meta.url), "--mcp-fixture",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let protocolError: Error | undefined;
    let nextId = 1;
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
    child.stderr.on("data", (data) => { stderr += String(data); });
    child.stdout.on("data", (data) => {
      stdout += String(data);
      buffer += String(data);
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          assert.equal(message.jsonrpc, "2.0");
          const waiter = pending.get(message.id);
          if (waiter) {
            pending.delete(message.id);
            if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
            else waiter.resolve(message.result);
          }
        } catch (error) {
          protocolError = error instanceof Error ? error : new Error(String(error));
          for (const waiter of pending.values()) waiter.reject(protocolError);
          pending.clear();
        }
      }
    });
    const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}; stderr=${stderr}`)); }, 10000);
      pending.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    try {
      await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "untrusted-client-identity", version: "1" } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const listing = await request("tools/list", {});
      const richTool = listing.tools.find((tool: any) => tool.name === "rich_result");
      assert.equal(richTool.annotations.readOnlyHint, true);
      assert.equal(richTool.outputSchema.type, "object");
      const empty = await request("tools/call", { name: "empty_result", arguments: {} });
      assert.equal(typeof empty.content[0].text, "string");
      const rich = await request("tools/call", { name: "rich_result", arguments: {} });
      assert.deepEqual(rich.structuredContent, { value: 42 });
      assert.deepEqual(rich.content.map((item: any) => item.type), ["text", "image", "resource_link", "resource", "resource"]);
      assert.equal(rich.content[3].resource.text, "evidence");
      assert.equal(rich.content[4].resource.blob, "YmxvYg==");
      assert.equal(rich._meta.upstream, "kept");
      for (const name of ["uncertain_write", "throws_after_effect"]) {
        const result = await request("tools/call", { name, arguments: {} });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /unknown/i);
        assert.equal(result._meta["openfunction/execution"].executionOutcome, "unknown");
      }
      const unknown = await request("tools/call", { name: "missing_tool", arguments: {} });
      assert.equal(unknown.isError, true);
      assert.equal(unknown._meta["openfunction/execution"].phase, "not_started");
      assert.equal(protocolError, undefined);
      assert.ok(stdout.split("\n").filter(Boolean).every((line) => JSON.parse(line).jsonrpc === "2.0"));
    } finally {
      child.kill();
      for (const waiter of pending.values()) waiter.reject(new Error("Fixture closed"));
    }
  });

  test("MCP projects validated data without repeating effects or changing canonical receipts", async () => {
    const executions: Readonly<ToolExecution>[] = [];
    const registry = new ToolRegistry({
      journal: { record: () => {}, onSettled: execution => { executions.push(execution); } },
    });
    let effects = 0;
    const outputSchema = {
      type: "object" as const,
      properties: { value: { type: "number" as const } },
      required: ["value"], additionalProperties: false,
    };
    registry.register({
      name: "data_effect", description: "Return ordinary data after one effect", inputSchema: emptySchema,
      outputSchema,
      handler: async () => {
        effects++;
        return { success: true, data: { value: 42 } };
      },
    });
    registry.register({
      name: "explicit_result", description: "Keep explicit structured output and rich content", inputSchema: emptySchema,
      outputSchema,
      handler: async () => ({ success: true, data: { value: "legacy data" },
        structuredContent: { value: 7 },
        content: [{ type: "resource_link", name: "Evidence", uri: "file:///evidence.json" }],
        _meta: { upstream: "kept", "openfunction/execution": "untrusted receipt" },
      }),
    });
    registry.register({
      name: "invalid_result", description: "Reject invalid output after an effect", inputSchema: emptySchema,
      outputSchema,
      handler: async () => {
        effects++;
        return { success: true, data: { value: "invalid" } };
      },
    });
    registry.register({
      name: "failed_result", description: "Return a known failure with schema-shaped data", inputSchema: emptySchema,
      outputSchema,
      handler: async () => ({ success: false, error: "known failure", data: { value: 42 } }),
    });
    const handle = createMcpServer(registry, { name: "output-projection" });
    const client = new Client({ name: "output-validation-client", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    try {
      await handle.connect(right);
      await client.connect(left);
      const listing = await client.listTools(); // Prime the SDK's output-schema validators.
      assert.deepEqual(listing.tools.find(tool => tool.name === "data_effect")?.outputSchema, outputSchema);
      const valid = await client.callTool({ name: "data_effect", arguments: {} });
      assert.equal(effects, 1);
      assert.equal(valid.isError, undefined);
      assert.deepEqual(valid.structuredContent, { value: 42 });
      assert.deepEqual(executions[0].result.data, valid.structuredContent);
      assert.equal(executions[0].result.structuredContent, undefined, "Projection does not change the canonical result");
      assert.deepEqual(valid._meta?.["openfunction/execution"], executions[0].receipt);

      const explicit = await client.callTool({ name: "explicit_result", arguments: {} });
      assert.deepEqual(explicit.structuredContent, { value: 7 });
      assert.deepEqual(explicit.content, executions[1].result.content);
      assert.equal(explicit._meta?.upstream, "kept");
      assert.deepEqual(explicit._meta?.["openfunction/execution"], executions[1].receipt);

      const invalid = await client.callTool({ name: "invalid_result", arguments: {} });
      assert.equal(effects, 2);
      assert.equal(invalid.isError, true);
      assert.equal(invalid.structuredContent, undefined);
      assert.equal(executions[2].receipt.errorCategory, "invalid_output");
      assert.equal(executions[2].receipt.executionOutcome, "unknown");
      assert.deepEqual(invalid._meta?.["openfunction/execution"], executions[2].receipt);

      const failed = await client.callTool({ name: "failed_result", arguments: {} });
      assert.equal(failed.isError, true);
      assert.equal(failed.structuredContent, undefined);
      assert.equal(executions[3].receipt.executionOutcome, "failed");
      assert.deepEqual(failed._meta?.["openfunction/execution"], executions[3].receipt);
      assert.equal(effects, 2);
    } finally {
      await client.close();
      await handle.close();
    }
  });

  test("MCP lifecycle binds trusted context and signals without trusting arguments", async () => {
    const registry = new ToolRegistry();
    let received: any;
    registry.register({
      name: "inspect_context", description: "Return context supplied by the host",
      inputSchema: { type: "object", properties: { actor: { type: "string" } } },
      handler: async (_params, context) => {
        received = context;
        return { success: true, data: { actorId: context?.actor?.id, correlationId: context?.correlationId } };
      },
    });
    const handle = createMcpServer(registry, {
      name: "trusted-host",
      resolveContext: () => ({ actor: { kind: "local_user", id: "host-bound-user" } }),
    });
    const client = new Client({ name: "client-asserted-identity", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await handle.connect(serverTransport);
      await client.connect(clientTransport);
      await client.callTool({ name: "inspect_context", arguments: { actor: "forged-admin" } });
      assert.equal(received.actor.id, "host-bound-user");
      assert.equal(typeof received.correlationId, "string");
      assert.ok(received.signal instanceof AbortSignal);
      await assert.rejects(handle.connect(serverTransport), /already connected/);
    } finally {
      await client.close();
      await handle.close();
      await handle.close();
    }
    await assert.rejects(handle.connect(serverTransport), /closed/);

    const unbound = createMcpServer(registry, { name: "unbound" });
    const unboundClient = new Client({ name: "forged-admin", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    try {
      await unbound.connect(right);
      await unboundClient.connect(left);
      await unboundClient.callTool({ name: "inspect_context", arguments: { actor: "forged-admin" } });
      assert.equal(received.actor, undefined);
    } finally {
      await unboundClient.close();
      await unbound.close();
    }
  });

  test("MCP request cancellation reaches the cooperative handler", async () => {
    const registry = new ToolRegistry();
    let markStarted!: () => void;
    let markAborted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
    registry.register({
      name: "wait_for_cancel", description: "Wait for client cancellation", inputSchema: emptySchema,
      handler: async (_params, context) => {
        assert.ok(context?.signal);
        markStarted();
        await new Promise<void>((resolve) => {
          context.signal!.addEventListener("abort", () => { markAborted(); resolve(); }, { once: true });
        });
        return { success: false, error: "cancelled during execution", executionOutcome: "unknown" };
      },
    });
    const handle = createMcpServer(registry, { name: "cancellation" });
    const client = new Client({ name: "cancellation-client", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    const controller = new AbortController();
    try {
      await handle.connect(right);
      await client.connect(left);
      const call = client.callTool({ name: "wait_for_cancel", arguments: {} }, undefined, { signal: controller.signal });
      const rejected = assert.rejects(call);
      await started;
      controller.abort();
      await rejected;
      await Promise.race([
        aborted,
        new Promise<void>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Cancellation did not reach handler")), 1000);
          timer.unref();
        }),
      ]);
    } finally {
      controller.abort();
      await client.close();
      await handle.close();
    }
  });

  test("Siftable preserves SDK schemas, structured schema IDs, idempotency, and uncertain errors", async () => {
    const fake = {
      listProjects: async () => ({ statusCode: 200, data: { projects: [] } }),
      updateTask: async () => ({
        statusCode: 200, data: { task: { title: "updated", status: "open" } },
        idempotency: { disposition: "replayed", payloadDigest: "abc" },
      }),
      createTask: async () => ({ statusCode: 503, error: "response interrupted" }),
    };
    const tools = createSiftableSdkTools({ raw: () => fake } as unknown as ExfClient);
    const list = tools.find((tool) => tool.name === "project_list")!;
    const source = TOOLS.find((tool) => tool.name === "project_list")! as unknown as Tool;
    assert.equal(list.annotations?.readOnlyHint, true);
    assert.equal(list.outputSchema?.type, "object");
    assert.deepEqual(list.annotations, source.annotations);
    assert.deepEqual(list._meta?.["siftable/upstreamOutputSchema"], source.outputSchema);
    assert.ok(list.outputSchema?.properties.projects);
    assert.notEqual(list.annotations, source.annotations);
    const registry = new ToolRegistry();
    registry.registerAll(tools);
    const result = (await registry.executeDetailed("project_list", {})).result;
    assert.equal(result.success, true);
    assert.deepEqual(result.structuredContent, result.data);
    assert.equal((result._meta?.["siftable/execution"] as any).structuredResult.schemaId, "sift.project.list.v2");
    const update = await tools.find((tool) => tool.name === "task_update")!.handler({ taskId: "task-1", title: "updated" });
    assert.deepEqual((update._meta?.["siftable/execution"] as any).idempotency, { disposition: "replayed", payloadDigest: "abc" });
    assert.equal((update._meta?.["siftable/execution"] as any).structuredResult.schemaId, "sift.task.mutation.v1");
    assert.deepEqual(update.structuredContent, update.data);
    const failed = await tools.find((tool) => tool.name === "task_create")!.handler({ title: "sample" });
    assert.equal(failed.success, false);
    assert.equal(failed.executionOutcome, "unknown");
  });
}
