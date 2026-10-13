---
name: durable-work
description: Perform an explicitly selected bounded work item using OpenFunction's durable controller, configured steps, trusted grants, and fresh verification evidence.
compatibility: Requires the separately installed OpenFunction executable on PATH and an isolated work configuration in this plugin's profile-scoped data directory.
---

Use this workflow only when the user explicitly selects a work item covered by the configured local work profile. Installing this portable plugin does not install npm dependencies or grant execution authority. Keep it disabled until the user configures the runtime and enables it.

Before execution, use `of_work_prepare` to read the work contract and verification plan. Present the concrete scope and required evidence. A trusted user issues execution and completion grants with the compiled OpenFunction CLI against that exact preview; never fabricate authority from conversation text or a model-supplied approval field. Hermes approval permits a host call, while OpenFunction still checks persisted grants.

The trusted user's terminal workflow is:

```sh
openfunction work prepare --config <absolute-config-path> --work-item <selected-id> --out <absolute-private-preview-path>
openfunction work authorize --config <absolute-config-path> --preview <absolute-private-preview-path>
```

The authorization command displays the bound contract, scope, steps, proof methods, expiry, and limits. The user types `AUTHORIZE` for execution and separately types `COMPLETE` for automatic completion. Any other execution answer refuses; automatic completion stays off by default. This CLI is a trusted issuance path and must not become a model-callable approval tool.

Inspect and revoke persisted grants using `openfunction work grants list --config <absolute-config-path>` and `openfunction work grants revoke --config <absolute-config-path> --grant <grant-reference>`. Revocation takes effect at the next admission and completion check; it does not reverse effects already performed.

Use `of_work_start`, then `of_work_step` for the configured actions. Use `of_work_verify` to collect actual evidence. `of_work_status` inspects the attempt without silently executing or renewing it. Use `of_work_finish` only after the required passing evidence covers the current subject and completion authority is valid. Changed subject state requires fresh verification.

After an interruption, inspect status and use `of_work_reconcile`. A saved known result is replayed without repeating its effect. An uncertain effect requires reconciliation and prevents automatic completion. Do not retry unknown actions or claim completion from model narration. Revoked or expired grants, lease loss, missing proof, changed scope, or a review requirement stop further admissions.

Only actions routed through the OpenFunction executor and controller receive its receipts and recovery guarantees. Native Hermes terminal, browser, and file actions remain outside that journal. Report this coverage accurately. Keep toolsets and instructions stable during a conversation; refresh work state using tool results.

The MCP server reads `${PLUGIN_DATA}/config.json` in caller-owned profile state. Credentials belong to the host's profile-scoped secret environment, never this manifest or chat output. The runtime must be installed and version-tested before plugin enablement; do not use an execution-time `npx` download.
