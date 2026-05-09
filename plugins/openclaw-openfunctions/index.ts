/**
 * Reference openclaw plugin: openFunctions tools via toOpenclawTools.
 *
 * Demonstrates the openFunctions → openclaw bridge. Builds a small
 * sample registry of openFunctions-defined tools and routes every
 * tool through `toOpenclawTools` to convert them into openclaw's
 * `AnyAgentTool` shape, then registers each via `api.registerTool`.
 *
 * NOTE on packaging: this plugin currently uses a relative import to
 * the colocated openFunctions framework (`../../src/framework/...`).
 * It is intended to run from inside the openFunctions monorepo. To
 * publish as a standalone npm package, you would either:
 *   - bundle the framework into the plugin, or
 *   - depend on a published `@openfunctions/framework` (not yet on
 *     npm), or
 *   - inline the small `toOpenclawTools` function.
 *
 * The bridge itself (src/framework/openclaw.ts) is dependency-free
 * apart from the framework's own ToolRegistry/types — it's a thin
 * adapter, not a runtime layer.
 */

import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { toOpenclawTools } from "../../src/framework/openclaw.js";
import { buildSampleRegistry } from "./src/registry.js";

export default definePluginEntry({
  id: "openfunctions-demo",
  name: "openFunctions Demo",
  description:
    "Reference plugin showing how to expose openFunctions defineTool() definitions to openclaw via the toOpenclawTools bridge.",
  // `api` is typed by openclaw's plugin SDK at runtime (the openclaw
  // process resolves it). When typechecking from outside the openclaw
  // monorepo with no SDK installed, fall back to `any` rather than
  // failing strict-mode tsc.
  register(api: any) {
    const registry = buildSampleRegistry();
    for (const tool of toOpenclawTools(registry)) {
      api.registerTool(tool as AnyAgentTool);
    }
  },
});
