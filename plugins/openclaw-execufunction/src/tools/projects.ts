import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import type { ExfClient } from "../client.js";

const ListProjectsSchema = Type.Object(
  {
    status: Type.Optional(
      Type.String({
        description:
          'Filter by status: "planning", "active", "on_hold", "blocked", "completed", or "archived".',
      }),
    ),
  },
  { additionalProperties: false },
);

const ProjectContextSchema = Type.Object(
  {
    projectId: Type.String({
      description: "Project ID to get full context for.",
    }),
  },
  { additionalProperties: false },
);

export function registerProjectTools(client: ExfClient) {
  return [
    {
      name: "exf_projects_list",
      label: "ExecuFunction: List Projects",
      description:
        "List projects from ExecuFunction. Returns project names, statuses, summaries, and dates.",
      parameters: ListProjectsSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const status = readStringParam(rawParams, "status");
        return jsonResult(await client.listProjects({ status }));
      },
    },
    {
      name: "exf_projects_context",
      label: "ExecuFunction: Project Context",
      description:
        "Get full context for a project: active tasks, recent notes, signals, and status. " +
        "Useful for understanding what's happening in a project before taking action.",
      parameters: ProjectContextSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const projectId = readStringParam(rawParams, "projectId", { required: true });
        return jsonResult(await client.getProjectContext(projectId));
      },
    },
  ];
}
