# Siftable integration contract

OpenFunction treats Siftable as a shared, evidence-backed work graph, not a
bundle of unrelated productivity APIs. Human planning tasks and executable
agent work have distinct lifecycles over connected projects, knowledge,
relationships, code, datasets, authority, and proof.

## Current sources of truth

The embedded adapter uses exact development SDK `1.5.1`, inspected against its
published package on 2026-10-12. Hosted MCP and the local controller have separate
availability and recovery contracts:

| Surface | Current version/state | Adapter rule |
|---|---|---|
| MCP SDK | `@siftable/mcp-server` 1.5.1 | Derive schemas, feature gates, transport containment, and execution from `TOOLS`, `isToolEnabled()`, `isToolAllowedForTransport()`, and `executeTool()`; exclude hosted sessions from the embedded path |
| Ordinary CLI | `@siftable/cli` 0.5.40 | Treat as the human/operator surface; do not infer MCP parity from command parity |
| Interactive TUI | Separate CLI runtime | Do not treat it as an MCP transport |
| Standalone CLI repository | Distribution mirror | The monorepo package is canonical for implementation state |

The MCP factory also contributes the transport-owned synthetic
`find_capability` tool. It is deliberately not copied into this embedded
adapter because its implementation and catalog fingerprint belong to the MCP
server transport. The SDK-backed `capability_list`, `capability_describe`, and
`capability_execute` tools remain available.

Dataset and ontology tools are declared by the SDK but feature-gated. They are
exposed automatically when the corresponding Siftable server flags are active;
`includeDisabledCapabilities` is intended for catalog inspection, not for
pretending an unavailable capability can execute.

## Authentication boundaries

The ordinary CLI accepts `SIFT_TOKEN`, legacy `EXF_TOKEN`, or a credential saved
by `sift auth login`. MCP configuration commonly uses `SIFT_PAT`. Embedded
OpenFunction and OpenClaw processes do not read the CLI credential store; they
resolve an explicit token, `SIFT_TOKEN`, `SIFT_PAT`, `EXF_TOKEN`, then `EXF_PAT`.
This keeps credential storage private while supporting both current public
conventions.

Useful CLI probes:

```bash
sift auth status --json
sift context current --json
sift capabilities --json
sift commands --json
sift doctor --json
```

Use `sift tasks` for human planning and `sift work` for executable agent work.
Claims, leases, dependencies, authority, verification evidence, and completion
gates are execution semantics and must not be flattened into task status.

## Hosted MCP and durable-work availability

`createSiftableMcpProvider()` uses the existing authenticated
`https://siftable.io/api/v1/mcp` boundary through the generic MCP provider. Trusted
host callbacks supply credentials. Authenticated `context_current` binds the
principal/workspace/project; model parameters cannot substitute another scope.
The default profile exposes only context and work reads. Session tools are
always excluded from the model-facing catalog, including explicit allowlists.
Their availability in the authenticated upstream catalog remains inspectable.
Evidence is disabled by default; enabling it requires an explicit host
`evidenceExecution` policy and trusted identity resolver. The governed executor
requires a validated grant and the matching supported user scope before
dispatch. A null project is not permission to guess one.

The embedded SDK wrapper has neither a hosted principal nor session store, so
`work_session_*` tools are unavailable there. An SDK upgrade does not create
those bindings. Local durable work works independently without Siftable.

The hosted bounded backend currently refuses construction before any claim.
The inspected 1.5.1 package does not establish the contracts needed for its
automatic recovery:

- No supported public export supplies the canonical work-contract parser. The
  internal parser behind the export map is not a supported API.
- Session open/transition/close accept keys, but public API key scope,
  retention, and authoritative operation receipt lookup are not established.
- Evidence submission generates a new transport key per SDK invocation.
  Stable attempt IDs alone do not establish server deduplication or conflicting
  payload rejection.
- Closed-session replay compares action/key without validating a changed
  payload, despite the receipt's stronger advertised duplicate behavior.

`test-client/fixtures/siftable-work-recovery-1.5.1.json` records package integrity,
inspected source locations, exact fields, and unsupported or unproven recovery
entries. Fixtures must not invent stronger guarantees. Missing receipt lookup
is not proof of non-execution; uncertain evidence submission must not rerun its
verification command. These blockers apply to hosted durable work. Ordinary
embedded domains and authenticated MCP calls remain usable. Real hosted
interoperability and queue mutations need their own evidence and authorization.

## Embedded result projection

SDK `executeTool()` emits a structured value, while discovery advertises a
canonical `sift.action_receipt` wrapper. The embedded projection advertises the
supported raw value schema and keeps the full upstream receipt schema and
projection explanation in discovery metadata. It preserves schema IDs,
idempotency dispositions, omissions, and warnings across incremental callbacks.
Unsupported extraction is explicit rather than advertising an unavailable shape.

Hosted MCP retains the full upstream structured payload and schema unchanged.
Executor receipts remain separate metadata. Validated canonical pre-handler
rejection may establish no dispatch; generic failed receipts and post-dispatch
transport errors preserve unknown certainty. Error-text prefixes alone cannot
establish that a write failed.

## Drift prevention

- The provider parity test compares its canonical tool names to the installed
  MCP SDK at test time.
- OpenClaw's `npm run sync-contract` generates `contracts.tools` from that SDK;
  `npm run verify` then compares the generated manifest with runtime
  registration.
- `npm run verify:typescript` proves native TypeScript 7 output remains runtime
  compatible with the TypeScript 6 compiler/programmatic-API lane.
- Legacy `exf_*` aliases are opt-in through `includeLegacyAliases`; new callers
  should use canonical MCP names.
