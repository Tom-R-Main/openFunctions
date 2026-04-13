<p align="center">
  <img src="assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Build AI tools first. Compose agents when you need them.</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#the-mental-model">Mental Model</a> &middot;
  <a href="#choose-the-right-primitive">Choose a Primitive</a> &middot;
  <a href="#capability-ladder">Capability Ladder</a> &middot;
  <a href="#providers">Providers</a> &middot;
  <a href="#examples">Examples</a> &middot;
  <a href="#docs">Docs</a>
</p>

<p align="center">
  <sub>
    <a href="docs/i18n/README.ar.md">العربية</a> · <a href="docs/i18n/README.bn.md">বাংলা</a> · <a href="docs/i18n/README.de.md">Deutsch</a> · <a href="docs/i18n/README.es.md">Español</a> · <a href="docs/i18n/README.fr.md">Français</a> · <a href="docs/i18n/README.hi.md">हिन्दी</a> · <a href="docs/i18n/README.id.md">Indonesia</a> · <a href="docs/i18n/README.ja.md">日本語</a> · <a href="docs/i18n/README.ko.md">한국어</a> · <a href="docs/i18n/README.nl.md">Nederlands</a> · <a href="docs/i18n/README.pa.md">ਪੰਜਾਬੀ</a> · <a href="docs/i18n/README.pl.md">Polski</a> · <a href="docs/i18n/README.pt-BR.md">Português</a> · <a href="docs/i18n/README.ru.md">Русский</a> · <a href="docs/i18n/README.sv.md">Svenska</a> · <a href="docs/i18n/README.te.md">తెలుగు</a> · <a href="docs/i18n/README.th.md">ไทย</a> · <a href="docs/i18n/README.tr.md">Türkçe</a> · <a href="docs/i18n/README.uk.md">Українська</a> · <a href="docs/i18n/README.yue.md">粵語</a> · <a href="docs/i18n/README.zh-CN.md">简体中文</a> · <a href="docs/i18n/README.zh-TW.md">繁體中文</a>
  </sub>
</p>

---

openFunctions is an MIT-licensed TypeScript framework for building AI-callable tools and exposing them through [MCP](https://modelcontextprotocol.io), chat adapters, workflows, and agents. Its core runtime is simple:

`ToolDefinition -> ToolRegistry -> AIAdapter`

Everything else composes on top of that:

- `workflows` are deterministic orchestration around tools
- `agents` are LLM loops over a filtered registry
- `structured output` is a synthetic tool pattern
- `memory` and `rag` are stateful systems that can be wrapped back into tools

If you understand the tool runtime, the rest of the framework stays legible.

```text
defineTool() -> registry.register() -> adapter/server executes tool
                                    -> workflows compose tools
                                    -> agents use filtered tools
                                    -> memory/rag expose more tools
```

## Quick Start

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

The first thing to build is a tool, not an agent.

## The Mental Model

A tool is your business logic plus a schema the AI can read:

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
    const rolled = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled });
  },
});
```

That one definition can be:

- executed directly by `registry.execute()`
- exposed to Claude/Desktop over MCP
- used inside the interactive chat loop
- composed into workflows
- filtered into agent-specific registries

Read more: [Architecture](docs/ARCHITECTURE.md)

## Choose The Right Primitive

| Use this | When you want | What it really is |
|----------|---------------|-------------------|
| `defineTool()` | callable AI-facing business logic | the core primitive |
| `pipe()` | deterministic orchestration | code-driven tool/LLM pipeline |
| `defineAgent()` | adaptive multi-step tool use | an LLM loop over a filtered registry |
| `createConversationMemory()` / `createFactMemory()` | thread/fact state | persistence plus memory tools |
| `createRAG()` | semantic document retrieval | pgvector + embeddings + tools |
| `connectProvider()` | external system context | structured tools from ExecuFunction, Obsidian, etc. |
| `createStore()` / `createPgStore()` | persistence | storage layer, not retrieval |

Rule of thumb:

- Start with a tool.
- Use a workflow when you know the sequence.
- Use an agent only when the model needs to choose what to do next.
- Add memory for state you control.
- Add RAG for document retrieval by meaning.
- Add a context provider when you need external systems (tasks, calendars, CRM).

## Capability Ladder

### 1. Build a tool

```bash
npm run create-tool expense_tracker
```

Edit `src/my-tools/expense_tracker.ts`, then run:

```bash
npm run test-tools
npm test
```

### 2. Expose it through MCP or chat

```bash
npm start
npm run chat -- gemini
```

The same registry powers both.

### 3. Compose it with workflows

Workflows are the default “advanced” primitive because the control flow stays explicit:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}"));

await research.run({ word: "ephemeral" });
```

### 4. Add adaptive behavior with agents

Agents use the same tools, but through a filtered registry and a reasoning loop:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst",
  goal: "Find accurate information using available tools",
  toolTags: ["search"],
});
```

Use crews when multiple specialized agents need to collaborate.

### 5. Add state only when needed

Persistence:

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

Memory:

```typescript
const conversations = createConversationMemory();
const facts = createFactMemory();
registry.registerAll(createMemoryTools(conversations, facts));
```

RAG:

```typescript
const rag = await createRAG({ embeddingProvider: "gemini" });
registry.registerAll(rag.createTools());
```

RAG docs: [docs/RAG.md](docs/RAG.md)

### 6. Connect external context

Context providers bring external systems (task managers, calendars, CRM, knowledge bases) into the agent runtime as tools:

```typescript
import { connectProvider, contextPrompt } from "./framework/index.js";
import { createExecuFunctionProvider } from "./providers/execufunction/index.js";

// Connect — registers 17 tools tagged "context" + "context:execufunction"
const exf = await connectProvider(
  createExecuFunctionProvider({ token: process.env.EXF_PAT }),
  registry,
);

// Inject active tasks + upcoming events into agent system prompts
const context = await contextPrompt([exf]);
```

The `ContextProvider` interface is pluggable — implement `metadata`, `connect()`, and `createTools()` to bring any backend into the framework. See [Architecture](docs/ARCHITECTURE.md#context-providers) for the full interface.

| Provider | Status | Capabilities |
|----------|--------|--------------|
| [ExecuFunction](src/providers/execufunction/) | Built-in | tasks, projects, calendar, knowledge, people, organizations, codebase |
| Obsidian | Template (planned) | knowledge |
| Notion | Template (planned) | knowledge, tasks, projects |

## Commands

```bash
npm run test-tools          # Interactive CLI — test tools locally
npm run dev                 # Dev mode — auto-restarts on save
npm test                    # Run tool-defined automated tests
npm run chat                # Chat with AI using your tools
npm run chat -- gemini      # Force a specific provider
npm run create-tool <name>  # Scaffold a new tool
npm run docs                # Generate tool reference docs
npm run inspect             # MCP Inspector web UI
npm start                   # Start MCP server for Claude Desktop / Cursor
```

## Providers

Set one API key in `.env` and the chat loop will auto-detect the provider.

| Provider | Default Model | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | Function calling |
| OpenAI | `gpt-5.4` | Responses API |
| Anthropic | `claude-sonnet-4-6` | Messages + tool_use |
| xAI | `grok-4.20-0309-reasoning` | Responses API |
| OpenRouter | `google/gemini-3-flash-preview` | OpenAI-compatible |

Examples:

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## Testing

Tests live with tool definitions:

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

The registry validates parameters before handlers run, so schema errors are surfaced clearly enough for both humans and LLMs to recover.

## Examples

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

## Docs

- [Architecture](docs/ARCHITECTURE.md): the runtime model, filtered registries, synthetic tools, and execution paths
- [RAG](docs/RAG.md): semantic chunking, Gemini/OpenAI embeddings, pgvector schema, HNSW search, and tool integration

## Plugins

### ExecuFunction for OpenClaw

The [`@openfunctions/openclaw-execufunction`](plugins/openclaw-execufunction/) plugin brings [ExecuFunction](https://execufunction.com) into the [OpenClaw](https://github.com/openclaw/openclaw) agent ecosystem — 17 tools across 6 domains:

| Domain | Tools | What it does |
|--------|-------|--------------|
| Tasks | `exf_tasks_list`, `exf_tasks_create`, `exf_tasks_update`, `exf_tasks_complete` | Structured task management with priorities (do_now/do_next/do_later/delegate/drop) |
| Calendar | `exf_calendar_list`, `exf_calendar_create`, `exf_calendar_update` | Event scheduling and lookup |
| Knowledge | `exf_notes_search`, `exf_notes_create`, `exf_notes_get` | Semantic search across a knowledge base |
| Projects | `exf_projects_list`, `exf_projects_context` | Project status and full context (tasks, notes, signals) |
| People/CRM | `exf_people_search`, `exf_person_create`, `exf_org_search` | Contact and organization management |
| Codebase | `exf_codebase_search`, `exf_code_who_knows` | Semantic code search and expertise tracking |

Install:

```bash
openclaw plugins install @openfunctions/openclaw-execufunction
```

Set `EXF_PAT` in your environment (or configure via OpenClaw plugin settings), and your OpenClaw agent gets persistent tasks, calendar awareness, semantic knowledge search, CRM, and code intelligence — backed by ExecuFunction's cloud API.

See the [plugin README](plugins/openclaw-execufunction/) for details.

## Project Structure

```text
openFunctions/
├── src/
│   ├── framework/              # Core runtime + composition layers
│   │   ├── context.ts          # Context provider interface
│   │   └── ...                 # tool, registry, agents, memory, rag, workflows
│   ├── providers/
│   │   └── execufunction/      # ExecuFunction context provider (reference impl)
│   ├── examples/               # Reference tool patterns
│   ├── my-tools/               # Your tools
│   └── index.ts                # MCP entrypoint
├── plugins/
│   └── openclaw-execufunction/ # ExecuFunction plugin for OpenClaw
├── docs/                       # Architecture docs
├── scripts/                    # chat, create-tool, docs
├── test-client/                # CLI tester + test runner
├── system-prompts/             # Prompt presets
└── package.json
```

## License

MIT — see [LICENSE](LICENSE)
