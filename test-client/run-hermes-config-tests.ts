import assert from "node:assert/strict";
import { test } from "node:test";
import { createHermesMcpConfig } from "../src/framework/hermes.js";
import { ToolRegistry } from "../src/framework/registry.js";
test("Hermes helper preserves native trust, parked state, protocol and lifecycle settings", () => {
  const lifecycle = { idle_timeout_seconds: 0, max_lifetime_seconds: 3600 };
  const value = createHermesMcpConfig(new ToolRegistry(), {
    command: "openfunction", cwd: "/caller/profile", enabled: false,
    protocol: "legacy", trust: "untrusted", lifecycle,
    supportsParallelToolCalls: false, resources: false, prompts: false,
  });
  assert.deepEqual(value.mcp_servers.openfunctions, {
    command: "openfunction", cwd: "/caller/profile", enabled: false,
    protocol: "legacy", trust: "untrusted", lifecycle,
    supports_parallel_tool_calls: false,
    tools: { include: [], resources: false, prompts: false },
  });
  lifecycle.max_lifetime_seconds = 1;
  assert.equal(value.mcp_servers.openfunctions.lifecycle?.max_lifetime_seconds, 3600);
});
test("Hermes helper rejects invalid lifecycle values before returning config", () => {
  for (const value of [-1, Number.NaN, Infinity]) {
    assert.throws(() => createHermesMcpConfig(new ToolRegistry(), { command: "openfunction", lifecycle: { idle_timeout_seconds: value } }), /non-negative/);
  }
  assert.throws(() => createHermesMcpConfig(new ToolRegistry(), { command: "openfunction", cwd: " " }), /cwd must not be empty/);
});
