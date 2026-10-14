/** Verification-domain checks; the controller owns admission, custody and persistence. */
import type { FileArtifactStore } from "../artifacts.js";
import { JournalInvariantError } from "../journal-file.js";
import { digestJson } from "../session.js";
import type { PersistedAttempt } from "./attempt-state.js";
import { fingerprintSubject } from "./verification.js";
import type {
  ResolvedWorkGrant,
  VerificationBinding,
  VerificationEvidence,
  VerificationPlanSnapshot,
  WorkSnapshot,
} from "./types.js";

export function selectVerificationBinding(
  stepId: string,
  plan: VerificationPlanSnapshot,
  bindings: readonly VerificationBinding[],
): VerificationBinding {
  const step = plan.steps.find(step => step.id === stepId);
  const binding = bindings.find(binding =>
    binding.stepId === stepId
    && binding.specDigest === step?.specDigest
    && binding.environment === step.environment,
  );
  if (!step || !binding || ["human", "external"].includes(step.kind)) {
    throw new JournalInvariantError("Verification method unsupported or unbound");
  }
  return binding;
}

interface CollectVerificationEvidenceOptions {
  state: PersistedAttempt;
  binding: VerificationBinding;
  plan: VerificationPlanSnapshot;
  stepId: string;
  evidenceId: string;
  workspaceRoot: string;
  artifacts: FileArtifactStore;
  now: () => number;
  signal: AbortSignal;
}

/** Return the private handler's result directly, without an extra awaited wrapper. */
export async function collectVerificationEvidence({
  state,
  binding,
  plan,
  stepId,
  evidenceId,
  workspaceRoot,
  artifacts,
  now,
  signal,
}: CollectVerificationEvidenceOptions): Promise<{ success: true; data: VerificationEvidence }> {
  const before = fingerprintSubject(workspaceRoot, state.binding.workspaceId, binding.inputs, state.mutationEpoch);
  const startedAt = now();
  const result = await binding.run({ workspaceRoot, signal });
  const readbackPassed = result.readbackPassed && await binding.readback(workspaceRoot);
  // The final subject includes changes made while the independent readback awaited.
  const after = fingerprintSubject(workspaceRoot, state.binding.workspaceId, binding.inputs, state.mutationEpoch);
  const evidence: VerificationEvidence = {
    id: evidenceId,
    backendId: state.binding.backendId,
    workItemId: state.workItemId,
    attemptId: state.attemptId,
    planId: plan.id,
    planVersion: plan.version,
    stepId,
    specDigest: binding.specDigest,
    environment: binding.environment,
    ...(result.environmentSnapshot ? { environmentSnapshot: result.environmentSnapshot } : {}),
    before,
    after,
    startedAt,
    finishedAt: now(),
    exitCode: result.exitCode,
    outcome: before.digest !== after.digest || before.mutationEpoch !== after.mutationEpoch || result.exitCode === null
      ? "inconclusive"
      : result.exitCode === 0 && readbackPassed ? "passed" : "failed",
    readbackPassed,
    acceptanceMethods: result.acceptanceMethods,
    artifact: artifacts.put(result.output, { mediaType: "text/plain" }),
  };
  return { success: true, data: evidence };
}

interface ProofSubject {
  binding: VerificationBinding;
  evidence: VerificationEvidence;
}
interface CheckCompletionProofOptions {
  state: PersistedAttempt;
  currentState: () => PersistedAttempt;
  grant: ResolvedWorkGrant;
  snapshot: WorkSnapshot;
  plan: VerificationPlanSnapshot;
  verificationBindings: readonly VerificationBinding[];
  workspaceRoot: string;
  artifacts: FileArtifactStore;
}

/** The caller refreshes completion authority and backend custody before this check. */
export async function checkCompletionProof({
  state,
  currentState,
  grant,
  snapshot,
  plan,
  verificationBindings,
  workspaceRoot,
  artifacts,
}: CheckCompletionProofOptions): Promise<() => void> {
  const assertProofSubjects = (subjects: readonly ProofSubject[]): void => {
    const currentAttempt = currentState();
    for (const { binding, evidence } of subjects) {
      const current = fingerprintSubject(workspaceRoot, currentAttempt.binding.workspaceId, binding.inputs, currentAttempt.mutationEpoch);
      if (current.digest !== evidence.after.digest || current.mutationEpoch !== evidence.after.mutationEpoch) {
        throw new JournalInvariantError("Verification subject changed");
      }
      if (digestJson(artifacts.metadata(evidence.artifact.id)) !== digestJson(evidence.artifact)) {
        throw new JournalInvariantError("Evidence artifact metadata changed");
      }
    }
  };
  if (
    snapshot.humanReviewRequired
    || !plan.steps.some(step => step.required)
    || Object.keys(state.inflightSteps).length
    || Object.keys(state.verificationRuns).length
    || state.unknownExecutions.length
    || Object.values(state.operations).some(operation => operation.status === "started" && operation.ref.kind !== "complete")
  ) {
    throw new JournalInvariantError("Review, missing proof or uncertain operations prevent completion");
  }
  const covered = new Set<string>();
  const subjects: ProofSubject[] = [];
  const criterionMethods = new Set(snapshot.contract.acceptanceCriteria.map(criterion => criterion.method));
  for (const step of plan.steps.filter(step => step.required || state.evidence[step.id]?.acceptanceMethods.some(method => criterionMethods.has(method)))) {
    const binding = verificationBindings.find(binding =>
      binding.stepId === step.id
      && binding.specDigest === step.specDigest
      && binding.environment === step.environment,
    );
    const evidence = state.evidence[step.id];
    const authoritative = plan.coverage[step.id];
    if (
      !binding
      || !evidence
      || authoritative?.id !== evidence.id
      || authoritative.outcome !== "passed"
      || digestJson(authoritative) !== digestJson(evidence)
      || evidence.outcome !== "passed"
      || evidence.before.mutationEpoch !== state.mutationEpoch
      || evidence.after.mutationEpoch !== state.mutationEpoch
      || evidence.before.digest !== evidence.after.digest
      || evidence.specDigest !== step.specDigest
      || evidence.environment !== step.environment
      || evidence.planId !== plan.id
      || evidence.planVersion !== plan.version
      || evidence.attemptId !== state.attemptId
    ) {
      throw new JournalInvariantError("Current active proof missing");
    }
    assertProofSubjects([{ binding, evidence }]);
    if (!await binding.readback(workspaceRoot)) {
      throw new JournalInvariantError("Independent readback failed");
    }
    subjects.push({ binding, evidence });
    for (const method of evidence.acceptanceMethods) covered.add(method);
  }
  if (
    !snapshot.contract.acceptanceCriteria.length
    || !snapshot.contract.acceptanceCriteria.every(criterion => grant.acceptanceMethods.includes(criterion.method) && covered.has(criterion.method))
  ) {
    throw new JournalInvariantError("Acceptance method coverage missing");
  }
  // Later readbacks can change subjects checked earlier. The synchronous fence
  // also lets terminal dispatch recheck after its final awaited authority lookup.
  assertProofSubjects(subjects);
  return () => assertProofSubjects(subjects);
}
