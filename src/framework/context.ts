/**
 * OpenFunction — Context Provider System
 *
 * A context provider connects an external system (ExecuFunction, Obsidian,
 * Notion, etc.) to the Open Functions agent runtime. Like memory and RAG,
 * providers expose themselves as tools — the same tool definitions work
 * across MCP, chat, workflows, and agents.
 *
 * The pattern follows the existing composition model:
 *   - memory: createConversationMemory() → .createMemoryTools() → registry
 *   - rag:    createRAG() → .createTools() → registry
 *   - context: createProvider() → .createTools() → registry
 *
 * Providers also support system prompt injection: buildContext() returns
 * a text block (active tasks, upcoming events, etc.) that agents can
 * include in their system prompt for situational awareness.
 *
 * @example
 * ```ts
 * import { connectProvider, contextPrompt } from "./framework/index.js";
 * import { createExecuFunctionProvider } from "@openfunctions/provider-execufunction";
 *
 * // Connect a provider — registers its tools into the global registry
 * const exf = await connectProvider(
 *   createExecuFunctionProvider({ token: process.env.EXF_PAT }),
 *   registry,
 * );
 *
 * // Build a context block for agent system prompts
 * const context = await contextPrompt([exf]);
 *
 * const agent = defineAgent({
 *   name: "assistant",
 *   role: "Personal productivity assistant",
 *   goal: "Help the user manage tasks and schedule",
 *   toolTags: ["context"],
 * });
 * ```
 */

import { randomUUID } from "node:crypto";
import { digestJson, snapshotJson } from "./session.js";
import type { ToolDefinition } from "./types.js";
import { ToolRegistry } from "./registry.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Capability domains a context provider can support.
 * Providers declare which domains they cover so the framework (and agents)
 * know what's available without calling any tools.
 */
export type ContextCapability =
  | "tasks"
  | "projects"
  | "calendar"
  | "knowledge"
  | "people"
  | "organizations"
  | "codebase"
  | "code_memory"
  | "vault"
  | "datasets"
  | "documents"
  | "agent_work"
  | "agents"
  | "relationships"
  | "approvals"
  | "execution_grants"
  | "ai"
  | "capabilities";

/**
 * Lightweight metadata about a context provider.
 * Cheap to compute — no network calls, no auth needed.
 * Used for discovery, setup UX, and agent prompt composition.
 */
export interface ContextProviderMetadata {
  /** Unique provider ID (e.g. "execufunction", "obsidian", "notion") */
  id: string;
  /** Human-readable name */
  name: string;
  /** One-line description for agent system prompts and setup UX */
  description: string;
  /** Which capability domains this provider supports */
  capabilities: ContextCapability[];
  /** Auth requirements — helps setup UX and error messages */
  auth?: {
    /** How the user authenticates */
    kind: "pat" | "oauth" | "api_key" | "local";
    /** Environment variable to check for credentials */
    envVar?: string;
    /** URL where the user can create credentials */
    setupUrl?: string;
    /** Human-readable setup instructions */
    instructions?: string;
  };
}

/**
 * A context provider definition.
 *
 * Implementors create one of these via a factory function
 * (e.g. createExecuFunctionProvider()). The framework calls connect()
 * to initialize the provider and get a ConnectedProvider back.
 *
 * This two-phase design (define → connect) mirrors the framework's
 * existing patterns: defineTool() validates at definition time,
 * registry.execute() runs at call time.
 */
export interface ContextProvider {
  /** Cheap metadata — no network calls, no auth required */
  metadata: ContextProviderMetadata;

  /**
   * Initialize the provider. May perform auth validation, health checks,
   * or lazy resource setup. Returns a connected handle with tools.
   *
   * @param config - Optional provider-specific configuration
   * @throws If auth fails or the provider cannot be reached
   */
  connect(config?: Record<string, unknown>): Promise<ConnectedProvider>;
}

/**
 * A connected, ready-to-use context provider.
 *
 * Returned by ContextProvider.connect(). Provides tools for the registry
 * and optional context for agent system prompts.
 */
export interface ConnectedProvider {
  /** The provider's metadata (same as the parent ContextProvider) */
  readonly metadata: ContextProviderMetadata;

  /** Non-secret authenticated connection scope used to isolate snapshot caches. */
  readonly contextScope?: ContextScopeIdentity;

  /** Structured source evidence with optional authoritative freshness. */
  buildSnapshot?(): Promise<ContextSnapshotInput>;

  /**
   * Generate tool definitions for this provider's capabilities.
   * All returned tools are tagged with `"context"` and
   * `"context:<providerId>"` for agent filtering.
   */
  createTools(): ToolDefinition<any, any>[];

  /**
   * Build a text block summarizing the user's current context
   * from this provider. Agents include this in their system prompt
   * for situational awareness (active tasks, upcoming events, etc.).
   *
   * Returns undefined if no context is available or the provider
   * doesn't support prompt injection.
   */
  buildContext?(): Promise<string | undefined>;

  /**
   * Check if the provider is reachable and authenticated.
   * Useful for setup UX and monitoring.
   */
  healthCheck?(): Promise<{ ok: boolean; error?: string }>;

  /**
   * Clean up resources (close connections, cancel timers, etc.).
   */
  disconnect?(): Promise<void>;
}

export type ContextFreshnessPolicy = "session" | "turn" | "invalidated";
export type ContextFreshness = "fresh" | "stale" | "unavailable" | "unknown";
export interface ContextScopeIdentity {
  principalId?: string;
  workspaceId?: string;
  projectId?: string;
}
export interface ContextSourceReference {
  id: string;
  uri?: string;
  revision?: string;
}
export interface ContextSnapshotItem {
  kind: "observation" | "claim" | "inference" | "policy_reference";
  text: string;
  sourceRefs?: string[];
}
/** Provider-owned facts and their known upstream observation information. */
export interface ContextSnapshotInput {
  providerId: string;
  scope: ContextScopeIdentity;
  content: string;
  observedAt?: string;
  revision?: string;
  expiresAt?: string;
  freshness?: ContextFreshness;
  completeness?: "complete" | "partial" | "unknown";
  sourceRefs?: ContextSourceReference[];
  items?: ContextSnapshotItem[];
  omissions?: string[];
  warnings?: string[];
}
/** Immutable captured evidence; retrievedAt is local, observedAt is upstream. */
export interface ContextSnapshot extends ContextSnapshotInput {
  snapshotId: string;
  contentDigest: string;
  retrievedAt: string;
  freshness: ContextFreshness;
  completeness: "complete" | "partial" | "unknown";
  sourceRefs: ContextSourceReference[];
  items: ContextSnapshotItem[];
}
export interface ContextSnapshotReference {
  snapshotId: string;
  contentDigest: string;
  providerId: string;
  scope: ContextScopeIdentity;
  freshness: ContextFreshness;
  completeness: ContextSnapshot["completeness"];
  revision?: string;
}
export interface ContextSnapshotOptions {
  freshness?: ContextFreshnessPolicy;
  clock?: () => Date;
}

// Connections are isolated even if two principals reuse the same provider ID.
// Scope changes additionally select a new cache entry inside one connection.
const contextCache = new WeakMap<ConnectedProvider, Map<string, ContextSnapshot>>();
const invalidatedConnections = new WeakSet<ConnectedProvider>();
function cacheIdentity(provider: ConnectedProvider): string {
  return digestJson({ providerId: provider.metadata.id, scope: provider.contextScope ?? {} });
}
export function invalidateContext(provider: ConnectedProvider): void {
  invalidatedConnections.add(provider);
}
function validTime(value: string | undefined): void {
  if (value !== undefined && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))) {
    throw new Error("Context timestamps must be ISO timestamps");
  }
}
function validateSnapshot(input: ContextSnapshotInput, provider: ConnectedProvider): void {
  if (input.providerId !== provider.metadata.id || typeof input.content !== "string"
    || input.scope === null || typeof input.scope !== "object" || Array.isArray(input.scope)) {
    throw new Error("Invalid context snapshot identity/content");
  }
  for (const key of ["principalId", "workspaceId", "projectId"] as const) {
    const bound = provider.contextScope?.[key];
    if (bound !== undefined && input.scope[key] !== bound) throw new Error("Context snapshot scope changed");
    if (input.scope[key] !== undefined && (typeof input.scope[key] !== "string" || !input.scope[key])) throw new Error("Invalid context scope identity");
  }
  validTime(input.observedAt);
  validTime(input.expiresAt);
  if (input.revision !== undefined && typeof input.revision !== "string") throw new Error("Invalid context revision");
  if (input.freshness !== undefined && !["fresh", "stale", "unknown", "unavailable"].includes(input.freshness)) throw new Error("Invalid context freshness");
  if (input.completeness !== undefined && !["complete", "partial", "unknown"].includes(input.completeness)) throw new Error("Invalid context completeness");
  for (const source of input.sourceRefs ?? []) {
    if (!source || typeof source.id !== "string" || source.id.length === 0) throw new Error("Invalid context source reference");
  }
  for (const item of input.items ?? []) {
    if (!item || !["observation", "claim", "inference", "policy_reference"].includes(item.kind) || typeof item.text !== "string") throw new Error("Invalid context item");
  }
}
function captured(input: ContextSnapshotInput, retrievedAt: string, freshness?: ContextFreshness): ContextSnapshot {
  const state = freshness ?? input.freshness ?? (input.observedAt === undefined ? "unknown" : "fresh");
  const expired = input.expiresAt !== undefined && Date.parse(input.expiresAt) <= Date.parse(retrievedAt);
  return snapshotJson({
    ...input, snapshotId: randomUUID(), contentDigest: digestJson({ content: input.content, items: input.items ?? [], sourceRefs: input.sourceRefs ?? [] }), retrievedAt,
    freshness: expired && state !== "unavailable" ? "stale" : state,
    completeness: input.completeness ?? "unknown", sourceRefs: input.sourceRefs ?? [], items: input.items ?? [],
  }, "context snapshot") as ContextSnapshot;
}

/** Collect evidence without converting text or policy references into grants. */
export async function collectContextSnapshots(providers: ConnectedProvider[], options: ContextSnapshotOptions = {}): Promise<ContextSnapshot[]> {
  const now = (options.clock ?? (() => new Date()))().toISOString();
  const result: ContextSnapshot[] = [];
  for (const provider of providers) {
    if (!provider.buildSnapshot && !provider.buildContext) continue;
    let cache = contextCache.get(provider);
    if (cache === undefined) { cache = new Map(); contextCache.set(provider, cache); }
    const key = cacheIdentity(provider);
    const previous = cache.get(key);
    const refresh = previous === undefined || options.freshness === "turn" || invalidatedConnections.has(provider);
    if (!refresh && previous !== undefined) {
      if (previous.freshness !== "stale" && previous.expiresAt !== undefined && Date.parse(previous.expiresAt) <= Date.parse(now)) {
        const expired = captured(previous, now, "stale");
        cache.set(key, expired);
        result.push(expired);
      } else result.push(previous);
      continue;
    }
    invalidatedConnections.delete(provider);
    try {
      const input = provider.buildSnapshot !== undefined
        ? await provider.buildSnapshot()
        : { providerId: provider.metadata.id, scope: provider.contextScope ?? {}, content: await provider.buildContext!() ?? "", freshness: "unknown" as const, completeness: "unknown" as const };
      validateSnapshot(input, provider);
      const next = captured(input, now);
      cache.set(key, next);
      result.push(next);
    } catch {
      const next = previous === undefined
        ? captured({ providerId: provider.metadata.id, scope: provider.contextScope ?? {}, content: "", warnings: ["Provider context is unavailable; retrieval failed."] }, now, "unavailable")
        : captured({ ...previous, warnings: [...new Set([...(previous.warnings ?? []), "Provider context refresh failed; retained source evidence is stale."])] }, now, "stale");
      cache.set(key, next);
      result.push(next);
    }
  }
  return result;
}
export function contextSnapshotReferences(snapshots: readonly ContextSnapshot[]): ContextSnapshotReference[] {
  return snapshots.map(({ snapshotId, contentDigest, providerId, scope, freshness, completeness, revision }) => ({
    snapshotId, contentDigest, providerId, scope, freshness, completeness, ...(revision === undefined ? {} : { revision }),
  }));
}
export function formatContextSnapshots(snapshots: readonly ContextSnapshot[]): string {
  return snapshots.map((snapshot) => [
    `Source context ${snapshot.providerId}; snapshot ${snapshot.snapshotId}; freshness ${snapshot.freshness}; completeness ${snapshot.completeness}.`,
    snapshot.content,
    ...(snapshot.content.length === 0 && snapshot.items.length === 0
      ? ["No context text or items were returned in this snapshot. Use this snapshot in place of earlier context from this provider."] : []),
    ...(snapshot.items.length === 0 ? [] : snapshot.items.map((item) => `[${item.kind}] ${item.text}`)),
    ...(snapshot.omissions ?? []).map((entry) => `Omitted: ${entry}`),
    ...(snapshot.warnings ?? []).map((entry) => `Warning: ${entry}`),
  ].filter(Boolean).join("\n")).join("\n\n");
}

// ─── Provider Connection ────────────────────────────────────────────────────

/**
 * Connect a context provider and register its tools into a registry.
 *
 * This is the primary way to wire a provider into the framework:
 *
 * ```ts
 * const exf = await connectProvider(
 *   createExecuFunctionProvider({ token: "..." }),
 *   registry,
 * );
 * ```
 *
 * Tools are automatically tagged with `"context"` and
 * `"context:<providerId>"` so agents can filter by provider or
 * by the general context tag.
 *
 * @param provider - The provider to connect
 * @param registry - The tool registry to register tools into
 * @param config - Optional provider-specific configuration
 * @returns The connected provider handle
 */
export async function connectProvider(
  provider: ContextProvider,
  registry: ToolRegistry,
  config?: Record<string, unknown>,
): Promise<ConnectedProvider> {
  const { id, name } = provider.metadata;

  const connected = await provider.connect(config);
  const before = new Set(registry.listNames());
  try {
    const tools = connected.createTools();
    const taggedTools = tools.map((tool) => ({
      ...tool,
      tags: dedupTags([
        ...(tool.tags ?? []),
        "context",
        `context:${id}`,
      ]),
    }));

    // User tools win on name collision — provider tools should not silently
    // shadow them. Skip and warn instead of overwrite.
    registry.registerAll(taggedTools, { overwrite: false });

    console.error(
      `🔗 ${name}: connected (${taggedTools.length} tool${taggedTools.length === 1 ? "" : "s"} registered)`,
    );
    return connected;
  } catch (error) {
    for (const registeredName of registry.listNames()) {
      if (!before.has(registeredName)) registry.unregister(registeredName);
    }
    await connected.disconnect?.().catch(() => undefined);
    throw error;
  }
}

// ─── Context Prompt Builder ─────────────────────────────────────────────────

/**
 * Build a system prompt section from one or more connected providers.
 *
 * Each provider that implements buildContext() contributes a section.
 * The result is a single string suitable for inclusion in a system prompt
 * via composePrompt({ context: ... }).
 *
 * ```ts
 * const context = await contextPrompt([exf, obsidian]);
 * const systemPrompt = composePrompt({
 *   role: "Personal assistant",
 *   context,
 *   toolGuide: autoToolGuide(registry),
 * });
 * ```
 *
 * @param providers - Connected providers to query for context
 * @returns Combined context string, or empty string if no context available
 */
export async function contextPrompt(
  providers: ConnectedProvider[],
): Promise<string> {
  return formatContextSnapshots(await collectContextSnapshots(providers));
}

// ─── Provider Health ────────────────────────────────────────────────────────

/**
 * Check the health of one or more connected providers.
 *
 * Returns a summary for each provider. Useful for setup UX
 * and monitoring dashboards.
 *
 * ```ts
 * const health = await checkProviderHealth([exf, obsidian]);
 * // [{ id: "execufunction", name: "ExecuFunction", ok: true },
 * //  { id: "obsidian", name: "Obsidian", ok: false, error: "vault not found" }]
 * ```
 */
export async function checkProviderHealth(
  providers: ConnectedProvider[],
): Promise<Array<{ id: string; name: string; ok: boolean; error?: string }>> {
  return Promise.all(
    providers.map(async (provider) => {
      const { id, name } = provider.metadata;

      if (!provider.healthCheck) {
        return { id, name, ok: true };
      }

      try {
        const result = await provider.healthCheck();
        return { id, name, ...result };
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        return { id, name, ok: false, error: message };
      }
    }),
  );
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function dedupTags(tags: string[]): string[] {
  return [...new Set(tags)];
}
