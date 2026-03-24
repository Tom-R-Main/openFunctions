# openFunctions — AI Assistant Context

## What This Is
A TypeScript framework for building MCP (Model Context Protocol) servers.
Students define AI-callable tools using `defineTool()`. Tools work with
Claude (MCP), Gemini (function calling), and OpenAI (tools API).

## Architecture

```
src/
  framework/         # Core framework — don't edit
    tool.ts          # defineTool(), ok(), err()
    store.ts         # createStore() — JSON file persistence
    pg-store.ts      # createPgStore() — Postgres persistence (optional)
    registry.ts      # ToolRegistry — manages tools, provider format adapters
    server.ts        # startServer() — MCP server wrapper
    types.ts         # TypeScript interfaces
    index.ts         # Re-exports everything
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
  cli.ts             # Interactive CLI for testing tools
gemini-bridge/
  bridge.ts          # Converts tools → Gemini function calling format
  test-with-gemini.ts# Chat with Gemini using your tools
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
