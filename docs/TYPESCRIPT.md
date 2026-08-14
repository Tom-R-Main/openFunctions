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

The verified tree currently produces 106 artifacts with byte-identical runtime
JavaScript. Four declarations differed only in union-member ordering.

This is a compiler feedback and tooling-compatibility improvement. TypeScript
types are erased, so it is not a runtime performance optimization.
