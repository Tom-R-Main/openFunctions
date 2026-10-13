/**
 * OpenFunction — Tool Registry
 *
 * Manages all registered tools and provides format adapters for
 * different AI providers. Derived from ExecuFunction's ToolRegistry,
 * stripped down for simplicity.
 *
 * Key concept: you define your tools ONCE, and the registry makes them
 * available to any AI (Claude via MCP, Gemini via function calling,
 * OpenAI via tools API) without rewriting anything.
 */

import type {
  ToolDefinition,
  ToolResult,
  GeminiFunctionDeclaration,
  AnthropicTool,
  OpenAIFunction,
} from "./types.js";
import { ToolExecutor, capabilityDigest } from "./executor.js";
import { snapshotJson } from "./session.js";
import type { ExecutionJournalSink, ExecutionPolicy, RegistrySelection, ToolExecution, ToolExecutionContext, ToolExecutorOptions } from "./execution-types.js";

export class ToolRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tools: Map<string, ToolDefinition<any, any>> = new Map();
  private readonly executor: ToolExecutor;
  private readonly policies: readonly ExecutionPolicy[];
  private readonly capturedDigests = new Map<string, string>();
  private readonly origins = new Map<string, () => ToolDefinition | undefined>();
  private readonly options: Readonly<ToolExecutorOptions>;

  constructor(options: ToolExecutorOptions = {}, shared?: { executor: ToolExecutor; policies: readonly ExecutionPolicy[] }) {
    this.options = Object.freeze({ ...options, logger: options.logger ?? {
      warn: (message: string) => console.warn(message), error: (message: string) => console.error(message),
    } });
    this.executor = shared?.executor ?? new ToolExecutor(name => this.tools.get(name), this.options);
    this.policies = shared?.policies ?? [];
  }

  // ── Registration ─────────────────────────────────────────────────────────

  /**
   * Register a single tool.
   *
   * @param opts.overwrite When false, an existing tool with the same name
   *   wins — the new tool is skipped and a warning is logged. Used by the
   *   framework to register memory + context-provider tools without silently
   *   shadowing user tools of the same name. Default: true (back-compat).
   */
  register(
    tool: ToolDefinition<any, any>,
    opts: { overwrite?: boolean } = {},
  ): void {
    if (this.tools.has(tool.name)) {
      if (this.options.mode === "governed") throw new Error(`Governed registry collision: ${tool.name}`);
      if (opts.overwrite === false) {
        this.options.logger?.warn?.(
          `⚠️  Tool "${tool.name}" is already registered — keeping existing definition (skipping new one).`,
        );
        return;
      }
      this.options.logger?.warn?.(
        `⚠️  Tool "${tool.name}" is already registered — overwriting.`,
      );
    }
    const stored = this.options.mode === "governed" ? Object.freeze({ ...tool,
      inputSchema: snapshotJson(tool.inputSchema) as ToolDefinition["inputSchema"],
      ...(tool.outputSchema ? { outputSchema: snapshotJson(tool.outputSchema) as ToolDefinition["inputSchema"] } : {}),
      ...(tool.annotations ? { annotations: snapshotJson(tool.annotations) } : {}),
      ...(tool._meta ? { _meta: snapshotJson(tool._meta) } : {}),
      ...(tool.contract ? { contract: snapshotJson(tool.contract) } : {}),
    }) : tool;
    this.tools.set(tool.name, stored);
    this.origins.delete(tool.name);
    this.capturedDigests.delete(tool.name);
  }

  /** Register multiple tools at once. See register() for opts. */
  registerAll(
    tools: ToolDefinition<any, any>[],
    opts: { overwrite?: boolean } = {},
  ): void {
    for (const tool of tools) {
      this.register(tool, opts);
    }
  }

  /**
   * Remove a tool by name. Returns true if the tool existed and was
   * removed, false otherwise. Used by ChatAgent.destroy() to clean up
   * provider/memory tools so long-lived processes that create and
   * destroy agents don't accumulate ghost tools in shared registries.
   */
  unregister(name: string): boolean {
    this.origins.delete(name);
    this.capturedDigests.delete(name);
    return this.tools.delete(name);
  }

  // ── Lookup ───────────────────────────────────────────────────────────────

  /** Get a tool by name */
  get(name: string): ToolDefinition<any, any> | undefined {
    return this.tools.get(name);
  }

  /** Get all registered tools */
  getAll(): ToolDefinition<any, any>[] {
    return Array.from(this.tools.values());
  }

  /** Get tools matching a tag */
  getByTag(tag: string): ToolDefinition<any, any>[] {
    return this.getAll().filter((t) => t.tags?.includes(tag));
  }

  /** List all tool names */
  listNames(): string[] {
    return Array.from(this.tools.keys());
  }

  // ── Execution ────────────────────────────────────────────────────────────

  /** Compatible facade returning the canonical JSON-safe result. */
  async execute(name: string, params: Record<string, unknown>, context: ToolExecutionContext = {}): Promise<ToolResult> {
    return (await this.executeDetailed(name, params, context)).result;
  }

  executeDetailed(name: string, params: Record<string, unknown>, context: ToolExecutionContext = {}, lifecycle?: ExecutionJournalSink): Promise<ToolExecution> {
    const captured = this.capturedDigests.get(name);
    return this.executor.executeDetailed(name, params, context, {
      resolve: selected => this.tools.has(selected)
        ? (this.origins.has(selected) ? this.origins.get(selected)!() : this.tools.get(selected)) : undefined,
      policies: this.policies, lifecycle,
      catalogDigest: this.options.mode === "governed" ? captured : undefined,
    });
  }

  executeBatch(calls: readonly { name: string; args: Record<string, unknown>; id?: string }[], context: ToolExecutionContext = {}): Promise<ToolExecution[]> {
    return Promise.all(calls.map(call => this.executeDetailed(call.name, call.args, { ...context, callId: call.id ?? context.callId })));
  }

  withChildExecution<T>(callback: () => Promise<T>): Promise<T> {
    return this.executor.withChildExecution(callback);
  }

  /** A private host capability bound to one adapter-owned lease-renewal tool. */
  createRenewalRunner(tool: ToolDefinition, lifecycle?: ExecutionJournalSink) {
    return this.executor.createRenewalRunner(tool, this.policies, lifecycle);
  }

  /** Visibility ceiling with the same executor, scheduling domain, and policy. */
  project(selection: RegistrySelection = {}, policy?: ExecutionPolicy): ToolRegistry {
    const projected = new ToolRegistry(this.options, {
      executor: this.executor, policies: [...this.policies, ...(policy ? [policy] : [])],
    });
    for (const tool of this.getAll()) {
      if (selection.names && !selection.names.includes(tool.name)) continue;
      if (selection.tags && !selection.tags.some(tag => tool.tags?.includes(tag))) continue;
      if (selection.capabilities && !selection.capabilities.some(tag => tool.tags?.includes(tag) || tool.name === tag)) continue;
      const isRead = tool.contract?.mutation === false || (tool.contract?.sideEffects.length === 0 && tool.contract?.mutation !== true);
      if (selection.level === "read" && !isRead) continue;
      if (selection.level === "write" && isRead) continue;
      if (selection.filter && !selection.filter(tool)) continue;
      projected.tools.set(tool.name, tool);
      projected.origins.set(tool.name, () => {
        if (!this.tools.has(tool.name)) return undefined;
        return this.origins.has(tool.name) ? this.origins.get(tool.name)!() : this.tools.get(tool.name);
      });
      projected.capturedDigests.set(tool.name, capabilityDigest(tool));
    }
    return projected;
  }

  // ── Provider Format Adapters ─────────────────────────────────────────────
  //
  // These convert your tool definitions into the format each AI provider
  // expects. This is the "write once, use everywhere" magic.

  /** Convert tools to Gemini function calling format */
  toGeminiFormat(): GeminiFunctionDeclaration[] {
    return this.getAll().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object" as const,
        properties: tool.inputSchema.properties,
        required: tool.inputSchema.required,
      },
    }));
  }

  /** Convert tools to Anthropic/Claude format */
  toAnthropicFormat(): AnthropicTool[] {
    return this.getAll().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }

  /** Convert tools to OpenAI format */
  toOpenAIFormat(): OpenAIFunction[] {
    return this.getAll().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }
}

/** Global registry instance — import this to register and access tools */
export const registry = new ToolRegistry();
