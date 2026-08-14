/** Reference Pi extension for the dependency-free openFunctions bridge. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerPiTools,
  type PiExtensionApiLike,
} from "../../../src/framework/pi.js";
import { buildSampleRegistry } from "./registry.js";

export default function openFunctionsExtension(pi: ExtensionAPI): void {
  registerPiTools(
    pi as unknown as PiExtensionApiLike,
    buildSampleRegistry(),
    {
      promptSnippet: () => "Calculate values or convert common units",
      promptGuidelines: (tool) => [
        `Use ${tool.name} when its calculation or conversion matches the request.`,
      ],
    },
  );
}
