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

## Capability contracts

Tools may add an optional `contract` next to their schema. It describes
authority, side effects, commitment class, idempotency, reversibility,
concurrency control, and verification hints. The contract is included in the
capability digest, so a materially changed tool definition creates a different
snapshot.

The input schema remains the provider-facing invocation contract. The optional
capability contract is execution metadata for agents, policy, and audit layers.
