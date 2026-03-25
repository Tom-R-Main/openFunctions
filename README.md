<p align="center">
  <img src="assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Build AI agent tools in minutes.</strong> Define once, use with any AI.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#build-your-own-tools">Build Tools</a> &middot;
  <a href="#ai-providers">AI Providers</a> &middot;
  <a href="#example-domains-26-tools">Examples</a>
</p>

---

openFunctions is a TypeScript framework for building [MCP](https://modelcontextprotocol.io) (Model Context Protocol) servers — the open standard for giving AI agents tools to call. Your tools work with Claude, Gemini, ChatGPT, and any MCP-compatible client, with zero rewriting.

```
┌─────────────────────────────────────────────────────────┐
│                  Your Tool Definitions                   │
│              (define once with openFunctions)             │
└──────┬──────────┬──────────┬──────────┬────────────────┘
       │          │          │          │
  ┌────▼────┐ ┌──▼───┐ ┌───▼───┐ ┌───▼────────┐
  │ Claude  │ │Gemini│ │ChatGPT│ │ OpenRouter  │
  │  (MCP)  │ │      │ │       │ │ (any model) │
  └─────────┘ └──────┘ └───────┘ └────────────┘
```

## Quick Start

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
```

That's it. You have a working MCP server with 26 example tools across 9 domains.

## Commands

```bash
npm run test-tools          # Interactive CLI — test any tool, no API key needed
npm run dev                 # Dev mode — auto-restarts when you edit code
npm test                    # Run all automated tests
npm run chat                # Chat with AI using your tools (auto-detects API key)
npm run chat -- gemini      # Chat with Gemini specifically
npm run chat -- openai      # Chat with OpenAI (GPT-5.4)
npm run chat -- anthropic   # Chat with Claude (Sonnet 4.6)
npm run chat -- openrouter  # Chat via OpenRouter (any model)
npm run create-tool <name>  # Scaffold a new tool with tests
npm run docs                # Generate markdown reference of all tools
npm run inspect             # MCP Inspector — visual web UI
npm start                   # Start MCP server for Claude Desktop / Cursor
```

## Build Your Own Tools

Open `src/my-tools/index.ts` and start building. Here's the simplest possible tool:

```typescript
import { defineTool, ok } from "../framework/index.js";

export const rollDice = defineTool({
  name: "roll_dice",
  description: "Roll a dice with the given number of sides",
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "number", description: "Number of sides (default 6)" },
    },
  },
  handler: async ({ sides }) => {
    const result = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled: result });
  },
});

export const myTools = [rollDice];
```

Or scaffold a new tool with one command:

```bash
npm run create-tool expense_tracker
# → Creates src/my-tools/expense_tracker.ts with full pattern + passing test
# → Auto-registers in src/my-tools/index.ts
```

For full examples with typed params, persistence, and error handling, see `src/examples/`.

## Testing

Tests live inside tool definitions — no separate test files needed:

```typescript
export const createTask = defineTool({
  name: "create_task",
  // ...schema and handler...
  tests: [
    {
      name: "creates a task with title and subject",
      input: { title: "Read chapter 5", subject: "Biology" },
      expect: { success: true, data: { title: "Read chapter 5", completed: false } },
    },
    {
      name: "fails without required field",
      input: { title: "Read chapter 5" },
      expect: { success: false, errorContains: "Required parameter" },
    },
  ],
});
```

```bash
npm test
```

Parameters are automatically validated against the `inputSchema` before the handler runs. Missing required fields, wrong types, and invalid enum values are caught with clear error messages — no validation code needed in your handlers.

## Persistence

Three tiers — pick what fits:

```typescript
// Tier 1: JSON files (zero setup, saves to .data/<name>.json)
import { createStore } from "../framework/index.js";
const tasks = createStore<Task>("tasks");

// Tier 2: Postgres (same API, needs DATABASE_URL env var)
import { createPgStore } from "../framework/index.js";
const tasks = await createPgStore<Task>("tasks");

// Tier 3: Roll your own (pg, Prisma, whatever you want)
```

Tiers 1 and 2 share the same `Store` interface: `get()`, `set()`, `delete()`, `getAll()`, `has()`, `size`, `clear()`. Switching is a one-line change.

## AI Providers

Chat with any provider using your tools:

```bash
export GEMINI_API_KEY=...       # Google AI Studio (free) — https://aistudio.google.com/apikey
export OPENAI_API_KEY=...       # OpenAI — https://platform.openai.com/api-keys
export ANTHROPIC_API_KEY=...    # Anthropic — https://console.anthropic.com/settings/keys
export OPENROUTER_API_KEY=...   # OpenRouter — https://openrouter.ai/keys

npm run chat                    # auto-detects from whichever key is set
```

| Provider | Default Model | Tool Format |
|----------|---------------|-------------|
| Gemini | `gemini-3-flash-preview` | Function calling |
| OpenAI | `gpt-5.4` | Responses API |
| Anthropic | `claude-sonnet-4-6` | Messages API + tool_use |
| OpenRouter | `google/gemini-3-flash-preview` | OpenAI-compatible |

Override the model with environment variables: `GEMINI_MODEL`, or pass config to the adapter.

### MCP Clients (Claude Desktop, Cursor, etc.)

See [claude-config/README.md](claude-config/README.md) for setup instructions.

## Example Domains (26 tools)

Every domain has a complete reference implementation in `src/examples/`:

| Domain | Tools | Pattern |
|--------|-------|---------|
| Study Tracker | `create_task`, `list_tasks`, `complete_task` | CRUD + Store |
| Bookmark Manager | `save_link`, `search_links`, `tag_link` | Arrays + Search |
| Recipe Keeper | `save_recipe`, `search_recipes`, `get_random` | Nested Data + Random |
| Expense Splitter | `add_expense`, `split_bill`, `get_balances` | Math + Calculations |
| Workout Logger | `log_workout`, `get_stats`, `suggest_workout` | Date Filtering + Stats |
| Dictionary | `define_word`, `find_synonyms` | External API (no key) |
| Quiz Generator | `create_quiz`, `answer_question`, `get_score` | Stateful Game |
| AI Tools | `summarize_text`, `generate_flashcards` | Tool Calls an LLM |
| Utilities | `calculate`, `convert_units`, `format_date` | Stateless Helpers |
| **Or invent your own!** | Whatever you want | You decide |

## Project Structure

```
openFunctions/
├── src/
│   ├── framework/              # Core framework (you don't need to edit this)
│   │   ├── tool.ts             # defineTool(), ok(), err()
│   │   ├── registry.ts         # Tool registry + provider format adapters
│   │   ├── server.ts           # MCP server wrapper
│   │   ├── store.ts            # JSON file persistence (createStore)
│   │   ├── pg-store.ts         # Postgres persistence (createPgStore)
│   │   ├── validate.ts         # Runtime parameter validation
│   │   ├── test-runner.ts      # Built-in test framework
│   │   ├── adapters/           # AI provider adapters
│   │   │   ├── gemini.ts       # Google AI Studio
│   │   │   ├── openai.ts       # OpenAI Responses API + OpenRouter
│   │   │   ├── anthropic.ts    # Anthropic Claude
│   │   │   └── chat.ts         # Shared interactive chat loop
│   │   └── types.ts            # TypeScript interfaces
│   ├── examples/               # 9 domains, 26 tools — read these to learn
│   │   ├── study-tracker/      # CRUD pattern (beginner)
│   │   ├── bookmark-manager/   # Arrays + search (beginner)
│   │   ├── recipe-keeper/      # Nested data + random (beginner)
│   │   ├── expense-splitter/   # Math + calculations (intermediate)
│   │   ├── workout-logger/     # Date filtering + stats (intermediate)
│   │   ├── dictionary/         # External API wrapper (intermediate)
│   │   ├── quiz-generator/     # Stateful game (advanced)
│   │   ├── ai-tools/           # Tool calls an LLM (advanced)
│   │   └── utilities/          # Stateless helpers (beginner)
│   ├── my-tools/               # YOUR tools go here
│   │   └── index.ts            # Start building!
│   └── index.ts                # Entry point — registers tools, starts MCP server
├── scripts/
│   ├── chat.ts                 # Unified AI chat (multi-provider)
│   ├── create-tool.ts          # Tool scaffolder
│   └── generate-docs.ts        # Docs generator
├── test-client/
│   ├── cli.ts                  # Interactive CLI tool tester
│   └── run-tests.ts            # Test runner entry point
├── claude-config/
│   └── README.md               # Claude Desktop setup instructions
├── CLAUDE.md                   # AI assistant context (for Cursor, Claude Code, etc.)
├── setup.sh                    # One-command setup
└── package.json
```

## How It Works

openFunctions is built on three concepts:

**1. Tools** — Functions an AI can call. Each tool has a name, description (the AI reads this to decide when to use it), a JSON Schema for parameters, and a handler function. Parameters are validated automatically before the handler runs.

**2. Registry** — Manages all your tools and converts them to the format each AI provider expects. Define once, use with Claude (MCP), Gemini (function calling), OpenAI (Responses API), or any OpenAI-compatible provider like OpenRouter.

**3. MCP Server** — Exposes your tools over the [Model Context Protocol](https://modelcontextprotocol.io), the open standard for AI tool interoperability. Any MCP client (Claude Desktop, Cursor, Claude.ai, etc.) can discover and call your tools.

## Architecture

This framework is derived from [ExecuFunction](https://execufunction.com)'s production tool system, which powers ~150 AI-callable tools across task management, calendar, knowledge, code search, and more. openFunctions extracts the core pattern and strips away the production complexity (auth, RLS, activity events, billing) so you can focus on building tools.

The key insight: **the AI model is interchangeable, but the tool layer is what makes agents actually useful.** openFunctions proves this by making the same tool definitions work across Claude, Gemini, ChatGPT, OpenRouter, and any MCP client.

## License

MIT — see [LICENSE](LICENSE)
