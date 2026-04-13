import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam, readNumberParam } from "openclaw/plugin-sdk/provider-web-search";
import type { ExfClient } from "../client.js";

const ListTasksSchema = Type.Object(
  {
    projectId: Type.Optional(Type.String({ description: "Filter by project ID." })),
    status: Type.Optional(
      Type.String({
        description: 'Filter by status: "pending", "in_progress", or "completed".',
      }),
    ),
    limit: Type.Optional(
      Type.Number({ description: "Max tasks to return (default 20).", minimum: 1, maximum: 100 }),
    ),
  },
  { additionalProperties: false },
);

const CreateTaskSchema = Type.Object(
  {
    title: Type.String({ description: "Task title." }),
    description: Type.Optional(Type.String({ description: "Detailed description of the task." })),
    priority: Type.Optional(
      Type.String({
        description:
          'Priority level: "do_now", "do_next", "do_later", "delegate", or "drop".',
      }),
    ),
    projectId: Type.Optional(Type.String({ description: "Project to assign this task to." })),
    dueAt: Type.Optional(Type.String({ description: "Due date in ISO 8601 format." })),
    acceptanceCriteria: Type.Optional(
      Type.String({
        description: "Semicolon-separated acceptance criteria, e.g. 'criterion 1; criterion 2'.",
      }),
    ),
  },
  { additionalProperties: false },
);

const UpdateTaskSchema = Type.Object(
  {
    taskId: Type.String({ description: "ID of the task to update." }),
    title: Type.Optional(Type.String({ description: "New title." })),
    description: Type.Optional(Type.String({ description: "New description." })),
    priority: Type.Optional(Type.String({ description: "New priority." })),
    status: Type.Optional(Type.String({ description: "New status." })),
    dueAt: Type.Optional(Type.String({ description: "New due date in ISO 8601 format." })),
  },
  { additionalProperties: false },
);

const CompleteTaskSchema = Type.Object(
  {
    taskId: Type.String({ description: "ID of the task to complete." }),
    completionNotes: Type.Optional(
      Type.String({ description: "Notes about how the task was completed." }),
    ),
  },
  { additionalProperties: false },
);

export function registerTaskTools(client: ExfClient) {
  return [
    {
      name: "exf_tasks_list",
      label: "ExecuFunction: List Tasks",
      description:
        "List tasks from ExecuFunction. Filter by project, status, or limit. " +
        "Returns task titles, priorities, statuses, and due dates.",
      parameters: ListTasksSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const projectId = readStringParam(rawParams, "projectId");
        const status = readStringParam(rawParams, "status");
        const limit = readNumberParam(rawParams, "limit", { integer: true });
        return jsonResult(await client.listTasks({ projectId, status, limit }));
      },
    },
    {
      name: "exf_tasks_create",
      label: "ExecuFunction: Create Task",
      description:
        "Create a new task in ExecuFunction. Supports title, description, priority " +
        "(do_now/do_next/do_later/delegate/drop), project assignment, due dates, " +
        "and acceptance criteria.",
      parameters: CreateTaskSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const title = readStringParam(rawParams, "title", { required: true });
        const description = readStringParam(rawParams, "description");
        const priority = readStringParam(rawParams, "priority");
        const projectId = readStringParam(rawParams, "projectId");
        const dueAt = readStringParam(rawParams, "dueAt");
        const acceptanceCriteria = readStringParam(rawParams, "acceptanceCriteria");
        return jsonResult(
          await client.createTask({ title, description, priority, projectId, dueAt, acceptanceCriteria }),
        );
      },
    },
    {
      name: "exf_tasks_update",
      label: "ExecuFunction: Update Task",
      description: "Update an existing task's title, description, priority, status, or due date.",
      parameters: UpdateTaskSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const taskId = readStringParam(rawParams, "taskId", { required: true });
        const updates: Record<string, unknown> = {};
        for (const key of ["title", "description", "priority", "status", "dueAt"]) {
          const val = readStringParam(rawParams, key);
          if (val) updates[key] = val;
        }
        return jsonResult(await client.updateTask(taskId, updates));
      },
    },
    {
      name: "exf_tasks_complete",
      label: "ExecuFunction: Complete Task",
      description: "Mark a task as completed, optionally with completion notes.",
      parameters: CompleteTaskSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const taskId = readStringParam(rawParams, "taskId", { required: true });
        const completionNotes = readStringParam(rawParams, "completionNotes");
        return jsonResult(await client.completeTask(taskId, completionNotes));
      },
    },
  ];
}
