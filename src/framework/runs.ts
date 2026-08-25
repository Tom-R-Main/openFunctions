/**
 * Legible execution records.
 *
 * A task, one execution attempt, an outcome claim, verification evidence, and
 * task fulfillment are separate records. These helpers keep that separation
 * explicit without requiring a database or a workflow engine.
 */

import { createHash, randomUUID } from "node:crypto";
import type { AIAdapter } from "./adapters/types.js";
import type { ToolDefinition } from "./types.js";
import {
  customAdapterSelection,
  type ModelSelection,
} from "./models.js";

export const RUN_SCHEMA_VERSION = "openfunction.run/1" as const;

export type RunStatus =
  | "running"
  | "completed"
  | "limit_reached"
  | "failed"
  | "cancelled";

export interface CapabilitySnapshotEntry {
  name: string;
  definitionDigest: string;
}

export interface CapabilitySnapshot {
  digest: string;
  tools: CapabilitySnapshotEntry[];
}

export interface RunEnvironmentRef {
  environmentId?: string;
  repository?: string;
  baseRef?: string;
  baseSha?: string;
  templateId?: string;
  templateDigest?: string;
}

export interface RunManifest {
  schemaVersion: typeof RUN_SCHEMA_VERSION;
  runId: string;
  taskId?: string;
  workItemId?: string;
  parentRunId?: string;
  correlationId: string;
  attempt: number;
  actor: {
    kind: "agent" | "chat_agent";
    name: string;
  };
  model: ModelSelection;
  instructionsDigest: string;
  taskContractVersion?: number;
  invokedSkills: Array<{
    resource: string;
    invocationKind: "explicit" | "matched" | "inherited";
  }>;
  capabilities: CapabilitySnapshot;
  protocolVersion?: string;
  authorityGrantRefs: string[];
  authorizationContextId?: string;
  verificationPlan?: {
    id: string;
    version: number;
  };
  limits: {
    maxRounds: number;
  };
  execution?: {
    leaseGeneration?: number;
    idempotencyKey?: string;
    budget?: {
      timeSeconds?: number;
      costUsd?: number;
      maxActions?: number;
    };
    continuationPolicy?: string;
  };
  environment?: RunEnvironmentRef;
}

export interface RunFailure {
  name: string;
  message: string;
}

export interface RunToolEffectReceipt {
  name: string;
  args: Record<string, unknown>;
  result: {
    success: boolean;
    data?: unknown;
    error?: string;
    executionOutcome?: "succeeded" | "failed" | "unknown";
  };
}

export interface RunToolEffects {
  state: "partial";
  certainty: "known" | "unknown";
  receipts: RunToolEffectReceipt[];
  verificationRequired?: string;
}

export interface RunRecord {
  manifest: RunManifest;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  stopReason?: "model_response" | "max_rounds" | "error" | "cancelled";
  error?: RunFailure;
  toolEffects?: RunToolEffects;
  cancellation?: {
    effects: "none" | "partial" | "committed";
    reason: string;
    compensationRequired?: string;
    verificationRequired?: string;
  };
}

export interface OutcomeClaim {
  claimId: string;
  runId: string;
  taskId?: string;
  claimedAt: string;
  output: string;
  artifacts: Array<{
    uri: string;
    digest?: string;
  }>;
  stateChanges: Array<{
    resource: string;
    before?: unknown;
    after?: unknown;
  }>;
  receipt?: Record<string, unknown>;
  warnings: string[];
  nextActions: string[];
}

export type VerificationMethod =
  | { kind: "receipt"; source: string }
  | { kind: "state_readback"; source: string }
  | { kind: "deterministic_oracle"; command?: string }
  | { kind: "external_reconciliation"; source: string }
  | { kind: "semantic_review"; reviewer: string }
  | { kind: "human_judgment"; reviewer: string };

export type VerificationMethodKind = VerificationMethod["kind"];

export interface VerificationAttempt {
  attemptId: string;
  outcomeClaimId: string;
  planId: string;
  method: VerificationMethod;
  status: "passed" | "failed" | "inconclusive";
  independent: boolean;
  coverage: string[];
  evidence: Array<{
    uri?: string;
    digest?: string;
    summary?: string;
  }>;
  performedAt: string;
}

export interface AssurancePolicy {
  requiredMethods: VerificationMethodKind[];
  requiredCoverage?: string[];
  requireIndependent?: boolean;
}

export interface AssuranceBundle {
  bundleId: string;
  outcomeClaimId: string;
  policy: AssurancePolicy;
  attempts: VerificationAttempt[];
  decision: "satisfied" | "unsatisfied" | "incomplete";
  reasons: string[];
  decidedAt: string;
}

export interface FulfillmentDecision {
  decisionId: string;
  taskId: string;
  outcomeClaimId: string;
  assuranceBundleId: string;
  status: "fulfilled" | "unfulfilled" | "undetermined";
  decidedBy: string;
  decidedAt: string;
  reason: string;
}

export interface GoalTransition {
  transitionId: string;
  goalId: string;
  from: string;
  to: string;
  decidedBy: string;
  decidedAt: string;
  reason: string;
}

export interface RunContext {
  runId?: string;
  taskId?: string;
  workItemId?: string;
  parentRunId?: string;
  correlationId?: string;
  attempt?: number;
  authorityGrantRefs?: string[];
  authorizationContextId?: string;
  taskContractVersion?: number;
  invokedSkills?: RunManifest["invokedSkills"];
  protocolVersion?: string;
  verificationPlan?: RunManifest["verificationPlan"];
  environment?: RunEnvironmentRef;
  execution?: RunManifest["execution"];
}

export interface CreateRunManifestInput extends RunContext {
  actor: RunManifest["actor"];
  adapter: AIAdapter;
  instructions: string;
  tools: ToolDefinition[];
  maxRounds: number;
  now?: string;
}

/** Error with the failed run attached, while preserving ordinary throw flow. */
export class RunExecutionError extends Error {
  readonly run: RunRecord;
  readonly toolEffects?: RunToolEffects;

  constructor(message: string, run: RunRecord, options?: ErrorOptions) {
    super(message, options);
    this.name = "RunExecutionError";
    this.run = run;
    this.toolEffects = run.toolEffects;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  if (typeof value === "function" || value === undefined) return null;
  return value;
}

/** SHA-256 digest for model-visible or executable definitions, never secrets. */
export function digestValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function createCapabilitySnapshot(
  tools: ToolDefinition[],
): CapabilitySnapshot {
  const entries = tools
    .map((tool) => ({
      name: tool.name,
      definitionDigest: digestValue({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        tags: tool.tags ?? [],
        contract: tool.contract ?? null,
      }),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    digest: digestValue(entries),
    tools: entries,
  };
}

export function createRunManifest(input: CreateRunManifestInput): RunRecord {
  const startedAt = input.now ?? new Date().toISOString();
  const model =
    input.adapter.modelSelection ??
    customAdapterSelection(input.adapter.name, input.adapter.model);

  return {
    manifest: {
      schemaVersion: RUN_SCHEMA_VERSION,
      runId: input.runId ?? randomUUID(),
      ...(input.taskId && { taskId: input.taskId }),
      ...(input.workItemId && { workItemId: input.workItemId }),
      ...(input.parentRunId && { parentRunId: input.parentRunId }),
      correlationId: input.correlationId ?? randomUUID(),
      attempt: input.attempt ?? 1,
      actor: input.actor,
      model,
      instructionsDigest: digestValue(input.instructions),
      ...(input.taskContractVersion !== undefined && {
        taskContractVersion: input.taskContractVersion,
      }),
      invokedSkills: [...(input.invokedSkills ?? [])],
      capabilities: createCapabilitySnapshot(input.tools),
      ...(input.protocolVersion && { protocolVersion: input.protocolVersion }),
      authorityGrantRefs: [...(input.authorityGrantRefs ?? [])],
      ...(input.authorizationContextId && {
        authorizationContextId: input.authorizationContextId,
      }),
      ...(input.verificationPlan && { verificationPlan: input.verificationPlan }),
      limits: { maxRounds: input.maxRounds },
      ...(input.execution && { execution: input.execution }),
      ...(input.environment && { environment: input.environment }),
    },
    status: "running",
    startedAt,
  };
}

function requireRunning(run: RunRecord): void {
  if (run.status !== "running") {
    throw new Error(
      `Run "${run.manifest.runId}" is already terminal (${run.status}).`,
    );
  }
}

export function completeRun(
  run: RunRecord,
  options: {
    limitReached?: boolean;
    completedAt?: string;
  } = {},
): RunRecord {
  requireRunning(run);
  return {
    ...run,
    status: options.limitReached ? "limit_reached" : "completed",
    completedAt: options.completedAt ?? new Date().toISOString(),
    stopReason: options.limitReached ? "max_rounds" : "model_response",
  };
}

export function failRun(
  run: RunRecord,
  error: unknown,
  completedAt = new Date().toISOString(),
): RunRecord {
  requireRunning(run);
  const normalized =
    error instanceof Error
      ? { name: error.name, message: error.message }
      : { name: "Error", message: String(error) };
  return {
    ...run,
    status: "failed",
    completedAt,
    stopReason: "error",
    error: normalized,
  };
}

export function cancelRun(
  run: RunRecord,
  cancellation: NonNullable<RunRecord["cancellation"]>,
  completedAt = new Date().toISOString(),
): RunRecord {
  requireRunning(run);
  return {
    ...run,
    status: "cancelled",
    completedAt,
    stopReason: "cancelled",
    cancellation: { ...cancellation },
  };
}

export function createOutcomeClaim(
  run: RunRecord,
  output: string,
  options: {
    claimId?: string;
    claimedAt?: string;
    artifacts?: OutcomeClaim["artifacts"];
    stateChanges?: OutcomeClaim["stateChanges"];
    receipt?: OutcomeClaim["receipt"];
    warnings?: string[];
    nextActions?: string[];
  } = {},
): OutcomeClaim {
  if (run.status !== "completed") {
    throw new Error(
      `Cannot claim an outcome from run "${run.manifest.runId}" with status ${run.status}.`,
    );
  }
  return {
    claimId: options.claimId ?? randomUUID(),
    runId: run.manifest.runId,
    ...(run.manifest.taskId && { taskId: run.manifest.taskId }),
    claimedAt: options.claimedAt ?? new Date().toISOString(),
    output,
    artifacts: [...(options.artifacts ?? [])],
    stateChanges: [...(options.stateChanges ?? [])],
    ...(options.receipt && { receipt: options.receipt }),
    warnings: [...(options.warnings ?? [])],
    nextActions: [...(options.nextActions ?? [])],
  };
}

export function evaluateAssurance(
  outcomeClaimId: string,
  policy: AssurancePolicy,
  attempts: VerificationAttempt[],
  options: { bundleId?: string; decidedAt?: string } = {},
): AssuranceBundle {
  const relevant = attempts.filter(
    (attempt) => attempt.outcomeClaimId === outcomeClaimId,
  );
  const reasons: string[] = [];

  const failedRequired = policy.requiredMethods.filter((method) =>
    relevant.some(
      (attempt) =>
        attempt.method.kind === method && attempt.status === "failed",
    ),
  );
  for (const method of failedRequired) {
    reasons.push(`Required verification method failed: ${method}`);
  }

  const missingMethods = policy.requiredMethods.filter(
    (method) =>
      !relevant.some(
        (attempt) =>
          attempt.method.kind === method && attempt.status === "passed",
      ),
  );
  for (const method of missingMethods) {
    reasons.push(`Required verification method has not passed: ${method}`);
  }

  const passedCoverage = new Set(
    relevant
      .filter((attempt) => attempt.status === "passed")
      .flatMap((attempt) => attempt.coverage),
  );
  const missingCoverage = (policy.requiredCoverage ?? []).filter(
    (item) => !passedCoverage.has(item),
  );
  for (const item of missingCoverage) {
    reasons.push(`Required coverage is missing: ${item}`);
  }

  const hasIndependentPass = relevant.some(
    (attempt) => attempt.status === "passed" && attempt.independent,
  );
  if (policy.requireIndependent && !hasIndependentPass) {
    reasons.push("No independent verification attempt has passed.");
  }

  const decision = failedRequired.length
    ? "unsatisfied"
    : reasons.length
      ? "incomplete"
      : "satisfied";

  return {
    bundleId: options.bundleId ?? randomUUID(),
    outcomeClaimId,
    policy: {
      requiredMethods: [...policy.requiredMethods],
      ...(policy.requiredCoverage && {
        requiredCoverage: [...policy.requiredCoverage],
      }),
      ...(policy.requireIndependent !== undefined && {
        requireIndependent: policy.requireIndependent,
      }),
    },
    attempts: [...relevant],
    decision,
    reasons,
    decidedAt: options.decidedAt ?? new Date().toISOString(),
  };
}

export function decideFulfillment(input: {
  taskId: string;
  outcome: OutcomeClaim;
  assurance: AssuranceBundle;
  decidedBy: string;
  reason: string;
  status?: FulfillmentDecision["status"];
  decisionId?: string;
  decidedAt?: string;
}): FulfillmentDecision {
  if (input.outcome.taskId !== input.taskId) {
    throw new Error("Outcome claim does not belong to the requested task.");
  }
  if (input.assurance.outcomeClaimId !== input.outcome.claimId) {
    throw new Error("Assurance bundle does not belong to the outcome claim.");
  }

  const status =
    input.status ??
    (input.assurance.decision === "satisfied"
      ? "fulfilled"
      : input.assurance.decision === "unsatisfied"
        ? "unfulfilled"
        : "undetermined");

  if (status === "fulfilled" && input.assurance.decision !== "satisfied") {
    throw new Error("A task cannot be fulfilled without satisfied assurance.");
  }

  return {
    decisionId: input.decisionId ?? randomUUID(),
    taskId: input.taskId,
    outcomeClaimId: input.outcome.claimId,
    assuranceBundleId: input.assurance.bundleId,
    status,
    decidedBy: input.decidedBy,
    decidedAt: input.decidedAt ?? new Date().toISOString(),
    reason: input.reason,
  };
}
