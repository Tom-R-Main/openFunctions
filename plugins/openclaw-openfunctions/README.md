# @openfunctions/openclaw-openfunctions

Reference openclaw plugin showing how to expose **openFunctions** `defineTool()`
definitions to OpenClaw via the current `defineToolPlugin` and generated
manifest contract.

## What it does

- Builds a small registry with two openFunctions-defined tools (`of_calculate`,
  `of_convert_units`) using the framework's `defineTool()`.
- Calls `toOpenclawToolPluginTools(registry)` to convert each definition into
  OpenClaw's current tool-plugin shape.
- Ships compiled ESM and uses `openclaw plugins build` to keep
  `contracts.tools` synchronized before publishing.

## What it does NOT claim

- This is a reference / demo, not a production-grade plugin.
- It currently uses a relative import (`../../../src/framework/openclaw.js`)
  to the colocated openFunctions framework. It runs from inside the
  openFunctions monorepo. To package for standalone publication, either
  bundle the framework, depend on a published `openfunction` framework export
  (not yet on npm), or inline `toOpenclawTools`.
- Marked `"private": true` in `package.json` to prevent accidental publish.

## Where the bridge lives

- `src/framework/openclaw.ts` in the openFunctions repo.
- Current surface: `toOpenclawToolPluginTools(registry, options?)`.
- Compatibility surface for mixed/dynamic plugins: `toOpenclawTools()` and
  `toolToOpenclaw()`.

## When you'd write this plugin yourself

If you have an existing `ToolRegistry` of openFunctions tools and want
them callable from openclaw — for example, your team's MCP tools — you
write three lines inside an openclaw plugin:

```ts
import { toOpenclawToolPluginTools } from "openfunction/framework"; // when published
import { registry } from "./your-tools.js";

const definitions = toOpenclawToolPluginTools(registry);
// Pass each definition through defineToolPlugin's `tool()` factory.
```

Build and validate against the pinned current host:

```bash
npm install
npm run validate
```
