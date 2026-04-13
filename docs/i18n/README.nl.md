[English](../../README.md) | [Nederlands](README.nl.md)

<p align="center">
  <img src="../../assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Bouw eerst AI-tools. Stel agents samen wanneer je ze nodig hebt.</strong>
</p>

<p align="center">
  <a href="#quick-start">Snelle start</a> &middot;
  <a href="#the-mental-model">Mentaal model</a> &middot;
  <a href="#choose-the-right-primitive">Kies de juiste primitief</a> &middot;
  <a href="#capability-ladder">Mogelijkhedenladder</a> &middot;
  <a href="#providers">Providers</a> &middot;
  <a href="#examples">Voorbeelden</a> &middot;
  <a href="#docs">Documentatie</a>
</p>

---

openFunctions is een MIT-gelicentieerd TypeScript-framework voor het bouwen van AI-aanroepbare tools en deze beschikbaar te stellen via [MCP](https://modelcontextprotocol.io), chatadapters, workflows en agents. De kernruntime is eenvoudig:

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

## Snelle start

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

Het eerste wat je bouwt is een tool, geen agent.

## Het mentale model

Een tool is je bedrijfslogica plus een schema dat de AI kan lezen:

```typescript
import { defineTool, ok } from "../framework/index.js";

export const rollDice = defineTool({
  name: "roll_dice",
  description: "Roll a dice with the given number of sides", // Gooi een dobbelsteen met het opgegeven aantal zijden
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "number", description: "Number of sides (default 6)" }, // Aantal zijden (standaard 6)
    },
  },
  handler: async ({ sides }) => {
    const rolled = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled });
  },
});
```

Die ene definitie kan:

- direct uitgevoerd worden door `registry.execute()`
- beschikbaar gesteld worden aan Claude/Desktop via MCP
- gebruikt worden binnen de interactieve chatloop
- samengesteld worden in workflows
- gefilterd worden in agentspecifieke registers

Lees meer: [Architectuur](docs/ARCHITECTURE.md)

## Kies de juiste primitief

| Gebruik dit | Wanneer je wilt | Wat het werkelijk is |
|----------|---------------|-------------------|
| `defineTool()` | aanroepbare AI-gerichte bedrijfslogica | de kernprimitief |
| `createChatAgent()` | een componeerbare, inbedbare AI-agent | tools + geheugen + context + adapter in een configuratie |
| `pipe()` | deterministische orkestratie | code-gestuurde tool/LLM-pipeline |
| `defineAgent()` | adaptief gebruik van tools in meerdere stappen | een LLM-loop over een gefilterd register |
| `createConversationMemory()` / `createFactMemory()` | thread-/feitenstatus | persistentie plus geheugentools |
| `createRAG()` | semantische documentretrieval | pgvector + embeddings + tools |
| `connectProvider()` | context van een extern systeem | gestructureerde tools van ExecuFunction, Obsidian, enz. |
| `createStore()` / `createPgStore()` | persistentie | opslaglaag, geen retrieval |

Vuistregel:

- Begin met een tool.
- Gebruik `createChatAgent()` wanneer je een complete agent met geheugen en context wilt.
- Gebruik een workflow wanneer je de volgorde kent.
- Gebruik `defineAgent()` wanneer je gespecialiseerde agents in teams nodig hebt.
- Voeg geheugen toe voor status die je beheert.
- Voeg RAG toe voor documentretrieval op basis van betekenis.
- Voeg een contextprovider toe wanneer je externe systemen nodig hebt (taken, kalenders, CRM).

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

### 4. Bouw een chatagent

`createChatAgent()` combineert tools, geheugen, contextproviders en een AI-adapter in een enkele inbedbare agent:

```typescript
import { createChatAgent } from "./framework/index.js";

const agent = await createChatAgent({
  provider: "gemini",
  preset: "study-buddy",
  memory: true,                    // gesprek- + feitengeheugen (standaard aan)
  providers: ["execufunction"],    // verbind externe context
});

// Vier manieren om het te gebruiken:
await agent.interactive();                          // CLI
const result = await agent.chat("Create a task");   // programmatisch
for await (const chunk of agent.chat("hello", { stream: true })) { ... }  // streaming
await agent.serve({ port: 3000 });                  // HTTP-server
```

Dezelfde configuratie werkt vanuit code, CLI-flags of YAML-bestanden. Geheugen is standaard aan — de agent onthoudt tussen sessies.

### 5. Voeg adaptief gedrag toe met agents

`defineAgent()` is bedoeld voor gespecialiseerde agents in teams en workflows — gefilterde registers en redeneerloops:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst", // Onderzoeksanalist
  goal: "Find accurate information using available tools", // Nauwkeurige informatie vinden met beschikbare tools
  toolTags: ["search"],
});
```

Gebruik crews wanneer meerdere gespecialiseerde agents moeten samenwerken.

### 6. Voeg alleen status toe wanneer nodig

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

RAG-documentatie: [docs/RAG.md](docs/RAG.md)

### 7. Verbind externe context

Contextproviders verbinden externe systemen (taakbeheerders, kalenders, CRM, kennisbanken) met de agentruntime als tools:

```typescript
import { connectProvider, contextPrompt } from "./framework/index.js";
import { createExecuFunctionProvider } from "./providers/execufunction/index.js";

// Verbinden — registreert 17 tools getagd "context" + "context:execufunction"
const exf = await connectProvider(
  createExecuFunctionProvider({ token: process.env.EXF_PAT }),
  registry,
);

// Injecteer actieve taken + aankomende evenementen in agent-systeemprompts
const context = await contextPrompt([exf]);
```

De `ContextProvider`-interface is pluggable — implementeer `metadata`, `connect()` en `createTools()` om elke backend in het framework te integreren. Zie [Architectuur](docs/ARCHITECTURE.md#context-providers) voor de volledige interface.

| Provider | Status | Mogelijkheden |
|----------|--------|--------------|
| [ExecuFunction](src/providers/execufunction/) | Ingebouwd | taken, projecten, kalender, kennis, mensen, organisaties, codebase |
| Obsidian | Template (gepland) | kennis |
| Notion | Template (gepland) | kennis, taken, projecten |

## Commando's

```bash
npm run test-tools          # Interactieve CLI — test tools lokaal
npm run dev                 # Dev-modus — herstart automatisch bij opslaan
npm test                    # Voer tool-gedefinieerde geautomatiseerde tests uit
npm run chat                # Chat met AI met behulp van je tools
npm run chat -- gemini      # Forceer een specifieke provider
npm run chat -- --no-memory # Chat zonder persistent geheugen
npm run create-tool <name>  # Genereer een nieuwe tool-structuur
npm run docs                # Genereer toolreferentiedocumentatie
npm run inspect             # MCP Inspector web-UI
npm start                   # Start MCP-server voor Claude Desktop / Cursor
```

## Providers

Stel een API-sleutel in `.env` in en de chatloop detecteert automatisch de provider.

| Provider | Standaard model | API |
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

Tests staan bij de tooldefinities:

```typescript
defineTool({
  name: "create_task",
  // ...
  tests: [
    { name: "creates a task", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } }, // maakt een taak aan
    { name: "fails without subject", input: { title: "Read ch5" }, expect: { success: false } }, // faalt zonder onderwerp
  ],
});
```

Het register valideert parameters voordat handlers worden uitgevoerd, zodat schemafouten duidelijk genoeg worden weergegeven voor zowel mensen als LLM's om te herstellen.

## Voorbeelden

| Domein | Tools | Patroon |
|--------|-------|---------|
| Studieplanner | `create_task`, `list_tasks`, `complete_task` | CRUD + Opslag |
| Bladwijzerbeheerder | `save_link`, `search_links`, `tag_link` | Arrays + Zoeken |
| Receptenbeheerder | `save_recipe`, `search_recipes`, `get_random` | Geneste data + Willekeurig |
| Kostenverdeler | `add_expense`, `split_bill`, `get_balances` | Wiskunde + Berekeningen |
| Workout Logger | `log_workout`, `get_stats`, `suggest_workout` | Datumfiltering + Statistieken |
| Woordenboek | `define_word`, `find_synonyms` | Externe API (geen sleutel) |
| Quizgenerator | `create_quiz`, `answer_question`, `get_score` | Stateful spel |
| AI Tools | `summarize_text`, `generate_flashcards` | Tool roept een LLM aan |
| Hulpprogramma's | `calculate`, `convert_units`, `format_date` | Stateless helpers |

## Documentatie

- [Architectuur](docs/ARCHITECTURE.md): het runtimemodel, gefilterde registers, synthetische tools en uitvoeringspaden
- [RAG](docs/RAG.md): semantische chunking, Gemini/OpenAI-embeddings, pgvector-schema, HNSW-zoeken en toolintegratie

## Plugins

### ExecuFunction voor OpenClaw

De [`@openfunctions/openclaw-execufunction`](plugins/openclaw-execufunction/) plugin brengt [ExecuFunction](https://execufunction.com) naar het [OpenClaw](https://github.com/openclaw/openclaw) agent-ecosysteem — 17 tools in 6 domeinen:

| Domein | Tools | Wat het doet |
|--------|-------|--------------|
| Taken | `exf_tasks_list`, `exf_tasks_create`, `exf_tasks_update`, `exf_tasks_complete` | Gestructureerd taakbeheer met prioriteiten (do_now/do_next/do_later/delegate/drop) |
| Kalender | `exf_calendar_list`, `exf_calendar_create`, `exf_calendar_update` | Evenementplanning en opzoeken |
| Kennis | `exf_notes_search`, `exf_notes_create`, `exf_notes_get` | Semantisch zoeken in een kennisbank |
| Projecten | `exf_projects_list`, `exf_projects_context` | Projectstatus en volledige context (taken, notities, signalen) |
| Mensen/CRM | `exf_people_search`, `exf_person_create`, `exf_org_search` | Contact- en organisatiebeheer |
| Codebase | `exf_codebase_search`, `exf_code_who_knows` | Semantisch zoeken in code en expertise-tracking |

Installeren:

```bash
openclaw plugins install @openfunctions/openclaw-execufunction
```

Stel `EXF_PAT` in je omgeving in (of configureer via OpenClaw plugin-instellingen), en je OpenClaw-agent krijgt persistente taken, kalenderbewustzijn, semantisch zoeken in kennis, CRM en code-intelligentie — aangedreven door de cloud-API van ExecuFunction.

Zie de [plugin README](plugins/openclaw-execufunction/) voor details.

## Projectstructuur

```text
openFunctions/
├── src/
│   ├── framework/              # Kernruntime + compositielagen
│   │   ├── chat-agent.ts       # createChatAgent() — componeerbare chatagent-fabriek
│   │   ├── chat-agent-types.ts # ChatAgent, ChatAgentConfig, ChatResult types
│   │   ├── chat-agent-resolve.ts # Configuratieresolutie, provider-autodetectie
│   │   ├── chat-agent-http.ts  # HTTP-server voor agent.serve()
│   │   ├── context.ts          # Contextprovider-interface
│   │   └── ...                 # tool, registry, agents, memory, rag, workflows
│   ├── providers/
│   │   └── execufunction/      # ExecuFunction contextprovider (referentie-implementatie)
│   ├── examples/               # Referentietoolpatronen
│   ├── my-tools/               # Jouw tools
│   └── index.ts                # MCP-ingangspunt
├── plugins/
│   └── openclaw-execufunction/ # ExecuFunction plugin voor OpenClaw
├── docs/                       # Architectuurdocumentatie
├── scripts/                    # chat, create-tool, docs
├── test-client/                # CLI-tester + testrunner
├── system-prompts/             # Prompt-voorinstellingen
└── package.json
```

## Licentie

MIT — zie [LICENSE](LICENSE)
