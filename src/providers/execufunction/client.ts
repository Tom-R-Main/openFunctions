/**
 * ExecuFunction API Client
 *
 * Thin HTTP client for the ExecuFunction REST API.
 * Used by the context provider to implement tool handlers.
 *
 * Auth: Personal Access Token via Authorization: Bearer header.
 * Base URL defaults to https://execufunction.com (configurable).
 */

const DEFAULT_API_URL = "https://execufunction.com";
const REQUEST_TIMEOUT_MS = 30_000;

export interface ExfClientOptions {
  /** ExecuFunction API base URL */
  apiUrl?: string;
  /** Personal Access Token */
  token: string;
  /** Optional workspace ID for multi-workspace accounts */
  workspaceId?: string;
}

export class ExfClient {
  private baseUrl: string;
  private token: string;
  private workspaceId: string | undefined;
  private timezone: string;

  constructor(options: ExfClientOptions) {
    this.token = options.token;
    this.baseUrl = options.apiUrl?.replace(/\/+$/, "") ?? DEFAULT_API_URL;
    this.workspaceId = options.workspaceId;
    this.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }

  // ─── HTTP ───────────────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = new URL(`/api/v1${path}`, this.baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== "") {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.token}`,
      "Content-Type": "application/json",
      "Timezone": this.timezone,
    };
    if (this.workspaceId) {
      headers["X-Workspace-Id"] = this.workspaceId;
    }
    if (method !== "GET") {
      headers["Idempotency-Key"] = crypto.randomUUID();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url.toString(), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        let detail = text;
        try {
          const json = JSON.parse(text);
          detail = json.error || json.message || text;
        } catch {
          // raw text
        }
        throw new Error(
          `ExecuFunction ${method} ${path} (${response.status}): ${detail}`,
        );
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.request<T>("GET", path, undefined, query);
  }

  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  async patch<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  // ─── Tasks ──────────────────────────────────────────────────────────────

  async listTasks(filters?: {
    projectId?: string;
    status?: string;
    limit?: number;
  }) {
    return this.get<{ tasks: Record<string, unknown>[] }>("/tasks", filters);
  }

  async createTask(data: {
    title: string;
    description?: string;
    priority?: string;
    projectId?: string;
    dueAt?: string;
    acceptanceCriteria?: string;
  }) {
    const body: Record<string, unknown> = { title: data.title };
    if (data.description) body.description = data.description;
    if (data.priority) body.priority = data.priority;
    if (data.projectId) body.projectId = data.projectId;
    if (data.dueAt) body.dueAt = data.dueAt;
    if (data.acceptanceCriteria) {
      body.acceptanceCriteria = data.acceptanceCriteria
        .split(";")
        .map((c) => c.trim())
        .filter(Boolean)
        .map((text) => ({ text }));
    }
    return this.post<{ task: Record<string, unknown> }>("/tasks", body);
  }

  async updateTask(taskId: string, updates: Record<string, unknown>) {
    return this.patch<{ task: Record<string, unknown> }>(`/tasks/${taskId}`, updates);
  }

  async completeTask(taskId: string, completionNotes?: string) {
    const body: Record<string, unknown> = { status: "completed", phase: "done" };
    if (completionNotes) body.completionNotes = completionNotes;
    return this.patch<{ task: Record<string, unknown> }>(`/tasks/${taskId}`, body);
  }

  // ─── Calendar ───────────────────────────────────────────────────────────

  async listEvents(filters: { startDate: string; endDate: string; limit?: number }) {
    return this.get<{ events: Record<string, unknown>[] }>("/calendar/events", filters);
  }

  async createEvent(data: {
    title: string;
    startTime: string;
    endTime?: string;
    description?: string;
    location?: string;
    allDay?: boolean;
  }) {
    return this.post<{ event: Record<string, unknown> }>("/calendar/events", data);
  }

  async updateEvent(eventId: string, updates: Record<string, unknown>) {
    return this.patch<{ event: Record<string, unknown> }>(`/calendar/events/${eventId}`, updates);
  }

  // ─── Notes / Knowledge ──────────────────────────────────────────────────

  async searchNotes(query: string, limit?: number) {
    return this.get<{ notes: Record<string, unknown>[] }>("/notes/search", { q: query, limit });
  }

  async createNote(data: {
    title: string;
    content: string;
    noteType?: string;
    projectId?: string;
    tags?: string[];
  }) {
    return this.post<{ note: Record<string, unknown> }>("/notes", data as Record<string, unknown>);
  }

  async getNote(noteId: string) {
    return this.get<{ note: Record<string, unknown> }>(`/notes/${noteId}`);
  }

  // ─── Projects ───────────────────────────────────────────────────────────

  async listProjects(filters?: { status?: string }) {
    return this.get<{ projects: Record<string, unknown>[] }>("/projects", filters);
  }

  async getProjectContext(projectId: string) {
    return this.get<Record<string, unknown>>(`/projects/${projectId}/context`);
  }

  // ─── People ─────────────────────────────────────────────────────────────

  async searchPeople(search: string) {
    return this.get<{ people: Record<string, unknown>[] }>("/people", { search });
  }

  async createPerson(data: {
    name: string;
    email?: string;
    phone?: string;
    relationship?: string;
    organizationId?: string;
    notes?: string;
  }) {
    return this.post<{ person: Record<string, unknown> }>("/people", data as Record<string, unknown>);
  }

  // ─── Organizations ──────────────────────────────────────────────────────

  async searchOrganizations(search: string) {
    return this.get<{ organizations: Record<string, unknown>[] }>("/organizations", { search });
  }

  // ─── Codebase ───────────────────────────────────────────────────────────

  async searchCode(query: string, repositoryId?: string) {
    const body: Record<string, unknown> = { query };
    if (repositoryId) body.repositoryId = repositoryId;
    return this.post<{ results: Record<string, unknown>[] }>("/code/search", body);
  }

  async codeWhoKnows(repositoryId: string, area: string) {
    return this.get<Record<string, unknown>>(
      `/code/repositories/${repositoryId}/expertise/who-knows`,
      { area },
    );
  }

  // ─── Health ─────────────────────────────────────────────────────────────

  async checkAuth() {
    return this.get<{ user: Record<string, unknown> }>("/user/me");
  }
}
