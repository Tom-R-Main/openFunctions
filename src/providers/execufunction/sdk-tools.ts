/** Canonical Siftable tools projected directly from the current MCP SDK. */

import {
  TOOLS,
  executeTool,
  isToolEnabled,
  type ToolExecutionMetadata,
} from "@siftable/mcp-server";
import {
  isToolAllowedForTransport,
  type McpTransportProfile,
} from "@siftable/mcp-server/factory";
import type { InputSchema, ToolDefinition } from "../../framework/types.js";
import { defineTool, ok } from "../../framework/tool.js";
import type { ExfClient } from "./client.js";

type SiftableSdkTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: ToolDefinition["annotations"];
  outputSchema?: ToolDefinition["outputSchema"];
};

export interface SiftableSdkToolOptions {
  /** Match the SDK's transport policy. Generic embedded adapters use hosted_remote. */
  transportProfile?: McpTransportProfile;
  /** Include capabilities disabled by the MCP package's feature gates. */
  includeDisabled?: boolean;
}

function asInputSchema(schema: unknown): InputSchema {
  return structuredClone(schema) as InputSchema;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** executeTool emits the receipt's structured value, while MCP factory adds its envelope. */
function outputProjection(schema: unknown): { schema?: InputSchema; limitation?: string; upstream?: unknown } {
  if (schema === undefined) return {};
  if (!record(schema) || schema.type !== "object") {
    return { upstream: structuredClone(schema), limitation: "The upstream output schema has no supported object root; the embedded projection retains it as provenance without advertising an incompatible schema." };
  }
  if (!record(schema.properties) || !record(schema.properties.kind) ||
      schema.properties.kind.const !== "sift.action_receipt") return { schema: asInputSchema(schema) };
  const upstream = structuredClone(schema);
  const result = schema.properties.result;
  const variants = record(result) && Array.isArray(result.anyOf) ? result.anyOf : [];
  const values: unknown[] = [];
  for (const variant of variants) {
    if (record(variant) && record(variant.properties) && record(variant.properties.contentType) &&
        variant.properties.contentType.const === "application/json") values.push(variant.properties.value);
  }
  const supportedReferences = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.every(supportedReferences);
    if (!record(value)) return true;
    if (typeof value.$ref === "string" && !/^#\/(?:\$defs|definitions)(?:\/|$)/.test(value.$ref)) return false;
    return Object.values(value).every(supportedReferences);
  };
  if (!values.length || values.some((value) => !record(value) || value.type !== "object" || !supportedReferences(value)) ||
      !supportedReferences(schema.$defs) || !supportedReferences(schema.definitions)) {
    return { upstream, limitation: "Embedded executeTool does not expose a faithfully extractable object payload schema. The upstream MCP receipt schema is retained as provenance; no output schema is advertised." };
  }
  const projected: Record<string, unknown> = values.length === 1
    ? structuredClone(values[0]) as Record<string, unknown>
    : { type: "object", properties: {}, anyOf: structuredClone(values) };
  for (const keyword of ["$defs", "definitions", "$schema"]) {
    if (schema[keyword] !== undefined) projected[keyword] = structuredClone(schema[keyword]);
  }
  projected.properties ??= {};
  return { schema: projected as unknown as InputSchema, upstream };
}

function domainFor(name: string): string {
  if (name.startsWith("work_item_") || name.startsWith("work_dependency_")) return "agent_work";
  if (name.startsWith("code_memory_")) return "code_memory";
  if (name.startsWith("execution_grant_")) return "execution_grants";
  if (name.startsWith("vault_materialization_")) return "vault";
  return name.split("_", 1)[0] ?? "siftable";
}

function executionFailure(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.startsWith("Error:") ? trimmed.slice("Error:".length).trim() : undefined;
}

/**
 * Build the current callable Siftable MCP surface without duplicating schemas
 * or endpoint mappings in OpenFunction. Feature gates and transport containment
 * are evaluated by the installed @siftable/mcp-server package.
 */
export function createSiftableSdkTools(
  client: Pick<ExfClient, "raw">,
  options: SiftableSdkToolOptions = {},
): ToolDefinition<Record<string, unknown>, unknown>[] {
  const transportProfile = options.transportProfile ?? "hosted_remote";
  const tools = TOOLS as unknown as readonly SiftableSdkTool[];

  return tools
    .filter((tool) => options.includeDisabled || isToolEnabled(tool.name))
    .filter((tool) => isToolAllowedForTransport(tool.name, transportProfile))
    // Embedded clients do not own an authenticated principal/session store.
    // Hosted sessions are available through createSiftableMcpProvider instead.
    .filter((tool) => !tool.name.startsWith("work_session_"))
    .map((tool) => {
      const projected = outputProjection(tool.outputSchema);
      const provenance = projected.upstream === undefined ? undefined : {
        "siftable/upstreamOutputSchema": projected.upstream,
        "siftable/outputProjection": projected.limitation ?? "Embedded executeTool structured value; upstream MCP factory receipt envelope remains a separate transport contract",
      };
      return defineTool<Record<string, unknown>, unknown>({
        name: tool.name,
        description: projected.limitation ? `${tool.description} ${projected.limitation}` : tool.description,
        inputSchema: asInputSchema(tool.inputSchema),
        ...(tool.annotations === undefined ? {} : { annotations: structuredClone(tool.annotations) }),
        ...(projected.schema === undefined ? {} : { outputSchema: projected.schema }),
        ...(provenance ? { _meta: provenance } : {}),
        tags: ["siftable", `siftable:${domainFor(tool.name)}`, "siftable:mcp"],
        handler: async (params, context) => {
          let metadata: ToolExecutionMetadata = {};
          const executionContext = {
            transportProfile,
            signal: context?.signal,
            onExecutionMetadata: (value: ToolExecutionMetadata) => {
              metadata = {
                ...metadata,
                ...Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)),
              };
            },
          };
          const text = await executeTool(client.raw(), tool.name, params, executionContext);
          const upstream = Object.keys(metadata).length > 0
            ? { "siftable/execution": metadata }
            : undefined;
          const failure = executionFailure(text);
          if (failure) {
            // A formatted SDK error does not prove a write was never applied.
            // SDK discovery hints also cannot establish authoritative certainty.
            return {
              success: false,
              error: failure,
              executionOutcome: "unknown",
              ...(metadata.structuredResult ? { structuredContent: metadata.structuredResult.value } : {}),
              ...(upstream ? { _meta: upstream } : {}),
            };
          }

          if (metadata.structuredResult) {
            return {
              ...ok(metadata.structuredResult.value, text),
              structuredContent: metadata.structuredResult.value,
              _meta: upstream,
            };
          }
          let data: unknown;
          try {
            data = JSON.parse(text) as unknown;
          } catch {
            data = text;
          }
          return { ...ok(data), ...(upstream ? { _meta: upstream } : {}) };
        },
      });
    });
}
