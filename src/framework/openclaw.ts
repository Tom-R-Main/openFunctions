/**
 * openFunctions ↔ openclaw bridge.
 *
 * Converts an openFunctions ToolRegistry into the shape openclaw's
 * `api.registerTool()` expects. Lets a tool author write `defineTool({...})`
 * once and expose the same tool to MCP clients, ChatAgent, AND openclaw —
 * without hand-writing a plugin per tool.
 *
 * No runtime dependency on `openclaw` — the bridge defines the
 * compatible shape locally, so this module ships with the framework
 * regardless of whether openclaw is installed. Plugin authors add the
 * OpenClaw package as a peer in their plugin's package.json, then call:
 *
 * ```ts
 * import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
 * import { toOpenclawTools } from "openfunction/framework";
 * import { registry } from "./register-tools.js";
 *
 * export default definePluginEntry({
 *   id: "my-tools",
 *   name: "My Tools",
 *   description: "openFunctions tools, exposed to openclaw",
 *   register(api) {
 *     for (const tool of toOpenclawTools(registry)) {
 *       api.registerTool(tool);
 *     }
 *   },
 * });
 * ```
 */

import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition, ToolResult } from "./types.js";
import {
  executeRuntimeTool,
  formatRuntimeToolResult,
  selectRuntimeTools,
  type RuntimeToolSelectionOptions,
} from "./runtime-tool-bridge.js";

// ─── Output shape — compatible with openclaw's AnyAgentTool ────────────────

/** A single content block returned to openclaw. Matches the SDK shape. */
export interface OpenclawToolContentBlock {
  type: "text";
  text: string;
}

export interface OpenclawToolResult {
  type: "text" | "error";
  content: OpenclawToolContentBlock[];
  isError?: boolean;
}

/**
 * Tool shape openclaw plugins pass to `api.registerTool()`.
 *
 * Defined locally so this module has no runtime dep on
 * OpenClaw. The shape matches openclaw's `AnyAgentTool`
 * sufficiently for `api.registerTool()` to accept it; if openclaw's
 * type ever drifts beyond this, plugin authors can add an `as never`
 * cast at the registration site.
 */
export interface OpenclawToolShape {
  /** Tool name as the agent sees it. snake_case by openclaw convention. */
  name: string;
  /** Optional human-readable label shown in UIs. */
  label?: string;
  /** Description the model reads to decide when to call the tool. */
  description: string;
  /**
   * JSON-Schema-shaped parameter spec. openFunctions InputSchema is
   * a JSON-Schema subset; openclaw accepts JSONSchema or TypeBox
   * (TypeBox compiles to JSONSchema), so the openFunctions shape
   * passes through untouched.
   */
  parameters: unknown;
  /**
   * Run the tool. signal allows cancellation; openclaw passes one
   * when the user aborts mid-call.
   */
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<OpenclawToolResult>;
}

// ─── Conversion options ────────────────────────────────────────────────────

export interface ToOpenclawToolsOptions extends RuntimeToolSelectionOptions {
  /**
   * Format an openFunctions ToolResult into an openclaw result block.
   * Default: success → JSON-stringified data (or message if data is empty),
   *          failure → error text with isError set.
   * Override when you need richer formatting (markdown tables, custom
   * summaries, etc.) or to match a specific openclaw display contract.
   */
  formatResult?: (result: ToolResult, tool: ToolDefinition) => OpenclawToolResult;
}

/** Runtime context passed by OpenClaw's current `defineToolPlugin` helper. */
export interface OpenclawToolPluginExecutionContext {
  signal?: AbortSignal;
  toolCallId: string;
}

/**
 * Dependency-free shape accepted by `defineToolPlugin({ tools: (tool) => ... })`.
 * Plugin code passes each definition through OpenClaw's `tool()` factory.
 */
export interface OpenclawToolPluginToolShape {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  optional?: boolean;
  execute: (
    params: unknown,
    config: unknown,
    context: OpenclawToolPluginExecutionContext,
  ) => Promise<unknown>;
}

export interface ToOpenclawToolPluginToolsOptions
  extends RuntimeToolSelectionOptions {
  /** Mark selected tools optional in generated OpenClaw metadata. */
  optional?: (tool: ToolDefinition) => boolean;
  /** Customize a successful plain/JSON-compatible return value. */
  formatResult?: (result: ToolResult, tool: ToolDefinition) => unknown;
}

// ─── Conversion ────────────────────────────────────────────────────────────

/**
 * Convert every tool in `registry` (subject to `options.filter`) to the
 * openclaw shape. The returned execute() delegates to `registry.execute()`,
 * so input-schema validation and the framework's error handling apply
 * exactly as they would for any other openFunctions consumer.
 */
export function toOpenclawTools(
  registry: ToolRegistry,
  options: ToOpenclawToolsOptions = {},
): OpenclawToolShape[] {
  return selectRuntimeTools(registry, options).map(({ tool }) =>
    toolToOpenclaw(tool, registry, options),
  );
}

/**
 * Convert one tool. Exported so callers can build a custom set without
 * walking the whole registry — handy when wrapping individual tool
 * collections (memory, RAG, providers) into one openclaw plugin.
 */
export function toolToOpenclaw(
  tool: ToolDefinition<any, any>,
  registry: ToolRegistry,
  options: ToOpenclawToolsOptions = {},
): OpenclawToolShape {
  const namePrefix = options.namePrefix ?? "";
  const exposedName = `${namePrefix}${tool.name}`;
  const formatResult = options.formatResult ?? defaultFormatResult;
  const label = options.label ? options.label(tool) : tool.name;

  return {
    name: exposedName,
    label,
    description: tool.description,
    parameters: tool.inputSchema,
    async execute(_toolCallId, params, _signal) {
      // The bridge checks cancellation before and after execution. The
      // framework handler contract itself does not yet accept a signal.
      const result = await executeRuntimeTool(registry, tool, params, _signal);
      return formatResult(result, tool);
    },
  };
}

// ─── Default formatter ─────────────────────────────────────────────────────

/**
 * Default ToolResult → OpenclawToolResult mapping. Mirrors the MCP
 * server's behavior in src/framework/server.ts: stringify data on
 * success, emit error text with isError on failure.
 */
function defaultFormatResult(
  result: ToolResult,
  _tool: ToolDefinition,
): OpenclawToolResult {
  if (!result.success) {
    return {
      type: "error",
      isError: true,
      content: [
        {
          type: "text",
          text: `Error: ${result.error ?? "unknown error"}`,
        },
      ],
    };
  }

  const text = formatRuntimeToolResult(result);
  return {
    type: "text",
    content: [{ type: "text", text }],
  };
}

/**
 * Convert registry tools for OpenClaw's current `defineToolPlugin` API.
 *
 * Unlike the legacy `api.registerTool()` adapter above, failures throw so the
 * host records an actual failed tool call. Successful values remain structured
 * when possible, which lets OpenClaw retain them in result details.
 */
export function toOpenclawToolPluginTools(
  registry: ToolRegistry,
  options: ToOpenclawToolPluginToolsOptions = {},
): OpenclawToolPluginToolShape[] {
  return selectRuntimeTools(registry, options).map(
    ({ tool, exposedName, label }) => ({
      name: exposedName,
      label,
      description: tool.description,
      parameters: tool.inputSchema,
      ...(options.optional?.(tool) ? { optional: true } : {}),
      async execute(params, _config, context) {
        const result = await executeRuntimeTool(
          registry,
          tool,
          params,
          context.signal,
        );
        if (!result.success) {
          throw new Error(result.error ?? "unknown error");
        }
        return options.formatResult
          ? options.formatResult(result, tool)
          : defaultToolPluginResult(result);
      },
    }),
  );
}

function defaultToolPluginResult(result: ToolResult): unknown {
  if (result.message !== undefined && result.data !== undefined) {
    return { message: result.message, data: result.data };
  }
  return result.data ?? result.message ?? null;
}
