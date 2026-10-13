/** Reference Pi extension consuming the packaged OpenFunction bridge. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toPiTools } from "openfunction/framework/pi";
import { buildSampleRegistry } from "./registry.js";

export default function openFunctionsExtension(pi: ExtensionAPI): void {
  const definitions = toPiTools(buildSampleRegistry(), {
    promptSnippet: () => "Calculate values or convert common units",
    promptGuidelines: (tool) => [`Use ${tool.name} when its calculation or conversion matches the request.`],
  });
  for (const definition of definitions) {
    if (!definition.parameters || typeof definition.parameters !== "object") throw new Error(`Invalid schema for ${definition.name}`);
    // The actual pinned SDK checks content, callbacks and execution context.
    pi.registerTool({ ...definition, parameters: Type.Unsafe(definition.parameters) });
  }
}
