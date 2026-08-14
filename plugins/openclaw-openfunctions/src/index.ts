/** Current OpenClaw tool-only plugin reference for openFunctions. */

import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import type { TSchema } from "typebox";
import { toOpenclawToolPluginTools } from "../../../src/framework/openclaw.js";
import { buildSampleRegistry } from "./registry.js";

const definitions = toOpenclawToolPluginTools(buildSampleRegistry());

export default defineToolPlugin({
  id: "openfunctions-demo",
  name: "openFunctions Demo",
  description:
    "Reference plugin exposing openFunctions defineTool() definitions through OpenClaw's generated tool-plugin contract.",
  tools: (tool) =>
    definitions.map((definition) =>
      tool({
        name: definition.name,
        label: definition.label,
        description: definition.description,
        parameters: definition.parameters as TSchema,
        ...(definition.optional ? { optional: true } : {}),
        execute: (params, config, context) =>
          definition.execute(params, config, context),
      }),
    ),
});
