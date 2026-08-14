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
import { defineTool, err, ok } from "../../framework/tool.js";
import type { ExfClient } from "./client.js";

type SiftableSdkTool = {
  name: string;
  description: string;
  inputSchema: unknown;
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
  client: ExfClient,
  options: SiftableSdkToolOptions = {},
): ToolDefinition<Record<string, unknown>, unknown>[] {
  const transportProfile = options.transportProfile ?? "hosted_remote";
  const tools = TOOLS as unknown as readonly SiftableSdkTool[];

  return tools
    .filter((tool) => options.includeDisabled || isToolEnabled(tool.name))
    .filter((tool) => isToolAllowedForTransport(tool.name, transportProfile))
    .map((tool) => defineTool<Record<string, unknown>, unknown>({
      name: tool.name,
      description: tool.description,
      inputSchema: asInputSchema(tool.inputSchema),
      tags: ["siftable", `siftable:${domainFor(tool.name)}`, "siftable:mcp"],
      handler: async (params) => {
        let metadata: ToolExecutionMetadata | undefined;
        const text = await executeTool(client.raw(), tool.name, params, {
          transportProfile,
          onExecutionMetadata: (value) => { metadata = value; },
        });
        const failure = executionFailure(text);
        if (failure) return err(failure);

        if (metadata?.structuredResult) {
          return ok(metadata.structuredResult.value, text);
        }
        try {
          return ok(JSON.parse(text) as unknown);
        } catch {
          return ok(text);
        }
      },
    }));
}
