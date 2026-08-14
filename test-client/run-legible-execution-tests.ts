#!/usr/bin/env tsx

import test from "node:test";
import assert from "node:assert/strict";

import { defineAgent } from "../src/framework/agents.js";
import type { AIAdapter, AdapterResponse } from "../src/framework/adapters/types.js";
import { createChatAgent } from "../src/framework/chat-agent.js";
import { resolveModelSelection } from "../src/framework/models.js";
import { ToolRegistry } from "../src/framework/registry.js";
import {
  cancelRun,
  completeRun,
  createOutcomeClaim,
  createRunManifest,
  decideFulfillment,
  evaluateAssurance,
  RunExecutionError,
  type VerificationAttempt,
} from "../src/framework/runs.js";

function adapter(responses: Array<AdapterResponse | Error>): AIAdapter {
  let index = 0;
  return {
    name: "Test",
    model: "test-model",
    async chat() {
      const response = responses[index++] ?? responses.at(-1) ?? { text: "ok" };
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

test("model policy resolves stable roles and records explicit overrides", () => {
  const instant = resolveModelSelection("openai", { role: "instant" });
  assert.equal(instant.model, "gpt-5.6-luna");
  assert.equal(instant.policyVersion, "2026-08-13");
  assert.equal(instant.resolution, "policy");
  assert.equal(resolveModelSelection("gemini", { role: "expert" }).model, "gemini-3.7-flash");
  assert.equal(resolveModelSelection("anthropic", { role: "expert" }).model, "claude-sonnet-5");
  assert.equal(resolveModelSelection("xai", { role: "expert" }).model, "grok-4.5");

  const override = resolveModelSelection("openai", {
    role: "expert",
    model: "pinned-model",
    reasoningEffort: "high",
  });
  assert.equal(override.model, "pinned-model");
  assert.equal(override.reasoningEffort, "high");
  assert.equal(override.resolution, "model_override");
  assert.equal(resolveModelSelection("openai", { reasoningEffort: "minimal" }).reasoningEffort, "none");
  assert.equal(resolveModelSelection("xai", { reasoningEffort: "max" }).reasoningEffort, "high");
});

test("run manifests contain digests and IDs, not raw instructions", () => {
  const run = createRunManifest({
    runId: "run-1",
    correlationId: "correlation-1",
    taskId: "task-1",
    actor: { kind: "agent", name: "reviewer" },
    adapter: adapter([{ text: "done" }]),
    instructions: "private model-visible instructions",
    tools: [],
    maxRounds: 4,
    now: "2026-08-13T00:00:00.000Z",
  });

  assert.equal(run.status, "running");
  assert.equal(run.manifest.taskId, "task-1");
  assert.equal(run.manifest.capabilities.tools.length, 0);
  assert.match(run.manifest.instructionsDigest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(run), /private model-visible instructions/);
});

test("assurance and fulfillment are separate from completion", () => {
  const completed = completeRun(createRunManifest({
    runId: "run-2",
    correlationId: "correlation-2",
    taskId: "task-2",
    actor: { kind: "agent", name: "builder" },
    adapter: adapter([{ text: "done" }]),
    instructions: "build it",
    tools: [],
    maxRounds: 2,
    now: "2026-08-13T00:00:00.000Z",
  }), { completedAt: "2026-08-13T00:01:00.000Z" });
  const outcome = createOutcomeClaim(completed, "artifact ready", {
    claimId: "claim-2",
    claimedAt: "2026-08-13T00:01:01.000Z",
  });
  const attempts: VerificationAttempt[] = [{
    attemptId: "verify-2",
    outcomeClaimId: outcome.claimId,
    planId: "plan-1",
    method: { kind: "deterministic_oracle", command: "npm test" },
    status: "passed",
    independent: true,
    coverage: ["tests"],
    evidence: [{ summary: "all tests passed" }],
    performedAt: "2026-08-13T00:02:00.000Z",
  }];
  const assurance = evaluateAssurance(outcome.claimId, {
    requiredMethods: ["deterministic_oracle"],
    requiredCoverage: ["tests"],
    requireIndependent: true,
  }, attempts, {
    bundleId: "bundle-2",
    decidedAt: "2026-08-13T00:03:00.000Z",
  });
  const decision = decideFulfillment({
    taskId: "task-2",
    outcome,
    assurance,
    decidedBy: "owner",
    reason: "required assurance passed",
  });

  assert.equal(completed.status, "completed");
  assert.equal(assurance.decision, "satisfied");
  assert.equal(decision.status, "fulfilled");
});

test("cancellation records partial effects instead of erasing the run", () => {
  const cancelled = cancelRun(createRunManifest({
    runId: "run-cancelled",
    correlationId: "correlation-cancelled",
    actor: { kind: "agent", name: "publisher" },
    adapter: adapter([{ text: "unused" }]),
    instructions: "publish",
    tools: [],
    maxRounds: 2,
  }), {
    effects: "partial",
    reason: "operator cancelled after timeout",
    verificationRequired: "read back publication state",
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancellation?.effects, "partial");
});

test("agent results expose completed and limited runs without false claims", async () => {
  const registry = new ToolRegistry();
  const worker = defineAgent({
    name: "worker",
    role: "Worker",
    goal: "Return a concise result",
    maxRounds: 1,
  });

  const complete = await worker.run(
    "work",
    adapter([{ text: "finished" }]),
    registry,
    undefined,
    { taskId: "task-complete", correlationId: "crew-1" },
  );
  assert.equal(complete.run.status, "completed");
  assert.equal(complete.outcome?.output, "finished");

  const limited = await worker.run(
    "work",
    adapter([{ toolCall: { id: "1", name: "missing", args: {} } }]),
    registry,
  );
  assert.equal(limited.run.status, "limit_reached");
  assert.equal(limited.outcome, undefined);
  assert.equal(limited.truncated, true);
});

test("chat results expose run records and failures retain the failed run", async () => {
  const chat = await createChatAgent({
    name: "helper",
    adapter: adapter([{ text: "hello" }]),
    memory: false,
  });
  const result = await chat.chat("hi", {
    run: { taskId: "chat-task", correlationId: "chat-correlation" },
  });
  assert.equal(result.run.status, "completed");
  assert.equal(result.run.manifest.taskId, "chat-task");
  assert.equal(result.outcome?.output, "hello");

  const failing = await createChatAgent({
    name: "failing",
    adapter: adapter([new Error("offline")]),
    memory: false,
  });
  await assert.rejects(
    () => failing.chat("hi"),
    (error: unknown) => {
      assert.ok(error instanceof RunExecutionError);
      assert.equal(error.run.status, "failed");
      assert.equal(error.run.stopReason, "error");
      return true;
    },
  );
});
