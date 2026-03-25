# Architecture

openFunctions is easiest to understand if you start from the runtime it is built on:

`ToolDefinition -> ToolRegistry -> AIAdapter`

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

Normal flow:

1. `registry.execute(name, params)`
2. validate params against `inputSchema`
3. run the handler
4. return `ToolResult`

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

The MCP layer is thin by design. The registry remains the execution engine.

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

That means storage and retrieval systems do not bypass the runtime. They re-enter it.

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

## How To Think About openFunctions

Use this order:

1. write a tool
2. register it
3. execute it through MCP or chat
4. compose multiple tools with workflows
5. add agents only when the model needs discretion
6. add memory or RAG only when state or retrieval is required

If you keep the runtime in mind, the rest of the framework stays predictable.
