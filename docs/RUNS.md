# Legible runs

OpenFunction separates five records that are easy to blur together:

1. A task says what should happen.
2. A run records one bounded execution attempt.
3. An outcome claim says what that run reports producing.
4. Verification attempts and an assurance bundle evaluate the claim.
5. A fulfillment decision changes the task's meaning only after the required assurance is satisfied.

A completed run is therefore not automatically a fulfilled task.

## Run manifests

`defineAgent()` and `createChatAgent()` now return a `run` on successful and
limited executions. Adapter failures throw `RunExecutionError`, whose `run`
property contains the failed record. A manifest captures:

- run, task, parent, work-item, and correlation IDs;
- actor and attempt number;
- the exact provider, role, model, reasoning effort, and dated model policy;
- digests of instructions and the exposed capability definitions;
- authority-grant and verification-plan references;
- environment references and execution limits.

Raw prompts, API keys, and environment secrets are not stored in a manifest.

Runs also retain `executionReceiptRefs` and optional `contextSnapshotRefs`.
Successful executions have receipt references without being mislabeled as
partial effects. Execution receipts bind tool/input/result digests, admission,
actor/scope references, policy, times, and verification state. They contain no
raw grant or lease custody and do not recursively embed the result.

`executeDetailed()` owns the canonical result and exact model serialization.
Host text, chat history, run evidence, and standalone journals consume that
same result; output hooks run once. Known success, known failure, and unknown
effect certainty are distinct from verification. Late cancellation preserves a
valid returned result. Failed result persistence requires reconciliation even
when useful handler output is retained.

```typescript
const result = await agent.run(task, adapter, registry, context, {
  taskId: "task-42",
  workItemId: "work-9",
  authorityGrantRefs: ["grant:calendar-write"],
  verificationPlan: { id: "calendar-readback", version: 2 },
});

console.log(result.run.status);              // completed | limit_reached
console.log(result.run.manifest.model.model); // exact resolved model
console.log(result.outcome?.runId);           // absent for limited runs
```

For chat agents, put the same context under `options.run`:

```typescript
const result = await chat.chat("Schedule the review", {
  run: { taskId: "task-42", correlationId: "request-17" },
});
```

## Model policy

`modelRole` is the durable application-level choice. `instant`, `expert`,
`frontier`, and `background` resolve through `PROVIDER_MODEL_DEFAULTS`.
`model` remains an explicit escape hatch. Every resolution records
`MODEL_POLICY_VERSION`, so historical runs remain interpretable after defaults
change.

The provider is never changed implicitly. Choosing OpenAI with the `instant`
role selects OpenAI's instant default; it does not route the call to Gemini.

`cancelRun()` records whether cancellation happened before effects, after
partial effects, or after commitment, plus any required compensation or
verification. It does not erase the attempt.

## Verification and fulfillment

Verification methods compose; they are not a universal strength ladder. A
policy can require, for example, both a deterministic oracle and an independent
state readback. `evaluateAssurance()` produces `satisfied`, `unsatisfied`, or
`incomplete`. Only satisfied assurance can produce a default `fulfilled`
decision through `decideFulfillment()`.

```typescript
const assurance = evaluateAssurance(outcome.claimId, {
  requiredMethods: ["deterministic_oracle", "state_readback"],
  requiredCoverage: ["tests", "remote-state"],
  requireIndependent: true,
}, attempts);

const fulfillment = decideFulfillment({
  taskId: "task-42",
  outcome,
  assurance,
  decidedBy: "workflow:calendar",
  reason: "tests and remote readback passed",
});
```

Structured output proves that an answer has a requested shape. It does not, by
itself, prove that an external effect occurred or that a task is fulfilled.

The work controller uses a stricter completion gate than the general run
helpers. Its current plan coverage must match locally collected evidence,
including outcome, plan/specification/environment, attempt, input fingerprint,
mutation epoch, and saved artifact digest. Later writes invalidate that proof.
Automatic completion needs a separate current grant and independent readback;
human-only or unsupported criteria route to review. Unknown operations cannot
complete until independently reconciled.

Each claim, renewal, step, verification run, evidence submission, and terminal
transition has its own durable identity. Recovery replays a known canonical
result without another effect. A durable verification result can be submitted
without rerunning the command. An uncertain backend operation can retry only
within a verified backend key/payload guarantee; absent lookup does not prove
non-execution. Hosted Siftable recovery is currently disabled where those
contracts remain unproven.

## Context and history

Providers may implement `buildSnapshot()` alongside legacy `buildContext()`.
Snapshots distinguish observations, claims, inferences, and policy references;
they carry source/scope, observation time when known, digest, expiry, omissions,
and freshness. Legacy text has unknown upstream freshness. Failed retrieval is
stale or unavailable, rather than evidence that no work exists. Caches separate
provider/principal/workspace/project identities.

Sessions capture the snapshots used by model requests and runs. Refreshes append
attributed context without rewriting prior evidence or stable system prompts.
Provider text cannot grant execution authority. Actual adapter-provided usage
and request limits are recorded; byte counts do not estimate tokens or cost.

`historyBudget` optionally bounds messages and bytes. Projection retains whole
turns/tool exchanges and clears incompatible continuation state atomically.
An active turn exceeding the configured budget fails explicitly rather than
splitting a provider exchange or inventing a summary. Full journal evidence
remains available; the compatibility default is unbounded.

## Capability contracts

Tools may add an optional `contract` next to their schema. It describes
authority, side effects, commitment class, idempotency, reversibility,
concurrency control, and verification hints. The contract is included in the
capability digest, so a materially changed tool definition creates a different
snapshot.

The input schema remains the provider-facing invocation contract. The optional
capability contract is execution metadata for agents, policy, and audit layers.
