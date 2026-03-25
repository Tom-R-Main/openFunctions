<p align="center">
  <img src="assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Build AI agent tools in minutes.</strong> Define once, use with any AI.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#build-your-own-tools">Build Tools</a> &middot;
  <a href="#ai-providers">Providers</a> &middot;
  <a href="#agents--crews">Agents</a> &middot;
  <a href="#workflows">Workflows</a> &middot;
  <a href="#memory">Memory</a> &middot;
  <a href="#rag">RAG</a> &middot;
  <a href="#example-domains-26-tools">Examples</a>
</p>

---

openFunctions is a modular TypeScript framework for building AI agent tools and [MCP](https://modelcontextprotocol.io) servers. Start simple — define a tool in 10 lines. Scale up to multi-agent crews, workflows, RAG, and memory when you need them. Your tools work with Claude, Gemini, ChatGPT, Grok, and any MCP-compatible client.

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
cp .env.example .env   # add your API key(s)
```

## Commands

```bash
npm run test-tools          # Interactive CLI — test tools, no API key needed
npm run dev                 # Dev mode — auto-restarts on save
npm test                    # Run all automated tests
npm run chat                # Chat with AI using your tools (auto-detects key)
npm run chat -- gemini      # Specific provider
npm run chat -- gemini --prompt study-buddy   # With custom persona
npm run create-tool <name>  # Scaffold a new tool with tests
npm run docs                # Generate tool reference docs
npm run inspect             # MCP Inspector web UI
npm start                   # Start MCP server for Claude Desktop / Cursor
```

## Build Your Own Tools

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
```

Or scaffold with one command: `npm run create-tool expense_tracker`

## Testing

Tests live inside tool definitions — no separate files:

```typescript
defineTool({
  name: "create_task",
  // ...
  tests: [
    { name: "creates a task", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } },
    { name: "fails without subject", input: { title: "Read ch5" }, expect: { success: false } },
  ],
});
```

Parameters are validated against `inputSchema` automatically — missing fields, wrong types, and invalid enums are caught before the handler runs.

## Persistence

```typescript
// JSON files (zero setup)
const tasks = createStore<Task>("tasks");

// Postgres (same API, needs DATABASE_URL)
const tasks = await createPgStore<Task>("tasks");
```

Same `Store` interface — switching is a one-line change.

## AI Providers

```bash
cp .env.example .env    # add your key(s) — you only need ONE
npm run chat            # auto-detects provider
```

| Provider | Default Model | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | Function calling |
| OpenAI | `gpt-5.4` | Responses API |
| Anthropic | `claude-sonnet-4-6` | Messages + tool_use |
| xAI | `grok-4.20-0309-reasoning` | Responses API |
| OpenRouter | `google/gemini-3-flash-preview` | OpenAI-compatible |

Override any model: `npm run chat -- openai gpt-5.4-pro`

## System Prompts

Composable presets that shape AI behavior:

```bash
npm run chat -- gemini --prompt study-buddy       # preset
npm run chat -- gemini --prompt "You are a pirate" # inline
```

Ships with 5 presets: `default`, `study-buddy`, `code-tutor`, `strict-tools`, `workshop-helper`. Create your own at `system-prompts/my-preset.md` with `{{tools}}` auto-expansion.

```typescript
// Or compose programmatically
const prompt = composePrompt({
  role: "You are a study assistant.",
  rules: ["Always use tools — never guess."],
  toolGuide: autoToolGuide(registry),
});
```

## Agents & Crews

Define agent personas with role/goal and a subset of tools. Run them individually or as sequential/parallel crews:

```typescript
import { defineAgent, runCrew } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst",
  goal: "Find accurate information using available tools",
  toolTags: ["search", "web"],
});

const writer = defineAgent({
  name: "writer",
  role: "Content Writer",
  goal: "Write clear articles from research findings",
  tools: ["save_note"],
});

const result = await runCrew(
  { agents: [researcher, writer], mode: "sequential" },
  "Write about the MCP protocol",
  adapter, registry,
);
```

Agents can delegate to each other via synthetic tools when `delegation: true`.

## Workflows

Deterministic, code-driven pipelines. Chain tools, add branching, run steps in parallel:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}"));

await research.run({ word: "ephemeral" });
```

Supports `.then()`, `.parallel()`, and `.branch()` for conditional routing.

## Memory

Conversation threads and long-term fact storage:

```typescript
import { createConversationMemory, createFactMemory, createMemoryTools } from "./framework/index.js";

const conversations = createConversationMemory();
const facts = createFactMemory();

// Give the AI memory capabilities via tools
registry.registerAll(createMemoryTools(conversations, facts));
// → store_fact, recall_facts, list_threads, get_thread
```

Backed by the Store interface — defaults to JSON files, swap to Postgres with `createPgStore`.

## Structured Output

Force the AI to return typed JSON matching a schema:

```typescript
import { forceStructuredOutput } from "./framework/index.js";

const result = await forceStructuredOutput<{
  sentiment: "positive" | "negative" | "neutral";
  confidence: number;
}>(adapter, {
  schema: {
    type: "object",
    properties: {
      sentiment: { type: "string", enum: ["positive", "negative", "neutral"] },
      confidence: { type: "number", description: "0.0 to 1.0" },
    },
    required: ["sentiment", "confidence"],
  },
  prompt: "Analyze: 'I love this framework!'",
});
// result.data.sentiment === "positive"
```

## RAG

Retrieval-Augmented Generation with pgvector. Add documents, search by semantic similarity:

```typescript
import { createRAG } from "./framework/index.js";

const rag = await createRAG({ embeddingProvider: "gemini" });

await rag.addDocument("Mitosis is the process of cell division...");
await rag.addDocument("Photosynthesis converts light energy...");

const results = await rag.search("How does cell division work?");
// → [{ content: "Mitosis is the process...", distance: 0.25 }]

// Or give the AI RAG tools directly
registry.registerAll(rag.createTools());
// → add_document, search_documents
```

Requires Postgres with pgvector (`docker run pgvector/pgvector:pg16`). Supports Gemini Embedding 2 (768/1536/3072 dim) or OpenAI embeddings. User-configurable dimensions.

## Example Domains (26 tools)

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

## Project Structure

```
openFunctions/
├── src/
│   ├── framework/              # Core framework
│   │   ├── tool.ts             # defineTool(), ok(), err()
│   │   ├── registry.ts         # Tool registry + provider format adapters
│   │   ├── server.ts           # MCP server wrapper
│   │   ├── store.ts            # JSON file persistence
│   │   ├── pg-store.ts         # Postgres persistence
│   │   ├── validate.ts         # Runtime parameter validation
│   │   ├── test-runner.ts      # Built-in test framework
│   │   ├── prompts.ts          # Composable system prompts
│   │   ├── agents.ts           # defineAgent(), runCrew()
│   │   ├── workflows.ts        # pipe(), parallel(), branch()
│   │   ├── memory.ts           # Conversation threads + fact memory
│   │   ├── structured.ts       # Structured JSON output
│   │   ├── rag.ts              # pgvector RAG with embeddings
│   │   ├── env.ts              # .env file loader
│   │   ├── adapters/           # AI provider adapters
│   │   │   ├── gemini.ts       # Google AI Studio
│   │   │   ├── openai.ts       # OpenAI + OpenRouter
│   │   │   ├── anthropic.ts    # Anthropic Claude
│   │   │   ├── xai.ts          # xAI Grok
│   │   │   └── chat.ts         # Shared chat loop
│   │   └── types.ts            # TypeScript interfaces
│   ├── examples/               # 9 domains, 26 tools
│   ├── my-tools/               # Your tools go here
│   └── index.ts                # Entry point
├── scripts/                    # chat, create-tool, docs
├── test-client/                # CLI tester + test runner
├── system-prompts/             # 5 composable presets
├── CLAUDE.md                   # AI assistant context
├── .env.example                # API key template
└── package.json
```

## Architecture

Derived from [ExecuFunction](https://execufunction.com)'s production tool system (~150 AI-callable tools). openFunctions extracts the core patterns and makes them modular — use only what you need:

| Module | What It Does | Requires |
|--------|-------------|----------|
| **Core** | defineTool, registry, MCP server, validation | Nothing |
| **Store** | JSON file persistence | Nothing |
| **Pg Store** | Postgres persistence | `DATABASE_URL` |
| **Adapters** | 5 AI providers + chat loop | API key |
| **Prompts** | Composable system prompts | Nothing |
| **Agents** | Personas, crews, delegation | Adapter |
| **Workflows** | pipe, parallel, branch | Nothing |
| **Memory** | Threads + facts + AI tools | Nothing |
| **Structured** | Force typed JSON output | Adapter |
| **RAG** | pgvector embeddings + search | `DATABASE_URL` + API key |

**The key insight: the AI model is interchangeable, but the tool layer is what makes agents useful.**

## License

MIT — see [LICENSE](LICENSE)
