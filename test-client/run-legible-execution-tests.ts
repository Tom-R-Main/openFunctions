#!/usr/bin/env tsx

import test from "node:test";
import assert from "node:assert/strict";

import { defineAgent } from "../src/framework/agents.js";
import type { AIAdapter, AdapterResponse } from "../src/framework/adapters/types.js";
import { createChatAgent } from "../src/framework/chat-agent.js";
import { resolveModelSelection } from "../src/framework/models.js";
import { ToolRegistry } from "../src/framework/registry.js";
import { defineTool } from "../src/framework/tool.js";
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
  registry.register(defineTool({
    name: "record_limit_effect",
    description: "Records an effect before the agent reaches its round limit",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({
      success: true,
      data: { receiptId: "limit-effect-1" },
      executionOutcome: "succeeded" as const,
    }),
  }));
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
    adapter([{ toolCall: { id: "1", name: "record_limit_effect", args: {} } }]),
    registry,
  );
  assert.equal(limited.run.status, "limit_reached");
  assert.equal(limited.run.toolEffects?.state, "partial");
  assert.equal(limited.run.toolEffects?.certainty, "known");
  assert.deepEqual(limited.run.toolEffects?.receipts, [{
    name: "record_limit_effect",
    args: {},
    result: {
      success: true,
      data: { receiptId: "limit-effect-1" },
      executionOutcome: "succeeded",
    },
  }]);
  assert.equal(limited.outcome, undefined);
  assert.equal(limited.truncated, true);
});

test("agent failures retain an unknown tool-effect receipt and verification requirement", async () => {
  const registry = new ToolRegistry();
  let effectCount = 0;
  registry.register(defineTool({
    name: "uncertain_publish",
    description: "Publishes an effect with an uncertain confirmation",
    inputSchema: {
      type: "object",
      properties: { destination: { type: "string" } },
      required: ["destination"],
    },
    handler: async ({ destination }: { destination: string }) => {
      effectCount += 1;
      return {
        success: false,
        error: `Confirmation unavailable for ${destination}`,
        executionOutcome: "unknown" as const,
      };
    },
  }));
  const publisher = defineAgent({
    name: "publisher",
    role: "Publisher",
    goal: "Publish exactly once",
  });

  await assert.rejects(
    () => publisher.run(
      "publish",
      adapter([{
        toolCall: {
          id: "publish-1",
          name: "uncertain_publish",
          args: { destination: "release" },
        },
      }]),
      registry,
    ),
    (error: unknown) => {
      assert.ok(error instanceof RunExecutionError);
      assert.equal(error.run.status, "failed");
      assert.equal(error.toolEffects?.state, "partial");
      assert.equal(error.toolEffects?.certainty, "unknown");
      assert.equal(
        error.toolEffects?.verificationRequired,
        "verify tool side effects before deciding whether any retry is safe",
      );
      assert.deepEqual(error.toolEffects?.receipts, [{
        name: "uncertain_publish",
        args: { destination: "release" },
        result: {
          success: false,
          error: "Confirmation unavailable for release",
          executionOutcome: "unknown",
        },
      }]);
      return true;
    },
  );
  assert.equal(effectCount, 1);
});

test("parallel agent calls retain later receipts when an earlier result is not serializable", async () => {
  const registry = new ToolRegistry();
  let laterEffectCount = 0;
  registry.register(defineTool({
    name: "return_bigint_result",
    description: "Returns a result that JSON cannot serialize",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({
      success: true,
      data: { value: 1n },
      executionOutcome: "succeeded" as const,
    }),
  }));
  registry.register(defineTool({
    name: "record_later_effect",
    description: "Records a durable effect after the earlier call starts",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      laterEffectCount += 1;
      return {
        success: true,
        data: { receiptId: "later-effect-1" },
        executionOutcome: "succeeded" as const,
      };
    },
  }));
  const worker = defineAgent({
    name: "parallel_receipt_worker",
    role: "Parallel receipt worker",
    goal: "Record every started tool call",
  });

  await assert.rejects(
    () => worker.run(
      "run both",
      adapter([{
        toolCalls: [
          { id: "unserializable-call", name: "return_bigint_result", args: {} },
          { id: "later-effect-call", name: "record_later_effect", args: {} },
        ],
      }]),
      registry,
    ),
    (error: unknown) => {
      assert.ok(error instanceof RunExecutionError);
      assert.equal(error.run.status, "failed");
      assert.equal(error.toolEffects?.certainty, "unknown");
      assert.equal(
        error.toolEffects?.verificationRequired,
        "verify tool side effects before deciding whether any retry is safe",
      );
      assert.equal(error.toolEffects?.receipts.length, 2);
      assert.equal(error.toolEffects?.receipts[0].name, "return_bigint_result");
      assert.equal(error.toolEffects?.receipts[0].result.success, false);
      assert.equal(error.toolEffects?.receipts[0].result.executionOutcome, "unknown");
      assert.match(
        error.toolEffects?.receipts[0].result.error ?? "",
        /Tool execution outcome is unknown:.*BigInt/i,
      );
      assert.deepEqual(error.toolEffects?.receipts[1], {
        name: "record_later_effect",
        args: {},
        result: {
          success: true,
          data: { receiptId: "later-effect-1" },
          executionOutcome: "succeeded",
        },
      });
      return true;
    },
  );
  assert.equal(laterEffectCount, 1);
});

test("agent rejects duplicate tool-call ids before starting any handler", async () => {
  const registry = new ToolRegistry();
  let effectCount = 0;
  registry.register(defineTool({
    name: "duplicate_id_effect",
    description: "Records an effect that must not run for ambiguous calls",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      effectCount += 1;
      return { success: true, executionOutcome: "succeeded" as const };
    },
  }));
  const worker = defineAgent({
    name: "duplicate_id_worker",
    role: "Duplicate ID worker",
    goal: "Reject ambiguous adapter output",
  });

  await assert.rejects(
    () => worker.run(
      "do not run either",
      adapter([{
        toolCalls: [
          { id: "same-call", name: "duplicate_id_effect", args: {} },
          { id: "same-call", name: "duplicate_id_effect", args: {} },
        ],
      }]),
      registry,
    ),
    /duplicate tool call id same-call/,
  );
  assert.equal(effectCount, 0);
});

test("parallel agent calls normalize executor rejections without losing later effects", async () => {
  const registry = new ToolRegistry();
  let laterEffectCount = 0;
  const rejectedTool = defineTool({
    name: "reject_executor_pipeline",
    description: "Triggers a deterministic executor-pipeline rejection",
    inputSchema: {
      type: "object",
      properties: { trigger: { type: "boolean" } },
    },
    handler: async () => ({ success: true, executionOutcome: "succeeded" as const }),
  });
  registry.register(rejectedTool);
  registry.register(defineTool({
    name: "record_after_rejection",
    description: "Records a durable effect after a rejected execution starts",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      laterEffectCount += 1;
      return {
        success: true,
        data: { receiptId: "post-rejection-effect-1" },
        executionOutcome: "succeeded" as const,
      };
    },
  }));
  const worker = defineAgent({
    name: "executor_rejection_worker",
    role: "Executor rejection worker",
    goal: "Record every started tool call",
  });
  let adapterCalls = 0;
  const rejectingAdapter: AIAdapter = {
    name: "Test",
    model: "test-model",
    async chat() {
      adapterCalls += 1;
      // The run manifest has already snapshotted the valid schema. Mutating
      // this local test tool now makes validation reject outside the
      // registry's handler try/catch, exercising defineAgent's settlement.
      rejectedTool.inputSchema.properties = new Proxy(
        rejectedTool.inputSchema.properties,
        {
          get() {
            throw new Error("executor pipeline rejected");
          },
        },
      );
      return {
        toolCalls: [
          {
            id: "rejected-execution",
            name: "reject_executor_pipeline",
            args: { trigger: true },
          },
          {
            id: "post-rejection-effect",
            name: "record_after_rejection",
            args: {},
          },
        ],
      };
    },
  };

  await assert.rejects(
    () => worker.run("run both", rejectingAdapter, registry),
    (error: unknown) => {
      assert.ok(error instanceof RunExecutionError);
      assert.equal(error.toolEffects?.certainty, "unknown");
      assert.equal(error.toolEffects?.receipts.length, 2);
      assert.deepEqual(error.toolEffects?.receipts[0], {
        name: "reject_executor_pipeline",
        args: { trigger: true },
        result: {
          success: false,
          error: "Tool execution outcome is unknown: executor pipeline rejected",
          executionOutcome: "unknown",
        },
      });
      assert.deepEqual(error.toolEffects?.receipts[1], {
        name: "record_after_rejection",
        args: {},
        result: {
          success: true,
          data: { receiptId: "post-rejection-effect-1" },
          executionOutcome: "succeeded",
        },
      });
      return true;
    },
  );
  assert.equal(adapterCalls, 1);
  assert.equal(laterEffectCount, 1);
});

test("agent adapter failures retain receipts for known earlier effects", async () => {
  const registry = new ToolRegistry();
  registry.register(defineTool({
    name: "record_checkpoint",
    description: "Records one durable checkpoint",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({
      success: true,
      data: { checkpointId: "checkpoint-1" },
      executionOutcome: "succeeded" as const,
    }),
  }));
  const worker = defineAgent({
    name: "checkpoint_worker",
    role: "Checkpoint worker",
    goal: "Record a checkpoint",
  });

  await assert.rejects(
    () => worker.run(
      "record it",
      adapter([
        { toolCall: { id: "checkpoint-call", name: "record_checkpoint", args: {} } },
        new Error("provider disconnected"),
      ]),
      registry,
    ),
    (error: unknown) => {
      assert.ok(error instanceof RunExecutionError);
      assert.equal(error.run.status, "failed");
      assert.equal(error.toolEffects?.certainty, "known");
      assert.equal(error.toolEffects?.verificationRequired, undefined);
      assert.deepEqual(error.toolEffects?.receipts, [{
        name: "record_checkpoint",
        args: {},
        result: {
          success: true,
          data: { checkpointId: "checkpoint-1" },
          executionOutcome: "succeeded",
        },
      }]);
      return true;
    },
  );
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
