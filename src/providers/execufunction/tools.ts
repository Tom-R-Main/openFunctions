/**
 * ExecuFunction — Tool Definitions
 *
 * Each function returns an array of ToolDefinitions for a capability domain.
 * Tools follow the framework's defineTool() pattern and are tagged for
 * agent filtering.
 */

import type { ToolDefinition } from "../../framework/types.js";
import { defineTool, ok, err } from "../../framework/tool.js";
import type { ExfClient } from "./client.js";

// ─── Tasks ──────────────────────────────────────────────────────────────────

export function createTaskTools(client: ExfClient): ToolDefinition<any, any>[] {
  return [
    defineTool<{ projectId?: string; status?: string; limit?: number }>({
      name: "exf_tasks_list",
      description:
        "List tasks from ExecuFunction. Filter by project, status (pending/in_progress/completed), " +
        "or limit. Returns task titles, priorities, statuses, and due dates.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Filter by project ID" },
          status: { type: "string", description: 'Filter: "pending", "in_progress", or "completed"' },
          limit: { type: "integer", description: "Max tasks to return (default 20)" },
        },
      },
      tags: ["tasks"],
      handler: async (params) => {
        const data = await client.listTasks(params);
        return ok(data, `Found ${data.tasks.length} task(s)`);
      },
    }),

    defineTool<{ title: string; description?: string; priority?: string; projectId?: string; dueAt?: string; acceptanceCriteria?: string }>({
      name: "exf_tasks_create",
      description:
        "Create a new task in ExecuFunction. Supports priority levels: " +
        "do_now, do_next, do_later, delegate, drop. Acceptance criteria are semicolon-separated.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title" },
          description: { type: "string", description: "Task details" },
          priority: { type: "string", description: "Priority: do_now, do_next, do_later, delegate, drop" },
          projectId: { type: "string", description: "Project to assign to" },
          dueAt: { type: "string", description: "Due date (ISO 8601)" },
          acceptanceCriteria: { type: "string", description: 'Semicolon-separated criteria, e.g. "criterion 1; criterion 2"' },
        },
        required: ["title"],
      },
      tags: ["tasks"],
      handler: async (params) => {
        const data = await client.createTask(params);
        return ok(data, `Created task: ${params.title}`);
      },
    }),

    defineTool<{ taskId: string; title?: string; description?: string; priority?: string; status?: string; dueAt?: string }>({
      name: "exf_tasks_update",
      description: "Update an existing task's title, description, priority, status, or due date.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID to update" },
          title: { type: "string", description: "New title" },
          description: { type: "string", description: "New description" },
          priority: { type: "string", description: "New priority" },
          status: { type: "string", description: "New status" },
          dueAt: { type: "string", description: "New due date (ISO 8601)" },
        },
        required: ["taskId"],
      },
      tags: ["tasks"],
      handler: async ({ taskId, ...updates }) => {
        const filtered: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(updates)) {
          if (v !== undefined) filtered[k] = v;
        }
        const data = await client.updateTask(taskId, filtered);
        return ok(data);
      },
    }),

    defineTool<{ taskId: string; completionNotes?: string }>({
      name: "exf_tasks_complete",
      description: "Mark a task as completed, optionally with completion notes.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID to complete" },
          completionNotes: { type: "string", description: "Notes about how the task was completed" },
        },
        required: ["taskId"],
      },
      tags: ["tasks"],
      handler: async ({ taskId, completionNotes }) => {
        const data = await client.completeTask(taskId, completionNotes);
        return ok(data, "Task completed");
      },
    }),
  ];
}

// ─── Calendar ───────────────────────────────────────────────────────────────

export function createCalendarTools(client: ExfClient): ToolDefinition<any, any>[] {
  return [
    defineTool<{ startDate: string; endDate: string; limit?: number }>({
      name: "exf_calendar_list",
      description:
        "List calendar events from ExecuFunction for a date range. " +
        "Returns event titles, times, locations, and descriptions.",
      inputSchema: {
        type: "object",
        properties: {
          startDate: { type: "string", description: "Start date (YYYY-MM-DD)" },
          endDate: { type: "string", description: "End date (YYYY-MM-DD)" },
          limit: { type: "integer", description: "Max events to return" },
        },
        required: ["startDate", "endDate"],
      },
      tags: ["calendar"],
      handler: async (params) => {
        const data = await client.listEvents(params);
        return ok(data, `Found ${data.events.length} event(s)`);
      },
    }),

    defineTool<{ title: string; startTime: string; endTime?: string; description?: string; location?: string; allDay?: boolean }>({
      name: "exf_calendar_create",
      description: "Create a new calendar event in ExecuFunction.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Event title" },
          startTime: { type: "string", description: "Start time (ISO 8601)" },
          endTime: { type: "string", description: "End time (ISO 8601)" },
          description: { type: "string", description: "Event description" },
          location: { type: "string", description: "Event location" },
          allDay: { type: "boolean", description: "Whether this is an all-day event" },
        },
        required: ["title", "startTime"],
      },
      tags: ["calendar"],
      handler: async (params) => {
        const data = await client.createEvent(params);
        return ok(data, `Created event: ${params.title}`);
      },
    }),

    defineTool<{ eventId: string; title?: string; startTime?: string; endTime?: string; description?: string; location?: string }>({
      name: "exf_calendar_update",
      description: "Update an existing calendar event.",
      inputSchema: {
        type: "object",
        properties: {
          eventId: { type: "string", description: "Event ID to update" },
          title: { type: "string", description: "New title" },
          startTime: { type: "string", description: "New start time (ISO 8601)" },
          endTime: { type: "string", description: "New end time (ISO 8601)" },
          description: { type: "string", description: "New description" },
          location: { type: "string", description: "New location" },
        },
        required: ["eventId"],
      },
      tags: ["calendar"],
      handler: async ({ eventId, ...updates }) => {
        const filtered: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(updates)) {
          if (v !== undefined) filtered[k] = v;
        }
        const data = await client.updateEvent(eventId, filtered);
        return ok(data);
      },
    }),
  ];
}

// ─── Knowledge / Notes ──────────────────────────────────────────────────────

export function createKnowledgeTools(client: ExfClient): ToolDefinition<any, any>[] {
  return [
    defineTool<{ query: string; limit?: number }>({
      name: "exf_notes_search",
      description:
        "Semantic search across the ExecuFunction knowledge base. " +
        "Finds notes, decisions, meeting notes, and references by meaning.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (natural language)" },
          limit: { type: "integer", description: "Max notes to return (default 10)" },
        },
        required: ["query"],
      },
      tags: ["knowledge"],
      handler: async ({ query, limit }) => {
        const data = await client.searchNotes(query, limit);
        return ok(data, `Found ${data.notes.length} note(s)`);
      },
    }),

    defineTool<{ title: string; content: string; noteType?: string; projectId?: string; tags?: string[] }>({
      name: "exf_notes_create",
      description:
        "Create a new note in the ExecuFunction knowledge base. " +
        "Supports markdown, note types (note/reference/decision/meeting/journal), and tags.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Note title" },
          content: { type: "string", description: "Note content (markdown)" },
          noteType: { type: "string", description: "Type: note, reference, decision, meeting, journal" },
          projectId: { type: "string", description: "Project to associate with" },
          tags: { type: "array", items: { type: "string" }, description: "Tags for categorization" },
        },
        required: ["title", "content"],
      },
      tags: ["knowledge"],
      handler: async (params) => {
        const data = await client.createNote(params);
        return ok(data, `Created note: ${params.title}`);
      },
    }),

    defineTool<{ noteId: string }>({
      name: "exf_notes_get",
      description: "Retrieve the full content of a specific note by ID.",
      inputSchema: {
        type: "object",
        properties: {
          noteId: { type: "string", description: "Note ID to retrieve" },
        },
        required: ["noteId"],
      },
      tags: ["knowledge"],
      handler: async ({ noteId }) => {
        const data = await client.getNote(noteId);
        return ok(data);
      },
    }),
  ];
}

// ─── Projects ───────────────────────────────────────────────────────────────

export function createProjectTools(client: ExfClient): ToolDefinition<any, any>[] {
  return [
    defineTool<{ status?: string }>({
      name: "exf_projects_list",
      description:
        "List projects from ExecuFunction. Filter by status: " +
        "planning, active, on_hold, blocked, completed, archived.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by status" },
        },
      },
      tags: ["projects"],
      handler: async (params) => {
        const data = await client.listProjects(params);
        return ok(data, `Found ${data.projects.length} project(s)`);
      },
    }),

    defineTool<{ projectId: string }>({
      name: "exf_projects_context",
      description:
        "Get full context for a project: active tasks, recent notes, signals, and status. " +
        "Useful for understanding what's happening before taking action.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project ID" },
        },
        required: ["projectId"],
      },
      tags: ["projects"],
      handler: async ({ projectId }) => {
        const data = await client.getProjectContext(projectId);
        return ok(data);
      },
    }),
  ];
}

// ─── People / CRM ───────────────────────────────────────────────────────────

export function createPeopleTools(client: ExfClient): ToolDefinition<any, any>[] {
  return [
    defineTool<{ search: string }>({
      name: "exf_people_search",
      description: "Search contacts in ExecuFunction CRM by name, role, or organization.",
      inputSchema: {
        type: "object",
        properties: {
          search: { type: "string", description: "Search query" },
        },
        required: ["search"],
      },
      tags: ["people"],
      handler: async ({ search }) => {
        const data = await client.searchPeople(search);
        return ok(data, `Found ${data.people.length} contact(s)`);
      },
    }),

    defineTool<{ name: string; email?: string; phone?: string; relationship?: string; organizationId?: string; notes?: string }>({
      name: "exf_person_create",
      description: "Create a new contact in ExecuFunction CRM.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Full name" },
          email: { type: "string", description: "Email address" },
          phone: { type: "string", description: "Phone number" },
          relationship: { type: "string", description: 'Relationship: friend, colleague, contact, client, etc.' },
          organizationId: { type: "string", description: "Organization to associate with" },
          notes: { type: "string", description: "Notes about this person" },
        },
        required: ["name"],
      },
      tags: ["people"],
      handler: async (params) => {
        const data = await client.createPerson(params);
        return ok(data, `Created contact: ${params.name}`);
      },
    }),

    defineTool<{ search: string }>({
      name: "exf_org_search",
      description: "Search organizations in ExecuFunction CRM by name or domain.",
      inputSchema: {
        type: "object",
        properties: {
          search: { type: "string", description: "Search query" },
        },
        required: ["search"],
      },
      tags: ["organizations"],
      handler: async ({ search }) => {
        const data = await client.searchOrganizations(search);
        return ok(data, `Found ${data.organizations.length} organization(s)`);
      },
    }),
  ];
}

// ─── Codebase ───────────────────────────────────────────────────────────────

export function createCodebaseTools(client: ExfClient): ToolDefinition<any, any>[] {
  return [
    defineTool<{ query: string; repositoryId?: string }>({
      name: "exf_codebase_search",
      description:
        "Semantic search across indexed codebases in ExecuFunction. " +
        "Finds relevant code snippets, files, and functions by meaning.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (natural language)" },
          repositoryId: { type: "string", description: "Limit to a specific repository" },
        },
        required: ["query"],
      },
      tags: ["codebase"],
      handler: async ({ query, repositoryId }) => {
        const data = await client.searchCode(query, repositoryId);
        return ok(data, `Found ${data.results.length} result(s)`);
      },
    }),

    defineTool<{ repositoryId: string; area: string }>({
      name: "exf_code_who_knows",
      description:
        "Find who has expertise in a specific code area, based on commit history and ownership.",
      inputSchema: {
        type: "object",
        properties: {
          repositoryId: { type: "string", description: "Repository ID" },
          area: { type: "string", description: "Code area or topic, e.g. 'auth middleware'" },
        },
        required: ["repositoryId", "area"],
      },
      tags: ["codebase"],
      handler: async ({ repositoryId, area }) => {
        const data = await client.codeWhoKnows(repositoryId, area);
        return ok(data);
      },
    }),
  ];
}
