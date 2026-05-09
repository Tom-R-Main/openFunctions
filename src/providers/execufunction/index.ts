/**
 * Siftable Context Provider for openFunctions
 *
 * Reference implementation of the ContextProvider interface, built on
 * the published @siftable/mcp-server SDK. Connects Siftable's cloud
 * API (tasks, calendar, knowledge, projects, CRM, codebase) to the
 * openFunctions agent runtime.
 *
 * Auth resolution order:
 *   1. Explicit { token, apiUrl, workspaceId } passed to the factory
 *   2. SIFT_PAT / SIFT_API_URL / SIFT_WORKSPACE_ID (current branding)
 *   3. EXF_PAT / EXF_API_URL / EXF_WORKSPACE_ID (legacy fallback)
 *
 * @example
 * ```ts
 * import { registry, connectProvider, defineAgent } from "./framework/index.js";
 * import { createSiftableProvider } from "./providers/execufunction/index.js";
 *
 * const sift = await connectProvider(createSiftableProvider(), registry);
 *
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

export interface SiftableProviderOptions {
  /** Siftable API base URL (default: https://execufunction.com) */
  apiUrl?: string;
  /** Personal Access Token. Falls back to SIFT_PAT, then EXF_PAT. */
  token?: string;
  /** Workspace ID for multi-workspace accounts */
  workspaceId?: string;
}

/** @deprecated Use SiftableProviderOptions. Kept for back-compat. */
export type ExecuFunctionProviderOptions = SiftableProviderOptions;

// ─── Metadata ───────────────────────────────────────────────────────────────

const METADATA: ContextProviderMetadata = {
  id: "siftable",
  name: "Siftable",
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
    envVar: "SIFT_PAT",
    setupUrl: "https://execufunction.com/settings/tokens",
    instructions:
      "Run 'sift auth login' (or set SIFT_PAT). Legacy EXF_PAT also works.",
  },
};

// ─── Provider Factory ───────────────────────────────────────────────────────

/**
 * Create a Siftable context provider, backed by @siftable/mcp-server.
 *
 * ```ts
 * const provider = createSiftableProvider({ token: "sift_pat_..." });
 * const sift = await connectProvider(provider, registry);
 * ```
 */
export function createSiftableProvider(
  options?: SiftableProviderOptions,
): ContextProvider {
  return {
    metadata: METADATA,

    async connect(): Promise<ConnectedProvider> {
      // Resolve auth in order: explicit option → SIFT_* env → EXF_* env.
      const token =
        options?.token ?? process.env.SIFT_PAT ?? process.env.EXF_PAT;
      if (!token) {
        throw new Error(
          "Siftable requires a Personal Access Token.\n" +
            "Set SIFT_PAT (or legacy EXF_PAT) in your environment, or pass { token: '...' }.\n" +
            "Generate a token at https://execufunction.com/settings/tokens",
        );
      }

      const client = new ExfClient({
        apiUrl:
          options?.apiUrl ?? process.env.SIFT_API_URL ?? process.env.EXF_API_URL,
        token,
        workspaceId:
          options?.workspaceId ??
          process.env.SIFT_WORKSPACE_ID ??
          process.env.EXF_WORKSPACE_ID,
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

          // Fetch upcoming events (next 24 hours).
          // Use the client's local TZ for the date filter so a user in
          // PDT at 8pm doesn't see an empty calendar (UTC is already
          // tomorrow). The Timezone header on the API call is set to
          // the same TZ — keep them aligned.
          try {
            const now = new Date();
            const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
            const startDate = client.localDate(now);
            const endDate = client.localDate(tomorrow);
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

          return `## Your Current Context (via Siftable)\n\n${sections.join("\n\n")}`;
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
          // SiftClient uses stateless HTTP — nothing to clean up
        },
      };
    },
  };
}

/**
 * @deprecated Use createSiftableProvider — same factory under the new
 *   brand. Kept so existing callers keep working without code churn.
 */
export const createExecuFunctionProvider = createSiftableProvider;
