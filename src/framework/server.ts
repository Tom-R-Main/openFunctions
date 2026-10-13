/** MCP projection of the shared OpenFunction executor. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type ServerRequest,
  type ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolExecutionContext } from "./execution-types.js";

export interface McpRequestContext {
  request: CallToolRequest;
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>;
}

export interface ServerOptions {
  name: string;
  version?: string;
  /** Trusted application binding. Client arguments and _meta never confer authority. */
  resolveContext?: (request: McpRequestContext) =>
    ToolExecutionContext | undefined | Promise<ToolExecutionContext | undefined>;
}

export interface McpServerHandle {
  server: Server;
  /** Own one transport. Omit it to connect standard input/output. */
  connect(transport?: Transport): Promise<void>;
  close(): Promise<void>;
}

/** Construct without attaching process input/output; callers control lifecycle. */
export function createMcpServer(
  toolRegistry: ToolRegistry,
  options: ServerOptions,
): McpServerHandle {
  const server = new Server(
    { name: options.name, version: options.version ?? "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolRegistry.getAll().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      ...(tool._meta === undefined ? {} : { _meta: tool._meta }),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const resolved = await options.resolveContext?.({ request, extra });
    const context: ToolExecutionContext = {
      ...resolved,
      correlationId: resolved?.correlationId ?? String(extra.requestId),
      signal: resolved?.signal
        ? AbortSignal.any([extra.signal, resolved.signal])
        : extra.signal,
    };
    const outputSchema = toolRegistry.get(request.params.name)?.outputSchema;
    const execution = await toolRegistry.executeDetailed(
      request.params.name, request.params.arguments ?? {}, context,
    );
    const { result, receipt } = execution;
    const content: CallToolResult["content"] = result.content === undefined
      ? [{
        type: "text",
        text: result.success
          ? typeof result.data === "string"
            ? result.data
            : JSON.stringify(result.data, null, 2) ?? "null"
          : result.executionOutcome === "unknown"
            ? `Execution outcome is unknown: ${result.error ?? "Unable to confirm the effect"}. Reconcile the target state before retrying.`
            : `Error: ${result.error ?? "Tool execution failed"}`,
      }]
      : [...result.content];
    if (result.content !== undefined && result.executionOutcome === "unknown") {
      content.push({ type: "text", text: "Execution outcome is unknown. Reconcile the target state before retrying." });
    }
    if (result.message) content.push({ type: "text", text: result.message });
    // Keep the provider payload exactly aligned with its advertised schema.
    // The receipt is separate metadata, never a wrapper around structuredContent.
    // The executor validates successful schema output against structuredContent
    // or data. MCP clients require that validated object in structuredContent.
    const structuredContent = result.structuredContent !== undefined
      ? result.structuredContent
      : outputSchema && result.success && result.data !== null
        && typeof result.data === "object" && !Array.isArray(result.data)
        ? result.data as Record<string, unknown>
        : undefined;
    return {
      content,
      ...(structuredContent === undefined ? {} : { structuredContent }),
      ...(!result.success ? { isError: true } : {}),
      _meta: {
        ...result._meta,
        "openfunction/execution": receipt,
      },
    } satisfies CallToolResult;
  });

  let connected = false;
  let closed = false;
  return {
    server,
    async connect(transport = new StdioServerTransport()) {
      if (closed) throw new Error("MCP server is closed");
      if (connected) throw new Error("MCP server is already connected");
      connected = true;
      try {
        await server.connect(transport);
      } catch (error) {
        await server.close();
        closed = true;
        throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await server.close();
    },
  };
}

/** Compatible stdio entry point. Use createMcpServer for deliberate shutdown. */
export async function startServer(
  toolRegistry: ToolRegistry,
  options: ServerOptions,
): Promise<void> {
  const handle = createMcpServer(toolRegistry, options);
  await handle.connect();
  console.error(`${options.name} MCP server started with ${toolRegistry.getAll().length} tools`);
}
