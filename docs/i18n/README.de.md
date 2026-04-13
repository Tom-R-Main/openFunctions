[English](../../README.md) | [Deutsch](README.de.md)

<p align="center">
  <img src="../../assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Zuerst KI-Tools entwickeln. Agenten bei Bedarf zusammenstellen.</strong>
</p>

<p align="center">
  <a href="#schnellstart">Schnellstart</a> &middot;
  <a href="#das-mentale-modell">Mentales Modell</a> &middot;
  <a href="#das-richtige-primitive-wählen">Das richtige Primitive wählen</a> &middot;
  <a href="#fähigkeitsleiter">Fähigkeitsleiter</a> &middot;
  <a href="#anbieter">Anbieter</a> &middot;
  <a href="#beispiele">Beispiele</a> &middot;
  <a href="#dokumentation">Dokumentation</a>
</p>

---

openFunctions ist ein MIT-lizenziertes TypeScript-Framework zum Erstellen von KI-aufrufbaren Tools und deren Bereitstellung über [MCP](https://modelcontextprotocol.io), Chat-Adapter, Workflows und Agenten. Die Kernlaufzeit ist einfach:

`ToolDefinition -> ToolRegistry -> AIAdapter`

Alles andere baut darauf auf:

- `workflows` sind deterministische Orchestrierung rund um Tools
- `agents` sind LLM-Schleifen über ein gefiltertes Register
- `structured output` ist ein synthetisches Tool-Muster
- `memory` und `rag` sind zustandsbehaftete Systeme, die wieder in Tools verpackt werden können

Wenn Sie die Tool-Laufzeit verstehen, bleibt der Rest des Frameworks lesbar.

```text
defineTool() -> registry.register() -> adapter/server executes tool
                                    -> workflows compose tools // Workflows komponieren Tools
                                    -> agents use filtered tools // Agenten nutzen gefilterte Tools
                                    -> memory/rag expose more tools // Memory/RAG stellen weitere Tools bereit
```

## Schnellstart

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

Das Erste, was Sie bauen sollten, ist ein Tool, kein Agent.

## Das Mentale Modell

Ein Tool ist Ihre Geschäftslogik plus ein Schema, das die KI lesen kann:

```typescript
import { defineTool, ok } from "../framework/index.js";

export const rollDice = defineTool({
  name: "roll_dice",
  description: "Roll a dice with the given number of sides", // Würfelt einen Würfel mit der angegebenen Anzahl von Seiten
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "number", description: "Number of sides (default 6)" }, // Anzahl der Seiten (Standard 6)
    },
  },
  handler: async ({ sides }) => {
    const rolled = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled });
  },
});
```

Diese eine Definition kann:

- direkt von `registry.execute()` ausgeführt werden
- Claude/Desktop über MCP bereitgestellt werden
- innerhalb der interaktiven Chat-Schleife verwendet werden
- in Workflows komponiert werden
- in agentenspezifische Register gefiltert werden

Mehr erfahren: [Architektur](../../docs/ARCHITECTURE.md)

## Das richtige Primitive wählen

| Verwenden Sie dies | Wenn Sie möchten | Was es wirklich ist |
|--------------------|-------------------|--------------------|
| `defineTool()` | aufrufbare KI-orientierte Geschäftslogik | das Kern-Primitive |
| `createChatAgent()` | einen komponierbaren, einbettbaren KI-Agenten | Tools + Speicher + Kontext + Adapter in einer Konfiguration |
| `pipe()` | deterministische Orchestrierung | code-gesteuerte Tool-/LLM-Pipeline |
| `defineAgent()` | adaptive mehrstufige Tool-Nutzung | eine LLM-Schleife über ein gefiltertes Register |
| `createConversationMemory()` / `createFactMemory()` | Thread-/Fakt-Zustand | Persistenz plus Memory-Tools |
| `createRAG()` | semantische Dokumentenabfrage | pgvector + Embeddings + Tools |
| `connectProvider()` | Kontext aus externen Systemen | strukturierte Tools von ExecuFunction, Obsidian usw. |
| `createStore()` / `createPgStore()` | Persistenz | Speicherschicht, nicht Abfrage |

Faustregel:

- Beginnen Sie mit einem Tool.
- Verwenden Sie `createChatAgent()`, wenn Sie einen vollständigen Agenten mit Speicher und Kontext möchten.
- Verwenden Sie einen Workflow, wenn Sie die Reihenfolge kennen.
- Verwenden Sie `defineAgent()`, wenn Sie spezialisierte Agenten in Crews benötigen.
- Fügen Sie Speicher für den Zustand hinzu, den Sie kontrollieren.
- Fügen Sie RAG für die Dokumentenabfrage nach Bedeutung hinzu.
- Fügen Sie einen Kontextanbieter hinzu, wenn Sie externe Systeme benötigen (Aufgaben, Kalender, CRM).

## Fähigkeitsleiter

### 1. Ein Tool erstellen

```bash
npm run create-tool expense_tracker
```

Bearbeiten Sie `src/my-tools/expense_tracker.ts` und führen Sie dann aus:

```bash
npm run test-tools
npm test
```

### 2. Über MCP oder Chat bereitstellen

```bash
npm start
npm run chat -- gemini
```

Dasselbe Register treibt beides an.

### 3. Mit Workflows komponieren

Workflows sind das standardmäßige „fortgeschrittene" Primitive, da der Kontrollfluss explizit bleibt:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}")); // Erkläre dies einfach: {{input}}

await research.run({ word: "ephemeral" });
```

### 4. Einen Chat-Agenten erstellen

`createChatAgent()` kombiniert Tools, Speicher, Kontextanbieter und einen KI-Adapter zu einem einzigen einbettbaren Agenten:

```typescript
import { createChatAgent } from "./framework/index.js";

const agent = await createChatAgent({
  provider: "gemini",
  preset: "study-buddy",
  memory: true,                    // Konversations- + Fakten-Speicher (standardmäßig aktiviert)
  providers: ["execufunction"],    // externen Kontext verbinden
});

// Vier Verwendungsarten:
await agent.interactive();                          // CLI
const result = await agent.chat("Create a task");   // programmatisch
for await (const chunk of agent.chat("hello", { stream: true })) { ... }  // Streaming
await agent.serve({ port: 3000 });                  // HTTP-Server
```

Dieselbe Konfiguration funktioniert aus Code, CLI-Optionen oder YAML-Dateien. Speicher ist standardmäßig aktiviert — der Agent erinnert sich über Sitzungen hinweg.

### 5. Adaptives Verhalten mit Agenten hinzufügen

`defineAgent()` ist für spezialisierte Agenten innerhalb von Crews und Workflows — gefilterte Register und Reasoning-Schleifen:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst", // Forschungsanalyst
  goal: "Find accurate information using available tools", // Präzise Informationen mit verfügbaren Tools finden
  toolTags: ["search"],
});
```

Verwenden Sie Crews, wenn mehrere spezialisierte Agenten zusammenarbeiten müssen.

### 6. Zustand nur bei Bedarf hinzufügen

Persistenz:

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

Speicher:

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

RAG-Dokumentation: [docs/RAG.md](../../docs/RAG.md)

### 7. Externen Kontext verbinden

Kontextanbieter bringen externe Systeme (Aufgabenverwaltungen, Kalender, CRM, Wissensdatenbanken) als Tools in die Agenten-Laufzeit:

```typescript
import { connectProvider, contextPrompt } from "./framework/index.js";
import { createExecuFunctionProvider } from "./providers/execufunction/index.js";

// Verbinden — registriert 17 Tools mit den Tags "context" + "context:execufunction"
const exf = await connectProvider(
  createExecuFunctionProvider({ token: process.env.EXF_PAT }),
  registry,
);

// Aktive Aufgaben + bevorstehende Termine in System-Prompts des Agenten einfügen
const context = await contextPrompt([exf]);
```

Die `ContextProvider`-Schnittstelle ist erweiterbar — implementieren Sie `metadata`, `connect()` und `createTools()`, um jedes Backend in das Framework einzubinden. Siehe [Architektur](../../docs/ARCHITECTURE.md#context-providers) für die vollständige Schnittstelle.

| Anbieter | Status | Fähigkeiten |
|----------|--------|-------------|
| [ExecuFunction](../../src/providers/execufunction/) | Integriert | Aufgaben, Projekte, Kalender, Wissen, Personen, Organisationen, Code |
| Obsidian | Vorlage (geplant) | Wissen |
| Notion | Vorlage (geplant) | Wissen, Aufgaben, Projekte |

## Befehle

```bash
npm run test-tools          # Interaktive CLI — Tools lokal testen
npm run dev                 # Dev-Modus — startet bei Speicherung automatisch neu
npm test                    # Führt Tool-definierte automatisierte Tests aus
npm run chat                # Chatten Sie mit KI unter Verwendung Ihrer Tools
npm run chat -- gemini      # Erzwingt einen bestimmten Anbieter
npm run chat -- --no-memory # Chat ohne persistenten Speicher
npm run create-tool <name>  # Erstellt ein neues Tool-Grundgerüst
npm run docs                # Generiert Tool-Referenzdokumentation
npm run inspect             # MCP Inspector Web-UI
npm start                   # Startet den MCP-Server für Claude Desktop / Cursor
```

## Anbieter

Legen Sie einen API-Schlüssel in `.env` fest, und die Chat-Schleife erkennt den Anbieter automatisch.

| Anbieter | Standard-Modell | API |
|----------|-----------------|-----|
| Gemini | `gemini-3-flash-preview` | Funktionsaufruf |
| OpenAI | `gpt-5.4` | Responses API |
| Anthropic | `claude-sonnet-4-6` | Nachrichten + Tool-Nutzung |
| xAI | `grok-4.20-0309-reasoning` | Responses API |
| OpenRouter | `google/gemini-3-flash-preview` | OpenAI-kompatibel |

Beispiele:

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## Testen

Tests befinden sich bei den Tool-Definitionen:

```typescript
defineTool({
  name: "create_task",
  // ...
  tests: [
    { name: "creates a task", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } }, // erstellt eine Aufgabe
    { name: "fails without subject", input: { title: "Read ch5" }, expect: { success: false } }, // schlägt ohne Betreff fehl
  ],
});
```

Das Register validiert Parameter, bevor Handler ausgeführt werden, sodass Schemafehler klar genug für Menschen und LLMs angezeigt werden, um sich zu erholen.

## Beispiele

| Domäne | Tools | Muster |
|--------|-------|---------|
| Lern-Tracker | `create_task`, `list_tasks`, `complete_task` | CRUD + Store |
| Lesezeichen-Manager | `save_link`, `search_links`, `tag_link` | Arrays + Suche |
| Rezept-Verwaltung | `save_recipe`, `search_recipes`, `get_random` | Verschachtelte Daten + Zufall |
| Ausgaben-Splitter | `add_expense`, `split_bill`, `get_balances` | Mathematik + Berechnungen |
| Trainings-Logger | `log_workout`, `get_stats`, `suggest_workout` | Datumsfilterung + Statistiken |
| Wörterbuch | `define_word`, `find_synonyms` | Externe API (kein Schlüssel) |
| Quiz-Generator | `create_quiz`, `answer_question`, `get_score` | Zustandsbehaftetes Spiel |
| KI-Tools | `summarize_text`, `generate_flashcards` | Tool ruft ein LLM auf |
| Dienstprogramme | `calculate`, `convert_units`, `format_date` | Zustandslose Helfer |

## Dokumentation

- [Architektur](../../docs/ARCHITECTURE.md): das Laufzeitmodell, gefilterte Register, synthetische Tools und Ausführungspfade
- [RAG](../../docs/RAG.md): semantisches Chunking, Gemini/OpenAI Embeddings, pgvector-Schema, HNSW-Suche und Tool-Integration

## Plugins

### ExecuFunction für OpenClaw

Das Plugin [`@openfunctions/openclaw-execufunction`](../../plugins/openclaw-execufunction/) bringt [ExecuFunction](https://execufunction.com) in das [OpenClaw](https://github.com/openclaw/openclaw)-Agenten-Ökosystem — 17 Tools in 6 Domänen:

| Domäne | Tools | Was es tut |
|--------|-------|------------|
| Aufgaben | `exf_tasks_list`, `exf_tasks_create`, `exf_tasks_update`, `exf_tasks_complete` | Strukturiertes Aufgabenmanagement mit Prioritäten (do_now/do_next/do_later/delegate/drop) |
| Kalender | `exf_calendar_list`, `exf_calendar_create`, `exf_calendar_update` | Terminplanung und -abfrage |
| Wissen | `exf_notes_search`, `exf_notes_create`, `exf_notes_get` | Semantische Suche in einer Wissensdatenbank |
| Projekte | `exf_projects_list`, `exf_projects_context` | Projektstatus und vollständiger Kontext (Aufgaben, Notizen, Signale) |
| Personen/CRM | `exf_people_search`, `exf_person_create`, `exf_org_search` | Kontakt- und Organisationsverwaltung |
| Code | `exf_codebase_search`, `exf_code_who_knows` | Semantische Code-Suche und Expertise-Tracking |

Installation:

```bash
openclaw plugins install @openfunctions/openclaw-execufunction
```

Setzen Sie `EXF_PAT` in Ihrer Umgebung (oder konfigurieren Sie es über die OpenClaw-Plugin-Einstellungen), und Ihr OpenClaw-Agent erhält persistente Aufgaben, Kalender-Bewusstsein, semantische Wissenssuche, CRM und Code-Intelligenz — alles gestützt auf die Cloud-API von ExecuFunction.

Siehe das [Plugin-README](../../plugins/openclaw-execufunction/) für Details.

## Projektstruktur

```text
openFunctions/
├── src/
│   ├── framework/              # Kernlaufzeit + Kompositionsschichten
│   │   ├── chat-agent.ts       # createChatAgent() — komponierbare Chat-Agenten-Fabrik
│   │   ├── chat-agent-types.ts # Typen ChatAgent, ChatAgentConfig, ChatResult
│   │   ├── chat-agent-resolve.ts # Konfigurationsauflösung, automatische Anbietererkennung
│   │   ├── chat-agent-http.ts  # HTTP-Server für agent.serve()
│   │   ├── context.ts          # Kontextanbieter-Schnittstelle
│   │   └── ...                 # tool, registry, agents, memory, rag, workflows
│   ├── providers/
│   │   └── execufunction/      # ExecuFunction-Kontextanbieter (Referenzimplementierung)
│   ├── examples/               # Referenz-Tool-Muster
│   ├── my-tools/               # Ihre Tools
│   └── index.ts                # MCP-Einstiegspunkt
├── plugins/
│   └── openclaw-execufunction/ # ExecuFunction-Plugin für OpenClaw
├── docs/                       # Architektur-Dokumentation
├── scripts/                    # chat, create-tool, docs
├── test-client/                # CLI-Tester + Test-Runner
├── system-prompts/             # Prompt-Voreinstellungen
└── package.json
```

## Lizenz

MIT — siehe [LICENSE](../../LICENSE)
