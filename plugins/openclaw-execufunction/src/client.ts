import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { normalizeSecretInput } from "openclaw/plugin-sdk/secret-input";

const DEFAULT_API_URL = "https://execufunction.com";
const REQUEST_TIMEOUT_MS = 30_000;

type PluginEntryConfig = {
  apiUrl?: string;
  token?: string | { path?: string };
  workspaceId?: string;
};

function resolvePluginConfig(cfg?: OpenClawConfig): PluginEntryConfig | undefined {
  const entries = cfg?.plugins?.entries as Record<string, { config?: PluginEntryConfig }> | undefined;
  return entries?.execufunction?.config;
}

function resolveToken(cfg?: OpenClawConfig): string | undefined {
  const pluginConfig = resolvePluginConfig(cfg);
  const configToken = pluginConfig?.token;
  if (typeof configToken === "string" && configToken) {
    return normalizeSecretInput(configToken) || undefined;
  }
  if (configToken && typeof configToken === "object" && "path" in configToken) {
    return normalizeSecretInput(configToken) || undefined;
  }
  return normalizeSecretInput(process.env.EXF_PAT) || undefined;
}

function resolveApiUrl(cfg?: OpenClawConfig): string {
  const pluginConfig = resolvePluginConfig(cfg);
  return pluginConfig?.apiUrl?.trim() || process.env.EXF_API_URL || DEFAULT_API_URL;
}

function resolveWorkspaceId(cfg?: OpenClawConfig): string | undefined {
  const pluginConfig = resolvePluginConfig(cfg);
  return pluginConfig?.workspaceId || process.env.EXF_WORKSPACE_ID || undefined;
}

export class ExfClient {
  private baseUrl: string;
  private token: string;
  private workspaceId: string | undefined;
  private timezone: string;

  constructor(cfg?: OpenClawConfig) {
    const token = resolveToken(cfg);
    if (!token) {
      throw new Error(
        "ExecuFunction requires a Personal Access Token. " +
          "Set EXF_PAT in your environment, or configure plugins.entries.execufunction.config.token.",
      );
    }
    this.token = token;
    this.baseUrl = resolveApiUrl(cfg);
    this.workspaceId = resolveWorkspaceId(cfg);
    this.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }

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
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      Timezone: this.timezone,
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
          // use raw text
        }
        throw new Error(`ExecuFunction API ${method} ${path} failed (${response.status}): ${detail}`);
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

  async delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  // --- Tasks ---

  async listTasks(filters?: {
    projectId?: string;
    status?: string;
    limit?: number;
  }) {
    return this.get<{ tasks: unknown[] }>("/tasks", filters);
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
    return this.post<{ task: unknown }>("/tasks", body);
  }

  async updateTask(taskId: string, data: Record<string, unknown>) {
    return this.patch<{ task: unknown }>(`/tasks/${taskId}`, data);
  }

  async completeTask(taskId: string, completionNotes?: string) {
    const body: Record<string, unknown> = {
      status: "completed",
      phase: "done",
    };
    if (completionNotes) body.completionNotes = completionNotes;
    return this.patch<{ task: unknown }>(`/tasks/${taskId}`, body);
  }

  // --- Calendar ---

  async listEvents(filters: { startDate: string; endDate: string; limit?: number }) {
    return this.get<{ events: unknown[] }>("/calendar/events", filters);
  }

  async createEvent(data: {
    title: string;
    startTime: string;
    endTime?: string;
    description?: string;
    location?: string;
    allDay?: boolean;
  }) {
    return this.post<{ event: unknown }>("/calendar/events", data);
  }

  async updateEvent(eventId: string, data: Record<string, unknown>) {
    return this.patch<{ event: unknown }>(`/calendar/events/${eventId}`, data);
  }

  // --- Notes/Knowledge ---

  async searchNotes(query: string, limit?: number) {
    return this.get<{ notes: unknown[] }>("/notes/search", { q: query, limit });
  }

  async createNote(data: {
    title: string;
    content: string;
    noteType?: string;
    projectId?: string;
    tags?: string[];
  }) {
    return this.post<{ note: unknown }>("/notes", data as Record<string, unknown>);
  }

  async getNote(noteId: string) {
    return this.get<{ note: unknown }>(`/notes/${noteId}`);
  }

  // --- Projects ---

  async listProjects(filters?: { status?: string }) {
    return this.get<{ projects: unknown[] }>("/projects", filters);
  }

  async getProjectContext(projectId: string) {
    return this.get<Record<string, unknown>>(`/projects/${projectId}/context`);
  }

  // --- People ---

  async searchPeople(search: string) {
    return this.get<{ people: unknown[] }>("/people", { search });
  }

  async createPerson(data: {
    name: string;
    email?: string;
    phone?: string;
    relationship?: string;
    organizationId?: string;
    notes?: string;
  }) {
    return this.post<{ person: unknown }>("/people", data as Record<string, unknown>);
  }

  // --- Organizations ---

  async searchOrganizations(search: string) {
    return this.get<{ organizations: unknown[] }>("/organizations", { search });
  }

  // --- Codebase ---

  async searchCode(query: string, repositoryId?: string) {
    const body: Record<string, unknown> = { query };
    if (repositoryId) body.repositoryId = repositoryId;
    return this.post<{ results: unknown[] }>("/code/search", body);
  }

  async codeWhoKnows(repositoryId: string, area: string) {
    return this.get<Record<string, unknown>>(
      `/code/repositories/${repositoryId}/expertise/who-knows`,
      { area },
    );
  }
}
