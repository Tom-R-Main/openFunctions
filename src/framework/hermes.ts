/** Hermes Agent MCP configuration helpers. */

import type { ToolRegistry } from "./registry.js";
import {
  selectRuntimeTools,
  type RuntimeToolSelectionOptions,
} from "./runtime-tool-bridge.js";

export interface HermesMcpToolFilter {
  include?: string[];
  exclude?: string[];
  resources?: boolean;
  prompts?: boolean;
}

export interface HermesMcpStdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;
  connect_timeout?: number;
  supports_parallel_tool_calls?: boolean;
  tools?: HermesMcpToolFilter;
}

export interface HermesMcpConfig {
  mcp_servers: Record<string, HermesMcpStdioServerConfig>;
}

export interface CreateHermesMcpConfigOptions
  extends Pick<RuntimeToolSelectionOptions, "filter"> {
  /** Stable key under Hermes' `mcp_servers` map. */
  serverName?: string;
  /** Executable Hermes should spawn, for example `node` or `npx`. */
  command: string;
  /** Arguments passed to the executable. Prefer absolute entrypoint paths. */
  args?: string[];
  /** Environment passed to the MCP subprocess. Do not hard-code secrets. */
  env?: Record<string, string>;
  /** Per-tool timeout in seconds. Hermes currently defaults to 300. */
  timeout?: number;
  /** Initial connection timeout in seconds. Hermes currently defaults to 60. */
  connectTimeout?: number;
  /** Opt this server into concurrent tool calls. */
  supportsParallelToolCalls?: boolean;
  /** Additional server tool names to exclude after the generated allowlist. */
  exclude?: string[];
  /** Whether Hermes should expose MCP resource utility wrappers. */
  resources?: boolean;
  /** Whether Hermes should expose MCP prompt utility wrappers. */
  prompts?: boolean;
}

/**
 * Build a merge-ready `config.yaml` object for Hermes Agent.
 *
 * The generated include list snapshots the selected registry names. That keeps
 * a newly connected MCP server least-privilege by default instead of silently
 * exposing tools added later.
 */
export function createHermesMcpConfig(
  registry: ToolRegistry,
  options: CreateHermesMcpConfigOptions,
): HermesMcpConfig {
  const serverName = options.serverName ?? "openfunctions";
  assertNonEmpty("serverName", serverName);
  assertNonEmpty("command", options.command);
  assertPositive("timeout", options.timeout);
  assertPositive("connectTimeout", options.connectTimeout);

  const include = selectRuntimeTools(registry, options).map(
    ({ tool }) => tool.name,
  );
  const tools: HermesMcpToolFilter = { include };
  if (options.exclude?.length) tools.exclude = [...options.exclude];
  if (options.resources !== undefined) tools.resources = options.resources;
  if (options.prompts !== undefined) tools.prompts = options.prompts;

  return {
    mcp_servers: {
      [serverName]: {
        command: options.command,
        ...(options.args ? { args: [...options.args] } : {}),
        ...(options.env ? { env: { ...options.env } } : {}),
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        ...(options.connectTimeout === undefined
          ? {}
          : { connect_timeout: options.connectTimeout }),
        ...(options.supportsParallelToolCalls === undefined
          ? {}
          : {
              supports_parallel_tool_calls:
                options.supportsParallelToolCalls,
            }),
        tools,
      },
    },
  };
}

function assertNonEmpty(field: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must not be empty`);
  }
}

function assertPositive(field: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new Error(`${field} must be a positive number`);
  }
}
