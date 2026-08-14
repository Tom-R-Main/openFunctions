#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExfClient } from "../src/providers/execufunction/client.js";
import { TOOLS, isToolEnabled } from "@siftable/mcp-server";
import { isToolAllowedForTransport } from "@siftable/mcp-server/factory";
import { createSiftableProvider } from "../src/providers/execufunction/index.js";
import { createSiftableSdkTools } from "../src/providers/execufunction/sdk-tools.js";
import {
  createVaultTools,
  createWorkItemTools,
} from "../src/providers/execufunction/tools.js";

function clientWithRaw(raw: Record<string, unknown>): ExfClient {
  return { raw: () => raw } as unknown as ExfClient;
}

test("claim maps the public tool input to the current Siftable lease contract", async () => {
  let received: unknown;
  const tools = createWorkItemTools(
    clientWithRaw({
      claimWorkItem: async (input: unknown) => {
        received = input;
        return {
          statusCode: 200,
          data: { workItem: { id: "work-1", claimToken: "opaque-token" } },
        };
      },
    }),
  );
  const claim = tools.find((tool) => tool.name === "exf_work_item_claim");
  assert.ok(claim);
  assert.deepEqual(claim.inputSchema.required, ["claimOwner"]);

  const result = await claim.handler({
    alias: "codex",
    claimOwner: "codex@tty1",
    workItemId: "work-1",
    leaseSeconds: 60,
  });

  assert.deepEqual(received, {
    assignedAlias: "codex",
    claimOwner: "codex@tty1",
    workItemId: "work-1",
    leaseSeconds: 60,
  });
  assert.equal(result.success, true);
});

test("work-item reads redact lease tokens", async () => {
  const tools = createWorkItemTools(
    clientWithRaw({
      getWorkItem: async () => ({
        statusCode: 200,
        data: { workItem: { id: "work-1", claimToken: "opaque-token" } },
      }),
    }),
  );
  const get = tools.find((tool) => tool.name === "exf_work_item_get");
  assert.ok(get);

  const result = await get.handler({ workItemId: "work-1" });
  const data = result.data as { workItem: Record<string, unknown> };
  assert.equal(data.workItem.claimToken, undefined);
});

test("owner-bound transitions fail before the API without claim credentials", async () => {
  let called = false;
  const tools = createWorkItemTools(
    clientWithRaw({
      transitionWorkItem: async () => {
        called = true;
        return { statusCode: 200, data: { workItem: { id: "work-1" } } };
      },
    }),
  );
  const transition = tools.find((tool) => tool.name === "exf_work_item_transition");
  assert.ok(transition);

  const result = await transition.handler({ workItemId: "work-1", action: "start" });
  assert.equal(result.success, false);
  assert.equal(called, false);
});

test("vault tools expose metadata and creation but never plaintext secret reads", () => {
  const names = createVaultTools(clientWithRaw({})).map((tool) => tool.name);
  assert.deepEqual(names, ["exf_vault_list", "exf_vault_search", "exf_vault_create"]);
  assert.equal(names.includes("exf_vault_read_secret"), false);
});

test("canonical provider surface follows the installed MCP SDK", async () => {
  const provider = createSiftableProvider({ token: "test-token" });
  const connected = await provider.connect();
  const actual = connected.createTools();
  const expectedNames = TOOLS
    .filter((tool) => isToolEnabled(tool.name))
    .filter((tool) => isToolAllowedForTransport(tool.name, "hosted_remote"))
    .map((tool) => tool.name);

  assert.deepEqual(actual.map((tool) => tool.name), expectedNames);
  assert.equal(actual.some((tool) => tool.name.startsWith("exf_")), false);
  assert.equal(actual.some((tool) => tool.name === "vault_read"), false);
  assert.ok(actual.some((tool) => tool.name === "task_list"));
  assert.ok(actual.some((tool) => tool.name === "work_item_verification_evidence_submit"));
  assert.ok(actual.some((tool) => tool.name === "capability_execute"));
});

test("canonical tools preserve current nested MCP schemas", () => {
  const tools = createSiftableSdkTools(clientWithRaw({}));
  const create = tools.find((tool) => tool.name === "work_item_create");
  assert.ok(create);
  const contract = create.inputSchema.properties.contract;
  assert.equal(contract.type, "object");
  assert.deepEqual(contract.required, ["version", "profile", "outcome", "authority", "boundary", "proof"]);
  assert.ok(contract.properties?.outcome.properties?.acceptanceCriteria.items);
});

test("canonical handlers delegate to SDK execution and return structured receipts", async () => {
  const tools = createSiftableSdkTools(clientWithRaw({
    listProjects: async () => ({
      statusCode: 200,
      data: { projects: [{ id: "project-1", name: "Alpha", status: "active" }] },
    }),
  }));
  const list = tools.find((tool) => tool.name === "project_list");
  assert.ok(list);

  const result = await list.handler({});
  assert.equal(result.success, true);
  assert.deepEqual(result.data, {
    projects: [{
      id: "project-1",
      name: "Alpha",
      status: "active",
      summary: null,
      summaryTruncated: false,
      emoji: null,
    }],
    nextCursor: null,
  });
  assert.match(result.message ?? "", /Alpha/);
});

test("legacy aliases remain explicitly opt-in", async () => {
  const provider = createSiftableProvider({ token: "test-token", includeLegacyAliases: true });
  const connected = await provider.connect();
  const names = connected.createTools().map((tool) => tool.name);
  assert.ok(names.includes("task_list"));
  assert.ok(names.includes("exf_tasks_list"));
});

test("metadata describes the graph and distinct planning/execution lifecycles", () => {
  const metadata = createSiftableProvider().metadata;
  assert.match(metadata.description, /shared, evidence-backed work graph/);
  assert.ok(metadata.capabilities.includes("agent_work"));
  assert.ok(metadata.capabilities.includes("capabilities"));
  assert.equal(metadata.auth?.envVar, "SIFT_TOKEN");
});
