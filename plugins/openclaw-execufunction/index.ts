import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { ExfClient } from "./src/client.js";
import { registerTaskTools } from "./src/tools/tasks.js";
import { registerCalendarTools } from "./src/tools/calendar.js";
import { registerKnowledgeTools } from "./src/tools/knowledge.js";
import { registerProjectTools } from "./src/tools/projects.js";
import { registerPeopleTools } from "./src/tools/people.js";
import { registerCodebaseTools } from "./src/tools/codebase.js";

export default definePluginEntry({
  id: "execufunction",
  name: "ExecuFunction",
  description:
    "Connect your agent to ExecuFunction for tasks, calendar, knowledge, projects, CRM, and codebase tools.",
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

    const toolSets = [
      registerTaskTools,
      registerCalendarTools,
      registerKnowledgeTools,
      registerProjectTools,
      registerPeopleTools,
      registerCodebaseTools,
    ];

    for (const register of toolSets) {
      for (const tool of register(clientProxy)) {
        api.registerTool(tool as AnyAgentTool);
      }
    }
  },
});
