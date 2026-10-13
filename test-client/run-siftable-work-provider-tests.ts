#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ToolRegistry } from "../src/framework/registry.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createSiftableMcpProvider, createSiftableWorkBackend, parseSiftableActionReceipt, SIFTABLE_HOSTED_RECOVERY_STATUS } from "../src/providers/siftable-work/index.js";

const schema = { type: "object" as const, properties: {} };
function receipt(outcome: "rejected" | "failed" | "succeeded", operation = "work_session_transition") {
  return {
    kind: "sift.action_receipt", schemaVersion: 1, receiptId: "receipt-1",
    completedAt: "2026-10-12T00:00:00.000Z", surface: "mcp",
    binding: { status: "unbound", action: null }, operation: { identifier: operation, schemaDigest: null },
    outcome, result: outcome === "succeeded" ? { contentType: "application/json", schemaId: "sift.work.lease-session.v1", value: { state: "active" } } : null,
    error: outcome === "succeeded" ? null : { code: "not_allowed", message: "connection refused", recovery: "check scope", details: null },
  };
}
async function hostedFixture(principalKind = "user", authority = "validated_token") {
  const server = new Server({ name: "siftable-fixture", version: "1.5.1" }, { capabilities: { tools: {} } });
  let calls = 0;
  const names = ["context_current", "work_item_get", "work_item_verification_plan_get", "work_item_verification_evidence_submit", "work_session_open", "work_session_transition", "work_session_close", "work_item_claim", "vault_read"];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: names.map((name) => ({
    name, description: `Fixture ${name}`, inputSchema: name === "work_item_verification_evidence_submit"
      ? { type: "object" as const, properties: { workItemId: { type: "string" }, claimToken: { type: "string" }, claimOwner: { type: "string" } } } : schema,
    annotations: { readOnlyHint: name === "context_current" || name.endsWith("_get") },
  })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    calls++;
    if (request.params.name === "context_current") return {
      content: [{ type: "text", text: "authenticated context" }],
      structuredContent: { contractVersion: 1, principal: { id: "authenticated-user", kind: principalKind, authority },
        queryContext: { selectedWorkspaceContextId: null }, project: null, projectCandidates: [{ id: "candidate", name: "do not infer" }], authorization: { effectiveScopes: ["work:read"] } },
    };
    if (request.params.name.startsWith("work_session_")) return {
      content: [{ type: "text", text: "private-custody-fixture" }],
      structuredContent: { ...receipt("succeeded", request.params.name), result: {
        contentType: "application/json", schemaId: "sift.work.lease-session.v1", value: { sessionHandle: "private-custody-fixture", state: "active" },
      } },
    };
    if (request.params.name === "work_item_verification_evidence_submit") return {
      content: [{ type: "text", text: "Evidence submitted" }],
      structuredContent: { ...receipt("succeeded", request.params.name), result: {
        contentType: "application/json", schemaId: "sift.work.evidence.v1", value: { attempt: { id: "evidence-1" } },
      } },
    };
    const outcome = request.params.arguments?.outcome === "rejected" ? "rejected" : "failed";
    return { content: [{ type: "text", text: "Error: response uncertain" }], structuredContent: receipt(outcome, request.params.name), isError: true };
  });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  return { server, get calls() { return calls; }, createTransport: () => left };
}

test("hosted Siftable binds authenticated identity and keeps null project without picking a candidate", async () => {
  const upstream = await hostedFixture();
  const provider = await createSiftableMcpProvider({ createTransport: upstream.createTransport }).connect();
  try {
    assert.equal(provider.authenticatedContext.principalId, "authenticated-user");
    assert.equal(provider.authenticatedContext.projectId, null);
    assert.equal(provider.executionContext.scope?.projectId, undefined);
    assert.equal(provider.executionContext.actor?.id, "authenticated-user");
    const tools = provider.createTools();
    assert.equal(tools.some((tool) => tool.name === "work_item_claim" || tool.name === "vault_read"), false);
    assert.equal(provider.hostedSessionsAvailable, true);
    assert.equal(tools.some((tool) => tool.name.startsWith("work_session_")), false);
    assert.equal(tools.some((tool) => tool.name === "work_item_verification_evidence_submit"), false);
    assert.equal(provider.evidenceSubmissionAvailable, false);
    const registry = new ToolRegistry();
    registry.registerAll(tools);
    const unavailable = await registry.executeDetailed("work_session_open", { claimOwner: "model-asserted" });
    assert.equal(unavailable.receipt.phase, "not_started");
    assert.equal(unavailable.modelContent.includes("private-custody-fixture"), false);
    assert.equal(upstream.calls, 1, "default profile cannot dispatch session operations");
    const read = tools.find((tool) => tool.name === "work_item_get")!;
    assert.equal((await read.handler({ workspaceId: "model-selected-other-scope" })).executionOutcome, "failed");
    assert.equal(upstream.calls, 1, "model workspace arguments cannot change the host binding");
    assert.equal((await read.handler({ outcome: "failed" })).executionOutcome, "unknown");
    assert.equal((await read.handler({ outcome: "rejected" })).executionOutcome, "failed");
    await assert.rejects(provider.refreshCatalog(), /Reconnect Siftable/);
    assert.throws(createSiftableWorkBackend, /unavailable/);
    assert.equal(upstream.calls, 3, "disabled durable backend never claims work");
  } finally {
    await provider.disconnect();
    await upstream.server.close();
  }
});

test("hosted scope mismatch and unvalidated principal close the connection before work calls", async () => {
  for (const kind of ["workspace", "principal"]) {
    const upstream = await hostedFixture("user", kind === "principal" ? "local_configuration" : "validated_token");
    try {
      const provider = createSiftableMcpProvider({ createTransport: upstream.createTransport, ...(kind === "workspace" ? { expectedWorkspaceId: "other-workspace" } : {}) });
      await assert.rejects(provider.connect(), kind === "workspace" ? /workspace.*match/ : /validated authenticated principal/);
      assert.equal(upstream.calls, 1);
    } finally {
      await upstream.server.close();
    }
  }
  assert.throws(() => createSiftableMcpProvider({ toolAllowlist: ["context_current", "work_item_claim"] }), /raw lifecycle/);
});

test("workspace-service identity cannot expose evidence requiring raw lease custody", async () => {
  const upstream = await hostedFixture("workspace_service");
  const provider = await createSiftableMcpProvider({ createTransport: upstream.createTransport }).connect();
  try {
    assert.equal(provider.evidenceSubmissionAvailable, false);
    assert.equal(provider.createTools().some((tool) => tool.name === "work_item_verification_evidence_submit"), false);
  } finally {
    await provider.disconnect();
    await upstream.server.close();
  }
});

test("explicit evidence selection requires trusted identity and validated execution policy", async () => {
  const upstream = await hostedFixture();
  let hostIdentity = "wrong-principal";
  let hostGrant = "unvalidated-reference";
  let authorizations = 0;
  const provider = await createSiftableMcpProvider({
    createTransport: upstream.createTransport,
    evidenceExecution: {
      resolveContext: () => ({ actor: { kind: "host", id: hostIdentity }, scope: {}, authorityGrantRefs: [hostGrant] }),
      policy: { authorize({ context }) {
        authorizations++;
        return context.actor?.id === "authenticated-user" && context.authorityGrantRefs?.includes("validated-host-evidence")
          ? { decision: "allow", authorityGrantRefs: ["validated-host-evidence"] }
          : { decision: "approval_required", reasonCodes: ["unvalidated_evidence_grant"] };
      } },
    },
  }).connect();
  try {
    const evidence = provider.createTools().find((tool) => tool.name === "work_item_verification_evidence_submit")!;
    assert.equal(provider.evidenceSubmissionAvailable, true);
    assert.equal(evidence.contract?.requiresAuthority, true);
    assert.equal(evidence.inputSchema.properties.claimToken, undefined);
    // Caller assertions cannot replace the trusted resolver's identity.
    assert.equal((await evidence.handler({ workItemId: "work-1" }, { actor: { kind: "host", id: "authenticated-user" }, authorityGrantRefs: ["validated-host-evidence"] })).executionOutcome, "failed");
    assert.equal(authorizations, 0);
    assert.equal(upstream.calls, 1);
    hostIdentity = "authenticated-user";
    assert.equal((await evidence.handler({ workItemId: "work-1" })).executionOutcome, "failed");
    assert.equal(upstream.calls, 1, "unvalidated host references cannot dispatch evidence");
    hostGrant = "validated-host-evidence";
    assert.equal((await evidence.handler({ workItemId: "work-1", claimToken: "model-forged-custody" })).executionOutcome, "failed");
    assert.equal(upstream.calls, 1);
    const accepted = await evidence.handler({ workItemId: "work-1" });
    assert.equal(accepted.success, true);
    assert.ok(authorizations >= 3, "policy validates admission and dispatch");
    assert.equal(upstream.calls, 2);
    assert.equal(JSON.stringify(accepted).includes("private-custody-fixture"), false);
  } finally {
    await provider.disconnect();
    await upstream.server.close();
  }
});

test("explicit allowlists cannot expose hosted session custody tools", async () => {
  const upstream = await hostedFixture();
  const provider = await createSiftableMcpProvider({ createTransport: upstream.createTransport,
    toolAllowlist: ["context_current", "work_session_open", "work_session_transition", "work_session_close"],
  }).connect();
  try {
    assert.equal(provider.hostedSessionsAvailable, true);
    assert.deepEqual(provider.createTools().map((tool) => tool.name), ["context_current"]);
    assert.equal(upstream.calls, 1);
  } finally {
    await provider.disconnect();
    await upstream.server.close();
  }
});

test("receipt parser requires a canonical matching operation and never treats failed as rejected", () => {
  assert.equal(parseSiftableActionReceipt(receipt("rejected"), "work_session_transition")?.outcome, "rejected");
  assert.equal(parseSiftableActionReceipt(receipt("failed"), "work_session_transition")?.outcome, "failed");
  assert.equal(parseSiftableActionReceipt(receipt("rejected"), "different_operation"), undefined);
  assert.equal(parseSiftableActionReceipt({ ...receipt("rejected"), result: { value: "not a rejection" } }), undefined);
  assert.equal(parseSiftableActionReceipt({ outcome: "rejected", error: "Error: failed" }), undefined);
});

test("inspected published recovery matrix keeps unproved retry guarantees disabled", () => {
  const matrix = JSON.parse(readFileSync(new URL("./fixtures/siftable-work-recovery-1.5.1.json", import.meta.url), "utf8"));
  assert.equal(matrix.package.version, "1.5.1");
  assert.equal(matrix.status, "blocked");
  assert.equal(matrix.capabilities.automaticRecoveryEnabled, false);
  assert.deepEqual(matrix.capabilities.keyedOperations, []);
  assert.equal(matrix.operations.find((operation: any) => operation.operation === "evidence").transportKeyField, null);
  assert.equal(SIFTABLE_HOSTED_RECOVERY_STATUS.enabled, false);
});
