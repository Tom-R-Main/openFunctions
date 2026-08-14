import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/provider-web-search";
import { TOOLS, executeTool, isToolEnabled } from "@siftable/mcp-server";
import { isToolAllowedForTransport } from "@siftable/mcp-server/factory";
import { ExfClient } from "./src/client.js";

type SiftableSdkTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: { title?: string };
};

const SIFTABLE_DESCRIPTION =
  "Siftable is a shared, evidence-backed work graph. Human planning and executable " +
  "agent work stay distinct while projects, knowledge, relationships, datasets, " +
  "governed actions, and verification remain connected.";

function executionFailure(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.startsWith("Error:") ? trimmed.slice("Error:".length).trim() : undefined;
}

export default definePluginEntry({
  id: "execufunction",
  name: "Siftable",
  description: SIFTABLE_DESCRIPTION,
  register(api) {
    // Defer client construction until a tool is actually called.
    // This allows the plugin to load even before the user sets EXF_PAT.
    let cachedClient: ExfClient | undefined;

    const clientProxy = new Proxy({} as ExfClient, {
      get(_target, prop, receiver) {
        if (!cachedClient) {
          cachedClient = new ExfClient(api.config);
        }
        const value = Reflect.get(cachedClient, prop, receiver);
        return typeof value === "function" ? value.bind(cachedClient) : value;
      },
    });

    const tools = TOOLS as unknown as readonly SiftableSdkTool[];
    for (const definition of tools) {
      if (!isToolEnabled(definition.name)) continue;
      if (!isToolAllowedForTransport(definition.name, "hosted_remote")) continue;

      api.registerTool({
        name: definition.name,
        label: definition.annotations?.title ?? `Siftable: ${definition.name}`,
        description: definition.description,
        parameters: definition.inputSchema,
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          const text = await executeTool(clientProxy.raw(), definition.name, params, {
            transportProfile: "hosted_remote",
          });
          const failure = executionFailure(text);
          if (failure) throw new Error(failure);
          return jsonResult(text);
        },
      } as AnyAgentTool);
    }
  },
});
