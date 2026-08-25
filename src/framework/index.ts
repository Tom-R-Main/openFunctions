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
export type { Store, StoreMutation } from "./store.js";

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
export type {
  Thread,
  Fact,
  ConversationMemory,
  JournalConversationMemory,
  FactMemory,
} from "./memory.js";

// Workflows
export { pipe, toolStep, llmStep } from "./workflows.js";
export type { Step, Workflow, ParallelResult } from "./workflows.js";

// RAG (Retrieval-Augmented Generation)
export { createRAG } from "./rag.js";
export type { RAG, RAGOptions, RAGDocument, RAGChunk, RAGSearchResult } from "./rag.js";

// Agents
export { defineAgent, runCrew, runRalph, runTaskCrew } from "./agents.js";
export type {
  AgentDefinition,
  Agent,
  AgentResult,
  AgentRunOptions,
  CrewOptions,
  CrewResult,
  RalphOptions,
  RalphResult,
  RalphStopReason,
  RalphCrewSummary,
  CrewTask,
  TaskResult,
  TaskCrewOptions,
  TaskCrewResult,
} from "./agents.js";

// Role-based model policy
export {
  MODEL_POLICY_VERSION,
  MODEL_ROLES,
  MODEL_PROVIDERS,
  PROVIDER_MODEL_DEFAULTS,
  normalizeModelProvider,
  resolveModelSelection,
  customAdapterSelection,
} from "./models.js";
export type {
  ModelRole,
  ModelProvider,
  ModelDefault,
  ModelSelection,
  ResolveModelSelectionOptions,
} from "./models.js";

// Legible execution records
export {
  RUN_SCHEMA_VERSION,
  RunExecutionError,
  digestValue,
  createCapabilitySnapshot,
  createRunManifest,
  completeRun,
  failRun,
  cancelRun,
  createOutcomeClaim,
  evaluateAssurance,
  decideFulfillment,
} from "./runs.js";
export type {
  RunStatus,
  CapabilitySnapshotEntry,
  CapabilitySnapshot,
  RunEnvironmentRef,
  RunManifest,
  RunFailure,
  RunToolEffectReceipt,
  RunToolEffects,
  RunRecord,
  OutcomeClaim,
  VerificationMethod,
  VerificationMethodKind,
  VerificationAttempt,
  AssurancePolicy,
  AssuranceBundle,
  FulfillmentDecision,
  GoalTransition,
  RunContext,
  CreateRunManifestInput,
} from "./runs.js";

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
  ChatSessionConfig,
  ChatResult,
  ChatStreamChunk,
  ChatAgentChatOptions,
  ChatAgentResetOptions,
  ExternalMessageOptions,
  ServeOptions,
  MemoryConfig,
  PeerConfig,
} from "./chat-agent-types.js";
export type {
  AdapterSessionState,
  ChatContent,
  ContentPart,
  TextContentPart,
  ImageContentPart,
} from "./adapters/types.js";

// Event-sourced session kernel
export {
  SESSION_EVENT_SCHEMA_VERSION,
  InMemorySessionEventStore,
  JsonlSessionEventStore,
  SessionConcurrencyError,
  SessionInvariantError,
  SessionKernel,
  digestJson,
  snapshotJson,
} from "./session.js";
export type {
  JsonObject,
  JsonValue,
  JsonlSessionEventStoreOptions,
  ModelHistoryReference,
  ModelRequestSnapshot,
  ModelResponseSnapshot,
  ModelToolSnapshotReference,
  SessionKernelOptions,
  SessionEvent,
  SessionEventContext,
  SessionEventDataMap,
  SessionEventInput,
  SessionEventOf,
  SessionEventStore,
  SessionEventType,
  StepOutcome,
  ToolResultOutcome,
} from "./session.js";

// Test runner
export { runTests } from "./test-runner.js";

// Agent runtime bridges
export {
  toOpenclawTools,
  toolToOpenclaw,
  toOpenclawToolPluginTools,
} from "./openclaw.js";
export type {
  OpenclawToolShape,
  OpenclawToolResult,
  OpenclawToolContentBlock,
  ToOpenclawToolsOptions,
  OpenclawToolPluginExecutionContext,
  OpenclawToolPluginToolShape,
  ToOpenclawToolPluginToolsOptions,
} from "./openclaw.js";
export { toPiTools, toolToPi, registerPiTools } from "./pi.js";
export type {
  PiTextContent,
  PiToolResult,
  PiExtensionContextLike,
  PiToolShape,
  PiExtensionApiLike,
  ToPiToolsOptions,
} from "./pi.js";
export { createHermesMcpConfig } from "./hermes.js";
export type {
  HermesMcpToolFilter,
  HermesMcpStdioServerConfig,
  HermesMcpConfig,
  CreateHermesMcpConfigOptions,
} from "./hermes.js";

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
  CommitmentClass,
  IdempotencyBehavior,
  CapabilityContract,
} from "./types.js";
