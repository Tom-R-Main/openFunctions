import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/** Shared selection controls used by native agent-runtime bridges. */
export interface RuntimeToolSelectionOptions {
  /** Include only tools accepted by this predicate. */
  filter?: (tool: ToolDefinition) => boolean;
  /** Prefix exposed names without changing registry lookup names. */
  namePrefix?: string;
  /** Compute a human-readable label. Defaults to the registry tool name. */
  label?: (tool: ToolDefinition) => string;
}

export interface SelectedRuntimeTool {
  tool: ToolDefinition<any, any>;
  exposedName: string;
  label: string;
}

export function selectRuntimeTools(
  registry: ToolRegistry,
  options: RuntimeToolSelectionOptions,
): SelectedRuntimeTool[] {
  const filter = options.filter ?? (() => true);
  const prefix = options.namePrefix ?? "";

  return registry
    .getAll()
    .filter(filter)
    .map((tool) => ({
      tool,
      exposedName: `${prefix}${tool.name}`,
      label: options.label ? options.label(tool) : tool.name,
    }));
}

export function normalizeRuntimeParams(
  params: unknown,
): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

export async function executeRuntimeTool(
  registry: ToolRegistry,
  tool: ToolDefinition,
  params: unknown,
  signal?: AbortSignal,
): Promise<ToolResult> {
  signal?.throwIfAborted();
  const result = await registry.execute(
    tool.name,
    normalizeRuntimeParams(params),
  );
  signal?.throwIfAborted();
  return result;
}

/** Human/model-readable text used by text-only host result contracts. */
export function formatRuntimeToolResult(result: ToolResult): string {
  if (!result.success) {
    return `Error: ${result.error ?? "unknown error"}`;
  }

  const data = result.data;
  if (data === undefined || data === null) {
    return result.message ?? "(no data)";
  }
  if (typeof data === "string") {
    return result.message ? `${result.message}\n${data}` : data;
  }
  const json = JSON.stringify(data, null, 2);
  return result.message ? `${result.message}\n${json}` : json;
}
