/** Current OpenClaw tool-only plugin reference for openFunctions. */

import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { toOpenclawToolPluginTools } from "openfunction/framework/openclaw";
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
        parameters: Type.Unsafe(requireSchema(definition.parameters)),
        ...(definition.optional ? { optional: true } : {}),
        execute: (params, config, context) =>
          definition.execute(params, config, context),
      }),
    ),
});

function requireSchema(schema: unknown): object {
  if (!schema || typeof schema !== "object") throw new Error("Invalid tool schema");
  return schema;
}
