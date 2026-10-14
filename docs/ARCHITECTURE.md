# Architecture

openFunctions is easiest to understand if you start from the runtime it is built on:

`ToolDefinition -> ToolRegistry -> ToolExecutor -> adapter or host`

Everything else in the framework composes on top of that path.

## Core Runtime

### 1. Tool definition

`defineTool()` is the source of truth.

A tool bundles:

- a stable name
- a description the AI reads
- a JSON schema for parameters
- an async handler
- optional tags, examples, and tests
- an optional capability contract for authority, side effects, idempotency, and verification

The TypeScript generic helps the developer. The `inputSchema` helps the model.

### 2. Registration

`ToolRegistry` stores tools once and makes them available everywhere:

- direct execution with `registry.execute()`
- MCP exposure through `startServer()`
- provider adapters through `toGeminiFormat()`, `toAnthropicFormat()`, and `toOpenAIFormat()`
- workflow steps through `toolStep()`
- agent execution through filtered registries

This is the framework’s universal primitive.

### 3. Adapter translation

`AIAdapter` is the provider boundary. Adapters translate the same registered tools into each provider’s tool schema and normalize responses back into:

- `text`
- or `toolCall`

That is why the same tool set works with Claude, Gemini, OpenAI, xAI, and OpenRouter.

## Execution Paths

### Tool execution with validation

`registry.execute(name, params, context?)` preserves the ordinary result API.
`executeDetailed()` also returns exact model content and an execution receipt.
The executor captures parameters and the tool specification, validates the
selected JSON Schema dialect, resolves policy, schedules admission, persists a
start when configured, invokes the handler, normalizes its result once, checks
output, and persists the canonical receipt before delivery.

The optional handler argument is trusted `ToolExecutionContext`. Tool arguments
cannot establish identity, scope, grant validity, or lease custody. Governed
mode requires a policy; even local mode refuses a capability requiring authority
when no policy has independently validated its binding. Discovery hints confer
no authority.

Unclassified tools run exclusively. Reviewed `parallel-safe` tools share a
bounded FIFO scheduler; writes form barriers across callers sharing a registry.
`registry.project()` preserves execution and policy services. Trusted synthetic
delegation uses `withChildExecution()` to inherit a private reservation and
narrowed authority; a read reservation cannot become a write reservation.

Throws, invalid output after entry, and failed result persistence preserve
unknown effect certainty. Cancellation stops admissions and reaches cooperative
handlers; a settled result is retained after late cancellation. Direct calls to
`tool.handler()` remain possible and bypass these guarantees.

This same path is used by:

- the MCP server
- the interactive chat loop
- agents
- crews
- workflows

### MCP server

`startServer()` exposes the registry through Model Context Protocol:

1. clients ask for tool schemas
2. the server returns registered tools
3. clients call a tool
4. the server delegates to `registry.execute()`

The MCP layer is thin by design. `createMcpServer()` provides connect/close
lifecycle control; `startServer()` remains the stdio convenience. The executor
owns execution semantics. Discovery preserves annotations, output schemas, and
provider metadata; structured payloads retain their advertised shape, with
receipt metadata carried separately. Diagnostics use stderr.

### Durable work and separate journals

`SessionKernel` preserves chat and provider replay invariants. Standalone
`ExecutionJournal` and `WorkAttemptJournal` record action and attempt state
without inventing chat turns. They use protected JSONL files, sequence checks,
cross-process ownership, committed-line recovery, and fsync. Recovery reads
evidence without dispatching tools.

Session readers accept ordered v1/v2 events. Writers emit v2; rejected or
cancelled calls need no fictitious start, but their result requires a bound
not-started receipt. Before the first v2 write, the durable store preserves the
existing bytes in a protected `.pre-v2` copy. Old binaries cannot read v2, so
downgrade requires that preserved copy, not deletion of new evidence.

The bounded controller owns one selected attempt, rather than a model loop.
It resolves persisted grants, coordinates leases and operation identities,
executes catalog-bound steps, and records actual command/readback evidence.
Lease renewal has a private execution lane that progresses during a long step;
terminal transitions and renewals remain serialized with each other.

The controller's internal modules separate the checks from their ordered effects:

| Module | Responsibility |
| --- | --- |
| `controller.ts` | Owns attempt state, admission/lifecycle locks, persistence, timers, and dispatch. |
| `authority.ts` | Resolves grants and checks current contract, catalog, path, lease, and receipt bindings. |
| `attempt-verification.ts` | Selects trusted verification bindings, collects evidence, and validates completion proof. |
| `attempt-recovery.ts` | Recovers saved calls and backend operations, performs independent readback, and restores lifecycle under the controller's locks. |
| `attempt-state.ts` | Defines the existing persisted attempt shape and internal effect signatures. |

Recovery first accounts saved outputs, then recovers oracle, step, and verification
calls. It records recovered outputs before reconciling backend operations, resolves
unknown effects through independent readback, and finally restores lifecycle.
The recovery runtime exposes the controller effects explicitly; it does not own
locks or a second copy of state. Completion proof checking returns a synchronous
subject fence that the controller runs immediately before terminal dispatch,
after the final awaited authority checks.

Verification binds the active plan, environment, source input manifest,
fingerprints before/after execution, and mutation epoch. Relevant writes
invalidate proof. Completion rechecks current subject and authoritative coverage
and uses independent readback. Passing tests and accepted queue status remain
separate facts. Unknown effects require reconciliation; an interrupted command
is never blindly rerun because its submission response was lost.

Trusted step bindings can supply `prepareReconciliation` and `reconcileEffect`
for an independent readback. The controller saves the input-bound readback
metadata before dispatch. Explicit reconciliation runs the read-only oracle
through the executor under current grant, catalog, path, and lease checks, then
records a separate receipt linked to the original uncertain execution. The
original receipt stays unchanged. Missing, mismatched, or inconclusive readback
keeps the attempt blocked; completion still requires fresh verification.

Artifacts are immutable, opaque-ID outputs with verified SHA-256 and bounded
reads. The work profile uses a 32 KiB model output budget and a 64 MiB artifact
quota per artifact store. Admitted work operation replies, including verification,
status and handler failures, are bounded in both canonical UTF-8 JSON and MCP's
pretty text projection. Schema and catalog rejections happen earlier in the shared
executor and use its diagnostic formatting.
Larger replies expose identity/state and evidence summaries plus an immutable
artifact containing the full canonical `ToolResult` JSON. Content digest lookup
reuses the artifact on unchanged status reads and after restart. The shipped work
profile and OpenClaw work facade expose `of_work_artifact_read` for opaque IDs
from the current selected attempt or saved previews. Reads return at most 16 KiB
as base64. Preview artifacts remain readable
after starting an attempt; current attempt receipts and evidence stay complete.
Quota exhaustion reports `artifactProjection.available: false` explicitly while
preserving the known operation's success and execution certainty. The framework
provides policy and trusted-code scope
checks, not OS isolation from malicious plugins or programs.

Work dispatch refreshes authoritative backend custody after queueing, and
terminal transitions recheck current grants after awaited proof readbacks.
The executor's optional `ExecutionJournalSink.onSettled` observer runs before
the scheduler releases its reservation, including after journal or pipeline
failure. The controller uses it to block queued effects as soon as an outcome
becomes uncertain.

Hosts can opt into `createArtifactReadTool(store)` for bounded, read-only access
to opaque artifact IDs from that store. The reader verifies the stored digest
and cannot resolve arbitrary filesystem paths.

### Interactive chat

The chat loop repeatedly:

1. sends conversation history plus registry tools to an adapter
2. checks whether the model returned text or a `toolCall`
3. executes tool calls through the registry
4. feeds tool results back into the conversation

This is the simplest place to see the runtime in action without MCP.

## Composition Layers

### Workflows

Workflows are deterministic composition.

Use them when you know the control flow ahead of time. `pipe()`, `.then()`, `.parallel()`, and `.branch()` let you build explicit pipelines around:

- tool steps
- transformation steps
- LLM steps

The macro flow is controlled by code. Only the LLM steps are adaptive.

### Agents

An agent is not a new execution engine. It is:

- a system prompt
- a filtered registry
- a reason/act/observe loop

The filtered registry is the key abstraction. Each agent only sees the tools it should use, selected by explicit tool name or by tag.

Agent loop:

1. build the filtered registry
2. compose the agent prompt
3. call `adapter.chat()`
4. if the model requests a tool, execute it through the filtered registry
5. add the tool result to history
6. repeat until the model returns text or max rounds is hit

That is why agents stay legible: they are still just tools plus a loop.

Every agent loop also emits a `RunRecord`. The run captures the exact resolved
model, instruction and capability digests, correlation IDs, limits, and its own
terminal status. A successful text response may create an `OutcomeClaim`, but
verification and task fulfillment remain separate records. See [Legible
runs](RUNS.md).

### Crews

Crews are composition over agents.

- sequential mode threads one agent’s output into the next agent’s prompt context
- parallel mode runs all agents on the same task independently

Delegation is implemented with synthetic tools such as `delegate_to_researcher`. The model sees delegation as a tool call; the runtime turns that into another agent execution.

## Repeating Design Patterns

### Filtered registry

This is the main agent pattern.

Instead of giving every model every tool, openFunctions builds a smaller registry for the current task or persona. That keeps behavior tighter and makes agent design understandable.

### Synthetic tool

Several advanced features are built by manufacturing tools at runtime:

- crew delegation tools
- structured-output extraction tools

This is an important design choice: provider-specific features are avoided when a tool-shaped abstraction can solve the same problem portably.

### Tool-wrapped subsystem

Higher-level modules can expose themselves back into the runtime as tools:

- `createMemoryTools(...)`
- `rag.createTools()`
- `connectedProvider.createTools()`

That means storage, retrieval, and context systems do not bypass the runtime. They re-enter it.

## Context Providers

A context provider connects an external system to the agent runtime. The pattern follows the same composition model as memory and RAG:

```text
ContextProvider → .connect() → ConnectedProvider → .createTools() → registry
                                                  → .buildContext() → system prompt
```

### Provider interface

A context provider has two phases:

1. **Define** — a factory function returns a `ContextProvider` with cheap metadata and a `connect()` method
2. **Connect** — `connect()` initializes auth and resources, returns a `ConnectedProvider` with tools

```typescript
const exf = await connectProvider(
  createExecuFunctionProvider({ token: "..." }),
  registry,
);
```

`connectProvider()` handles tagging: all tools are automatically tagged with `"context"` and `"context:<providerId>"` so agents can filter by provider or by the general context tag.

### Context prompt injection

Providers can implement `buildContext()` to return a text block for system prompts:

```typescript
const context = await contextPrompt([exf, obsidian]);
const systemPrompt = composePrompt({
  role: "Personal assistant",
  context,
  toolGuide: autoToolGuide(registry),
});
```

This is how agents get situational awareness (active tasks, upcoming events) without explicit tool calls. Context is best-effort — if a provider fails, the agent continues without that context.

### Capability declaration

Providers declare capability domains in their metadata:

- `tasks`, `projects`, `calendar`, `knowledge`, `people`, `organizations`, `codebase`, `vault`, `datasets`, `documents`

This lets the framework and setup UX know what a provider offers without loading its tools. The ExecuFunction reference provider covers 7 of these domains with 17 tools.

### Health checks

`checkProviderHealth()` runs health checks across all connected providers, useful for setup UX and monitoring.

## State Layers

### Store

`createStore()` and `createPgStore()` provide persistence with the same interface. Tools can move from local JSON storage to Postgres with minimal code changes.

### Memory

Memory is structured state for threads and facts. It is not the same as retrieval:

- conversation memory stores thread history
- fact memory stores extracted or saved facts

Memory becomes AI-usable through generated tools.

### RAG

RAG is semantic retrieval over document chunks. It combines:

- chunking
- embeddings
- pgvector storage
- cosine similarity search
- optional tool exposure

See [RAG.md](RAG.md) for the full ingestion and search flow.

## Chat Agent

`createChatAgent()` is the highest-level composition primitive. It wires together an adapter, a registry, memory, and context providers into a single embeddable agent.

```text
createChatAgent(config)
  → resolve adapter (provider + model)
  → build filtered registry (tools, tags, exclusions)
  → set up memory (conversation + facts → memory tools → registry)
  → connect context providers (tools + context prompt → registry + system prompt)
  → compose system prompt (preset/prompt/markdown + context + memory awareness)
  → return ChatAgent { chat(), interactive(), serve(), reset(), destroy() }
```

The factory is async because context providers require `connect()` calls.

### Three interfaces, one agent

- `agent.chat(message)` — programmatic, returns `ChatResult { text, toolCalls, rounds, metadata }`
- `agent.chat(message, { stream: true })` — returns `AsyncIterable<ChatStreamChunk>` with tool_call, tool_result, text, and done events
- `agent.interactive()` — readline CLI loop
- `agent.serve({ port })` — HTTP server with `/chat`, `/chat/stream` (SSE), `/health`, `/reset`

### Config resolution

The config drives everything declaratively:

- `provider` resolves to an adapter factory (auto-detected from env vars if omitted)
- `preset` / `prompt` resolves to a system prompt (preset name, inline string, markdown file path, or structured PromptOptions)
- `tools` / `toolTags` / `excludeTools` build a filtered registry
- `memory` (default: on) creates conversation + fact memory and registers memory tools
- `providers` resolves string names (e.g., `"execufunction"`) to ContextProvider instances via dynamic import

### Relationship to defineAgent()

`defineAgent()` creates task-scoped agents for use inside crews and workflows. `createChatAgent()` creates session-scoped agents for direct user interaction. They use the same underlying primitives (registry, adapters, prompts) but serve different roles.

## How To Think About openFunctions

Use this order:

1. write a tool
2. register it
3. execute it through MCP or chat
4. use `createChatAgent()` when you want a full agent with memory and context
5. compose multiple tools with workflows when the control flow is known
6. use `defineAgent()` inside crews when specialized agents need to collaborate
7. add memory or RAG only when state or retrieval is required
8. add context providers when you need external systems (task management, calendars, CRM, etc.)

If you keep the runtime in mind, the rest of the framework stays predictable.

## Storage paths and acknowledgement

`createStore(name)` uses caller `cwd/.data` at creation. An explicit
`createStore(name, { dataDir: "/previous/repository/.data" })` retains access to
old data. The runtime never copies or merges stores automatically.

`createPgStore()` lazily loads its optional peer. Sync methods acknowledge the
cache; `await store.flush()` acknowledges queued database writes and surfaces
errors. Shutdown also flushes and reports failures. This does not provide
distributed atomic mutation or an event-store contract; durable chat/work
journals still require their own atomic file/CAS semantics.
