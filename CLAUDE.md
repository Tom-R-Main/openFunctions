# openFunctions — AI Assistant Context

## What This Is
A TypeScript framework for building AI-callable tools, agents, and context
providers. Tools work with Claude (MCP), Gemini (function calling), and
OpenAI (tools API). Context providers connect external systems (ExecuFunction,
Obsidian, Notion) to the agent runtime.

## Architecture

```
src/
  framework/         # Core framework — don't edit
    tool.ts          # defineTool(), ok(), err()
    store.ts         # createStore() — JSON file persistence
    pg-store.ts      # createPgStore() — Postgres persistence (optional)
    registry.ts      # ToolRegistry — manages tools, provider format adapters
    chat-agent.ts    # createChatAgent() — composable chat agent factory
    chat-agent-types.ts # ChatAgent, ChatAgentConfig, ChatResult types
    chat-agent-resolve.ts # Config resolution, provider auto-detection
    chat-agent-http.ts # HTTP server for agent.serve()
    context.ts       # Context provider interface — connectProvider(), contextPrompt()
    server.ts        # startServer() — MCP server wrapper
    types.ts         # TypeScript interfaces
    index.ts         # Re-exports everything
  providers/         # Context provider implementations
    execufunction/   # ExecuFunction reference provider (tasks, calendar, CRM, etc.)
  examples/          # Read these for patterns
    study-tracker/   # CRUD pattern (beginner)
    bookmark-manager/# Arrays + search (beginner)
    quiz-generator/  # Stateful + complex params (advanced)
    expense-splitter/# Math + calculations (intermediate)
    workout-logger/  # Date filtering + aggregation (intermediate)
    recipe-keeper/   # Rich nested data + random (beginner)
    dictionary/      # External API wrapper (intermediate)
    ai-tools/        # Tool that calls an LLM (advanced)
    utilities/       # Stateless helpers — no store needed (beginner)
  my-tools/          # Student builds here
    index.ts         # Add tools to the myTools array
  index.ts           # Entry point — registers all tools, starts MCP server
test-client/
  cli.ts                  # Interactive CLI for testing tools (npm run test-tools)
  run-tests.ts            # Tool-test runner — runs `tests` arrays on tool defs
  run-framework-tests.ts  # Framework unit tests via node:test (zero deps)
scripts/
  chat.ts            # Multi-provider chat (Claude, Gemini, OpenAI, xAI)
  create-tool.ts     # Scaffold a new tool
  generate-docs.ts   # Generate tool docs
```

## How to Define a Tool

```typescript
import { defineTool, ok, err } from "../framework/index.js";

// 1. Define param types (gives you TypeScript autocomplete)
interface MyParams {
  name: string;
  count?: number;
}

// 2. Define the tool
export const myTool = defineTool<MyParams>({
  name: "my_tool",              // snake_case, lowercase
  description: "What this tool does — the AI reads this to decide when to use it",
  inputSchema: {
    type: "object",
    properties: {
      name:  { type: "string",  description: "What this param is for" },
      count: { type: "number",  description: "Optional count (default 1)" },
    },
    required: ["name"],
  },
  handler: async ({ name, count }) => {
    // Your logic here
    if (!name) return err("Name is required");
    return ok({ greeting: `Hello ${name}!`, count: count ?? 1 });
  },
});

// 3. Add to the exported array
export const myTools = [myTool];
```

**Why params appear twice:** The TypeScript interface gives YOU type safety.
The `inputSchema` gives the AI a description of each parameter. They should
match, but the schema has descriptions the AI reads to understand the tool.

## Persistence

Two built-in options with the same API:

```typescript
// JSON files (zero setup, saves to .data/<name>.json)
import { createStore } from "../framework/index.js";
const tasks = createStore<Task>("tasks");

// Postgres (needs DATABASE_URL env var)
import { createPgStore } from "../framework/index.js";
const tasks = await createPgStore<Task>("tasks");
```

**Store API:** `get(id)`, `set(id, value)`, `delete(id)`, `getAll()`,
`entries()`, `has(id)`, `size`, `clear()`

Not every tool needs persistence — see the `utilities/` and `dictionary/`
examples for stateless tools.

## Where to Put New Tools

1. Define tools in `src/my-tools/index.ts`
2. Add them to the `myTools` array export
3. They are automatically registered by `src/index.ts`
4. Test with `npm run test-tools` or `npm run dev`

## Framework Exports

All imports come from `"../framework/index.js"`:

| Export | Purpose |
|--------|---------|
| `defineTool` | Define a new tool |
| `ok(data, message?)` | Return success result |
| `err(errorString)` | Return error result |
| `createStore<T>(name)` | JSON file store |
| `createPgStore<T>(name)` | Postgres store (async init) |
| `closePgPool()` | Shut down Postgres pool |
| `registry` | Global tool registry instance |
| `startServer(registry, opts)` | Start MCP server |
| `connectProvider(provider, registry)` | Connect a context provider and register its tools |
| `contextPrompt(providers[])` | Build system prompt context from connected providers |
| `checkProviderHealth(providers[])` | Health check all connected providers |
| `createChatAgent(config?)` | Composable chat agent (tools + memory + context + adapter) |
| `defineAgent(def)` | Define a single-task agent with role/goal/filtered tools |
| `runCrew(opts, task, adapter, registry)` | Run multiple agents — sequential, parallel, or `mode: "ralph"` |
| `runRalph(agent, task, adapter, registry, opts)` | Iterate one agent until completion phrase or maxIterations |
| `toOpenclawTools(registry, opts?)` | Convert a ToolRegistry into openclaw's `AnyAgentTool[]` shape |
| `toolToOpenclaw(tool, registry, opts?)` | Convert a single tool to openclaw shape |

## ESM Import Requirement

ALL imports MUST use `.js` extensions even though files are `.ts`:
```typescript
// Correct:
import { defineTool } from "../framework/index.js";

// Wrong (will fail at runtime):
import { defineTool } from "../framework/index";
```
This is a Node.js ESM requirement — TypeScript resolves `.js` → `.ts` automatically.

## Testing

```bash
npm run test-tools   # Interactive CLI — test any tool, no API key needed
npm run dev          # Auto-restarts on save (tsx watch)
npm run inspect      # MCP Inspector web UI
npm run gemini       # Chat with Gemini using your tools (needs GEMINI_API_KEY)
npm start            # Start MCP server for Claude Desktop
```

## Ralph Loops

For tasks where iteration > one-shot (test-coverage drives, refactor sweeps,
"fix every lint error" passes), wrap an agent in a Ralph loop:

```typescript
import { defineAgent, runRalph } from "../framework/index.js";

const fixer = defineAgent({
  name: "lint_fixer",
  role: "Senior TypeScript engineer",
  goal: "Reach zero lint errors across src/",
  toolTags: ["filesystem", "shell"],
});

const result = await runRalph(fixer, `
  Fix every lint error in src/. After each change run \`npm run lint\`.
  When the report shows 0 errors, output <promise>LINT_DONE</promise>.
`, adapter, registry, {
  maxIterations: 25,                      // hard safety net
  completionPromise: "<promise>LINT_DONE</promise>",
  onIteration: (i, r) => console.log(`iter ${i}: ${r.toolCalls.length} tool calls`),
});

if (!result.completed) console.warn(`stopped: ${result.stopReason}`);
```

**Key idea:** each iteration calls `agent.run(task)` fresh — no in-conversation
history carries over. State persists between iterations via tool side-effects
(stores updated by handlers, files written, facts in memory). Wrap a unique
marker around the completion phrase (`<promise>...</promise>`) so the model
can't trip the check by paraphrasing earlier text.

For multi-agent loops, use `runCrew({ mode: "ralph", ralph: {...} })` — runs
the sequential crew once per iteration, checks completion against the last
agent's output. Returns `CrewResult` with a `ralph` summary attached.

## Integrations

### Siftable provider (`src/providers/execufunction/`)

Wraps `@siftable/mcp-server@^1.2.9`. Exports `createSiftableProvider()`
(and a deprecated `createExecuFunctionProvider` alias). 31 tools across
10 domains today; ~80 more SDK methods reachable via `client.raw()`.

Auth resolution: explicit option → `SIFT_PAT` env → `EXF_PAT` env.
Same chain for `SIFT_API_URL` and `SIFT_WORKSPACE_ID`.

Live e2e test: `tsx scripts/test-siftable-live.ts` (gated on
`SIFT_PAT`/`EXF_PAT`).

### openclaw bridge (`src/framework/openclaw.ts`)

`toOpenclawTools(registry, options?)` converts any openFunctions
`ToolRegistry` into the shape openclaw's `api.registerTool()` accepts.
Default formatter mirrors the MCP server's behavior (stringify on
success, error block + `isError` on failure). No runtime dep on
`@openclaw/plugin-sdk` — the shape is defined locally.

Plugin authors add `@openclaw/plugin-sdk` as a devDep, then:

```ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { toOpenclawTools } from "openfunction/framework/openclaw";
import { registry } from "./your-tools.js";

export default definePluginEntry({
  id: "your-plugin",
  name: "Your Plugin",
  description: "...",
  register(api) {
    for (const tool of toOpenclawTools(registry)) api.registerTool(tool);
  },
});
```

Two plugins ship in `plugins/`:
- `openclaw-execufunction/` — Siftable for openclaw (publishable).
- `openclaw-openfunctions/` — bridge reference (private, monorepo-only).

## Tool Patterns

| Pattern | Example | Key Concept |
|---------|---------|-------------|
| CRUD + Store | study-tracker | createStore, get/set/delete |
| Search + Filter | bookmark-manager | getAll() + .filter() |
| Stateful Game | quiz-generator | Multi-step interaction |
| Math/Calculations | expense-splitter | Aggregation, settlement algorithm |
| Date Aggregation | workout-logger | Date filtering, stats, recommendations |
| Nested Data | recipe-keeper | Arrays of objects, random selection |
| External API | dictionary | fetch(), response parsing, error handling |
| AI-Powered | ai-tools | Tool calls Gemini internally |
| Stateless Utility | utilities | Pure functions, no store needed |

## Common Pitfalls

- **Tool name not snake_case** → throws at registration (regex: `/^[a-z][a-z0-9_]*$/`)
- **Missing `.js` extension** in import path → runtime module not found error
- **Forgot `async` on handler** → handler must be async, return `Promise<ToolResult>`
- **Missing `inputSchema.properties`** → throws at registration (even if empty, use `{}`)
- **Description too short** → throws if < 5 characters
- **Forgot to add tool to exported array** → tool won't be registered
- **Mutating store data directly** → use `store.set(id, { ...item, field: newValue })` to persist changes
