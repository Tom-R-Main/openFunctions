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

// Postgres store (optional — requires DATABASE_URL)
export { createPgStore, closePgPool } from "./pg-store.js";

// Tool registry
export { ToolRegistry, registry } from "./registry.js";

// MCP server
export { startServer } from "./server.js";
export type { ServerOptions } from "./server.js";

// System prompts
export { composePrompt, autoToolGuide, loadPromptPreset, resolvePrompt, listPresets } from "./prompts.js";
export type { PromptOptions } from "./prompts.js";

// Structured output
export { forceStructuredOutput, createExtractor } from "./structured.js";
export type { StructuredOutputOptions, StructuredResult } from "./structured.js";

// Memory
export { createConversationMemory, createFactMemory, createMemoryTools } from "./memory.js";
export type { Thread, Fact, ConversationMemory, FactMemory } from "./memory.js";

// Workflows
export { pipe, toolStep, llmStep } from "./workflows.js";
export type { Step, Workflow } from "./workflows.js";

// RAG (Retrieval-Augmented Generation)
export { createRAG } from "./rag.js";
export type { RAG, RAGOptions, RAGDocument, RAGChunk, RAGSearchResult } from "./rag.js";

// Agents
export { defineAgent, runCrew } from "./agents.js";
export type { AgentDefinition, Agent, AgentResult, CrewOptions, CrewResult } from "./agents.js";

// Context Providers
export { connectProvider, contextPrompt, checkProviderHealth } from "./context.js";
export type {
  ContextProvider,
  ConnectedProvider,
  ContextProviderMetadata,
  ContextCapability,
} from "./context.js";

// Chat Agent
export { createChatAgent } from "./chat-agent.js";
export type {
  ChatAgent,
  ChatAgentConfig,
  ChatResult,
  ChatStreamChunk,
  ChatAgentChatOptions,
  ServeOptions,
  MemoryConfig,
  PeerConfig,
} from "./chat-agent-types.js";

// Test runner
export { runTests } from "./test-runner.js";

// Types (for students who want TypeScript help)
export type {
  ToolDefinition,
  ToolResult,
  ToolExample,
  ToolTest,
  InputSchema,
  JsonSchemaProperty,
  GeminiFunctionDeclaration,
  AnthropicTool,
  OpenAIFunction,
} from "./types.js";
