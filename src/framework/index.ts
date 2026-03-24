/**
 * OpenFunction Framework
 *
 * Build AI agent tools in minutes. Define once, use with any AI.
 *
 * @example
 * ```ts
 * import { defineTool, registry, startServer, ok, err } from './framework/index.js';
 *
 * const myTool = defineTool({
 *   name: 'hello_world',
 *   description: 'Says hello to someone',
 *   inputSchema: {
 *     type: 'object',
 *     properties: {
 *       name: { type: 'string', description: 'Who to greet' },
 *     },
 *     required: ['name'],
 *   },
 *   handler: async ({ name }) => ok({ greeting: `Hello, ${name}!` }),
 * });
 *
 * registry.register(myTool);
 * startServer(registry, { name: 'hello-server' });
 * ```
 */

// Core tool definition
export { defineTool, ok, err } from "./tool.js";

// Persistent store
export { createStore } from "./store.js";
export type { Store } from "./store.js";

// Tool registry
export { ToolRegistry, registry } from "./registry.js";

// MCP server
export { startServer } from "./server.js";
export type { ServerOptions } from "./server.js";

// Types (for students who want TypeScript help)
export type {
  ToolDefinition,
  ToolResult,
  ToolExample,
  InputSchema,
  JsonSchemaProperty,
  GeminiFunctionDeclaration,
  AnthropicTool,
  OpenAIFunction,
} from "./types.js";
