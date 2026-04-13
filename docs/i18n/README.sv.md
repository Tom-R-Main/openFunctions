[English](../../README.md) | [Svenska](README.sv.md)

<p align="center">
  <img src="../../assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Bygg AI-verktyg forst. Komponera agenter nar du behover dem.</strong>
</p>

<p align="center">
  <a href="#quick-start">Snabbstart</a> &middot;
  <a href="#the-mental-model">Mental modell</a> &middot;
  <a href="#choose-the-right-primitive">Valj en primitiv</a> &middot;
  <a href="#capability-ladder">Formagsstege</a> &middot;
  <a href="#providers">Leverantorer</a> &middot;
  <a href="#examples">Exempel</a> &middot;
  <a href="#docs">Dokumentation</a>
</p>

---

openFunctions ar ett MIT-licensierat TypeScript-ramverk for att bygga AI-anropbara verktyg och exponera dem via [MCP](https://modelcontextprotocol.io), chattadaptrar, arbetsfloden och agenter. Dess karnkortid ar enkel:

`ToolDefinition -> ToolRegistry -> AIAdapter`

Allt annat byggs ovanpa det:

- `workflows` ar deterministisk orkestrering kring verktyg
- `agents` ar LLM-loopar over ett filtrerat register
- `structured output` ar ett syntetiskt verktygmonster
- `memory` och `rag` ar tillstandskansliga system som kan omslutas tillbaka till verktyg

Om du forstar verktygets kortid forblir resten av ramverket lasbart.

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

Det forsta att bygga ar ett verktyg, inte en agent.

## Den mentala modellen

Ett verktyg ar din affarslogik plus ett schema som AI kan lasa:

```typescript
import { defineTool, ok } from "../framework/index.js";

export const rollDice = defineTool({
  name: "roll_dice",
  description: "Roll a dice with the given number of sides", // Sla en tarning med det angivna antalet sidor
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "number", description: "Number of sides (default 6)" }, // Antal sidor (standard 6)
    },
  },
  handler: async ({ sides }) => {
    const rolled = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled });
  },
});
```

Denna enda definition kan:

- exekveras direkt av `registry.execute()`
- exponeras for Claude/Desktop via MCP
- anvandas inuti den interaktiva chattloopen
- komponeras till arbetsfloden
- filtreras in i agentspecifika register

Las mer: [Arkitektur](docs/ARCHITECTURE.md)

## Valj ratt primitiv

| Anvand detta | Nar du vill | Vad det egentligen ar |
|----------|---------------|-------------------|
| `defineTool()` | anropbar AI-riktad affarslogik | den primara primitiven |
| `createChatAgent()` | en komponerbar, inbaddbar AI-agent | verktyg + minne + kontext + adapter i en konfiguration |
| `pipe()` | deterministisk orkestrering | koddriven verktygs-/LLM-pipeline |
| `defineAgent()` | adaptiv verktygsanvandning i flera steg | en LLM-loop over ett filtrerat register |
| `createConversationMemory()` / `createFactMemory()` | trad-/faktatillstand | persistens plus minnesverktyg |
| `createRAG()` | semantisk dokumenthamtning | pgvector + inbaddningar + verktyg |
| `connectProvider()` | kontext fran ett externt system | strukturerade verktyg fran ExecuFunction, Obsidian m.fl. |
| `createStore()` / `createPgStore()` | persistens | lagringslager, inte hamtning |

Tumregel:

- Borja med ett verktyg.
- Anvand `createChatAgent()` nar du vill ha en komplett agent med minne och kontext.
- Anvand ett arbetsflode nar du kanner till sekvensen.
- Anvand `defineAgent()` nar du behover specialiserade agenter i team.
- Lagg till minne for tillstand du kontrollerar.
- Lagg till RAG for dokumenthamtning baserat pa betydelse.
- Lagg till en kontextprovider nar du behover externa system (uppgifter, kalendrar, CRM).

## Formagsstege

### 1. Bygg ett verktyg

```bash
npm run create-tool expense_tracker
```

Redigera `src/my-tools/expense_tracker.ts`, kor sedan:

```bash
npm run test-tools
npm test
```

### 2. Exponera det via MCP eller chatt

```bash
npm start
npm run chat -- gemini
```

Samma register driver bada.

### 3. Komponera det med arbetsfloden

Arbetsfloden ar den forvalda "avancerade" primitiven eftersom kontrollflodet forblir explicit:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}"));

await research.run({ word: "ephemeral" });
```

### 4. Bygg en chattagent

`createChatAgent()` komponerar verktyg, minne, kontextproviders och en AI-adapter till en enda inbaddbar agent:

```typescript
import { createChatAgent } from "./framework/index.js";

const agent = await createChatAgent({
  provider: "gemini",
  preset: "study-buddy",
  memory: true,                    // konversations- + faktaminne (pa som standard)
  providers: ["execufunction"],    // anslut extern kontext
});

// Fyra satt att anvanda det:
await agent.interactive();                          // CLI
const result = await agent.chat("Create a task");   // programmatiskt
for await (const chunk of agent.chat("hello", { stream: true })) { ... }  // streaming
await agent.serve({ port: 3000 });                  // HTTP-server
```

Samma konfiguration fungerar fran kod, CLI-flaggor eller YAML-filer. Minne ar pa som standard — agenten kommer ihag mellan sessioner.

### 5. Lagg till adaptivt beteende med agenter

`defineAgent()` ar for specialiserade agenter i team och arbetsfloden — filtrerade register och resonemangslooppar:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst", // Forskningsanalytiker
  goal: "Find accurate information using available tools", // Hitta korrekt information med tillgangliga verktyg
  toolTags: ["search"],
});
```

Anvand team nar flera specialiserade agenter behover samarbeta.

### 6. Lagg till tillstand endast vid behov

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

### 7. Anslut extern kontext

Kontextproviders ansluter externa system (uppgiftshanterare, kalendrar, CRM, kunskapsbaser) till agentens kortidsmiljo som verktyg:

```typescript
import { connectProvider, contextPrompt } from "./framework/index.js";
import { createExecuFunctionProvider } from "./providers/execufunction/index.js";

// Anslut — registrerar 17 verktyg taggade "context" + "context:execufunction"
const exf = await connectProvider(
  createExecuFunctionProvider({ token: process.env.EXF_PAT }),
  registry,
);

// Injicera aktiva uppgifter + kommande handelser i agentens systempromptar
const context = await contextPrompt([exf]);
```

`ContextProvider`-interfacet ar pluggbart — implementera `metadata`, `connect()` och `createTools()` for att integrera vilken backend som helst i ramverket. Se [Arkitektur](docs/ARCHITECTURE.md#context-providers) for det fullstandiga interfacet.

| Provider | Status | Funktioner |
|----------|--------|--------------|
| [ExecuFunction](src/providers/execufunction/) | Inbyggd | uppgifter, projekt, kalender, kunskap, personer, organisationer, kodbas |
| Obsidian | Mall (planerad) | kunskap |
| Notion | Mall (planerad) | kunskap, uppgifter, projekt |

## Kommandon

```bash
npm run test-tools          # Interaktiv CLI — testa verktyg lokalt
npm run dev                 # Utvecklingslage — startar om automatiskt vid sparning
npm test                    # Kor verktygsdefinierade automatiserade tester
npm run chat                # Chatta med AI med dina verktyg
npm run chat -- gemini      # Tvinga en specifik leverantor
npm run chat -- --no-memory # Chatta utan persistent minne
npm run create-tool <name>  # Skapa ett nytt verktyg
npm run docs                # Generera referensdokumentation for verktyg
npm run inspect             # MCP Inspector webbgranssnitt
npm start                   # Starta MCP-server for Claude Desktop / Cursor
```

## Leverantorer

Ange en API-nyckel i `.env` sa kommer chattloopen automatiskt att upptacka leverantoren.

| Leverantor | Standardmodell | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | Funktionsanrop |
| OpenAI | `gpt-5.4` | Responses API |
| Anthropic | `claude-sonnet-4-6` | Meddelanden + verktygsanvandning |
| xAI | `grok-4.20-0309-reasoning` | Responses API |
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
    { name: "creates a task", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } }, // skapar en uppgift
    { name: "fails without subject", input: { title: "Read ch5" }, expect: { success: false } }, // misslyckas utan amne
  ],
});
```

Registret validerar parametrar innan hanterare kors, sa schemafel visas tillrackligt tydligt for att bade manniskor och LLM:er ska kunna aterhamt sig.

## Exempel

| Doman | Verktyg | Monster |
|--------|-------|---------|
| Studiehanterare | `create_task`, `list_tasks`, `complete_task` | CRUD + Lagring |
| Bokmarkshanterare | `save_link`, `search_links`, `tag_link` | Arrayer + Sokning |
| Receptsamlare | `save_recipe`, `search_recipes`, `get_random` | Kapslad data + Slumpmassigt |
| Utgiftsdelare | `add_expense`, `split_bill`, `get_balances` | Matematik + Berakningar |
| Traningslogg | `log_workout`, `get_stats`, `suggest_workout` | Datumfiltrering + Statistik |
| Ordbok | `define_word`, `find_synonyms` | Extern API (ingen nyckel) |
| Quizgenerator | `create_quiz`, `answer_question`, `get_score` | Tillstandskansligt spel |
| AI-verktyg | `summarize_text`, `generate_flashcards` | Verktyg anropar en LLM |
| Verktyg | `calculate`, `convert_units`, `format_date` | Tillstandslosa hjalpare |

## Dokumentation

- [Arkitektur](docs/ARCHITECTURE.md): kortidsmodellen, filtrerade register, syntetiska verktyg och exekveringsvagar
- [RAG](docs/RAG.md): semantisk chunking, Gemini/OpenAI-inbaddningar, pgvector-schema, HNSW-sokning och verktygsintegration

## Plugins

### ExecuFunction for OpenClaw

Pluginen [`@openfunctions/openclaw-execufunction`](plugins/openclaw-execufunction/) tar [ExecuFunction](https://execufunction.com) till [OpenClaw](https://github.com/openclaw/openclaw)-agentekosystemet — 17 verktyg i 6 domaner:

| Doman | Verktyg | Vad det gor |
|--------|-------|--------------|
| Uppgifter | `exf_tasks_list`, `exf_tasks_create`, `exf_tasks_update`, `exf_tasks_complete` | Strukturerad uppgiftshantering med prioriteringar (do_now/do_next/do_later/delegate/drop) |
| Kalender | `exf_calendar_list`, `exf_calendar_create`, `exf_calendar_update` | Handelseschemalaggning och uppslag |
| Kunskap | `exf_notes_search`, `exf_notes_create`, `exf_notes_get` | Semantisk sokning i en kunskapsbas |
| Projekt | `exf_projects_list`, `exf_projects_context` | Projektstatus och full kontext (uppgifter, anteckningar, signaler) |
| Personer/CRM | `exf_people_search`, `exf_person_create`, `exf_org_search` | Kontakt- och organisationshantering |
| Kodbas | `exf_codebase_search`, `exf_code_who_knows` | Semantisk kodsokning och expertisuppfoljning |

Installera:

```bash
openclaw plugins install @openfunctions/openclaw-execufunction
```

Stall in `EXF_PAT` i din miljo (eller konfigurera via OpenClaw plugininstellningar), och din OpenClaw-agent far persistenta uppgifter, kalendermedvetenhet, semantisk kunskapssokning, CRM och kodintelligens — drivet av ExecuFunctions moln-API.

Se [plugin README](plugins/openclaw-execufunction/) for detaljer.

## Projektstruktur

```text
openFunctions/
├── src/
│   ├── framework/              # Karnkortid + kompositionslager
│   │   ├── chat-agent.ts       # createChatAgent() — komponerbar chattagentfabrik
│   │   ├── chat-agent-types.ts # ChatAgent, ChatAgentConfig, ChatResult-typer
│   │   ├── chat-agent-resolve.ts # Konfigurationsupplysning, leverantorsautodetektering
│   │   ├── chat-agent-http.ts  # HTTP-server for agent.serve()
│   │   ├── context.ts          # Kontextprovider-interface
│   │   └── ...                 # tool, registry, agents, memory, rag, workflows
│   ├── providers/
│   │   └── execufunction/      # ExecuFunction kontextprovider (referensimplementation)
│   ├── examples/               # Referensverktygsmonster
│   ├── my-tools/               # Dina verktyg
│   └── index.ts                # MCP-ingangspunkt
├── plugins/
│   └── openclaw-execufunction/ # ExecuFunction-plugin for OpenClaw
├── docs/                       # Arkitekturdokumentation
├── scripts/                    # chatt, skapa-verktyg, dokumentation
├── test-client/                # CLI-testare + testkornare
├── system-prompts/             # Prompt-forinstallningar
└── package.json
```

## Licens

MIT — se [LICENSE](LICENSE)
