# @openfunctions/openclaw-openfunctions

Reference openclaw plugin showing how to expose **openFunctions** `defineTool()`
definitions to openclaw via the `toOpenclawTools` bridge.

## What it does

- Builds a small registry with two openFunctions-defined tools (`of_calculate`,
  `of_convert_units`) using the framework's `defineTool()`.
- Calls `toOpenclawTools(registry)` to convert each `ToolDefinition` into
  the shape openclaw's `api.registerTool()` accepts.
- Registers them in a normal openclaw plugin entry.

## What it does NOT claim

- This is a reference / demo, not a production-grade plugin.
- It currently uses a relative import (`../../src/framework/openclaw.js`)
  to the colocated openFunctions framework. It runs from inside the
  openFunctions monorepo. To package for standalone publication, either
  bundle the framework, depend on a published `@openfunctions/framework`
  (not yet on npm), or inline `toOpenclawTools`.
- Marked `"private": true` in `package.json` to prevent accidental publish.

## Where the bridge lives

- `src/framework/openclaw.ts` in the openFunctions repo.
- Public surface: `toOpenclawTools(registry, options?)` and
  `toolToOpenclaw(tool, registry, options?)`.
- 8 regression tests in `test-client/run-framework-tests.ts`.

## When you'd write this plugin yourself

If you have an existing `ToolRegistry` of openFunctions tools and want
them callable from openclaw — for example, your team's MCP tools — you
write three lines inside an openclaw plugin:

```ts
import { toOpenclawTools } from "@openfunctions/framework/openclaw"; // when published
import { registry } from "./your-tools.js";

for (const tool of toOpenclawTools(registry)) api.registerTool(tool);
```
