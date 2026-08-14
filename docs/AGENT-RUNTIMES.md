# Agent runtime integrations

OpenFunction definitions can be exposed through MCP or adapted to a host's
native extension API. The framework keeps all three integrations dependency
free: install a host SDK only in the plugin or extension package that needs it.

## Hermes Agent

Hermes consumes OpenFunction through MCP, its supported boundary for external
tool servers. `createHermesMcpConfig()` builds the `mcp_servers` fragment for
`~/.hermes/config.yaml` and snapshots an explicit tool allowlist from the
registry.

```ts
import {
  createHermesMcpConfig,
  registry,
} from "../src/framework/index.js";

const config = createHermesMcpConfig(registry, {
  command: "node",
  args: ["/absolute/path/to/openfunction/dist/src/index.js"],
  timeout: 120,
  connectTimeout: 30,
  supportsParallelToolCalls: true,
  filter: (tool) => tool.tags?.includes("hermes") ?? false,
  resources: false,
  prompts: false,
});
```

Serialize or merge the returned object into YAML, then start a new Hermes
session or run `/reload-mcp`. Prefer an absolute server entrypoint because
Hermes may start the subprocess from a different working directory.

The generated `tools.include` is intentional. Adding a new registry tool later
does not silently grant it to Hermes; regenerate and review the config.

## Pi (`@earendil-works/pi`)

Pi has a native TypeScript extension API. `registerPiTools()` accepts the
small part of `ExtensionAPI` that OpenFunction needs and registers compatible
tool definitions without importing Pi in the framework itself.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerPiTools,
  type PiExtensionApiLike,
} from "openfunction/framework";
import { registry } from "./registry.js";

export default function (pi: ExtensionAPI) {
  registerPiTools(pi as unknown as PiExtensionApiLike, registry, {
    namePrefix: "of_",
    promptSnippet: (tool) => `Use ${tool.name} from OpenFunction`,
  });
}
```

The JSON Schema subset used by `defineTool()` passes through as Pi's
`parameters` schema. Successful calls return text content plus the original
`ToolResult` in `details`. Failed validation or handlers throw because that is
how current Pi sets `isError: true` on a tool result.

See `plugins/pi-openfunctions/` for a loadable local reference extension.

## OpenClaw

Current OpenClaw has two relevant plugin paths:

- `defineToolPlugin()` for a static, tool-only plugin. It exposes metadata that
  `openclaw plugins build` writes to `openclaw.plugin.json` before runtime code
  is loaded. Use `toOpenclawToolPluginTools()` for this path.
- `definePluginEntry()` plus `api.registerTool()` for mixed-capability plugins
  or plugins whose tool names are computed dynamically. Existing
  `toOpenclawTools()` and `toolToOpenclaw()` remain for this path.

```ts
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import type { TSchema } from "typebox";
import { toOpenclawToolPluginTools } from "openfunction/framework";
import { registry } from "./registry.js";

const definitions = toOpenclawToolPluginTools(registry);

export default defineToolPlugin({
  id: "my-openfunctions-tools",
  name: "My OpenFunction tools",
  description: "Expose an OpenFunction registry to OpenClaw.",
  tools: (tool) => definitions.map((definition) => tool({
    ...definition,
    parameters: definition.parameters as TSchema,
  })),
});
```

For distributable plugins, ship compiled ESM, keep `typebox` in runtime
dependencies, declare `openclaw >=2026.5.17` as a peer, and run both:

```bash
openclaw plugins build --entry ./dist/index.js --check
openclaw plugins validate --entry ./dist/index.js
```

`plugins/openclaw-openfunctions/` demonstrates the generated tool-only path.
`plugins/openclaw-execufunction/` uses direct registration because its surface
is projected dynamically from the installed Siftable MCP SDK. Its checked-in
`contracts.tools` list is generated from that same SDK and verified against
runtime registrations, so OpenClaw discovery cannot drift from execution.

## Contract comparison

| Runtime | Boundary | Failure signal | Discovery safeguard |
|---|---|---|---|
| Hermes | MCP stdio | MCP error result | Explicit `tools.include` snapshot |
| Pi | `ExtensionAPI.registerTool()` | Throw from `execute()` | Extension-selected registry filter |
| OpenClaw tool plugin | `defineToolPlugin()` | Throw from `execute()` | Generated `contracts.tools` manifest |
| OpenClaw mixed plugin | `api.registerTool()` | Throw from `execute()` | Generated and runtime-verified manifest contract |
