/**
 * openFunctions ↔ Pi extension bridge.
 *
 * Pi extensions register tools through `ExtensionAPI.registerTool()`. This
 * module mirrors that small contract locally so openFunctions does not need a
 * runtime dependency on `@earendil-works/pi-coding-agent` or `typebox`.
 */

import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition, ToolResult } from "./types.js";
import {
  executeRuntimeTool,
  formatRuntimeToolResult,
  selectRuntimeTools,
  type RuntimeToolSelectionOptions,
} from "./runtime-tool-bridge.js";

export interface PiTextContent {
  type: "text";
  text: string;
}

export interface PiToolResult<TDetails = ToolResult> {
  content: PiTextContent[];
  details: TDetails;
}

export interface PiExtensionContextLike {
  [key: string]: unknown;
}

export interface PiToolShape {
  name: string;
  label: string;
  description: string;
  /** JSON Schema/TypeBox-compatible object schema. */
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((result: PiToolResult) => void) | undefined,
    context: PiExtensionContextLike,
  ) => Promise<PiToolResult>;
}

export interface PiExtensionApiLike {
  registerTool(tool: PiToolShape): void;
}

export interface ToPiToolsOptions extends RuntimeToolSelectionOptions {
  /** Add a one-line entry to Pi's default Available tools prompt section. */
  promptSnippet?: (tool: ToolDefinition) => string | undefined;
  /** Add tool-specific bullets to Pi's default prompt guidelines. */
  promptGuidelines?: (tool: ToolDefinition) => string[] | undefined;
  /** Customize the successful result. Failures always throw for Pi. */
  formatResult?: (result: ToolResult, tool: ToolDefinition) => PiToolResult;
}

/** Convert all selected registry tools into Pi `registerTool()` definitions. */
export function toPiTools(
  registry: ToolRegistry,
  options: ToPiToolsOptions = {},
): PiToolShape[] {
  return selectRuntimeTools(registry, options).map(({ tool }) =>
    toolToPi(tool, registry, options),
  );
}

/** Convert one registry tool into Pi's extension tool contract. */
export function toolToPi(
  tool: ToolDefinition<any, any>,
  registry: ToolRegistry,
  options: ToPiToolsOptions = {},
): PiToolShape {
  const name = `${options.namePrefix ?? ""}${tool.name}`;
  const label = options.label ? options.label(tool) : tool.name;
  const promptSnippet = options.promptSnippet?.(tool);
  const promptGuidelines = options.promptGuidelines?.(tool);

  return {
    name,
    label,
    description: tool.description,
    parameters: tool.inputSchema,
    ...(promptSnippet === undefined ? {} : { promptSnippet }),
    ...(promptGuidelines === undefined ? {} : { promptGuidelines }),
    async execute(_toolCallId, params, signal, _onUpdate, _context) {
      const result = await executeRuntimeTool(registry, tool, params, signal);
      // Pi marks tool failures only when execute throws. Returning an `isError`
      // field is ignored by the current runtime.
      if (!result.success) {
        throw new Error(result.error ?? "unknown error");
      }
      return options.formatResult
        ? options.formatResult(result, tool)
        : {
            content: [{ type: "text", text: formatRuntimeToolResult(result) }],
            details: result,
          };
    },
  };
}

/** Register converted tools with a Pi extension in one call. */
export function registerPiTools(
  pi: PiExtensionApiLike,
  registry: ToolRegistry,
  options: ToPiToolsOptions = {},
): PiToolShape[] {
  const tools = toPiTools(registry, options);
  for (const tool of tools) pi.registerTool(tool);
  return tools;
}
