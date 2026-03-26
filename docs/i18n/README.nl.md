[English](../README.md) | [Dutch](README.nl.md)

<p align="center">
  <img src="assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Bouw eerst AI-tools. Stel agents samen wanneer je ze nodig hebt.</strong>
</p>

<p align="center">
  <a href="#quick-start">Snelle Start</a> &middot;
  <a href="#the-mental-model">Mentaal Model</a> &middot;
  <a href="#choose-the-right-primitive">Kies de Juiste Primitief</a> &middot;
  <a href="#capability-ladder">Mogelijkhedenladder</a> &middot;
  <a href="#providers">Providers</a> &middot;
  <a href="#examples">Voorbeelden</a> &middot;
  <a href="#docs">Documentatie</a>
</p>

---

openFunctions is een MIT-gelicentieerd TypeScript framework voor het bouwen van AI-aanroepbare tools en deze beschikbaar te stellen via [MCP](https://modelcontextprotocol.io), chatadapters, workflows en agents. De kernruntime is eenvoudig:

`ToolDefinition -> ToolRegistry -> AIAdapter`

Al het andere bouwt daarop voort:

- `workflows` zijn deterministische orkestratie rondom tools
- `agents` zijn LLM-loops over een gefilterd register
- `structured output` is een synthetisch toolpatroon
- `memory` en `rag` zijn stateful systemen die terug in tools kunnen worden gewrapt

Als je de toolruntime begrijpt, blijft de rest van het framework leesbaar.

```text
defineTool() -> registry.register() -> adapter/server executes tool
                                    -> workflows compose tools
                                    -> agents use filtered tools
                                    -> memory/rag expose more tools
```

## Snelle Start

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

Het eerste wat je bouwt is een tool, geen agent.

## Het Mentaal Model

Een tool is je bedrijfslogica plus een schema dat de AI kan lezen:

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

Die ene definitie kan zijn:

- direct uitgevoerd worden door `registry.execute()`
- beschikbaar gesteld worden aan Claude/Desktop via MCP
- gebruikt worden binnen de interactieve chatloop
- samengesteld worden in workflows
- gefilterd worden in agentspecifieke registers

Lees meer: [Architectuur](docs/ARCHITECTURE.md)

## Kies de Juiste Primitief

| Gebruik dit | Wanneer je wilt | Wat het werkelijk is |
|----------|---------------|-------------------|
| `defineTool()` | aanroepbare AI-gerichte bedrijfslogica | de kernprimitief |
| `pipe()` | deterministische orkestratie | code-gestuurde tool/LLM-pipeline |
| `defineAgent()` | adaptief gebruik van tools in meerdere stappen | een LLM-loop over een gefilterd register |
| `createConversationMemory()` / `createFactMemory()` | thread-/feitenstatus | persistentie plus geheugentools |
| `createRAG()` | semantische documentretrieval | pgvector + embeddings + tools |
| `createStore()` / `createPgStore()` | persistentie | opslaglaag, geen retrieval |

Vuistregel:

- Begin met een tool.
- Gebruik een workflow wanneer je de volgorde kent.
- Gebruik een agent alleen wanneer het model moet kiezen wat het volgende moet doen.
- Voeg geheugen toe voor status die je beheert.
- Voeg RAG toe voor documentretrieval op basis van betekenis.

## Mogelijkhedenladder

### 1. Bouw een tool

```bash
npm run create-tool expense_tracker
```

Bewerk `src/my-tools/expense_tracker.ts` en voer vervolgens uit:

```bash
npm run test-tools
npm test
```

### 2. Stel het beschikbaar via MCP of chat

```bash
npm start
npm run chat -- gemini
```

Hetzelfde register stuurt beide aan.

### 3. Combineer het met workflows

Workflows zijn de standaard "geavanceerde" primitief omdat de controlestroom expliciet blijft:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}"));

await research.run({ word: "ephemeral" });
```

### 4. Voeg adaptief gedrag toe met agents

Agents gebruiken dezelfde tools, maar via een gefilterd register en een redeneerloop:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst",
  goal: "Find accurate information using available tools",
  toolTags: ["search"],
});
```

Gebruik crews wanneer meerdere gespecialiseerde agents moeten samenwerken.

### 5. Voeg alleen status toe wanneer nodig

Persistentie:

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

Geheugen:

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

RAG documentatie: [docs/RAG.md](docs/RAG.md)

## Commando's

```bash
npm run test-tools          # Interactieve CLI — test tools lokaal
npm run dev                 # Dev-modus — herstart automatisch bij opslaan
npm test                    # Voer tool-gedefinieerde geautomatiseerde tests uit
npm run chat                # Chat met AI met behulp van je tools
npm run chat -- gemini      # Forceer een specifieke provider
npm run create-tool <name>  # Genereer een nieuwe tool-structuur
npm run docs                # Genereer toolreferentiedocumentatie
npm run inspect             # MCP Inspector web-UI
npm start                   # Start MCP-server voor Claude Desktop / Cursor
```

## Providers

Stel één API-sleutel in `.env` in en de chatloop detecteert automatisch de provider.

| Provider | Standaard Model | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | Function calling |
| OpenAI | `gpt-5.4` | Responses API |
| Anthropic | `claude-sonnet-4-6` | Messages + tool_use |
| xAI | `grok-4.20-0309-reasoning` | Responses API |
| OpenRouter | `google/gemini-3-flash-preview` | OpenAI-compatible |

Voorbeelden:

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## Testen

Tests leven met tooldefinities:

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

Het register valideert parameters voordat handlers worden uitgevoerd, zodat schemafouten duidelijk genoeg worden weergegeven voor zowel mensen als LLM's om te herstellen.

## Voorbeelden

| Domein | Tools | Patroon |
|--------|-------|---------|
| Studieplanner | `create_task`, `list_tasks`, `complete_task` | CRUD + Store |
| Bladwijzerbeheerder | `save_link`, `search_links`, `tag_link` | Arrays + Zoeken |
| Receptenbeheerder | `save_recipe`, `search_recipes`, `get_random` | Geneste Data + Willekeurig |
| Kostenverdeler | `add_expense`, `split_bill`, `get_balances` | Wiskunde + Berekeningen |
| Workout Logger | `log_workout`, `get_stats`, `suggest_workout` | Datumfiltering + Statistieken |
| Woordenboek | `define_word`, `find_synonyms` | Externe API (geen sleutel) |
| Quizgenerator | `create_quiz`, `answer_question`, `get_score` | Stateful Spel |
| AI Tools | `summarize_text`, `generate_flashcards` | Tool Roept een LLM aan |
| Hulpprogramma's | `calculate`, `convert_units`, `format_date` | Stateless Helpers |

## Documentatie

- [Architectuur](docs/ARCHITECTURE.md): het runtime-model, gefilterde registers, synthetische tools en uitvoeringspaden
- [RAG](docs/RAG.md): semantische chunking, Gemini/OpenAI embeddings, pgvector schema, HNSW zoeken en toolintegratie

## Projectstructuur

```text
openFunctions/
├── src/
│   ├── framework/              # Kernruntime + compositielagen
│   ├── examples/               # Referentietoolpatronen
│   ├── my-tools/               # Jouw tools
│   └── index.ts                # MCP-ingangspunt
├── docs/                       # Architectuurdocumentatie
├── scripts/                    # chat, create-tool, docs
├── test-client/                # CLI-tester + testrunner
├── system-prompts/             # Prompt-voorinstellingen
└── package.json
```

## Licentie

MIT — zie [LICENSE](LICENSE)
