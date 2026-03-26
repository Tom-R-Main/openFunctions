[English](../README.md) | [German](README.de.md)

<p align="center">
  <img src="assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Zuerst KI-Tools entwickeln. Agenten bei Bedarf zusammenstellen.</strong>
</p>

<p align="center">
  <a href="#quick-start">Schnellstart</a> &middot;
  <a href="#the-mental-model">Mentales Modell</a> &middot;
  <a href="#choose-the-right-primitive">Das richtige Primitive wählen</a> &middot;
  <a href="#capability-ladder">Fähigkeitsleiter</a> &middot;
  <a href="#providers">Anbieter</a> &middot;
  <a href="#examples">Beispiele</a> &middot;
  <a href="#docs">Dokumentation</a>
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
                                    -> workflows compose tools
                                    -> agents use filtered tools
                                    -> memory/rag expose more tools
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

Diese eine Definition kann sein:

- direkt von `registry.execute()` ausgeführt werden
- Claude/Desktop über MCP bereitgestellt werden
- innerhalb der interaktiven Chat-Schleife verwendet werden
- in Workflows komponiert werden
- in agentenspezifische Register gefiltert werden

Mehr erfahren: [Architektur](docs/ARCHITECTURE.md)

## Das richtige Primitive wählen

| Verwenden Sie dies | Wenn Sie möchten | Was es wirklich ist |
|--------------------|-------------------|--------------------|
| `defineTool()` | aufrufbare KI-orientierte Geschäftslogik | das Kern-Primitive |
| `pipe()` | deterministische Orchestrierung | code-gesteuerte Tool-/LLM-Pipeline |
| `defineAgent()` | adaptive mehrstufige Tool-Nutzung | eine LLM-Schleife über ein gefiltertes Register |
| `createConversationMemory()` / `createFactMemory()` | Thread-/Fakt-Zustand | Persistenz plus Memory-Tools |
| `createRAG()` | semantische Dokumentenabfrage | pgvector + Embeddings + Tools |
| `createStore()` / `createPgStore()` | Persistenz | Speicherschicht, nicht Abfrage |

Faustregel:

- Beginnen Sie mit einem Tool.
- Verwenden Sie einen Workflow, wenn Sie die Reihenfolge kennen.
- Verwenden Sie einen Agenten nur, wenn das Modell entscheiden muss, was als Nächstes zu tun ist.
- Fügen Sie Speicher für den Zustand hinzu, den Sie kontrollieren.
- Fügen Sie RAG für die Dokumentenabfrage nach Bedeutung hinzu.

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

Workflows sind das standardmäßige „fortgeschrittene“ Primitive, da der Kontrollfluss explizit bleibt:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}"));

await research.run({ word: "ephemeral" });
```

### 4. Adaptives Verhalten mit Agenten hinzufügen

Agenten verwenden dieselben Tools, jedoch über ein gefiltertes Register und eine Reasoning-Schleife:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst",
  goal: "Find accurate information using available tools",
  toolTags: ["search"],
});
```

Verwenden Sie Crews, wenn mehrere spezialisierte Agenten zusammenarbeiten müssen.

### 5. Zustand nur bei Bedarf hinzufügen

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

RAG-Dokumentation: [docs/RAG.md](docs/RAG.md)

## Befehle

```bash
npm run test-tools          # Interaktive CLI — Tools lokal testen
npm run dev                 # Dev-Modus — startet bei Speicherung automatisch neu
npm test                    # Führt Tool-definierte automatisierte Tests aus
npm run chat                # Chatten Sie mit KI unter Verwendung Ihrer Tools
npm run chat -- gemini      # Erzwingt einen bestimmten Anbieter
npm run create-tool <name>  # Erstellt ein neues Tool-Grundgerüst
npm run docs                # Generiert Tool-Referenzdokumentation
npm run inspect             # MCP Inspector Web-UI
npm start                   # Startet den MCP-Server für Claude Desktop / Cursor
```

## Anbieter

Legen Sie einen API-Schlüssel in `.env` fest, und die Chat-Schleife erkennt den Anbieter automatisch.

| Provider | Default Model | API |
|----------|---------------|-----|
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

- [Architektur](docs/ARCHITECTURE.md): das Laufzeitmodell, gefilterte Register, synthetische Tools und Ausführungspfade
- [RAG](docs/RAG.md): semantisches Chunking, Gemini/OpenAI Embeddings, pgvector-Schema, HNSW-Suche und Tool-Integration

## Projektstruktur

```text
openFunctions/
├── src/
│   ├── framework/              # Kernlaufzeit + Kompositionsschichten
│   ├── examples/               # Referenz-Tool-Muster
│   ├── my-tools/               # Ihre Tools
│   └── index.ts                # MCP-Einstiegspunkt
├── docs/                       # Architektur-Dokumentation
├── scripts/                    # chat, create-tool, docs
├── test-client/                # CLI-Tester + Test-Runner
├── system-prompts/             # Prompt-Voreinstellungen
└── package.json
```

## Lizenz

MIT — siehe [LICENSE](LICENSE)
