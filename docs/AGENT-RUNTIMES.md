# Agent runtime integrations

Hermes consumes OpenFunction through MCP. OpenClaw and Pi use thin native
projections of the same executor. Native SDKs belong to their plugin packages,
so importing the framework does not load a host runtime.

## Hermes configuration and portable installation

Use a separately installed, version-tested OpenFunction runtime. Portable
plugins do not install npm dependencies or fetch an unpinned runtime on demand.
`plugins/hermes-openfunctions/` contains the manifest, MCP server definition,
and namespaced durable-work skill. Its command is the bare `openfunction`
executable on PATH, as required by the pinned portable schema. Caller-owned
configuration is selected through `${PLUGIN_DATA}`.

The tested portable schemas are Agent Plugins v1. Hermes trust belongs in
`plugin.json` under `extensions["com.nousresearch.hermes"].servers.openfunctions`.
The plugin starts disabled; installation performs no claiming or execution.
Enable it explicitly in the selected profile after configuring the runtime and
grants. Instructions/toolsets stay stable during a conversation; refresh data
through tool results or a new session boundary.

For ordinary MCP configuration, generate a merge-ready fragment:

```ts
import { createHermesMcpConfig } from "openfunction/framework/hermes";
import { registry } from "./tools.js";

const config = createHermesMcpConfig(registry, {
  command: "openfunction",
  args: ["serve", "--module", "/absolute/tools.js"],
  cwd: "/absolute/caller-state",
  protocol: "legacy",
  trust: "untrusted",
  timeout: 120,
  connectTimeout: 30,
  supportsParallelToolCalls: false,
  resources: false,
  prompts: false,
});
```

Merge it into the selected profile's configuration. The helper does not edit
Hermes files or print credentials. `tools.include` captures the selected catalog;
regenerate and review it when exposing new tools.

## Local durable work

The work profile reads a protected absolute configuration path. Public tools
prepare, start, step, verify, inspect, reconcile, and finish one explicitly
selected item. It does not claim the next job or expose an unrestricted shell.
`of_work_finish` may request review, block, or release explicitly; automatic
completion still requires the matching completion grant.

This example configures a job in an explicitly selected local workspace:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalFixtureBindings } from "openfunction/framework/work";

const workspaceRoot = "/absolute/local-job";
mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
writeFileSync(join(workspaceRoot, "fixture.json"),
  '{"status":"needs_correction","value":0}\n', { mode: 0o600 });
writeFileSync(join(workspaceRoot, "verify.mjs"),
  'import fs from "node:fs";const x=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));if(x.status!=="corrected"||x.value!==1)process.exit(1);console.log("verified");\n',
  { mode: 0o600 });
const binding = createLocalFixtureBindings({
  workspaceRoot, fixturePath: "fixture.json", verifierPath: "verify.mjs",
});
writeFileSync(join(workspaceRoot, "profile.json"), JSON.stringify({
  schemaVersion: 1,
  workspaceRoot,
  dataDir: join(workspaceRoot, "state"),
  grantDir: join(workspaceRoot, "grants"),
  backend: {
    kind: "local", backendId: "local-example", workspaceId: "example",
    workItems: [{
      workItemId: "job", contract: binding.contract,
      plan: { id: "fixture-plan", version: 1, state: "active", steps: [binding.verificationStep] },
    }],
  },
  stepCatalog: { kind: "fixture", fixturePath: "fixture.json", verifierPath: "verify.mjs" },
}), { mode: 0o600 });
```

Use the same installed Node runtime to generate the plan and launch the CLI;
verification binds the executable, arguments, environment, and source inputs.
Review and issue authority through the shipped CLI:

```sh
openfunction work prepare --config /absolute/local-job/profile.json --work-item job --out /absolute/local-job/preview.json
openfunction work authorize --config /absolute/local-job/profile.json --preview /absolute/local-job/preview.json
openfunction hermes-config --config /absolute/local-job/profile.json
```

The review displays exact roots, paths, actions, step/specification bindings,
verification, expiry, and limits. `AUTHORIZE` grants execution. A separate
`COMPLETE` decision enables automatic completion; otherwise it remains off.
References in model arguments cannot issue grants. Revocation remains available
when the target fixture or trusted step module disappears:

```sh
openfunction work grants list --config /absolute/local-job/profile.json
openfunction work grants revoke --config /absolute/local-job/profile.json --grant <grant-id>
```

For a practical job, configure `stepCatalog: { kind: "module", modulePath:
"/absolute/trusted-bindings.js" }`. That trusted module exports
`createWorkBindings({ workspaceRoot })`, returning tools, finite step bindings,
and verification bindings. Reviewed configuration selects paths and commands;
the model selects registered keys and parameters.

Grant/state custody uses protected permissions (0600 files and 0700 directories).
A same-user process with write access can change it; stronger separation requires
host permissions and OS isolation. Hermes approval precedes an MCP write request
but provides no signed server-side grant. Hosted/service use requires a genuine
authenticated issuer and policy binding.

The controller renews the lease independently of a completed MCP request.
Cancellation stops admissions and reaches cooperative handlers; started effects
retain receipts. Restart reads saved evidence and requires explicit reconciliation
before resuming. Unknown writes do not replay. The fixture catalog provides an
exact-digest readback for explicit reconciliation; a separate linked receipt
records that proof while the original uncertain execution stays unchanged.
Without a supported affirmative oracle, the attempt remains unresolved.
Evidence binds current inputs and
mutation epoch; later corrections invalidate it. Native terminal/browser/file
actions outside OpenFunction are not journaled.

## Pi

`registerPiTools()` and `toolToPi()` preserve native call IDs, signals, results,
and execution receipts. Text/image content survives directly; absent resource
features produce explicit text notices. Unknown failures throw a
verify-before-retry warning with the canonical receipt attached.

The reference extension uses the real SDK and `Type.Unsafe()` for a schema
already checked by the executor. It imports documented package subpaths rather
than source-relative internals. Pi contains no separate durable runtime.

## OpenClaw

The static `defineToolPlugin()` path uses `toOpenclawToolPluginTools()`. Its
metadata is checked with real `openclaw plugins build` and `plugins validate`,
including exact tool names and schema digests.

The mixed `definePluginEntry()` path uses `toOpenclawTools()`. The Siftable plugin
retains its `execufunction` identity and routes SDK tools through a registry and
executor. Credentials remain lazy. Local work tools are registered independently
and use trusted plugin `workConfigPath` (or `OPENFUNCTION_WORK_CONFIG`). Discovery
performs no login, claim, or network work.

Mixed failures retain error blocks and `isError`; static tool-plugin failures
throw. Both retain unknown certainty and receipts. The static CLI validator
requires `defineToolPlugin` metadata and cannot validate the legacy mixed entry;
that path is checked through real SDK types, registration/calls, and exact
manifest parity instead.

## Reproducible host checks

Hermes is pinned to `7cc3fb8cb55898747dd1dfa56fda3e16ebba028e`. Native checks
use OpenClaw `2026.7.1-2` and Pi `0.84.1`, pinned in plugin lockfiles. These are
tested versions, not promises about future releases.

```sh
node test-client/provision-hermes-runtime.mjs --hermes-root /absolute/hermes-agent --runtime-dir /absolute/managed-runtime --data-dir /absolute/provisioning-home --out /absolute/runtime.json
node test-client/run-hermes-tests.mjs --hermes-root /absolute/hermes-agent --python /absolute/managed-python --runtime-dir /absolute/managed-runtime --mode work
npm run test:hosts
```

Provisioning uses Hermes's official package manager and isolated paths. The
driver exercises ordinary MCP, a pinned local Git portable install while disabled,
explicit enablement, skill/tool discovery, approval/refusal, and profile isolation.
Its deterministic model endpoint is local and spends no model credits.

The work lane uses the installed tarball and real grant CLI. It checks renewal
during a step longer than the lease, lost model delivery after a durable result,
actual process death/restart, exact result recovery without repeat effects,
fresh verification/completion, revocation, stale-subject refusal, and crashes
between effect and receipt with both supported and unsupported readback. Logs
record exact package/host/runtime versions and
the tested loss boundary. Missing setup is an explicit failure or unproven boundary,
never a successful silent skip. Cold CI may use `--install-mode online` to acquire
tarball dependencies; tool/model traffic remains local.
