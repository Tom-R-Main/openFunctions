#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExfClient } from "../src/providers/execufunction/client.js";
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
