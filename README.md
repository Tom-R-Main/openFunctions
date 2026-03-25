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
  <a href="#system-prompts">System Prompts</a> &middot;
  <a href="#example-domains-26-tools">Examples</a>
</p>

---

openFunctions is a TypeScript framework for building [MCP](https://modelcontextprotocol.io) (Model Context Protocol) servers — the open standard for giving AI agents tools to call. Your tools work with Claude, Gemini, ChatGPT, Grok, and any MCP-compatible client, with zero rewriting.

```
┌──────────────────────────────────────────────────────────────┐
│                    Your Tool Definitions                      │
│               (define once with openFunctions)                │
└────┬──────────┬──────────┬──────────┬──────────┬────────────┘
     │          │          │          │          │
┌────▼────┐ ┌──▼───┐ ┌───▼───┐ ┌───▼───┐ ┌───▼────────┐
│ Claude  │ │Gemini│ │ChatGPT│ │ Grok  │ │ OpenRouter  │
│  (MCP)  │ │      │ │       │ │       │ │ (any model) │
└─────────┘ └──────┘ └───────┘ └───────┘ └────────────┘
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
npm run chat -- xai         # Chat with Grok (4.2)
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

Chat with any provider using your tools. Set your API keys in a `.env` file (never committed to git):

```bash
cp .env.example .env
# Edit .env and add your key(s) — you only need ONE to get started
```

Then chat:

```bash
npm run chat                    # auto-detects from whichever key is set
```

| Provider | Default Model | Tool Format |
|----------|---------------|-------------|
| Gemini | `gemini-3-flash-preview` | Function calling |
| OpenAI | `gpt-5.4` | Responses API |
| Anthropic | `claude-sonnet-4-6` | Messages API + tool_use |
| xAI | `grok-4.20-0309-reasoning` | Responses API |
| OpenRouter | `google/gemini-3-flash-preview` | OpenAI-compatible |

Override the model by passing it after the provider name:

```bash
npm run chat -- gemini gemini-2.5-flash
npm run chat -- openai gpt-5.4-pro
npm run chat -- xai grok-3
npm run chat -- openrouter anthropic/claude-sonnet-4-6
```

### MCP Clients (Claude Desktop, Cursor, etc.)

See [claude-config/README.md](claude-config/README.md) for setup instructions.

## System Prompts

Customize how the AI behaves with composable system prompts:

```bash
npm run chat -- gemini --prompt study-buddy          # use a preset
npm run chat -- gemini --prompt strict-tools         # force tool usage
npm run chat -- gemini --prompt "You are a pirate"   # inline prompt
```

**5 presets ship with the framework** in `system-prompts/`:

| Preset | Behavior |
|--------|----------|
| `default` | General helpful assistant |
| `study-buddy` | Creates tasks immediately, encourages, offers flashcards |
| `code-tutor` | Asks clarifying questions, gives hints not answers |
| `strict-tools` | Refuses to answer without a tool |
| `workshop-helper` | Live event mode — concise, shows code, ends with next step |

**Create your own** at `system-prompts/my-preset.md`:

```markdown
---
name: My Preset
---
<role>
You are a fitness coach who tracks workouts.
</role>

<rules>
- Always use log_workout when the user describes an exercise
- Use get_stats to show weekly progress
- Be motivating but not cheesy
</rules>

{{tools}}
```

The `{{tools}}` placeholder auto-expands to usage guidance generated from all registered tools — updates automatically when you add new tools.

**Programmatic composition** is also available:

```typescript
import { composePrompt, autoToolGuide, registry } from "./framework/index.js";

const prompt = composePrompt({
  role: "You are a friendly study assistant.",
  rules: ["Always use tools — never guess.", "Be concise."],
  toolGuide: autoToolGuide(registry),
  format: "Use bullet points.",
});
```

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
│   │   ├── prompts.ts          # Composable system prompt engine
│   │   ├── adapters/           # AI provider adapters
│   │   │   ├── gemini.ts       # Google AI Studio
│   │   │   ├── openai.ts       # OpenAI Responses API + OpenRouter
│   │   │   ├── anthropic.ts    # Anthropic Claude
│   │   │   ├── xai.ts          # xAI Grok
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
├── system-prompts/             # Composable system prompt presets
│   ├── default.md              # Default behavior
│   ├── study-buddy.md          # Study assistant persona
│   ├── code-tutor.md           # Patient coding tutor
│   ├── strict-tools.md         # Forces tool usage
│   └── workshop-helper.md      # Live workshop assistant
├── CLAUDE.md                   # AI assistant context (for Cursor, Claude Code, etc.)
├── setup.sh                    # One-command setup
└── package.json
```

## How It Works

openFunctions is built on three concepts:

**1. Tools** — Functions an AI can call. Each tool has a name, description (the AI reads this to decide when to use it), a JSON Schema for parameters, and a handler function. Parameters are validated automatically before the handler runs.

**2. Registry** — Manages all your tools and converts them to the format each AI provider expects. Define once, use with Claude (MCP), Gemini (function calling), OpenAI (Responses API), xAI Grok, or any OpenAI-compatible provider like OpenRouter.

**3. MCP Server** — Exposes your tools over the [Model Context Protocol](https://modelcontextprotocol.io), the open standard for AI tool interoperability. Any MCP client (Claude Desktop, Cursor, Claude.ai, etc.) can discover and call your tools.

## Architecture

This framework is derived from [ExecuFunction](https://execufunction.com)'s production tool system, which powers ~150 AI-callable tools across task management, calendar, knowledge, code search, and more. openFunctions extracts the core pattern and strips away the production complexity (auth, RLS, activity events, billing) so you can focus on building tools.

The key insight: **the AI model is interchangeable, but the tool layer is what makes agents actually useful.** openFunctions proves this by making the same tool definitions work across Claude, Gemini, ChatGPT, Grok, OpenRouter, and any MCP client.

## License

MIT — see [LICENSE](LICENSE)
