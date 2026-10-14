/** Recover one selected attempt. The controller owns admission/lifecycle locks. */
import { randomUUID } from "node:crypto";
import { capabilityDigest } from "../executor.js";
import { digestJson, snapshotJson } from "../session.js";
import { JournalInvariantError } from "../journal-file.js";
import type { ExecutionJournal, RecoveredExecution } from "../execution-journal.js";
import type { ToolExecutionContext } from "../execution-types.js";
import type { WorkAttemptJournal } from "./journal.js";
import type { AttemptAuthority } from "./authority.js";
import type { AttemptPersistence, BackendOperation, PersistedAttempt, StepIntent } from "./attempt-state.js";
import type { ResolvedWorkGrant, VerificationEvidence, WorkControllerOptions, WorkPreview, WorkState } from "./types.js";
/** Only these ordered effects may be requested by recovery. */
export interface AttemptRecoveryRuntime {
  options: WorkControllerOptions;
  authority: AttemptAuthority;
  state(): PersistedAttempt;
  executions(): ExecutionJournal;
  persist: AttemptPersistence;
  accountOutput(executionId: string, bytes: number): void;
  recordOutput(executionId: string): Promise<void>;
  assertAdmissionContext(context: ToolExecutionContext): void;
  requestSignal(context: ToolExecutionContext): AbortSignal;
  ensureOwner(): void;
  releaseOwnership(): void;
  hasInflight(): boolean;
  prepare(workItemId: string, context?: ToolExecutionContext): Promise<WorkPreview>;
  backendOperation: BackendOperation;
  checkProof(): Promise<() => void>;
  scheduleRenewal(): void;
  safeStatus(): Record<string, unknown>;
  now(): number;
}
/** Restore optional fields without changing the stored schema or adopting a lease. */
export function validateRecoveredAttempt(state: PersistedAttempt, journal: WorkAttemptJournal): void {
  state.verificationRuns ??= {};
  state.outputArtifacts ??= {};
  state.unknownSteps ??= {};
  state.effectResolutions ??= {};
  state.accountedOutputs ??= {};
  state.oracleRuns ??= {};
  if (state.attemptId !== journal.read()[0]!.streamId
    || state.binding.scopeDigest !== journal.read()[0]!.scopeDigest
    || state.binding.backendId !== state.preview.binding.backendId
    || state.binding.workItemId !== state.workItemId) {
    throw new JournalInvariantError("Recovered attempt identity mismatch");
  }
  if (Object.keys(state.inflightSteps).length
    || Object.keys(state.verificationRuns).length
    || Object.values(state.operations).some(operation => operation.status === "started")) {
    state.state = "reconciliation_required";
  }
  // A lease from the former process is evidence, never fresh ownership authority.
}
export async function reconcileAttempt(runtime: AttemptRecoveryRuntime, context: ToolExecutionContext): Promise<Record<string, unknown>> {
  const state = runtime.state();
  runtime.assertAdmissionContext(context);
  runtime.ensureOwner();
  if (runtime.hasInflight()) {
    throw new JournalInvariantError("Started calls still draining");
  }
  await runtime.authority.grant();
  const saved = runtime.executions().recover();
  recoverOutputAccounting(runtime, state, saved);
  recoverOracleRuns(runtime, state, saved);
  recoverStepCalls(runtime, state);
  recoverVerificationCalls(runtime, state);
  for (const id of Object.keys(state.accountedOutputs))
    await runtime.recordOutput(id);
  await runtime.authority.grant();
  for (const operation of Object.values(state.operations).filter(op => op.status === "started")) {
    const result = await runtime.options.backend.reconcileOperation(operation.ref, runtime.requestSignal(context));
    runtime.assertAdmissionContext(context);
    if (result.state === "settled") {
      runtime.authority.validateBackendReceipt(result.receipt, operation.ref);
      operation.status = "settled";
      operation.backendReceipt = result.receipt;
      if (result.receipt.lease) {
        state.lease = result.receipt.lease;
      }
      runtime.persist("operation_settled", {
        operationId: operation.ref.id,
        backendReceiptRef: result.receipt.id,
        reconciled: true
      });
    }
    else if (result.state === "authoritatively_not_started") {
      // Reconciliation establishes non-execution but does not implicitly retry effects.
      operation.status = "settled";
      runtime.persist("operation_settled", {
        operationId: operation.ref.id,
        disposition: "authoritatively_not_started"
      });
    }
  }
  if (!Object.values(state.operations).some(operation => operation.status === "started")) {
    for (const [executionId, intent] of Object.entries(state.unknownSteps))
      await reconcileEffect(runtime, executionId, intent, context);
  }
  return restoreLifecycle(runtime, state, context);
}
function recoverOutputAccounting(runtime: AttemptRecoveryRuntime, state: PersistedAttempt, saved: readonly RecoveredExecution[]): void {
  const recoveredOutputRefs: string[] = [];
  for (const execution of saved) {
    if (!execution.settled
      || state.accountedOutputs[execution.executionId]) {
      continue;
    }
    const receipt = execution.settled.receipt as {
      toolName: string;
    };
    if (receipt.toolName === "_of_attempt_renew") {
      continue;
    }
    const evidence = (execution.settled.result as {
      data?: Partial<VerificationEvidence>;
    }).data;
    const bytes = receipt.toolName.startsWith("_of_verify_") && evidence?.artifact ? evidence.artifact.sizeBytes : Buffer.byteLength(execution.settled.modelContent as string);
    runtime.accountOutput(execution.executionId, bytes);
    recoveredOutputRefs.push(execution.executionId);
  }
  if (recoveredOutputRefs.length) {
    runtime.persist("reconciled", {
      recoveredOutputRefs
    });
  }
}
function recoverOracleRuns(runtime: AttemptRecoveryRuntime, state: PersistedAttempt, saved: readonly RecoveredExecution[]): void {
  for (const [id, run] of Object.entries(state.oracleRuns)) {
    const known = saved.find(execution => execution.events.some(event => event.data.callId === id || (event.data.receipt as {
      callId?: string;
    })?.callId === id));
    if (!known
      && !state.executionFileIdentity) {
      continue;
    }
    delete state.oracleRuns[id];
    runtime.persist("reconciled", {
      oracleRunId: id,
      originalExecutionId: run.originalExecutionId,
      readbackExecutionId: known?.executionId,
      disposition: known?.settled ? "readback_result_recovered" : known?.state === "unknown" ? "readback_result_unknown" : "readback_not_started"
    });
  }
}
function recoverStepCalls(runtime: AttemptRecoveryRuntime, state: PersistedAttempt): void {
  for (const [id, step] of Object.entries(state.inflightSteps)) {
    const known = runtime.executions().recover().find(execution => execution.events.some(event => event.data.callId === id || (event.data.receipt as {
      callId?: string;
    })?.callId === id));
    if (!known && state.executionFileIdentity
      || known?.state === "not_started") {
      delete state.inflightSteps[id];
      runtime.persist("reconciled", {
        stepIntentId: id,
        executionRef: known?.executionId,
        disposition: "not_started"
      });
      continue;
    }
    if (known?.settled) {
      delete state.inflightSteps[id];
      const receipt = known.settled!.receipt as {
        executionOutcome: string;
        executionId: string;
      };
      runtime.accountOutput(receipt.executionId, Buffer.byteLength(known.settled!.modelContent as string));
      if (receipt.executionOutcome === "unknown") {
        if (!state.unknownExecutions.includes(receipt.executionId)) {
          state.unknownExecutions.push(receipt.executionId);
        }
        state.unknownSteps[receipt.executionId] = step;
      }
      runtime.persist("step", {
        stepIntentId: id,
        stepKey: step.stepKey,
        recovered: true
      }, {
        executionId: receipt.executionId,
        receiptRef: receipt.executionId
      });
    }
    else if (known?.state === "unknown") {
      if (!state.unknownExecutions.includes(known.executionId)) {
        state.unknownExecutions.push(known.executionId);
      }
      state.unknownSteps[known.executionId] = step;
    }
  }
}
function recoverVerificationCalls(runtime: AttemptRecoveryRuntime, state: PersistedAttempt): void {
  for (const [id, run] of Object.entries(state.verificationRuns)) {
    const known = runtime.executions().recover().find(execution => execution.events.some(event => event.data.callId === id || (event.data.receipt as {
      callId?: string;
    })?.callId === id));
    if (!known && state.executionFileIdentity
      || known?.state === "not_started") {
      delete state.verificationRuns[id];
      runtime.persist("reconciled", {
        verificationRunId: id,
        executionRef: known?.executionId,
        disposition: "not_started"
      });
      continue;
    }
    if (!known?.settled) {
      continue;
    }
    const receipt = known.settled!.receipt as {
      executionOutcome: string;
      executionId: string;
      phase: string;
    };
    if (receipt.executionOutcome === "unknown") {
      if (!state.unknownExecutions.includes(receipt.executionId)) {
        state.unknownExecutions.push(receipt.executionId);
      }
      continue;
    }
    const result = known.settled!.result as {
      success: boolean;
      data?: VerificationEvidence;
    };
    if (result.success
      && result.data?.id === run.evidenceId) {
      runtime.accountOutput(receipt.executionId, result.data.artifact.sizeBytes);
      state.evidence[run.stepId] = result.data;
      delete state.verificationRuns[id];
      runtime.persist("verification", {
        verificationRunId: id,
        evidenceId: result.data.id,
        stepId: run.stepId,
        recovered: true
      }, {
        executionId: receipt.executionId,
        receiptRef: receipt.executionId
      });
    }
    else if (receipt.phase === "not_started") {
      delete state.verificationRuns[id];
      runtime.persist("verification", {
        verificationRunId: id,
        stepId: run.stepId,
        disposition: "not_started"
      }, {
        executionId: receipt.executionId,
        receiptRef: receipt.executionId
      });
    }
  }
}
async function restoreLifecycle(runtime: AttemptRecoveryRuntime, state: PersistedAttempt, context: ToolExecutionContext): Promise<Record<string, unknown>> {
  let snapshot = await runtime.options.backend.inspect(state.workItemId);
  const unresolved = Object.keys(state.inflightSteps).length || Object.keys(state.verificationRuns).length || state.unknownExecutions.length || Object.values(state.operations).some(operation => operation.status === "started");
  if (!unresolved
    && ["ready", "released"].includes(snapshot.state)
    && !state.lease
    && !Object.values(state.operations).some(operation => operation.ref.kind === "open" && operation.backendReceipt)) {
    const preview = await runtime.prepare(state.workItemId, context);
    await runtime.authority.grant();
    if (digestJson(preview.binding) !== digestJson(state.binding)
      || !preview.snapshot.claimable
      || !preview.snapshot.dependenciesSatisfied) {
      throw new JournalInvariantError("Prepared attempt scope changed or work is no longer claimable");
    }
    await runtime.options.grantResolver.reserveAttempt?.(state.binding, state.attemptId);
    const id = randomUUID();
    const payload = {
      workItemId: state.workItemId,
      claimOwner: runtime.options.claimOwner,
      leaseSeconds: runtime.options.leaseSeconds ?? 120,
      idempotencyKey: id
    };
    const receipt = await runtime.backendOperation("open", payload, async () => {
      const lease = await runtime.options.backend.open(payload, runtime.requestSignal(context));
      runtime.authority.validateLease(lease);
      return {
        id: lease.id,
        operationId: id,
        kind: "open",
        payloadDigest: digestJson(payload),
        workItemId: state.workItemId,
        state: "claimed",
        lease
      };
    }, id, undefined, context);
    state.lease = receipt.lease;
    snapshot = await runtime.options.backend.inspect(state.workItemId, runtime.requestSignal(context));
  }
  if (!unresolved
    && snapshot.state === "claimed") {
    await runtime.authority.fresh(["claimed"]);
    await runtime.authority.grant();
    await runtime.backendOperation("start", {
      leaseId: state.lease!.id,
      action: "start",
      payload: {}
    }, ref => runtime.options.backend.transition(state.lease!, "start", {}, ref.backendKey ?? ref.id, runtime.requestSignal(context)), undefined, undefined, context);
  }
  if (!unresolved
    && ["released", "needs_review", "blocked", "failed"].includes(snapshot.state)) {
    const terminal = Object.values(state.operations).find(operation => operation.backendReceipt?.state === snapshot.state && ["release", "review", "block", "fail"].includes(operation.ref.kind));
    if (terminal) {
      state.state = snapshot.state as WorkState;
      runtime.persist(snapshot.state === "failed" ? "failed" : snapshot.state === "needs_review" ? "review" : "blocked", {
        disposition: snapshot.state,
        backendReceiptRef: terminal.backendReceipt!.id,
        reconciled: true
      });
      runtime.releaseOwnership();
      return runtime.safeStatus();
    }
  }
  if (snapshot.state === "completed") {
    const completion = Object.values(state.operations).find(op => op.ref.kind === "complete" && op.backendReceipt?.state === "completed");
    if (completion
      && !Object.keys(state.inflightSteps).length
      && !Object.keys(state.verificationRuns).length
      && !state.unknownExecutions.length) {
      await runtime.checkProof();
      state.state = "completed";
      runtime.persist("completed", {
        backendReceiptRef: completion.backendReceipt!.id,
        reconciled: true
      });
    }
  }
  else if (!Object.keys(state.inflightSteps).length
    && !Object.keys(state.verificationRuns).length
    && !state.unknownExecutions.length
    && !Object.values(state.operations).some(op => op.status === "started")) {
    const { plan } = await runtime.authority.fresh();
    for (const evidence of Object.values(state.evidence)) {
      if (plan.coverage[evidence.stepId]?.id === evidence.id) {
        continue;
      }
      const existing = state.operations[evidence.id];
      if (existing?.status === "started") {
        continue;
      }
      if (existing?.backendReceipt) {
        state.state = "blocked";
        runtime.persist("blocked", {
          disposition: "authoritative_evidence_coverage_changed",
          evidenceRef: evidence.id
        });
        return runtime.safeStatus();
      }
      await runtime.backendOperation("evidence", evidence as unknown as Record<string, unknown>, ref => runtime.options.backend.submitEvidence(state.lease!, evidence, ref, runtime.requestSignal(context)), existing ? randomUUID() : evidence.id, existing ? evidence.id : undefined, context);
    }
    state.renewalFailed = false;
    state.state = Object.keys(state.evidence).length ? "verifying" : "running";
    runtime.persist("reconciled", {
      disposition: "ownership_confirmed"
    });
    runtime.scheduleRenewal();
  }
  return runtime.safeStatus();
}
async function reconcileEffect(runtime: AttemptRecoveryRuntime, originalExecutionId: string, intent: StepIntent, context: ToolExecutionContext): Promise<void> {
  const state = runtime.state();
  const sourceStep = runtime.options.steps[intent.stepKey];
  const step = sourceStep ? Object.freeze({
    ...sourceStep
  }) : undefined;
  if (!step?.reconcileEffect
    || !step.prepareReconciliation
    || !step.reconciliationSpecDigest
    || !intent.reconciliationMetadata
    || !intent.oracleDigest) {
    return;
  }
  const metadata = snapshotJson(intent.reconciliationMetadata, "captured readback metadata");
  const readback = step.reconcileEffect;
  const validateCatalog = (grant: ResolvedWorkGrant): void => {
    const current = runtime.options.steps[intent.stepKey];
    const tool = current ? runtime.options.registry.get(current.toolName) : undefined;
    const digest = current?.prepareReconciliation && current.reconcileEffect && current.reconciliationSpecDigest ? digestJson({
      specDigest: current.reconciliationSpecDigest,
      prepare: Function.prototype.toString.call(current.prepareReconciliation),
      readback: Function.prototype.toString.call(current.reconcileEffect),
      capabilityDigest: current.capabilityDigest
    }) : undefined;
    if (!current
      || current.reconcileEffect !== readback
      || digest !== intent.oracleDigest
      || current.capabilityDigest !== intent.capabilityDigest
      || current.toolName !== step.toolName
      || !tool
      || capabilityDigest(tool) !== intent.capabilityDigest
      || grant.stepBindings[intent.stepKey]?.toolName !== current.toolName
      || grant.stepBindings[intent.stepKey]?.capabilityDigest !== intent.capabilityDigest
      || !grant.actions.includes("read")
      || !state.preview.snapshot.contract.actions.includes("read")) {
      throw new JournalInvariantError("Effect readback catalog or authority changed");
    }
    runtime.authority.validatePaths(intent.admittedPaths, grant);
  };
  const grant = await runtime.authority.grant();
  await runtime.authority.fresh(["running"]);
  validateCatalog(grant);
  if (state.actions >= grant.limits.maxActions) {
    throw new JournalInvariantError("Effect readback action budget exhausted");
  }
  await runtime.options.grantResolver.reserveAttempt?.(state.binding, state.attemptId);
  await runtime.options.grantResolver.reserveAction?.(state.binding, state.attemptId);
  runtime.assertAdmissionContext(context);
  state.actions++;
  const oracleRunId = randomUUID();
  state.oracleRuns[oracleRunId] = {
    originalExecutionId,
    oracleDigest: intent.oracleDigest,
    inputDigest: intent.inputDigest
  };
  runtime.persist("reconciled", {
    originalExecutionId,
    oracleRunId,
    oracleIntent: true,
    oracleDigest: intent.oracleDigest,
    inputDigest: intent.inputDigest
  });
  const privateRegistry = runtime.options.registry.project({
    names: []
  }, {
    authorize: async () => {
      try {
        const current = await runtime.authority.grant();
        await runtime.authority.fresh(["running"]);
        validateCatalog(current);
        return current.actions.includes("read") ? {
          decision: "allow",
          authorityGrantRefs: [current.id],
          expiresAt: current.expiresAt
        } : {
          decision: "deny",
          reasonCodes: ["readback_read_permission_missing"]
        };
      }
      catch {
        return {
          decision: "deny",
          reasonCodes: ["readback_authority_unavailable"]
        };
      }
    }
  });
  const definition = {
    name: `_of_readback_${originalExecutionId.replaceAll("-", "_")}`,
    description: "Read the independent trusted effect oracle; never dispatch the original effect",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false
    },
    replayPolicy: "read_only" as const,
    executionMode: "parallel-safe" as const,
    contract: {
      version: "1",
      useWhen: [],
      doNotUseWhen: [],
      sideEffects: [],
      mutation: false,
      commitmentClass: "C0" as const,
      idempotency: "idempotent" as const,
      requiresAuthority: true,
      bounds: {
        originalExecutionId,
        oracleDigest: intent.oracleDigest,
        inputDigest: intent.inputDigest,
        capabilityDigest: intent.capabilityDigest
      }
    },
    handler: async (_params: Record<string, unknown>, boundContext?: ToolExecutionContext) => {
      const current = await runtime.authority.grant();
      await runtime.authority.fresh(["running"]);
      validateCatalog(current);
      return {
        success: true,
        data: await readback({
          workspaceRoot: runtime.options.workspaceRoot,
          metadata,
          inputDigest: intent.inputDigest,
          capabilityDigest: intent.capabilityDigest,
          signal: boundContext?.signal ?? runtime.requestSignal(context)
        })
      };
    }
  };
  privateRegistry.register(definition);
  const execution = await privateRegistry.executeDetailed(definition.name, {}, {
    ...context,
    expectedCapabilityDigest: capabilityDigest(definition),
    callId: oracleRunId,
    runId: state.attemptId,
    signal: runtime.requestSignal(context),
    deadline: Math.min(context.deadline ?? Infinity, grant.expiresAt, state.startedAt + grant.limits.maxDurationMs)
  }, runtime.executions());
  runtime.accountOutput(execution.receipt.executionId, Buffer.byteLength(execution.modelContent));
  delete state.oracleRuns[oracleRunId];
  runtime.persist("reconciled", {
    originalExecutionId,
    readbackExecutionId: execution.receipt.executionId,
    disposition: "readback_recorded"
  }, {
    executionId: execution.receipt.executionId,
    receiptRef: execution.receipt.executionId
  });
  await runtime.recordOutput(execution.receipt.executionId);
  await runtime.authority.grant();
  await runtime.authority.fresh(["running"]);
  validateCatalog(await runtime.authority.grant());
  const proof = execution.result.data as {
    effect?: unknown;
    sourceRefs?: unknown;
  } | undefined;
  if (execution.receipt.cancellationObserved
    || execution.receipt.deadlineObserved
    || context.signal?.aborted
    || context.deadline !== undefined && context.deadline <= runtime.now()
    || execution.outcome !== "succeeded"
    || !execution.result.success
    || proof?.effect !== "verified"
    || !Array.isArray(proof.sourceRefs)
    || !proof.sourceRefs.length
    || proof.sourceRefs.some(ref => typeof ref !== "string" || !ref)) {
    return;
  }
  state.effectResolutions[originalExecutionId] = {
    effect: "verified",
    readbackExecutionId: execution.receipt.executionId,
    sourceRefs: proof.sourceRefs as string[]
  };
  delete state.unknownSteps[originalExecutionId];
  state.unknownExecutions = state.unknownExecutions.filter(id => id !== originalExecutionId);
  for (const [id, pending] of Object.entries(state.inflightSteps))
    if (pending === intent
      || pending.stepKey === intent.stepKey && pending.inputDigest === intent.inputDigest && pending.reconciliationMetadata === intent.reconciliationMetadata) {
      delete state.inflightSteps[id];
    }
  runtime.persist("reconciled", {
    originalExecutionId,
    readbackExecutionId: execution.receipt.executionId,
    disposition: "effect_independently_verified"
  }, {
    executionId: execution.receipt.executionId,
    receiptRef: execution.receipt.executionId
  });
}
