# Siftable integration contract

OpenFunction treats Siftable as a shared, evidence-backed work graph, not a
bundle of unrelated productivity APIs. Human planning tasks and executable
agent work have distinct lifecycles over connected projects, knowledge,
relationships, code, datasets, authority, and proof.

## Current sources of truth

This integration was reconciled against the ExecuFunction monorepo and the
published packages on 2026-08-13:

| Surface | Current version/state | Adapter rule |
|---|---|---|
| MCP SDK | `@siftable/mcp-server` 1.2.27; 136 declared tools, 114 enabled by default | Derive schemas, feature gates, transport containment, and execution from `TOOLS`, `isToolEnabled()`, `isToolAllowedForTransport()`, and `executeTool()` |
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
