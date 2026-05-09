/**
 * Siftable client for the openclaw plugin.
 *
 * Thin adapter over the published @siftable/mcp-server SDK. Keeps the
 * ExfClient call surface stable so the plugin's tool handlers don't
 * need to change. Resolves auth from openclaw plugin config first,
 * then SIFT_PAT, then legacy EXF_PAT.
 */

import { SiftClient } from "@siftable/mcp-server/exfClient";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { normalizeSecretInput } from "openclaw/plugin-sdk/secret-input";

const DEFAULT_API_URL = "https://execufunction.com";

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
  // SIFT_PAT is the current brand; EXF_PAT is the legacy fallback.
  return (
    normalizeSecretInput(process.env.SIFT_PAT) ||
    normalizeSecretInput(process.env.EXF_PAT) ||
    undefined
  );
}

function resolveApiUrl(cfg?: OpenClawConfig): string {
  const pluginConfig = resolvePluginConfig(cfg);
  return (
    pluginConfig?.apiUrl?.trim() ||
    process.env.SIFT_API_URL ||
    process.env.EXF_API_URL ||
    DEFAULT_API_URL
  );
}

function resolveWorkspaceId(cfg?: OpenClawConfig): string | undefined {
  const pluginConfig = resolvePluginConfig(cfg);
  return (
    pluginConfig?.workspaceId ||
    process.env.SIFT_WORKSPACE_ID ||
    process.env.EXF_WORKSPACE_ID ||
    undefined
  );
}

/** Unwrap an ApiResponse, throwing on error so handlers can use try/catch. */
function unwrap<T>(
  res: { data?: T; error?: string; statusCode: number },
  label: string,
): T {
  if (res.error || !res.data) {
    throw new Error(
      `Siftable ${label} failed (HTTP ${res.statusCode}): ${res.error ?? "empty response"}`,
    );
  }
  return res.data;
}

export class ExfClient {
  private sift: SiftClient;

  constructor(cfg?: OpenClawConfig) {
    const token = resolveToken(cfg);
    if (!token) {
      throw new Error(
        "Siftable requires a Personal Access Token. " +
          "Set SIFT_PAT (or legacy EXF_PAT) in your environment, " +
          "or configure plugins.entries.execufunction.config.token.",
      );
    }
    this.sift = new SiftClient({
      apiUrl: resolveApiUrl(cfg).replace(/\/+$/, ""),
      pat: token,
      workspaceId: resolveWorkspaceId(cfg),
    });
  }

  /** Underlying SDK for callers wanting endpoints we haven't wrapped. */
  raw(): SiftClient {
    return this.sift;
  }

  // --- Tasks ---

  async listTasks(filters?: { projectId?: string; status?: string; limit?: number }) {
    return unwrap(await this.sift.listTasks(filters), "listTasks");
  }

  async createTask(data: {
    title: string;
    description?: string;
    priority?: string;
    projectId?: string;
    dueAt?: string;
    /** Semicolon-separated, e.g. "criterion 1; criterion 2" */
    acceptanceCriteria?: string;
  }) {
    const acceptanceCriteria = data.acceptanceCriteria
      ?.split(";")
      .map((c) => c.trim())
      .filter(Boolean)
      .map((text) => ({ text }));
    return unwrap(
      await this.sift.createTask({
        title: data.title,
        description: data.description,
        priority: data.priority,
        projectId: data.projectId,
        dueAt: data.dueAt,
        acceptanceCriteria,
      }),
      "createTask",
    );
  }

  async updateTask(taskId: string, data: Record<string, unknown>) {
    return unwrap(
      await this.sift.updateTask(taskId, data as never),
      "updateTask",
    );
  }

  async completeTask(taskId: string, completionNotes?: string) {
    if (completionNotes) {
      const update = await this.sift.updateTask(taskId, {
        completionNotes,
      } as never);
      if (update.error) {
        throw new Error(
          `Siftable updateTask (notes) failed (HTTP ${update.statusCode}): ${update.error}`,
        );
      }
    }
    return unwrap(await this.sift.completeTask(taskId), "completeTask");
  }

  // --- Calendar ---

  async listEvents(filters: { startDate: string; endDate: string; limit?: number }) {
    return unwrap(await this.sift.listCalendarEvents(filters), "listCalendarEvents");
  }

  async createEvent(data: {
    title: string;
    startTime: string;
    endTime?: string;
    description?: string;
    location?: string;
    allDay?: boolean;
  }) {
    return unwrap(
      await this.sift.createCalendarEvent(data as never),
      "createCalendarEvent",
    );
  }

  async updateEvent(eventId: string, data: Record<string, unknown>) {
    return unwrap(
      await this.sift.updateCalendarEvent(eventId, data as never),
      "updateCalendarEvent",
    );
  }

  // --- Notes/Knowledge ---

  async searchNotes(query: string, limit?: number) {
    // SDK returns { results }; tools expect { notes }.
    const data = unwrap(
      await this.sift.searchNotes(query, limit ? { limit } : undefined),
      "searchNotes",
    );
    return { notes: data.results };
  }

  async createNote(data: {
    title: string;
    content: string;
    noteType?: string;
    projectId?: string;
    tags?: string[];
  }) {
    return unwrap(
      await this.sift.createNote(data as never),
      "createNote",
    );
  }

  async getNote(noteId: string) {
    return unwrap(await this.sift.getNote(noteId), "getNote");
  }

  // --- Projects ---

  async listProjects(filters?: { status?: string }) {
    return unwrap(await this.sift.listProjects(filters), "listProjects");
  }

  async getProjectContext(projectId: string) {
    return unwrap(
      await this.sift.getProjectContext(projectId),
      "getProjectContext",
    );
  }

  // --- People ---

  async searchPeople(search: string) {
    return unwrap(
      await this.sift.searchPeople({ query: search }),
      "searchPeople",
    );
  }

  async createPerson(data: {
    name: string;
    email?: string;
    phone?: string;
    relationship?: string;
    organizationId?: string;
    notes?: string;
  }) {
    return unwrap(
      await this.sift.createPerson(data as never),
      "createPerson",
    );
  }

  // --- Organizations ---

  async searchOrganizations(search: string) {
    return unwrap(
      await this.sift.searchOrganizations({ query: search }),
      "searchOrganizations",
    );
  }

  // --- Codebase ---

  async searchCode(query: string, repositoryId?: string) {
    return unwrap(
      await this.sift.searchCode({ query, repositoryId }),
      "searchCode",
    );
  }

  async codeWhoKnows(repositoryId: string, area: string) {
    return unwrap(
      await this.sift.whoKnows(repositoryId, area),
      "whoKnows",
    );
  }
}
