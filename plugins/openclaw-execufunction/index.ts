import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ToolRegistry } from "openfunction/framework/registry";
import { toOpenclawTools } from "openfunction/framework/openclaw";
import { createSiftableSdkTools } from "openfunction/providers/siftable";
import { ExfClient } from "./src/client.js";
import { buildLocalWorkTools } from "./src/work-tools.js";

const SIFTABLE_DESCRIPTION =
  "Siftable is a shared, evidence-backed work graph. Human planning and executable " +
  "agent work stay distinct while projects, knowledge, relationships, datasets, " +
  "governed actions, and verification remain connected.";

/** Credential-free discovery; the client is touched only inside a dispatched handler. */
export function buildSiftableRegistry(client: Parameters<typeof createSiftableSdkTools>[0]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(createSiftableSdkTools(client, { transportProfile: "hosted_remote" }));
  return registry;
}

export default definePluginEntry({
  id: "execufunction",
  name: "Siftable",
  description: SIFTABLE_DESCRIPTION,
  register(api) {
    let cachedClient: ExfClient | undefined;
    const clientProxy = {
      raw() {
        cachedClient ??= new ExfClient(api.config);
        return cachedClient.raw();
      },
    };
    const registry = buildSiftableRegistry(clientProxy);
    const settings = api.config.plugins?.entries?.execufunction?.config;
    const configPath = settings && typeof settings.workConfigPath === "string"
      ? settings.workConfigPath : process.env.OPENFUNCTION_WORK_CONFIG;
    const work = buildLocalWorkTools(configPath);
    registry.registerAll(work.tools);
    api.registerService({ id: "openfunction-work", start() {}, stop: () => work.shutdown() });
    for (const tool of toOpenclawTools(registry, {
      label: (definition) => definition.annotations?.title ?? `Siftable: ${definition.name}`,
    })) {
      // Mixed plugin registration consumes the real pinned AnyAgentTool
      // contract; no cast hides drift in schemas, content or native signals.
      if (!tool.parameters || typeof tool.parameters !== "object") throw new Error(`Invalid schema for ${tool.name}`);
      api.registerTool({
        ...tool, label: tool.label ?? tool.name, parameters: Type.Unsafe(tool.parameters),
        async execute(toolCallId, params, signal) {
          const result = await tool.execute(toolCallId, params, signal);
          return { ...result, details: result.details ?? {} };
        },
      });
    }
  },
});
