/** A bounded MCP client projected into the ordinary OpenFunction tool surface. */
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport, FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolResultSchema,
  McpError,
  ErrorCode,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { ContextCapability, ContextProvider, ContextProviderMetadata, ConnectedProvider } from "../../framework/context.js";
import type { ToolExecutionContext } from "../../framework/execution-types.js";
import type { InputSchema, ToolDefinition, ToolResult } from "../../framework/types.js";

export type McpProviderTransport = {
  kind: "stdio";
  command: string;
  args?: readonly string[];
  cwd?: string;
  /** Trusted host callback; credentials never become tool arguments. */
  resolveEnvironment?: () => Record<string, string> | Promise<Record<string, string>>;
} | {
  kind: "streamable_http";
  url: string | URL;
  /** Trusted host callback, evaluated per HTTP request. */
  resolveHeaders?: () => HeadersInit | Promise<HeadersInit>;
};

export interface McpProviderOptions {
  id: string;
  name?: string;
  description?: string;
  capabilities?: ContextCapability[];
  transport?: McpProviderTransport;
  /** Trusted custom transport factory; each connection owns the returned transport. */
  createTransport?: () => Transport | Promise<Transport>;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxCatalogPages?: number;
  toolAllowlist?: readonly string[];
  /** Trusted approval/filtering at connection or an explicit refresh boundary. */
  approveCatalog?: (catalog: readonly Tool[]) => readonly string[] | Promise<readonly string[]>;
  /** Authoritative provider-specific rejection, never a text-prefix heuristic. */
  isAuthoritativeRejection?: (result: CallToolResult, toolName: string) => boolean;
}

export interface McpCatalogSnapshot {
  digest: string;
  generation: number;
  tools: readonly Tool[];
}

export interface McpProvider extends Omit<ContextProvider, "connect"> {
  connect(config?: Record<string, unknown>): Promise<ConnectedMcpProvider>;
}

export interface ConnectedMcpProvider extends ConnectedProvider {
  readonly catalog: McpCatalogSnapshot;
  readonly catalogStale: boolean;
  /** Refuse concurrent refresh; old tool projections remain invalid afterward. */
  refreshCatalog(): Promise<McpCatalogSnapshot>;
  disconnect(): Promise<void>;
}

/** Default network boundary: HTTPS or an explicit loopback HTTP endpoint. */
export function validateMcpEndpoint(value: string | URL): URL {
  const url = new URL(String(value));
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "[::1]" ||
    /^127(?:\.(?:\d{1,3})){3}$/.test(host);
  if (url.username || url.password) throw new Error("MCP endpoint credentials must come from a trusted auth callback");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("MCP endpoints require HTTPS; HTTP is allowed only for loopback testing");
  }
  return url;
}

function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "MCP transport failed";
}

/** Redirects cannot replay a call or carry credentials to another origin. */
function scopedFetch(endpoint: URL, options: McpProviderOptions, config: Extract<McpProviderTransport, { kind: "streamable_http" }>): FetchLike {
  const fetcher = options.fetch ?? globalThis.fetch;
  return async (input, init) => {
    let target = new URL(input instanceof Request ? input.url : String(input));
    const requestInit: RequestInit = { ...init, redirect: "manual" };
    if (target.origin !== endpoint.origin) throw new Error("MCP authentication is scoped to the configured endpoint origin");
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    new Headers(await config.resolveHeaders?.()).forEach((value, key) => headers.set(key, value));
    requestInit.headers = headers;
    for (let redirects = 0; redirects < 4; redirects++) {
      const response = await fetcher(target, requestInit);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      const next = validateMcpEndpoint(new URL(location, target));
      // Do not even issue an unauthenticated request to a different origin.
      if (next.origin !== endpoint.origin) throw new Error("MCP cross-origin redirect refused; configure the final authenticated endpoint");
      if ((requestInit.method ?? "GET").toUpperCase() !== "GET") {
        throw new Error("MCP redirected a request; configure the final endpoint before dispatching tools");
      }
      target = next;
    }
    throw new Error("MCP endpoint exceeded the redirect limit");
  };
}

async function providerTransport(options: McpProviderOptions): Promise<Transport> {
  if (options.createTransport) return options.createTransport();
  const config = options.transport;
  if (!config) throw new Error("MCP provider requires a transport configuration");
  if (config.kind === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ? [...config.args] : undefined,
      cwd: config.cwd,
      env: { ...getDefaultEnvironment(), ...await config.resolveEnvironment?.() },
      stderr: "inherit",
    });
  }
  const endpoint = validateMcpEndpoint(config.url);
  return new StreamableHTTPClientTransport(endpoint, {
    fetch: scopedFetch(endpoint, options, config),
    reconnectionOptions: {
      maxRetries: 0, maxReconnectionDelay: 1000,
      initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1,
    },
  });
}

function requestOptions(context: ToolExecutionContext | undefined, timeoutMs: number) {
  return {
    ...(context?.signal ? { signal: context.signal } : {}),
    timeout: context?.deadline === undefined
      ? timeoutMs
      : Math.max(1, Math.min(timeoutMs, context.deadline - Date.now())),
  };
}

export function createMcpProvider(options: McpProviderOptions): McpProvider {
  if (!/^[a-z][a-z0-9_-]*$/.test(options.id)) throw new Error("MCP provider id must be a stable lowercase identifier");
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxPages = options.maxCatalogPages ?? 100;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error("MCP timeout and catalog page limit must be positive");
  }
  const metadata: ContextProviderMetadata = {
    id: options.id,
    name: options.name ?? options.id,
    description: options.description ?? "Tools from an MCP connection",
    capabilities: options.capabilities ?? [],
  };
  return {
    metadata,
    async connect(): Promise<ConnectedMcpProvider> {
      const client = new Client({ name: "openfunction", version: "1.0.0" }, { capabilities: {} });
      // No sampling/elicitation capabilities are advertised. The protocol's
      // default handler rejects unsupported methods; no fabricated approvals.
      let connected = false;
      let stale = false;
      let activeCalls = 0;
      let refreshing = false;
      let invalidations = 0;
      let generation = 0;
      let catalog: McpCatalogSnapshot;
      client.fallbackRequestHandler = async (request) => {
        throw new McpError(ErrorCode.MethodNotFound,
          `Upstream ${request.method} requires a trusted host callback. No approval or sampled response was supplied; resume through a host that supports this request.`);
      };
      client.onclose = () => { connected = false; stale = true; invalidations++; };
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => { stale = true; invalidations++; });

      async function discover(): Promise<McpCatalogSnapshot> {
        const discovered: Tool[] = [];
        const cursors = new Set<string>();
        const names = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < maxPages; page++) {
          const response = await client.listTools(cursor === undefined ? {} : { cursor }, { timeout: timeoutMs });
          for (const tool of response.tools) {
            if (names.has(tool.name)) throw new Error(`MCP catalog repeated tool: ${tool.name}`);
            names.add(tool.name);
            discovered.push(structuredClone(tool));
          }
          cursor = response.nextCursor;
          if (cursor === undefined) break;
          if (cursors.has(cursor)) throw new Error("MCP catalog repeated its pagination cursor");
          cursors.add(cursor);
          if (page === maxPages - 1) throw new Error("MCP catalog exceeded its page limit");
        }
        const immutable = freezeJson(discovered);
        let allowed = options.toolAllowlist ? new Set(options.toolAllowlist) : names;
        if (options.approveCatalog) {
          const approved = new Set(await options.approveCatalog(immutable));
          allowed = new Set([...allowed].filter((name) => approved.has(name)));
          for (const name of approved) if (!names.has(name)) throw new Error(`MCP approval named an unavailable tool: ${name}`);
        }
        if (options.toolAllowlist) {
          for (const name of options.toolAllowlist) if (!names.has(name)) throw new Error(`MCP allowlist tool is unavailable: ${name}`);
        }
        const tools = freezeJson(discovered.filter((tool) => allowed.has(tool.name)));
        generation++;
        return freezeJson({
          generation, tools,
          digest: createHash("sha256").update(JSON.stringify(tools)).digest("hex"),
        });
      }
      const transport = await providerTransport(options);
      try {
        await client.connect(transport, { timeout: timeoutMs });
        connected = true;
        catalog = await discover();
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
      }
      return {
        metadata,
        get catalog() { return catalog; },
        get catalogStale() { return stale; },
        createTools(): ToolDefinition[] {
          const snapshot = catalog;
          return snapshot.tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? tool.title ?? `Call upstream tool ${tool.name}`,
            inputSchema: tool.inputSchema as InputSchema,
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
            ...(tool.outputSchema ? { outputSchema: tool.outputSchema as InputSchema } : {}),
            ...(tool._meta ? { _meta: tool._meta } : {}),
            tags: ["context", `context:${options.id}`, "mcp"],
            // Discovery hints do not authorize effects or prove retry safety.
            replayPolicy: "never",
            handler: async (params, context): Promise<ToolResult> => {
              if (!connected || stale || snapshot.generation !== catalog.generation) {
                return {
                  success: false, executionOutcome: "failed",
                  error: "MCP catalog is disconnected or stale. Reconnect or explicitly refresh at a safe session boundary before dispatch.",
                };
              }
              if (context?.signal?.aborted || (context?.deadline !== undefined && context.deadline <= Date.now())) {
                return { success: false, executionOutcome: "failed", error: "MCP call cancelled before upstream dispatch" };
              }
              activeCalls++;
              try {
                const result = CallToolResultSchema.parse(await client.callTool({ name: tool.name, arguments: params }, CallToolResultSchema, requestOptions(context, timeoutMs)));
                const errorText = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
                return {
                  success: !result.isError,
                  executionOutcome: result.isError
                    ? options.isAuthoritativeRejection?.(result, tool.name) ? "failed" : "unknown"
                    : "succeeded",
                  ...(result.isError ? { error: errorText || "Upstream MCP tool reported an error; reconcile its effect before retrying" } : {}),
                  content: result.content,
                  ...(result.structuredContent === undefined ? {} : {
                    data: result.structuredContent, structuredContent: result.structuredContent,
                  }),
                  ...(result._meta === undefined ? {} : { _meta: result._meta }),
                };
              } catch (error) {
                return {
                  success: false, executionOutcome: "unknown",
                  error: `Upstream MCP outcome is unknown: ${safeError(error)}. Reconcile the effect before retrying; no call was automatically retried.`,
                };
              } finally {
                activeCalls--;
              }
            },
          }));
        },
        async refreshCatalog() {
          if (!connected) throw new Error("MCP provider is disconnected; create a new connection");
          if (activeCalls || refreshing) throw new Error("MCP catalog refresh requires a boundary with no active calls or refresh");
          stale = true;
          refreshing = true;
          const before = invalidations;
          try {
            catalog = await discover();
            stale = invalidations !== before;
            return catalog;
          } finally {
            refreshing = false;
          }
        },
        async healthCheck() {
          return { ok: connected && !stale, ...(!connected || stale ? { error: "MCP connection is disconnected or catalog needs refresh" } : {}) };
        },
        async disconnect() {
          connected = false;
          stale = true;
          await client.close();
        },
      };
    },
  };
}
