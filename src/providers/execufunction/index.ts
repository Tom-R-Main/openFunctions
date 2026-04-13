/**
 * ExecuFunction Context Provider for Open Functions
 *
 * The reference implementation of the ContextProvider interface.
 * Connects ExecuFunction's cloud API (tasks, calendar, knowledge,
 * projects, CRM, codebase) to the Open Functions agent runtime.
 *
 * @example
 * ```ts
 * import { registry, connectProvider, contextPrompt, defineAgent } from "./framework/index.js";
 * import { createExecuFunctionProvider } from "./providers/execufunction/index.js";
 *
 * const exf = await connectProvider(
 *   createExecuFunctionProvider({ token: process.env.EXF_PAT }),
 *   registry,
 * );
 *
 * // Agent gets 17 ExecuFunction tools + context injection
 * const agent = defineAgent({
 *   name: "assistant",
 *   role: "Personal productivity assistant",
 *   goal: "Help the user manage tasks and schedule",
 *   toolTags: ["context"],
 * });
 * ```
 */

import type { ContextProvider, ConnectedProvider, ContextProviderMetadata } from "../../framework/context.js";
import type { ToolDefinition } from "../../framework/types.js";
import { ExfClient } from "./client.js";
import {
  createTaskTools,
  createCalendarTools,
  createKnowledgeTools,
  createProjectTools,
  createPeopleTools,
  createCodebaseTools,
} from "./tools.js";

// ─── Options ────────────────────────────────────────────────────────────────

export interface ExecuFunctionProviderOptions {
  /** ExecuFunction API base URL (default: https://execufunction.com) */
  apiUrl?: string;
  /** Personal Access Token. Falls back to EXF_PAT env var. */
  token?: string;
  /** Workspace ID for multi-workspace accounts */
  workspaceId?: string;
}

// ─── Metadata ───────────────────────────────────────────────────────────────

const METADATA: ContextProviderMetadata = {
  id: "execufunction",
  name: "ExecuFunction",
  description:
    "Tasks, projects, calendar, knowledge, CRM, and codebase — " +
    "structured cloud context for AI agents",
  capabilities: [
    "tasks",
    "projects",
    "calendar",
    "knowledge",
    "people",
    "organizations",
    "codebase",
  ],
  auth: {
    kind: "pat",
    envVar: "EXF_PAT",
    setupUrl: "https://execufunction.com/settings/tokens",
    instructions: "Run 'exf auth login' or set EXF_PAT in your environment",
  },
};

// ─── Provider Factory ───────────────────────────────────────────────────────

/**
 * Create an ExecuFunction context provider.
 *
 * ```ts
 * const provider = createExecuFunctionProvider({ token: "exf_pat_..." });
 * const exf = await connectProvider(provider, registry);
 * ```
 */
export function createExecuFunctionProvider(
  options?: ExecuFunctionProviderOptions,
): ContextProvider {
  return {
    metadata: METADATA,

    async connect(): Promise<ConnectedProvider> {
      const token = options?.token ?? process.env.EXF_PAT;
      if (!token) {
        throw new Error(
          "ExecuFunction requires a Personal Access Token.\n" +
            "Set EXF_PAT in your environment, or pass { token: '...' } to createExecuFunctionProvider().\n" +
            "Generate a token at https://execufunction.com/settings/tokens",
        );
      }

      const client = new ExfClient({
        apiUrl: options?.apiUrl ?? process.env.EXF_API_URL,
        token,
        workspaceId: options?.workspaceId ?? process.env.EXF_WORKSPACE_ID,
      });

      return {
        metadata: METADATA,

        createTools(): ToolDefinition<any, any>[] {
          return [
            ...createTaskTools(client),
            ...createCalendarTools(client),
            ...createKnowledgeTools(client),
            ...createProjectTools(client),
            ...createPeopleTools(client),
            ...createCodebaseTools(client),
          ];
        },

        async buildContext(): Promise<string | undefined> {
          const sections: string[] = [];

          // Fetch active tasks
          try {
            const { tasks } = await client.listTasks({ status: "in_progress", limit: 10 });
            if (tasks.length > 0) {
              const lines = tasks.map((t) => {
                const priority = t.priority ? `[${t.priority}]` : "";
                const project = t.projectName ? ` — ${t.projectName}` : "";
                return `- ${priority} ${t.title}${project}`.trim();
              });
              sections.push(`### Active Tasks (${tasks.length})\n${lines.join("\n")}`);
            }
          } catch {
            // Context is best-effort — don't fail the prompt
          }

          // Fetch upcoming events (next 24 hours)
          try {
            const now = new Date();
            const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
            const startDate = now.toISOString().split("T")[0];
            const endDate = tomorrow.toISOString().split("T")[0];
            const { events } = await client.listEvents({ startDate, endDate, limit: 5 });
            if (events.length > 0) {
              const lines = events.map((e) => {
                const time = e.startTime
                  ? new Date(e.startTime as string).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                  : "All day";
                return `- ${time} — ${e.title}`;
              });
              sections.push(`### Upcoming Events\n${lines.join("\n")}`);
            }
          } catch {
            // Best-effort
          }

          // Fetch active projects
          try {
            const { projects } = await client.listProjects({ status: "active" });
            if (projects.length > 0) {
              const lines = projects.map((p) => `- ${p.name}${p.summary ? `: ${p.summary}` : ""}`);
              sections.push(`### Active Projects (${projects.length})\n${lines.join("\n")}`);
            }
          } catch {
            // Best-effort
          }

          if (sections.length === 0) return undefined;

          return `## Your Current Context (via ExecuFunction)\n\n${sections.join("\n\n")}`;
        },

        async healthCheck() {
          try {
            await client.checkAuth();
            return { ok: true };
          } catch (error) {
            const message = error instanceof Error ? error.message : "unknown error";
            return { ok: false, error: message };
          }
        },

        async disconnect() {
          // ExfClient uses stateless HTTP — nothing to clean up
        },
      };
    },
  };
}
