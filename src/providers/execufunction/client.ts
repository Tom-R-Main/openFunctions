/**
 * Siftable Provider Client
 *
 * Thin adapter over the published @siftable/mcp-server SDK. Keeps the
 * ExfClient call surface stable for tools.ts (throws on error, returns
 * the unwrapped data shape the tools expect) so adding new domains
 * doesn't require touching every tool handler.
 *
 * Why this exists rather than tools.ts using SiftClient directly:
 *   - SiftClient returns Promise<ApiResponse<T>> with { data?, error?, statusCode }
 *   - Existing tool handlers expect the data directly (throws on error)
 *   - A few methods have different parameter shapes (acceptanceCriteria
 *     as semicolon-separated string vs array of objects, etc.)
 *
 * Auth resolution order (in createSiftableProvider):
 *   1. Explicit { token, apiUrl } passed to the factory
 *   2. SIFT_PAT / SIFT_API_URL (current branding)
 *   3. EXF_PAT / EXF_API_URL (legacy fallback — still supported)
 */

import { SiftClient } from "@siftable/mcp-server/exfClient";

const DEFAULT_API_URL = "https://execufunction.com";

export interface ExfClientOptions {
  /** Siftable API base URL */
  apiUrl?: string;
  /** Personal Access Token (sift_pat_... or legacy exf_pat_...) */
  token: string;
  /** Optional workspace ID for multi-workspace accounts */
  workspaceId?: string;
}

/** Unwrap an ApiResponse, throwing on error so callers can use try/catch. */
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
  /** IANA timezone used when computing localDate(). */
  readonly timezone: string;

  constructor(options: ExfClientOptions) {
    this.sift = new SiftClient({
      apiUrl: options.apiUrl?.replace(/\/+$/, "") ?? DEFAULT_API_URL,
      pat: options.token,
      workspaceId: options.workspaceId,
    });
    this.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }

  /**
   * Format a Date as YYYY-MM-DD in the client's local timezone.
   * Use this instead of toISOString().split("T")[0] so date filters
   * match the user's local day, not UTC.
   */
  localDate(date: Date = new Date()): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: this.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  }

  // ─── Tasks ──────────────────────────────────────────────────────────────

  async listTasks(filters?: {
    projectId?: string;
    status?: string;
    limit?: number;
  }) {
    return unwrap(await this.sift.listTasks(filters), "listTasks");
  }

  async createTask(data: {
    title: string;
    description?: string;
    priority?: string;
    projectId?: string;
    dueAt?: string;
    /** Semicolon-separated acceptance criteria, e.g. "criterion 1; criterion 2" */
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

  async updateTask(taskId: string, updates: Record<string, unknown>) {
    // Pass-through; SDK accepts the same shape as the REST API.
    return unwrap(
      await this.sift.updateTask(taskId, updates as never),
      "updateTask",
    );
  }

  async completeTask(taskId: string, completionNotes?: string) {
    // The SDK's completeTask is a single endpoint and doesn't accept
    // notes. To preserve the old wrapper's behavior, we attach notes
    // via updateTask first, then mark complete.
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

  // ─── Calendar ───────────────────────────────────────────────────────────

  async listEvents(filters: { startDate: string; endDate: string; limit?: number }) {
    return unwrap(
      await this.sift.listCalendarEvents(filters),
      "listCalendarEvents",
    );
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

  async updateEvent(eventId: string, updates: Record<string, unknown>) {
    return unwrap(
      await this.sift.updateCalendarEvent(eventId, updates as never),
      "updateCalendarEvent",
    );
  }

  // ─── Notes / Knowledge ──────────────────────────────────────────────────

  async searchNotes(query: string, limit?: number) {
    // SDK returns `{ results }`; the existing tool handler reads
    // `.notes.length`, so rename for back-compat.
    const data = unwrap(
      await this.sift.searchNotes(query, limit ? { limit } : undefined),
      "searchNotes",
    );
    return { notes: data.results } as { notes: Record<string, unknown>[] };
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

  // ─── Projects ───────────────────────────────────────────────────────────

  async listProjects(filters?: { status?: string }) {
    return unwrap(await this.sift.listProjects(filters), "listProjects");
  }

  async getProjectContext(projectId: string) {
    return unwrap(
      await this.sift.getProjectContext(projectId),
      "getProjectContext",
    );
  }

  // ─── People ─────────────────────────────────────────────────────────────

  async searchPeople(search: string) {
    // Old wrapper took a positional string; new SDK takes an options object.
    // The SDK calls the parameter `query`, not `search`.
    const data = unwrap(
      await this.sift.searchPeople({ query: search }),
      "searchPeople",
    );
    return data as { people: Record<string, unknown>[] };
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

  // ─── Organizations ──────────────────────────────────────────────────────

  async searchOrganizations(search: string) {
    const data = unwrap(
      await this.sift.searchOrganizations({ query: search }),
      "searchOrganizations",
    );
    return data as { organizations: Record<string, unknown>[] };
  }

  // ─── Codebase ───────────────────────────────────────────────────────────

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

  // ─── Health ─────────────────────────────────────────────────────────────

  async checkAuth() {
    // The published SDK doesn't expose a dedicated /me endpoint; the
    // cheapest authenticated call we can make is listProjects, which
    // 401s fast on a bad PAT and returns quickly on a good one.
    const res = await this.sift.listProjects();
    if (res.error || !res.data) {
      throw new Error(
        `Siftable auth check failed (HTTP ${res.statusCode}): ${res.error ?? "empty response"}`,
      );
    }
    return { ok: true } as const;
  }

  /**
   * Escape hatch: get the underlying SiftClient for callers who want
   * to use methods we haven't wrapped yet (work items, vault, datasets,
   * code memories, etc.). Returns a fully-typed SDK instance.
   */
  raw(): SiftClient {
    return this.sift;
  }
}
