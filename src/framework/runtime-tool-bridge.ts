import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition, ToolResult } from "./types.js";
import type { ToolExecution, ToolExecutionContext } from "./execution-types.js";

/** Shared selection controls used by native agent-runtime bridges. */
export interface RuntimeToolSelectionOptions {
  /** Include only tools accepted by this predicate. */
  filter?: (tool: ToolDefinition) => boolean;
  /** Prefix exposed names without changing registry lookup names. */
  namePrefix?: string;
  /** Compute a human-readable label. Defaults to the registry tool name. */
  label?: (tool: ToolDefinition) => string;
  /** Trusted application callback; tool arguments never supply authority. */
  resolveExecutionContext?: (input: {
    tool: ToolDefinition;
    toolCallId?: string;
    signal?: AbortSignal;
    hostContext?: unknown;
  }) => ToolExecutionContext | Promise<ToolExecutionContext>;
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
  context: ToolExecutionContext = {},
): Promise<ToolResult> {
  return (await executeRuntimeToolDetailed(registry, tool, params, signal, context)).result;
}

export async function executeRuntimeToolDetailed(
  registry: ToolRegistry,
  tool: ToolDefinition,
  params: unknown,
  signal?: AbortSignal,
  context: ToolExecutionContext = {},
): Promise<ToolExecution> {
  const signals = [signal, context.signal].filter((value): value is AbortSignal => value !== undefined);
  return registry.executeDetailed(tool.name, normalizeRuntimeParams(params), {
    ...context,
    ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
  });
}

/** These hosts support text and images. Other MCP blocks get explicit text projections. */
export type NativeToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export function runtimeToolContent(result: ToolResult): NativeToolContent[] {
  const content: NativeToolContent[] = result.content?.map((block): NativeToolContent => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image") return { type: "image", data: block.data, mimeType: block.mimeType };
    if (block.type === "resource") {
      return {
        type: "text",
        text: `[Resource ${block.resource.uri}; embedded resource metadata is not supported by this host]`
          + ("text" in block.resource ? `\n${block.resource.text}` : "\n[Binary resource omitted]"),
      };
    }
    if (block.type === "resource_link") {
      return { type: "text", text: `[Resource link: ${block.uri}; link metadata is not supported by this host]` };
    }
    return { type: "text", text: `[Unsupported ${block.type} content omitted by this host]` };
  }) ?? [{ type: "text", text: formatRuntimeToolResult(result) }];
  if (result.executionOutcome === "unknown") {
    content.push({ type: "text", text: "Tool execution outcome is unknown; verify side effects before deciding whether any retry is safe." });
  }
  return content;
}

export function runtimeToolFailureMessage(result: ToolResult): string {
  const message = result.error ?? "unknown error";
  return result.executionOutcome === "unknown"
    ? `${message}; tool execution outcome is unknown; verify side effects before deciding whether any retry is safe`
    : message;
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
