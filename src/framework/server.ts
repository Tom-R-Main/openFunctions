/**
 * OpenFunction — MCP Server
 *
 * Wraps the Model Context Protocol SDK to expose your tools as an MCP server.
 * Any MCP client (Claude Desktop, Cursor, Claude.ai, etc.) can connect to this.
 *
 * Derived from ExecuFunction's MCP server pattern. The production version
 * is ~3,500 lines — this is the essential ~80 lines that do the same job.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolRegistry } from "./registry.js";

export interface ServerOptions {
  /** Server name shown to MCP clients */
  name: string;
  /** Server version */
  version?: string;
}

/**
 * Start an MCP server that exposes all registered tools.
 *
 * This function never returns — it runs until the process exits.
 *
 * @example
 * ```ts
 * import { registry } from './framework/registry.js';
 * import { startServer } from './framework/server.js';
 * import './my-tools/index.js'; // registers tools as a side effect
 *
 * startServer(registry, { name: 'my-mcp-server' });
 * ```
 */
export async function startServer(
  toolRegistry: ToolRegistry,
  options: ServerOptions,
): Promise<void> {
  const server = new Server(
    {
      name: options.name,
      version: options.version ?? "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // ── List Tools ─────────────────────────────────────────────────────────
  // When a client connects, it asks "what tools do you have?"
  // We return all registered tools with their schemas.

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = toolRegistry.getAll().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    return { tools };
  });

  // ── Call Tool ──────────────────────────────────────────────────────────
  // When the AI decides to use a tool, the client sends the tool name
  // and arguments here. We execute and return the result.

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const result = await toolRegistry.execute(name, args ?? {});

    if (!result.success) {
      return {
        content: [{ type: "text", text: `Error: ${result.error}` }],
        isError: true,
      };
    }

    // Format the result as text for the AI to read
    const text =
      typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data, null, 2);

    const content: Array<{ type: "text"; text: string }> = [
      { type: "text", text },
    ];

    // Include the human-friendly message if present
    if (result.message) {
      content.push({ type: "text", text: result.message });
    }

    return { content };
  });

  // ── Start ──────────────────────────────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const toolCount = toolRegistry.getAll().length;
  console.error(
    `🔌 ${options.name} MCP server started with ${toolCount} tools`,
  );
  console.error(
    `   Tools: ${toolRegistry.listNames().join(", ")}`,
  );
}
