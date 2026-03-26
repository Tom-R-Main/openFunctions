[English](../README.md) | [Punjabi](README.pa.md)

<p align="center">
  <img src="../../assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>ਪਹਿਲਾਂ AI ਟੂਲ ਬਣਾਓ। ਲੋੜ ਪੈਣ 'ਤੇ ਏਜੰਟਾਂ ਨੂੰ ਕੰਪੋਜ਼ ਕਰੋ।</strong>
</p>

<p align="center">
  <a href="#quick-start">ਤੁਰੰਤ ਸ਼ੁਰੂਆਤ</a> &middot;
  <a href="#the-mental-model">ਮਾਨਸਿਕ ਮਾਡਲ</a> &middot;
  <a href="#choose-the-right-primitive">ਸਹੀ ਪ੍ਰਿਮਿਟਿਵ ਚੁਣੋ</a> &middot;
  <a href="#capability-ladder">ਸਮਰੱਥਾ ਪੌੜੀ</a> &middot;
  <a href="#providers">ਪ੍ਰਦਾਤਾ</a> &middot;
  <a href="#examples">ਉਦਾਹਰਨਾਂ</a> &middot;
  <a href="#docs">ਦਸਤਾਵੇਜ਼</a>
</p>

---

openFunctions ਇੱਕ MIT-ਲਾਇਸੰਸਸ਼ੁਦਾ TypeScript ਫਰੇਮਵਰਕ ਹੈ ਜੋ AI-ਕਾਲੇਬਲ ਟੂਲ ਬਣਾਉਣ ਅਤੇ ਉਹਨਾਂ ਨੂੰ [MCP](https://modelcontextprotocol.io), ਚੈਟ ਅਡਾਪਟਰਾਂ, ਵਰਕਫਲੋਜ਼, ਅਤੇ ਏਜੰਟਾਂ ਰਾਹੀਂ ਪ੍ਰਦਰਸ਼ਿਤ ਕਰਨ ਲਈ ਹੈ। ਇਸਦਾ ਮੁੱਖ ਰਨਟਾਈਮ ਸਧਾਰਨ ਹੈ:

`ToolDefinition -> ToolRegistry -> AIAdapter`

ਬਾਕੀ ਸਭ ਕੁਝ ਇਸਦੇ ਉੱਪਰ ਕੰਪੋਜ਼ ਹੁੰਦਾ ਹੈ:

- `workflows` ਟੂਲਜ਼ ਦੇ ਆਲੇ-ਦੁਆਲੇ ਨਿਰਧਾਰਤ ਆਰਕੈਸਟ੍ਰੇਸ਼ਨ ਹਨ
- `agents` ਇੱਕ ਫਿਲਟਰਡ ਰਜਿਸਟਰੀ ਉੱਤੇ LLM ਲੂਪਸ ਹਨ
- `structured output` ਇੱਕ ਸਿੰਥੈਟਿਕ ਟੂਲ ਪੈਟਰਨ ਹੈ
- `memory` ਅਤੇ `rag` ਸਟੇਟਫੁੱਲ ਸਿਸਟਮ ਹਨ ਜਿਨ੍ਹਾਂ ਨੂੰ ਟੂਲਜ਼ ਵਿੱਚ ਵਾਪਸ ਲਪੇਟਿਆ ਜਾ ਸਕਦਾ ਹੈ

ਜੇਕਰ ਤੁਸੀਂ ਟੂਲ ਰਨਟਾਈਮ ਨੂੰ ਸਮਝਦੇ ਹੋ, ਤਾਂ ਫਰੇਮਵਰਕ ਦਾ ਬਾਕੀ ਹਿੱਸਾ ਪੜ੍ਹਨਯੋਗ ਰਹਿੰਦਾ ਹੈ।

```text
defineTool() -> registry.register() -> adapter/server executes tool
                                    -> workflows compose tools
                                    -> agents use filtered tools
                                    -> memory/rag expose more tools
```

## ਤੁਰੰਤ ਸ਼ੁਰੂਆਤ

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

ਬਣਾਉਣ ਵਾਲੀ ਪਹਿਲੀ ਚੀਜ਼ ਇੱਕ ਟੂਲ ਹੈ, ਨਾ ਕਿ ਇੱਕ ਏਜੰਟ।

## ਮਾਨਸਿਕ ਮਾਡਲ

ਇੱਕ ਟੂਲ ਤੁਹਾਡਾ ਕਾਰੋਬਾਰੀ ਤਰਕ ਹੈ ਅਤੇ ਇੱਕ ਸਕੀਮਾ ਹੈ ਜਿਸਨੂੰ AI ਪੜ੍ਹ ਸਕਦਾ ਹੈ:

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

ਉਹ ਇੱਕ ਪਰਿਭਾਸ਼ਾ ਹੋ ਸਕਦੀ ਹੈ:

- `registry.execute()` ਦੁਆਰਾ ਸਿੱਧੇ ਤੌਰ 'ਤੇ ਚਲਾਈ ਗਈ
- MCP ਉੱਤੇ Claude/Desktop ਨੂੰ ਪ੍ਰਦਰਸ਼ਿਤ ਕੀਤੀ ਗਈ
- ਇੰਟਰਐਕਟਿਵ ਚੈਟ ਲੂਪ ਦੇ ਅੰਦਰ ਵਰਤੀ ਗਈ
- ਵਰਕਫਲੋਜ਼ ਵਿੱਚ ਕੰਪੋਜ਼ ਕੀਤੀ ਗਈ
- ਏਜੰਟ-ਵਿਸ਼ੇਸ਼ ਰਜਿਸਟਰੀਆਂ ਵਿੱਚ ਫਿਲਟਰ ਕੀਤੀ ਗਈ

ਹੋਰ ਪੜ੍ਹੋ: [ਆਰਕੀਟੈਕਚਰ](docs/ARCHITECTURE.md)

## ਸਹੀ ਪ੍ਰਿਮਿਟਿਵ ਚੁਣੋ

| ਇਸਦੀ ਵਰਤੋਂ ਕਰੋ | ਜਦੋਂ ਤੁਸੀਂ ਚਾਹੁੰਦੇ ਹੋ | ਇਹ ਅਸਲ ਵਿੱਚ ਕੀ ਹੈ |
|----------|---------------|-------------------|
| `defineTool()` | ਕਾਲੇਬਲ AI-ਮੁਖੀ ਕਾਰੋਬਾਰੀ ਤਰਕ | ਮੁੱਖ ਪ੍ਰਿਮਿਟਿਵ |
| `pipe()` | ਨਿਰਧਾਰਤ ਆਰਕੈਸਟ੍ਰੇਸ਼ਨ | ਕੋਡ-ਸੰਚਾਲਿਤ ਟੂਲ/LLM ਪਾਈਪਲਾਈਨ |
| `defineAgent()` | ਅਨੁਕੂਲ ਬਹੁ-ਪੜਾਵੀ ਟੂਲ ਦੀ ਵਰਤੋਂ | ਇੱਕ ਫਿਲਟਰਡ ਰਜਿਸਟਰੀ ਉੱਤੇ ਇੱਕ LLM ਲੂਪ |
| `createConversationMemory()` / `createFactMemory()` | ਥ੍ਰੈਡ/ਤੱਥ ਸਥਿਤੀ | ਸਥਿਰਤਾ ਅਤੇ ਮੈਮੋਰੀ ਟੂਲ |
| `createRAG()` | ਅਰਥਪੂਰਨ ਦਸਤਾਵੇਜ਼ ਪ੍ਰਾਪਤੀ | pgvector + embeddings + ਟੂਲ |
| `createStore()` / `createPgStore()` | ਸਥਿਰਤਾ | ਸਟੋਰੇਜ ਲੇਅਰ, ਪ੍ਰਾਪਤੀ ਨਹੀਂ |

ਅੰਗੂਠੇ ਦਾ ਨਿਯਮ:

- ਇੱਕ ਟੂਲ ਨਾਲ ਸ਼ੁਰੂ ਕਰੋ।
- ਜਦੋਂ ਤੁਸੀਂ ਕ੍ਰਮ ਜਾਣਦੇ ਹੋ ਤਾਂ ਇੱਕ ਵਰਕਫਲੋ ਦੀ ਵਰਤੋਂ ਕਰੋ।
- ਇੱਕ ਏਜੰਟ ਦੀ ਵਰਤੋਂ ਤਾਂ ਹੀ ਕਰੋ ਜਦੋਂ ਮਾਡਲ ਨੂੰ ਅੱਗੇ ਕੀ ਕਰਨਾ ਹੈ ਇਹ ਚੁਣਨ ਦੀ ਲੋੜ ਹੋਵੇ।
- ਉਸ ਸਥਿਤੀ ਲਈ ਮੈਮੋਰੀ ਸ਼ਾਮਲ ਕਰੋ ਜਿਸਨੂੰ ਤੁਸੀਂ ਨਿਯੰਤਰਿਤ ਕਰਦੇ ਹੋ।
- ਅਰਥ ਦੁਆਰਾ ਦਸਤਾਵੇਜ਼ ਪ੍ਰਾਪਤੀ ਲਈ RAG ਸ਼ਾਮਲ ਕਰੋ।

## ਸਮਰੱਥਾ ਪੌੜੀ

### 1. ਇੱਕ ਟੂਲ ਬਣਾਓ

```bash
npm run create-tool expense_tracker
```

`src/my-tools/expense_tracker.ts` ਨੂੰ ਸੰਪਾਦਿਤ ਕਰੋ, ਫਿਰ ਚਲਾਓ:

```bash
npm run test-tools
npm test
```

### 2. ਇਸਨੂੰ MCP ਜਾਂ ਚੈਟ ਰਾਹੀਂ ਪ੍ਰਦਰਸ਼ਿਤ ਕਰੋ

```bash
npm start
npm run chat -- gemini
```

ਉਹੀ ਰਜਿਸਟਰੀ ਦੋਵਾਂ ਨੂੰ ਸ਼ਕਤੀ ਪ੍ਰਦਾਨ ਕਰਦੀ ਹੈ।

### 3. ਇਸਨੂੰ ਵਰਕਫਲੋਜ਼ ਨਾਲ ਕੰਪੋਜ਼ ਕਰੋ

ਵਰਕਫਲੋਜ਼ ਡਿਫੌਲਟ "ਐਡਵਾਂਸਡ" ਪ੍ਰਿਮਿਟਿਵ ਹਨ ਕਿਉਂਕਿ ਕੰਟਰੋਲ ਫਲੋ ਸਪਸ਼ਟ ਰਹਿੰਦਾ ਹੈ:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}"));

await research.run({ word: "ephemeral" });
```

### 4. ਏਜੰਟਾਂ ਨਾਲ ਅਨੁਕੂਲ ਵਿਵਹਾਰ ਸ਼ਾਮਲ ਕਰੋ

ਏਜੰਟ ਉਹੀ ਟੂਲ ਵਰਤਦੇ ਹਨ, ਪਰ ਇੱਕ ਫਿਲਟਰਡ ਰਜਿਸਟਰੀ ਅਤੇ ਇੱਕ ਤਰਕ ਲੂਪ ਰਾਹੀਂ:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst",
  goal: "Find accurate information using available tools",
  toolTags: ["search"],
});
```

ਜਦੋਂ ਕਈ ਵਿਸ਼ੇਸ਼ ਏਜੰਟਾਂ ਨੂੰ ਸਹਿਯੋਗ ਕਰਨ ਦੀ ਲੋੜ ਹੋਵੇ ਤਾਂ ਕਰੂਜ਼ ਦੀ ਵਰਤੋਂ ਕਰੋ।

### 5. ਲੋੜ ਪੈਣ 'ਤੇ ਹੀ ਸਥਿਤੀ ਸ਼ਾਮਲ ਕਰੋ

ਸਥਿਰਤਾ:

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

ਮੈਮੋਰੀ:

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

RAG ਦਸਤਾਵੇਜ਼: [docs/RAG.md](docs/RAG.md)

## ਕਮਾਂਡਾਂ

```bash
npm run test-tools          # ਇੰਟਰਐਕਟਿਵ CLI — ਟੂਲਜ਼ ਨੂੰ ਸਥਾਨਕ ਤੌਰ 'ਤੇ ਟੈਸਟ ਕਰੋ
npm run dev                 # ਦੇਵ ਮੋਡ — ਸੇਵ ਕਰਨ 'ਤੇ ਆਟੋ-ਰੀਸਟਾਰਟ ਹੁੰਦਾ ਹੈ
npm test                    # ਟੂਲ-ਪਰਿਭਾਸ਼ਿਤ ਆਟੋਮੇਟਿਡ ਟੈਸਟ ਚਲਾਓ
npm run chat                # ਆਪਣੇ ਟੂਲਜ਼ ਦੀ ਵਰਤੋਂ ਕਰਕੇ AI ਨਾਲ ਚੈਟ ਕਰੋ
npm run chat -- gemini      # ਇੱਕ ਖਾਸ ਪ੍ਰਦਾਤਾ ਨੂੰ ਮਜਬੂਰ ਕਰੋ
npm run create-tool <name>  # ਇੱਕ ਨਵਾਂ ਟੂਲ ਬਣਾਓ
npm run docs                # ਟੂਲ ਸੰਦਰਭ ਦਸਤਾਵੇਜ਼ ਤਿਆਰ ਕਰੋ
npm run inspect             # MCP ਇੰਸਪੈਕਟਰ ਵੈੱਬ UI
npm start                   # Claude Desktop / Cursor ਲਈ MCP ਸਰਵਰ ਸ਼ੁਰੂ ਕਰੋ
```

## ਪ੍ਰਦਾਤਾ

`.env` ਵਿੱਚ ਇੱਕ API ਕੁੰਜੀ ਸੈੱਟ ਕਰੋ ਅਤੇ ਚੈਟ ਲੂਪ ਪ੍ਰਦਾਤਾ ਨੂੰ ਆਟੋ-ਡਿਟੈਕਟ ਕਰੇਗਾ।

| ਪ੍ਰਦਾਤਾ | ਡਿਫੌਲਟ ਮਾਡਲ | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | ਫੰਕਸ਼ਨ ਕਾਲਿੰਗ |
| OpenAI | `gpt-5.4` | ਰਿਸਪਾਂਸ API |
| Anthropic | `claude-sonnet-4-6` | ਮੈਸੇਜ + tool_use |
| xAI | `grok-4.20-0309-reasoning` | ਰਿਸਪਾਂਸ API |
| OpenRouter | `google/gemini-3-flash-preview` | OpenAI-ਅਨੁਕੂਲ |

ਉਦਾਹਰਨਾਂ:

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## ਟੈਸਟਿੰਗ

ਟੈਸਟ ਟੂਲ ਪਰਿਭਾਸ਼ਾਵਾਂ ਦੇ ਨਾਲ ਰਹਿੰਦੇ ਹਨ:

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

ਰਜਿਸਟਰੀ ਹੈਂਡਲਰਾਂ ਦੇ ਚੱਲਣ ਤੋਂ ਪਹਿਲਾਂ ਪੈਰਾਮੀਟਰਾਂ ਨੂੰ ਪ੍ਰਮਾਣਿਤ ਕਰਦੀ ਹੈ, ਇਸਲਈ ਸਕੀਮਾ ਦੀਆਂ ਗਲਤੀਆਂ ਮਨੁੱਖਾਂ ਅਤੇ LLM ਦੋਵਾਂ ਲਈ ਠੀਕ ਹੋਣ ਲਈ ਕਾਫ਼ੀ ਸਪਸ਼ਟ ਰੂਪ ਵਿੱਚ ਪ੍ਰਦਰਸ਼ਿਤ ਹੁੰਦੀਆਂ ਹਨ।

## ਉਦਾਹਰਨਾਂ

| ਡੋਮੇਨ | ਟੂਲਜ਼ | ਪੈਟਰਨ |
|--------|-------|---------|
| ਸਟੱਡੀ ਟ੍ਰੈਕਰ | `create_task`, `list_tasks`, `complete_task` | CRUD + ਸਟੋਰ |
| ਬੁੱਕਮਾਰਕ ਮੈਨੇਜਰ | `save_link`, `search_links`, `tag_link` | ਐਰੇ + ਖੋਜ |
| ਰੈਸਿਪੀ ਕੀਪਰ | `save_recipe`, `search_recipes`, `get_random` | ਨੈਸਟਡ ਡਾਟਾ + ਰੈਂਡਮ |
| ਖਰਚਾ ਵੰਡਣ ਵਾਲਾ | `add_expense`, `split_bill`, `get_balances` | ਗਣਿਤ + ਗਣਨਾਵਾਂ |
| ਵਰਕਆਊਟ ਲੌਗਰ | `log_workout`, `get_stats`, `suggest_workout` | ਮਿਤੀ ਫਿਲਟਰਿੰਗ + ਅੰਕੜੇ |
| ਡਿਕਸ਼ਨਰੀ | `define_word`, `find_synonyms` | ਬਾਹਰੀ API (ਕੋਈ ਕੁੰਜੀ ਨਹੀਂ) |
| ਕਵਿਜ਼ ਜਨਰੇਟਰ | `create_quiz`, `answer_question`, `get_score` | ਸਟੇਟਫੁੱਲ ਗੇਮ |
| AI ਟੂਲਜ਼ | `summarize_text`, `generate_flashcards` | ਟੂਲ ਇੱਕ LLM ਨੂੰ ਕਾਲ ਕਰਦਾ ਹੈ |
| ਉਪਯੋਗਤਾਵਾਂ | `calculate`, `convert_units`, `format_date` | ਸਟੇਟਲੈੱਸ ਹੈਲਪਰ |

## ਦਸਤਾਵੇਜ਼

- [ਆਰਕੀਟੈਕਚਰ](docs/ARCHITECTURE.md): ਰਨਟਾਈਮ ਮਾਡਲ, ਫਿਲਟਰਡ ਰਜਿਸਟਰੀਆਂ, ਸਿੰਥੈਟਿਕ ਟੂਲਜ਼, ਅਤੇ ਐਗਜ਼ੀਕਿਊਸ਼ਨ ਪਾਥ
- [RAG](docs/RAG.md): ਸਿਮੈਂਟਿਕ ਚੰਕਿੰਗ, Gemini/OpenAI embeddings, pgvector ਸਕੀਮਾ, HNSW ਖੋਜ, ਅਤੇ ਟੂਲ ਏਕੀਕਰਨ

## ਪ੍ਰੋਜੈਕਟ ਬਣਤਰ

```text
openFunctions/
├── src/
│   ├── framework/              # ਮੁੱਖ ਰਨਟਾਈਮ + ਕੰਪੋਜ਼ੀਸ਼ਨ ਲੇਅਰਜ਼
│   ├── examples/               # ਸੰਦਰਭ ਟੂਲ ਪੈਟਰਨ
│   ├── my-tools/               # ਤੁਹਾਡੇ ਟੂਲਜ਼
│   └── index.ts                # MCP ਐਂਟਰੀਪੁਆਇੰਟ
├── docs/                       # ਆਰਕੀਟੈਕਚਰ ਦਸਤਾਵੇਜ਼
├── scripts/                    # ਚੈਟ, create-tool, ਦਸਤਾਵੇਜ਼
├── test-client/                # CLI ਟੈਸਟਰ + ਟੈਸਟ ਰਨਰ
├── system-prompts/             # ਪ੍ਰੋਂਪਟ ਪ੍ਰੀਸੈੱਟਸ
└── package.json
```

## ਲਾਇਸੰਸ

MIT — [LICENSE](LICENSE) ਦੇਖੋ