[English](../README.md) | [Swedish](README.sv.md)

<p align="center">
  <img src="assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Bygg AI-verktyg först. Komponera agenter när du behöver dem.</strong>
</p>

<p align="center">
  <a href="#quick-start">Snabbstart</a> &middot;
  <a href="#the-mental-model">Mental Modell</a> &middot;
  <a href="#choose-the-right-primitive">Välj en Primitiv</a> &middot;
  <a href="#capability-ladder">Förmågestege</a> &middot;
  <a href="#providers">Leverantörer</a> &middot;
  <a href="#examples">Exempel</a> &middot;
  <a href="#docs">Dokumentation</a>
</p>

---

openFunctions är ett MIT-licensierat TypeScript-ramverk för att bygga AI-anropbara verktyg och exponera dem via [MCP](https://modelcontextprotocol.io), chattadaptrar, arbetsflöden och agenter. Dess kärnkörtid är enkel:

`ToolDefinition -> ToolRegistry -> AIAdapter`

Allt annat byggs ovanpå det:

- `workflows` är deterministisk orkestrering kring verktyg
- `agents` är LLM-loopar över ett filtrerat register
- `structured output` är ett syntetiskt verktygsmönster
- `memory` och `rag` är tillståndskänsliga system som kan omslutas tillbaka till verktyg

Om du förstår verktygets körtid förblir resten av ramverket läsbart.

```text
defineTool() -> registry.register() -> adapter/server executes tool
                                    -> workflows compose tools
                                    -> agents use filtered tools
                                    -> memory/rag expose more tools
```

## Snabbstart

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

Det första att bygga är ett verktyg, inte en agent.

## Den Mentala Modellen

Ett verktyg är din affärslogik plus ett schema som AI kan läsa:

```typescript
import { defineTool, ok } from "../framework/index.js";

export const rollDice = defineTool({
  name: "roll_dice",
  description: "Slå en tärning med det angivna antalet sidor",
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "number", description: "Antal sidor (standard 6)" },
    },
  },
  handler: async ({ sides }) => {
    const rolled = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled });
  },
});
```

Denna enda definition kan vara:

- exekveras direkt av `registry.execute()`
- exponeras för Claude/Desktop via MCP
- användas inuti den interaktiva chattloopen
- komponeras till arbetsflöden
- filtreras in i agentspecifika register

Läs mer: [Arkitektur](docs/ARCHITECTURE.md)

## Välj Rätt Primitiv

| Använd detta | När du vill | Vad det egentligen är |
|----------|---------------|-------------------|
| `defineTool()` | anropbar AI-riktad affärslogik | den primära primitiven |
| `pipe()` | deterministisk orkestrering | koddriven verktygs-/LLM-pipeline |
| `defineAgent()` | adaptiv verktygsanvändning i flera steg | en LLM-loop över ett filtrerat register |
| `createConversationMemory()` / `createFactMemory()` | tråd-/faktatillstånd | persistens plus minnesverktyg |
| `createRAG()` | semantisk dokumenthämtning | pgvector + inbäddningar + verktyg |
| `createStore()` / `createPgStore()` | persistens | lagringslager, inte hämtning |

Tumregel:

- Börja med ett verktyg.
- Använd ett arbetsflöde när du känner till sekvensen.
- Använd en agent endast när modellen behöver välja vad den ska göra härnäst.
- Lägg till minne för tillstånd du kontrollerar.
- Lägg till RAG för dokumenthämtning baserat på betydelse.

## Förmågestege

### 1. Bygg ett verktyg

```bash
npm run create-tool expense_tracker
```

Redigera `src/my-tools/expense_tracker.ts`, kör sedan:

```bash
npm run test-tools
npm test
```

### 2. Exponera det via MCP eller chatt

```bash
npm start
npm run chat -- gemini
```

Samma register driver båda.

### 3. Komponera det med arbetsflöden

Arbetsflöden är den förvalda ”avancerade” primitiven eftersom kontrollflödet förblir explicit:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}"));

await research.run({ word: "ephemeral" });
```

### 4. Lägg till adaptivt beteende med agenter

Agenter använder samma verktyg, men via ett filtrerat register och en resonemangsloop:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst",
  goal: "Find accurate information using available tools",
  toolTags: ["search"],
});
```

Använd team när flera specialiserade agenter behöver samarbeta.

### 5. Lägg till tillstånd endast vid behov

Persistens:

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

Minne:

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

RAG-dokumentation: [docs/RAG.md](docs/RAG.md)

## Kommandon

```bash
npm run test-tools          # Interaktiv CLI — testa verktyg lokalt
npm run dev                 # Utvecklingsläge — startar om automatiskt vid spara
npm test                    # Kör verktygsdefinierade automatiserade tester
npm run chat                # Chatta med AI med dina verktyg
npm run chat -- gemini      # Tvinga en specifik leverantör
npm run create-tool <name>  # Skapa ett nytt verktyg
npm run docs                # Generera referensdokumentation för verktyg
npm run inspect             # MCP Inspector webbgränssnitt
npm start                   # Starta MCP-server för Claude Desktop / Cursor
```

## Leverantörer

Ange en API-nyckel i `.env` så kommer chattloopen automatiskt att upptäcka leverantören.

| Leverantör | Standardmodell | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | Funktionsanrop |
| OpenAI | `gpt-5.4` | Svars-API |
| Anthropic | `claude-sonnet-4-6` | Meddelanden + verktygsanvändning |
| xAI | `grok-4.20-0309-reasoning` | Svars-API |
| OpenRouter | `google/gemini-3-flash-preview` | OpenAI-kompatibel |

Exempel:

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## Testning

Tester finns med verktygsdefinitioner:

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

Registret validerar parametrar innan hanterare körs, så schemafel visas tillräckligt tydligt för att både människor och LLM:er ska kunna återhämta sig.

## Exempel

| Domän | Verktyg | Mönster |
|--------|-------|---------|
| Studiehanterare | `create_task`, `list_tasks`, `complete_task` | CRUD + Lagring |
| Bokmärkshanterare | `save_link`, `search_links`, `tag_link` | Arrayer + Sökning |
| Receptsamlare | `save_recipe`, `search_recipes`, `get_random` | Kapslad data + Slumpmässigt |
| Utgiftsdelare | `add_expense`, `split_bill`, `get_balances` | Matematik + Beräkningar |
| Träningslogg | `log_workout`, `get_stats`, `suggest_workout` | Datumfiltrering + Statistik |
| Ordbok | `define_word`, `find_synonyms` | Extern API (ingen nyckel) |
| Quizgenerator | `create_quiz`, `answer_question`, `get_score` | Tillståndskänsligt spel |
| AI-verktyg | `summarize_text`, `generate_flashcards` | Verktyg anropar en LLM |
| Verktyg | `calculate`, `convert_units`, `format_date` | Tillståndslösa hjälpare |

## Dokumentation

- [Arkitektur](docs/ARCHITECTURE.md): körtidsmodellen, filtrerade register, syntetiska verktyg och exekveringsvägar
- [RAG](docs/RAG.md): semantisk chunking, Gemini/OpenAI-inbäddningar, pgvector-schema, HNSW-sökning och verktygsintegration

## Projektstruktur

```text
openFunctions/
├── src/
│   ├── framework/              # Kärnkörtid + kompositionslager
│   ├── examples/               # Referensverktygsmönster
│   ├── my-tools/               # Dina verktyg
│   └── index.ts                # MCP-ingångspunkt
├── docs/                       # Arkitekturdokumentation
├── scripts/                    # chatt, skapa-verktyg, dokumentation
├── test-client/                # CLI-testare + testkörare
├── system-prompts/             # Prompt-förinställningar
└── package.json
```

## Licens

MIT — se [LICENSE](LICENSE)