#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { createMcpProvider, validateMcpEndpoint } from "../src/providers/mcp/index.js";

const schema = { type: "object" as const, properties: {} };
const catalog: Tool[] = [
  { name: "read_value", description: "Read a structured value", inputSchema: schema, annotations: { readOnlyHint: true }, outputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] } },
  { name: "write_value", description: "Write a structured value", inputSchema: schema, annotations: { readOnlyHint: false } },
];

function fixture() {
  const server = new Server({ name: "provider-fixture", version: "1" }, { capabilities: { tools: { listChanged: true } } });
  let calls = 0;
  let pages = 0;
  let abortObserved = false;
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    pages++;
    return request.params?.cursor === "page-2" ? { tools: [catalog[1]] } : { tools: [catalog[0]], nextCursor: "page-2" };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    calls++;
    if (request.params.arguments?.wait) {
      await new Promise<void>((resolve) => extra.signal.addEventListener("abort", () => { abortObserved = true; resolve(); }, { once: true }));
      return { content: [{ type: "text", text: "cancel observed" }], isError: true };
    }
    if (request.params.name === "write_value") {
      return { content: [{ type: "text", text: "Error: response interrupted after effect" }], isError: true };
    }
    return { content: [{ type: "text", text: "Error: is ordinary readable content here" }], structuredContent: { value: 42 }, _meta: { schemaId: "fixture.v1" } };
  });
  return {
    server, get calls() { return calls; }, get pages() { return pages; }, get abortObserved() { return abortObserved; },
    async provider() {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      return createMcpProvider({ id: "fixture", createTransport: () => clientTransport }).connect();
    },
  };
}

if (process.argv.includes("--provider-fixture")) {
  await fixture().server.connect(new StdioServerTransport());
} else {
  test("generic MCP uses paginated frozen catalogs and preserves rich structured results", async () => {
    const upstream = fixture();
    const provider = await upstream.provider();
    try {
      assert.equal(upstream.pages, 2);
      assert.equal(provider.catalog.tools.length, 2);
      assert.ok(Object.isFrozen(provider.catalog.tools[0].inputSchema));
      const tools = provider.createTools();
      assert.deepEqual(tools[0].annotations, catalog[0].annotations);
      assert.deepEqual(tools[0].outputSchema, catalog[0].outputSchema);
      const result = await tools[0].handler({});
      assert.equal(result.success, true, "human text is not an error oracle");
      assert.deepEqual(result.structuredContent, { value: 42 });
      assert.equal(result._meta?.schemaId, "fixture.v1");
      const failed = await tools[1].handler({});
      assert.equal(failed.executionOutcome, "unknown");
      assert.equal(upstream.calls, 2, "there is no transparent write retry");
    } finally {
      await provider.disconnect();
      await upstream.server.close();
    }
  });

  test("catalog change invalidates projections until explicit safe-boundary refresh", async () => {
    const upstream = fixture();
    const provider = await upstream.provider();
    try {
      const old = provider.createTools()[0];
      await upstream.server.notification({ method: "notifications/tools/list_changed" });
      assert.equal(provider.catalogStale, true);
      assert.equal((await old.handler({})).success, false);
      assert.equal(upstream.calls, 0);
      await provider.refreshCatalog();
      assert.equal((await old.handler({})).success, false, "old projection must stay invalid after refresh");
      assert.equal((await provider.createTools()[0].handler({})).success, true);
      assert.equal(upstream.calls, 1);
    } finally {
      await provider.disconnect();
      await upstream.server.close();
    }
  });

  test("cancellation reaches upstream and retains unknown effect without retry", async () => {
    const upstream = fixture();
    const provider = await upstream.provider();
    const controller = new AbortController();
    try {
      const tools = provider.createTools();
      const pending = tools[1].handler({ wait: true }, { signal: controller.signal });
      await new Promise((resolve) => setImmediate(resolve));
      await assert.rejects(provider.refreshCatalog(), /no active calls/);
      controller.abort();
      const result = await pending;
      assert.equal(result.executionOutcome, "unknown");
      assert.equal(upstream.calls, 1);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(upstream.abortObserved, true);
      const before = await tools[1].handler({}, { signal: controller.signal });
      assert.equal(before.executionOutcome, "failed");
      assert.equal(upstream.calls, 1);
    } finally {
      await provider.disconnect();
      await upstream.server.close();
    }
  });

  test("upstream elicitation is rejected with host guidance and no fabricated approval", async () => {
    const upstream = fixture();
    const provider = await upstream.provider();
    try {
      assert.equal(upstream.server.getClientCapabilities()?.elicitation, undefined);
      assert.equal(upstream.server.getClientCapabilities()?.sampling, undefined);
      const transport = upstream.server.transport!;
      const original = transport.onmessage;
      const reply = new Promise<any>((resolve) => {
        transport.onmessage = (message, extra) => {
          if ("id" in message && message.id === "host-input" && "error" in message) resolve(message);
          else original?.(message, extra);
        };
      });
      // A noncompliant upstream may request input despite absent capabilities.
      await transport.send({ jsonrpc: "2.0", id: "host-input", method: "elicitation/create", params: {
        message: "Approve the write", requestedSchema: { type: "object", properties: { approved: { type: "boolean" } } },
      } });
      const result = await reply;
      assert.match(result.error.message, /trusted host callback/);
      assert.equal(result.result, undefined);
      assert.equal(upstream.calls, 0);
    } finally {
      await provider.disconnect();
      await upstream.server.close();
    }
  });

  test("disconnect only closes the owning MCP connection", async () => {
    const first = fixture();
    const second = fixture();
    const a = await first.provider();
    const b = await second.provider();
    try {
      await a.disconnect();
      assert.equal((await a.createTools()[0].handler({})).executionOutcome, "failed");
      assert.equal((await b.createTools()[0].handler({})).success, true);
    } finally {
      await b.disconnect();
      await first.server.close();
      await second.server.close();
    }
  });

  test("generic stdio transport calls the real SDK child process", async () => {
    const provider = await createMcpProvider({
      id: "stdio", transport: { kind: "stdio", command: process.execPath,
        args: [...process.execArgv, fileURLToPath(import.meta.url), "--provider-fixture"] },
    }).connect();
    try {
      assert.equal(provider.catalog.tools.length, 2);
      const result = await provider.createTools()[0].handler({});
      assert.deepEqual(result.structuredContent, { value: 42 });
    } finally {
      await provider.disconnect();
    }
  });

  test("HTTP credentials come from host callbacks and never cross an origin redirect", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const provider = createMcpProvider({
      id: "redirect", transport: { kind: "streamable_http", url: "https://trusted.example/mcp", resolveHeaders: () => ({ Authorization: "Bearer fixture-host-credential" }) },
      fetch: async (url, init) => {
        seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
        return new Response(null, { status: 307, headers: { location: "https://other.example/mcp" } });
      },
    });
    await assert.rejects(provider.connect(), /cross-origin redirect/);
    assert.deepEqual(seen, [{ url: "https://trusted.example/mcp", auth: "Bearer fixture-host-credential" }]);
    assert.equal(validateMcpEndpoint("http://127.0.0.1:4444/mcp").protocol, "http:");
    assert.equal(validateMcpEndpoint("http://[::1]/mcp").protocol, "http:");
    assert.throws(() => validateMcpEndpoint("http://remote.example/mcp"), /HTTPS/);
    assert.throws(() => validateMcpEndpoint("https://user:password@example.com/mcp"), /trusted auth callback/);
  });

  test("StreamableHTTP transports preserve calls without forwarding claimed credential arguments", async () => {
    const calls: string[] = [];
    const headers: string[] = [];
    const provider = await createMcpProvider({
      id: "http", transport: { kind: "streamable_http", url: "http://localhost:7777/mcp", resolveHeaders: () => ({ authorization: "Bearer host-value" }) },
      fetch: async (_url, init) => {
        headers.push(new Headers(init?.headers).get("authorization") ?? "");
        if (init?.method === "GET") return new Response(null, { status: 405 });
        const message = JSON.parse(String(init?.body));
        if (message.id === undefined) return new Response(null, { status: 202 });
        calls.push(message.method);
        const result = message.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "http-fixture", version: "1" } }
          : message.method === "tools/list" ? { tools: catalog }
          : { content: [{ type: "text", text: "HTTP result" }], structuredContent: { value: 42 } };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { headers: { "content-type": "application/json" } });
      },
    }).connect();
    try {
      const result = await provider.createTools()[0].handler({ authorization: "model-forged-value" });
      assert.equal(result.success, true);
      assert.ok(headers.every((header) => header === "Bearer host-value"));
      assert.equal(calls.filter((method) => method === "tools/call").length, 1);
    } finally {
      await provider.disconnect();
    }
  });
}
