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
  | "vault"
  | "datasets"
  | "documents";

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

  const tools = connected.createTools();
  const taggedTools = tools.map((tool) => ({
    ...tool,
    tags: dedupTags([
      ...(tool.tags ?? []),
      "context",
      `context:${id}`,
    ]),
  }));

  registry.registerAll(taggedTools);

  console.log(
    `🔗 ${name}: connected (${taggedTools.length} tool${taggedTools.length === 1 ? "" : "s"} registered)`,
  );

  return connected;
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
  const sections: string[] = [];

  for (const provider of providers) {
    if (!provider.buildContext) continue;

    try {
      const block = await provider.buildContext();
      if (block) {
        sections.push(block);
      }
    } catch (error) {
      const name = provider.metadata.name;
      const message = error instanceof Error ? error.message : "unknown error";
      console.warn(`⚠️  ${name}: failed to build context — ${message}`);
    }
  }

  return sections.join("\n\n");
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
