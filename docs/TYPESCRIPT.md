# TypeScript 7 and TypeScript 6

OpenFunction uses the same dual-compiler boundary as Siftable:

| Responsibility | Command or import | Version |
| --- | --- | --- |
| Typechecking and emitted builds | `tsc` | TypeScript 7.0.2 |
| Compatibility typecheck/build | `tsc6` | TypeScript 6.0.3 |
| JavaScript compiler API | `import ts from "typescript"` or `require("typescript")` | TypeScript 6.0.3 |

The package layout is intentional:

- `@typescript/native` aliases `typescript@7.0.2` and owns the `tsc` binary.
- `typescript` aliases `@typescript/typescript6@6.0.2`. That compatibility
  wrapper owns `tsc6` and exposes the stable TypeScript 6.0.3 JavaScript API.
- The root override pins the wrapper's `@typescript/old` dependency to exactly
  `typescript@6.0.3`.

TypeScript 7 is therefore the ordinary developer path:

```bash
npm run typecheck
npm run build
```

Use TypeScript 6 only to diagnose a compatibility difference or when code must
load the compiler as a JavaScript library:

```bash
npm run typecheck:ts6
npm run build:ts6
```

Do not change an ordinary build script to `tsc6` merely because the
`typescript` package resolves to the compatibility wrapper. `tsc` is the
authoritative compiler; `typescript` is the programmatic API boundary.

## Verification

```bash
npm run verify:typescript
```

The gate checks all four identities, runs a real `transpileModule()` operation
through the TypeScript 6 API, emits the project with both compilers into
isolated temporary directories, and verifies:

- identical artifact sets;
- byte-identical runtime JavaScript; and
- semantically equivalent declarations after normalizing union-member order.

The gate reports artifact counts for the actual tree. Do not reuse a historical
count as evidence for a changed build.

## Compiled package boundaries

`tsconfig.build.json` emits distributable source under `dist/src`, excluding
test-client and development bridges. The preparation script copies prompt
presets to `dist/system-prompts` and marks `dist/src/cli.js` executable.
`package.json` advertises explicit JavaScript/declaration subpaths; undocumented
internal paths are not public exports.

The package root re-exports the side-effect-free framework. Source workshop
startup moved to `src/workshop.ts`; `npm start`, `dev`, and inspector scripts
retain that beginner workflow. The compiled CLI separately supports exported
MCP registries and opt-in work profiles.

`npm run test:package` builds/packs and installs a fresh consumer, resolves all
exports and declarations, exercises presets/CLI/read-only installation, and
checks that root/core/framework imports need no Siftable or pg peer, load no
`.env`, register no tools, and create no data files. Host SDKs stay in plugin
dependencies. This test proves an installed package boundary, beyond a linked
source import.

This is a compiler feedback and tooling-compatibility improvement. TypeScript
types are erased, so it is not a runtime performance optimization.
