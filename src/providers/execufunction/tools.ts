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

// ─── Work Items ─────────────────────────────────────────────────────────────
//
// Work items are Siftable's executable agent work queue: discrete units
// of work that can be claimed by an agent alias, transitioned through
// states (started → done / blocked / failed), and tracked separately
// from human-planning tasks. The old custom client didn't expose these;
// we reach them via client.raw() (the underlying SiftClient).

export function createWorkItemTools(client: ExfClient): ToolDefinition<any, any>[] {
  const sift = client.raw();

  return [
    defineTool<{
      status?: string;
      assignedAlias?: string;
      projectId?: string;
      taskId?: string;
      limit?: number;
    }>({
      name: "exf_work_items_list",
      description:
        "List work items from Siftable's executable agent work queue. " +
        "Filter by status (pending/in_progress/done/blocked/failed), assigned " +
        "agent alias, project, or task. Returns work-item titles, statuses, " +
        "and current assignees.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by status" },
          assignedAlias: {
            type: "string",
            description: "Filter by agent alias (e.g. 'claude-code')",
          },
          projectId: { type: "string", description: "Filter by project ID" },
          taskId: { type: "string", description: "Filter by parent task ID" },
          limit: { type: "integer", description: "Max work items to return (default 20)" },
        },
      },
      tags: ["work_items"],
      handler: async (params) => {
        const res = await sift.listWorkItems(params);
        if (res.error || !res.data) {
          return err(`listWorkItems failed (${res.statusCode}): ${res.error}`);
        }
        return ok(res.data, `Found ${res.data.workItems.length} work item(s)`);
      },
    }),

    defineTool<{ workItemId: string }>({
      name: "exf_work_item_get",
      description:
        "Get a single work item by ID. Returns the full work-item record " +
        "including status, assignment, and any progress notes.",
      inputSchema: {
        type: "object",
        properties: {
          workItemId: { type: "string", description: "Work item ID" },
        },
        required: ["workItemId"],
      },
      tags: ["work_items"],
      handler: async ({ workItemId }) => {
        const res = await sift.getWorkItem(workItemId);
        if (res.error || !res.data) {
          return err(`getWorkItem failed (${res.statusCode}): ${res.error}`);
        }
        return ok(res.data);
      },
    }),

    defineTool<{ alias: string; preferredTaskId?: string }>({
      name: "exf_work_item_claim",
      description:
        "Claim the next available work item for an agent alias. Optionally " +
        "prefer a specific task. Returns the claimed work item, or empty if " +
        "none are available.",
      inputSchema: {
        type: "object",
        properties: {
          alias: {
            type: "string",
            description: "Agent alias claiming the work (e.g. 'claude-code')",
          },
          preferredTaskId: {
            type: "string",
            description: "Optional preferred task ID to look for first",
          },
        },
        required: ["alias"],
      },
      tags: ["work_items"],
      handler: async ({ alias, preferredTaskId }) => {
        const input: Record<string, unknown> = { alias };
        if (preferredTaskId) input.preferredTaskId = preferredTaskId;
        const res = await sift.claimWorkItem(input);
        if (res.error || !res.data) {
          return err(`claimWorkItem failed (${res.statusCode}): ${res.error}`);
        }
        return ok(res.data, `Claimed work item for ${alias}`);
      },
    }),

    defineTool<{ workItemId: string; action: string; notes?: string }>({
      name: "exf_work_item_transition",
      description:
        "Transition a work item to a new state. Common actions: 'start', " +
        "'complete', 'block', 'fail'. Pass optional notes to record progress " +
        "or the reason for blocking/failing.",
      inputSchema: {
        type: "object",
        properties: {
          workItemId: { type: "string", description: "Work item ID" },
          action: {
            type: "string",
            description: "State transition action: start, complete, block, fail",
          },
          notes: { type: "string", description: "Optional notes about the transition" },
        },
        required: ["workItemId", "action"],
      },
      tags: ["work_items"],
      handler: async ({ workItemId, action, notes }) => {
        const input: Record<string, unknown> = {};
        if (notes) input.notes = notes;
        const res = await sift.transitionWorkItem(workItemId, action, input);
        if (res.error || !res.data) {
          return err(`transitionWorkItem failed (${res.statusCode}): ${res.error}`);
        }
        return ok(res.data, `Work item transitioned: ${action}`);
      },
    }),
  ];
}

// ─── Vault ──────────────────────────────────────────────────────────────────
//
// Vault stores encrypted secrets (API keys, credentials, etc.). Read
// operations are audit-logged on the Siftable side — surface this in
// the tool description so models pause before invoking them.

export function createVaultTools(client: ExfClient): ToolDefinition<any, any>[] {
  const sift = client.raw();

  return [
    defineTool<{ entryType?: string; category?: string; search?: string; limit?: number }>({
      name: "exf_vault_list",
      description:
        "List Siftable vault entries (metadata only — does not return secret " +
        "payloads). Filter by entry type, category, or search string. Use " +
        "exf_vault_read_secret to fetch the actual secret payload.",
      inputSchema: {
        type: "object",
        properties: {
          entryType: { type: "string", description: "Filter by entry type" },
          category: { type: "string", description: "Filter by category" },
          search: { type: "string", description: "Substring match on name/description" },
          limit: { type: "integer", description: "Max entries to return (default 50)" },
        },
      },
      tags: ["vault"],
      handler: async (params) => {
        const res = await sift.listVaultEntries(params);
        if (res.error || !res.data) {
          return err(`listVaultEntries failed (${res.statusCode}): ${res.error}`);
        }
        return ok(res.data, `Found ${res.data.entries.length} vault entr(ies)`);
      },
    }),

    defineTool<{ query: string; limit?: number }>({
      name: "exf_vault_search",
      description:
        "Search vault entries by query string (metadata only — does not return " +
        "secret payloads). Use exf_vault_read_secret to fetch the actual secret.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "integer", description: "Max results (default 20)" },
        },
        required: ["query"],
      },
      tags: ["vault"],
      handler: async ({ query, limit }) => {
        const res = await sift.searchVaultEntries(query, limit);
        if (res.error || !res.data) {
          return err(`searchVaultEntries failed (${res.statusCode}): ${res.error}`);
        }
        return ok(res.data, `Found ${res.data.entries.length} match(es)`);
      },
    }),

    defineTool<{ entryId: string }>({
      name: "exf_vault_read_secret",
      description:
        "Read the decrypted secret payload of a vault entry. " +
        "WARNING: this call is audit-logged on the Siftable side. Only " +
        "invoke when the user explicitly asks for a secret value, and " +
        "never echo the payload back into a model-visible context.",
      inputSchema: {
        type: "object",
        properties: {
          entryId: { type: "string", description: "Vault entry ID" },
        },
        required: ["entryId"],
      },
      tags: ["vault", "audit_logged"],
      handler: async ({ entryId }) => {
        const res = await sift.readVaultSecret(entryId);
        if (res.error || !res.data) {
          return err(`readVaultSecret failed (${res.statusCode}): ${res.error}`);
        }
        return ok(res.data, "Secret read (audit-logged)");
      },
    }),

    defineTool<{
      name: string;
      payload: Record<string, string>;
      slug?: string;
      entryType?: string;
      description?: string;
      tags?: string[];
      category?: string;
      url?: string;
    }>({
      name: "exf_vault_create",
      description:
        "Create a new vault entry. Payload is a string→string map of " +
        "key/value pairs (e.g. { token: 'abc' } or { username: 'x', password: 'y' }).",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Entry display name" },
          payload: {
            type: "object",
            description: "Key/value secret payload (string values only)",
            properties: {},
          },
          slug: { type: "string", description: "Stable identifier (auto-derived if omitted)" },
          entryType: { type: "string", description: "Entry type (api_key, password, etc.)" },
          description: { type: "string", description: "Human-readable description" },
          tags: { type: "array", items: { type: "string" }, description: "Tags" },
          category: { type: "string", description: "Category for grouping" },
          url: { type: "string", description: "Associated URL" },
        },
        required: ["name", "payload"],
      },
      tags: ["vault"],
      handler: async (params) => {
        const res = await sift.createVaultEntry(params);
        if (res.error || !res.data) {
          return err(`createVaultEntry failed (${res.statusCode}): ${res.error}`);
        }
        return ok(res.data, `Created vault entry: ${params.name}`);
      },
    }),
  ];
}

// ─── Datasets ───────────────────────────────────────────────────────────────
//
// Datasets are Siftable's structured data tables (notes-as-tables).
// We wrap the highest-value subset; bucket/rank/analyze/export remain
// reachable via client.raw() if a tool author needs them.

export function createDatasetTools(client: ExfClient): ToolDefinition<any, any>[] {
  const sift = client.raw();

  return [
    defineTool<{ limit?: number }>({
      name: "exf_datasets_list",
      description:
        "List datasets in the workspace. Returns dataset IDs, titles, and " +
        "field schemas. Pass an ID to exf_dataset_query to read rows.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Max datasets (default 20)" },
        },
      },
      tags: ["datasets"],
      handler: async ({ limit }) => {
        const res = await sift.listDatasets(limit);
        if (res.error || !res.data) {
          return err(`listDatasets failed (${res.statusCode}): ${res.error}`);
        }
        return ok(res.data, `Found ${res.data.datasets.length} dataset(s)`);
      },
    }),

    defineTool<{
      datasetId: string;
      filters?: Array<Record<string, unknown>>;
      sorts?: Array<Record<string, unknown>>;
      limit?: number;
      cursor?: string;
    }>({
      name: "exf_dataset_query",
      description:
        "Query rows from a dataset. Supports filters, sorts, pagination via " +
        "cursor, and a limit. Returns the matching rows plus next-cursor if " +
        "more pages exist.",
      inputSchema: {
        type: "object",
        properties: {
          datasetId: { type: "string", description: "Dataset ID" },
          filters: {
            type: "array",
            items: { type: "object", properties: {} },
            description: "Filter clauses (Siftable filter shape)",
          },
          sorts: {
            type: "array",
            items: { type: "object", properties: {} },
            description: "Sort clauses (Siftable sort shape)",
          },
          limit: { type: "integer", description: "Max rows (default 100)" },
          cursor: { type: "string", description: "Pagination cursor from prior call" },
        },
        required: ["datasetId"],
      },
      tags: ["datasets"],
      handler: async ({ datasetId, ...input }) => {
        const res = await sift.queryDataset(datasetId, input);
        if (res.error || !res.data) {
          return err(`queryDataset failed (${res.statusCode}): ${res.error}`);
        }
        return ok(res.data);
      },
    }),

    defineTool<{ datasetId: string }>({
      name: "exf_dataset_summarize",
      description:
        "Get a summary of a dataset: row count, schema, value distributions " +
        "for low-cardinality fields. Cheaper than querying all rows when you " +
        "just want shape + scale.",
      inputSchema: {
        type: "object",
        properties: {
          datasetId: { type: "string", description: "Dataset ID" },
        },
        required: ["datasetId"],
      },
      tags: ["datasets"],
      handler: async ({ datasetId }) => {
        const res = await sift.summarizeDataset(datasetId);
        if (res.error || !res.data) {
          return err(`summarizeDataset failed (${res.statusCode}): ${res.error}`);
        }
        return ok(res.data);
      },
    }),
  ];
}

// ─── Code Memories ──────────────────────────────────────────────────────────
//
// Code memories are durable facts about a codebase (e.g. "the rate limiter
// in middleware/rateLimit.ts uses a leaky bucket per workspace_id, not
// per user"). Stored once, recalled via semantic search later. Distinct
// from RAG — these are facts the AGENT writes after learning something.

export function createCodeMemoryTools(client: ExfClient): ToolDefinition<any, any>[] {
  const sift = client.raw();

  return [
    defineTool<{
      fact: string;
      category: string;
      filePath?: string;
      repositoryId?: string;
    }>({
      name: "exf_code_memory_store",
      description:
        "Persist a fact about the codebase for future recall. Use after " +
        "discovering something non-obvious (a hidden invariant, a workaround, " +
        "an architectural quirk). The category groups related facts and " +
        "filePath/repositoryId scope where the fact applies.",
      inputSchema: {
        type: "object",
        properties: {
          fact: { type: "string", description: "The fact to remember (one sentence)" },
          category: { type: "string", description: "Category, e.g. 'invariant', 'gotcha', 'design-decision'" },
          filePath: { type: "string", description: "Path the fact relates to (optional)" },
          repositoryId: { type: "string", description: "Repository scope (optional)" },
        },
        required: ["fact", "category"],
      },
      tags: ["code_memory"],
      handler: async (params) => {
        const res = await sift.storeCodeMemory(params);
        if (res.error || !res.data) {
          return err(`storeCodeMemory failed (${res.statusCode}): ${res.error}`);
        }
        return ok(res.data, "Code memory stored");
      },
    }),

    defineTool<{
      query: string;
      category?: string;
      repositoryId?: string;
      scopePaths?: string[];
      limit?: number;
    }>({
      name: "exf_code_memory_search",
      description:
        "Semantic search over stored code memories. Use when about to do " +
        "something in an area you've worked on before — there may be a " +
        "warning or convention already recorded.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language query" },
          category: { type: "string", description: "Filter by category" },
          repositoryId: { type: "string", description: "Filter by repository" },
          scopePaths: {
            type: "array",
            items: { type: "string" },
            description: "Filter to memories scoped to these paths",
          },
          limit: { type: "integer", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
      tags: ["code_memory"],
      handler: async (params) => {
        const res = await sift.searchCodeMemories(params);
        if (res.error || !res.data) {
          return err(`searchCodeMemories failed (${res.statusCode}): ${res.error}`);
        }
        return ok(res.data);
      },
    }),

    defineTool<{ memoryId: string }>({
      name: "exf_code_memory_delete",
      description:
        "Delete a code memory by ID. Use when a stored fact is no longer " +
        "true (e.g. the convention changed, the gotcha was fixed).",
      inputSchema: {
        type: "object",
        properties: {
          memoryId: { type: "string", description: "Code memory ID" },
        },
        required: ["memoryId"],
      },
      tags: ["code_memory"],
      handler: async ({ memoryId }) => {
        const res = await sift.deleteCodeMemory(memoryId);
        if (res.error || !res.data) {
          return err(`deleteCodeMemory failed (${res.statusCode}): ${res.error}`);
        }
        return ok(res.data, "Code memory deleted");
      },
    }),
  ];
}
