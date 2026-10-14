/** Authority fences for one selected attempt; durable state remains controller-owned. */
import { isAbsolute, relative, resolve } from "node:path";
import type { ExecutionPolicy } from "../execution-types.js";
import { capabilityDigest } from "../executor.js";
import { JournalInvariantError } from "../journal-file.js";
import { digestJson } from "../session.js";
import type { PersistedAttempt } from "./attempt-state.js";
import type {
  BackendReceipt,
  LeaseRef,
  OperationRef,
  ResolvedWorkGrant,
  WorkAuthorizationBinding,
  WorkControllerOptions,
  WorkPreview,
  WorkSnapshot,
} from "./types.js";
import { pathMatches, scopedPath } from "./verification.js";

export interface AttemptAuthorityContext {
  options: WorkControllerOptions;
  state: () => PersistedAttempt;
  now: () => number;
  isStopping: () => boolean;
  prepare: (workItemId: string) => Promise<WorkPreview>;
}

export class AttemptAuthority {
  constructor(private readonly context: AttemptAuthorityContext) {}

  async grant(
    purpose: "execution" | "completion" = "execution",
    cleanup = false,
  ): Promise<ResolvedWorkGrant> {
    const state = this.context.state();
    const grant = await this.context.options.grantResolver.resolve(state.binding, purpose);
    const grantUnavailable = !grant
      || grant.expiresAt <= this.context.now()
      || purpose === "completion" && !grant.completion;
    if (grantUnavailable) {
      throw new JournalInvariantError(`Current ${purpose} grant missing or expired`);
    }
    if (!cleanup && state.outputBytes >= grant.limits.maxOutputBytes) {
      throw new JournalInvariantError("Attempt output budget is exhausted; fresh stronger authorization required");
    }
    if (!cleanup && this.context.now() - state.startedAt >= grant.limits.maxDurationMs) {
      throw new JournalInvariantError("Attempt duration limit reached");
    }
    return grant;
  }

  policy(): ExecutionPolicy {
    return {
      authorize: async ({ toolSnapshot, params }) => {
        try {
          const state = this.context.state();
          const accepting = () => !this.context.isStopping()
            && ["running", "verifying"].includes(state.state)
            && !state.unknownExecutions.length
            && !state.renewalFailed;
          if (!accepting()) {
            return { decision: "deny", reasonCodes: ["work_reconciliation_required"] };
          }

          // Queueing and journal I/O can outlive ownership observed at admission.
          await this.fresh(["running"]);
          const grant = await this.grant();
          const inactiveLease = !accepting()
            || !state.lease
            || state.lease.expiresAt <= this.context.now();
          if (inactiveLease) {
            return { decision: "deny", reasonCodes: ["inactive_work_lease"] };
          }
          const step = Object.entries(this.context.options.steps)
            .find(([, binding]) => binding.toolName === toolSnapshot.name);
          const unboundStep = !step
            || grant.stepBindings[step[0]]?.capabilityDigest !== capabilityDigest(toolSnapshot)
            || grant.stepBindings[step[0]]?.toolName !== toolSnapshot.name
            || !grant.actions.includes(step[1].action)
            || !state.preview.snapshot.contract.actions.includes(step[1].action);
          if (unboundStep) {
            return { decision: "deny", reasonCodes: ["unbound_work_step"] };
          }
          step[1].validateParams?.(params);
          this.validatePaths(step[1].paths?.(params) ?? [], grant);
          return { decision: "allow", authorityGrantRefs: [grant.id], expiresAt: grant.expiresAt };
        } catch {
          return { decision: "deny", reasonCodes: ["work_authority_unavailable"] };
        }
      },
    };
  }

  verificationPolicy(state: PersistedAttempt): ExecutionPolicy {
    return {
      authorize: async () => {
        try {
          const grant = await this.grant();
          // Verification dispatch rechecks backend ownership after queueing.
          await this.fresh(["running"]);
          // Keep the verification run's captured state, while grant/fresh read live state.
          const authorityUnavailable = this.context.isStopping()
            || !["running", "verifying"].includes(state.state)
            || state.unknownExecutions.length
            || state.renewalFailed
            || !grant.actions.includes("test")
            || !state.lease
            || state.lease.expiresAt <= this.context.now();
          if (authorityUnavailable) {
            return { decision: "deny", reasonCodes: ["verification_authority_unavailable"] };
          }
          return { decision: "allow", authorityGrantRefs: [grant.id], expiresAt: grant.expiresAt };
        } catch {
          return { decision: "deny", reasonCodes: ["verification_grant_unavailable"] };
        }
      },
    };
  }

  validatePaths(paths: readonly string[], grant: ResolvedWorkGrant): void {
    for (const path of paths) {
      const absolute = scopedPath(this.context.options.workspaceRoot, path, true);
      const rel = relative(resolve(this.context.options.workspaceRoot), absolute).replaceAll("\\", "/");
      const allowedRoot = grant.roots.some(root => {
        const part = relative(resolve(root), absolute);
        return part !== ".." && !part.startsWith("../") && !isAbsolute(part);
      });
      const contract = this.context.state().preview.snapshot.contract;
      const contractRoot = contract.roots.some(root => {
        const part = relative(resolve(root), absolute);
        return part !== ".." && !part.startsWith("../") && !isAbsolute(part);
      });
      const outsideScope = !allowedRoot
        || !contractRoot
        || !pathMatches(rel, grant.include)
        || pathMatches(rel, grant.exclude)
        || !pathMatches(rel, contract.include)
        || pathMatches(rel, contract.exclude);
      if (outsideScope) {
        throw new JournalInvariantError("Step path outside granted scope");
      }
    }
  }

  binding(snapshot: WorkSnapshot, plan: WorkPreview["plan"]): WorkAuthorizationBinding {
    return {
      backendId: snapshot.backendId,
      workItemId: snapshot.workItemId,
      workspaceId: snapshot.workspaceId,
      ...(snapshot.projectId ? { projectId: snapshot.projectId } : {}),
      contractDigest: snapshot.contractDigest,
      revision: snapshot.revision,
      planId: plan.id,
      planVersion: plan.version,
      planDigest: plan.digest,
      scopeDigest: digestJson({
        backendId: snapshot.backendId,
        workspaceId: snapshot.workspaceId,
        projectId: snapshot.projectId,
        workspaceRoot: resolve(this.context.options.workspaceRoot),
        contractDigest: snapshot.contractDigest,
      }),
    };
  }

  validateLease(lease: LeaseRef, requireLive = true): void {
    const state = this.context.state();
    const invalidLease = !lease
      || typeof lease.id !== "string"
      || !lease.id
      || lease.backendId !== state.binding.backendId
      || lease.workItemId !== state.workItemId
      || lease.owner !== this.context.options.claimOwner
      || !Number.isFinite(lease.expiresAt)
      || requireLive && lease.expiresAt <= this.context.now();
    if (invalidLease) {
      throw new JournalInvariantError("Lease descriptor identity, owner or expiry mismatch");
    }
  }

  validateBackendReceipt(receipt: BackendReceipt, operation: OperationRef): void {
    const state = this.context.state();
    const invalidBinding = !receipt
      || typeof receipt.id !== "string"
      || !receipt.id
      || receipt.kind !== operation.kind
      || receipt.operationId !== (operation.backendKey ?? operation.id)
      || receipt.payloadDigest !== operation.payloadDigest
      || receipt.workItemId !== state.workItemId;
    if (invalidBinding) {
      throw new JournalInvariantError("Backend receipt operation/work binding mismatch");
    }
    const expected = {
      open: ["claimed"],
      start: ["running"],
      heartbeat: ["claimed", "running"],
      evidence: ["running"],
      complete: ["completed"],
      review: ["needs_review"],
      block: ["blocked"],
      fail: ["failed"],
      release: ["released"],
    }[operation.kind];
    if (!expected.includes(receipt.state)) {
      throw new JournalInvariantError("Backend receipt lifecycle mismatch");
    }
    if (receipt.lease) this.validateLease(receipt.lease, false);
  }

  async fresh(
    allowedStates: readonly string[] = ["running", "completed"],
  ): Promise<{ snapshot: WorkSnapshot; plan: WorkPreview["plan"] }> {
    const state = this.context.state();
    const preview = await this.context.prepare(state.workItemId);
    if (digestJson(preview.binding) !== digestJson(state.binding)) {
      throw new JournalInvariantError("Work contract, plan or scope changed");
    }
    if (!allowedStates.includes(preview.snapshot.state)) {
      throw new JournalInvariantError("Selected backend lifecycle is incompatible with dispatch");
    }
    if (state.lease) this.validateLease(state.lease, false);
    if (preview.snapshot.lease) this.validateLease(preview.snapshot.lease);
    const ownershipUnavailable = !state.lease
      || !preview.snapshot.lease
      || state.lease.id !== preview.snapshot.lease.id
      || state.lease.owner !== preview.snapshot.lease.owner
      || preview.snapshot.lease.expiresAt <= this.context.now();
    if (ownershipUnavailable) {
      throw new JournalInvariantError("Fresh backend lease ownership unavailable");
    }
    state.lease = preview.snapshot.lease;
    return { snapshot: preview.snapshot, plan: preview.plan };
  }
}
