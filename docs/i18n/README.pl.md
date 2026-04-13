[English](../../README.md) | [Polski](README.pl.md)

<p align="center">
  <img src="../../assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Najpierw buduj narzędzia AI. Komponuj agentów, gdy ich potrzebujesz.</strong>
</p>

<p align="center">
  <a href="#quick-start">Szybki start</a> &middot;
  <a href="#the-mental-model">Model mentalny</a> &middot;
  <a href="#choose-the-right-primitive">Wybierz prymityw</a> &middot;
  <a href="#capability-ladder">Drabina możliwości</a> &middot;
  <a href="#providers">Dostawcy</a> &middot;
  <a href="#examples">Przykłady</a> &middot;
  <a href="#docs">Dokumentacja</a>
</p>

---

openFunctions to framework TypeScript na licencji MIT do tworzenia narzędzi wywoływalnych przez AI i udostępniania ich poprzez [MCP](https://modelcontextprotocol.io), adaptery czatu, przepływy pracy i agentów. Jego podstawowe środowisko uruchomieniowe jest proste:

`ToolDefinition -> ToolRegistry -> AIAdapter`

Wszystko inne komponuje się na tej podstawie:

- `workflows` to deterministyczna orkiestracja wokół narzędzi
- `agents` to pętle LLM działające na filtrowanym rejestrze
- `structured output` to syntetyczny wzorzec narzędzia
- `memory` i `rag` to systemy stanowe, które można ponownie opakować w narzędzia

Jeśli rozumiesz środowisko uruchomieniowe narzędzi, reszta frameworka pozostaje czytelna.

```text
defineTool() -> registry.register() -> adapter/server executes tool
                                    -> workflows compose tools
                                    -> agents use filtered tools
                                    -> memory/rag expose more tools
```

## Szybki start

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

Pierwszą rzeczą do zbudowania jest narzędzie, a nie agent.

## Model mentalny

Narzędzie to Twoja logika biznesowa plus schemat, który AI może odczytać:

```typescript
import { defineTool, ok } from "../framework/index.js";

export const rollDice = defineTool({
  name: "roll_dice",
  description: "Roll a dice with the given number of sides", // Rzuć kostką o podanej liczbie ścian
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "number", description: "Number of sides (default 6)" }, // Liczba ścian (domyślnie 6)
    },
  },
  handler: async ({ sides }) => {
    const rolled = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled });
  },
});
```

Ta jedna definicja może być:

- wykonywana bezpośrednio przez `registry.execute()`
- udostępniana Claude/Desktop poprzez MCP
- używana w interaktywnej pętli czatu
- komponowana w przepływy pracy
- filtrowana do rejestrów specyficznych dla agentów

Czytaj więcej: [Architektura](docs/ARCHITECTURE.md)

## Wybierz odpowiedni prymityw

| Użyj tego | Gdy chcesz | Czym to naprawdę jest |
|----------|---------------|-------------------|
| `defineTool()` | wywoływalna logika biznesowa dla AI | podstawowy prymityw |
| `createChatAgent()` | komponowalny, wbudowany agent AI | narzędzia + pamięć + kontekst + adapter w jednej konfiguracji |
| `pipe()` | deterministyczna orkiestracja | potok narzędzi/LLM sterowany kodem |
| `defineAgent()` | adaptacyjne wieloetapowe użycie narzędzi | pętla LLM działająca na filtrowanym rejestrze |
| `createConversationMemory()` / `createFactMemory()` | stan wątku/faktu | trwałość plus narzędzia pamięci |
| `createRAG()` | semantyczne wyszukiwanie dokumentów | pgvector + embeddings + narzędzia |
| `connectProvider()` | kontekst z zewnętrznego systemu | strukturalne narzędzia z ExecuFunction, Obsidian itp. |
| `createStore()` / `createPgStore()` | trwałość | warstwa przechowywania, nie wyszukiwania |

Ogólna zasada:

- Zacznij od narzędzia.
- Użyj `createChatAgent()`, gdy chcesz pełnego agenta z pamięcią i kontekstem.
- Użyj przepływu pracy, gdy znasz sekwencję.
- Użyj `defineAgent()`, gdy potrzebujesz wyspecjalizowanych agentów w zespołach.
- Dodaj pamięć dla stanu, który kontrolujesz.
- Dodaj RAG do wyszukiwania dokumentów według znaczenia.
- Dodaj dostawcę kontekstu, gdy potrzebujesz zewnętrznych systemów (zadania, kalendarze, CRM).

## Drabina możliwości

### 1. Zbuduj narzędzie

```bash
npm run create-tool expense_tracker
```

Edytuj `src/my-tools/expense_tracker.ts`, a następnie uruchom:

```bash
npm run test-tools
npm test
```

### 2. Udostępnij je poprzez MCP lub czat

```bash
npm start
npm run chat -- gemini
```

Ten sam rejestr zasila oba.

### 3. Komponuj je z przepływami pracy

Przepływy pracy są domyślnym "zaawansowanym" prymitywem, ponieważ przepływ sterowania pozostaje jawny:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}"));

await research.run({ word: "ephemeral" });
```

### 4. Zbuduj agenta czatu

`createChatAgent()` komponuje narzędzia, pamięć, dostawców kontekstu i adapter AI w jednego wbudowanego agenta:

```typescript
import { createChatAgent } from "./framework/index.js";

const agent = await createChatAgent({
  provider: "gemini",
  preset: "study-buddy",
  memory: true,                    // pamięć rozmów + faktów (domyślnie włączona)
  providers: ["execufunction"],    // podłącz zewnętrzny kontekst
});

// Cztery sposoby użycia:
await agent.interactive();                          // CLI
const result = await agent.chat("Create a task");   // programowe wywołanie
for await (const chunk of agent.chat("hello", { stream: true })) { ... }  // strumieniowanie
await agent.serve({ port: 3000 });                  // serwer HTTP
```

Ta sama konfiguracja działa z kodu, flag CLI lub plików YAML. Pamięć jest domyślnie włączona — agent zapamiętuje między sesjami.

### 5. Dodaj adaptacyjne zachowanie za pomocą agentów

`defineAgent()` jest przeznaczony dla wyspecjalizowanych agentów w zespołach i przepływach pracy — filtrowane rejestry i pętle rozumowania:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst", // Analityk badawczy
  goal: "Find accurate information using available tools", // Znaleźć dokładne informacje za pomocą dostępnych narzędzi
  toolTags: ["search"],
});
```

Użyj zespołów (crews), gdy wielu wyspecjalizowanych agentów musi współpracować.

### 6. Dodaj stan tylko wtedy, gdy jest to potrzebne

Trwałość:

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

Pamięć:

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

Dokumentacja RAG: [docs/RAG.md](docs/RAG.md)

### 7. Podłącz zewnętrzny kontekst

Dostawcy kontekstu podłączają zewnętrzne systemy (menedżery zadań, kalendarze, CRM, bazy wiedzy) do środowiska uruchomieniowego agentów jako narzędzia:

```typescript
import { connectProvider, contextPrompt } from "./framework/index.js";
import { createExecuFunctionProvider } from "./providers/execufunction/index.js";

// Podłączenie — rejestruje 17 narzędzi z tagami "context" + "context:execufunction"
const exf = await connectProvider(
  createExecuFunctionProvider({ token: process.env.EXF_PAT }),
  registry,
);

// Wstrzykuje aktywne zadania + nadchodzące wydarzenia do promptów systemowych agenta
const context = await contextPrompt([exf]);
```

Interfejs `ContextProvider` jest podłączalny — zaimplementuj `metadata`, `connect()` i `createTools()`, aby zintegrować dowolny backend z frameworkiem. Szczegóły w [Architektura](docs/ARCHITECTURE.md#context-providers).

| Dostawca | Status | Możliwości |
|----------|--------|--------------|
| [ExecuFunction](src/providers/execufunction/) | Wbudowany | zadania, projekty, kalendarz, wiedza, ludzie, organizacje, baza kodu |
| Obsidian | Szablon (planowany) | wiedza |
| Notion | Szablon (planowany) | wiedza, zadania, projekty |

## Polecenia

```bash
npm run test-tools          # Interaktywny CLI — testuj narzędzia lokalnie
npm run dev                 # Tryb deweloperski — automatyczne ponowne uruchamianie po zapisie
npm test                    # Uruchom zdefiniowane przez narzędzia testy automatyczne
npm run chat                # Czatuj z AI używając swoich narzędzi
npm run chat -- gemini      # Wymuś konkretnego dostawcę
npm run chat -- --no-memory # Czat bez trwałej pamięci
npm run create-tool <name>  # Utwórz szkielet nowego narzędzia
npm run docs                # Generuj dokumentację referencyjną narzędzi
npm run inspect             # Interfejs webowy inspektora MCP
npm start                   # Uruchom serwer MCP dla Claude Desktop / Cursor
```

## Dostawcy

Ustaw jeden klucz API w `.env`, a pętla czatu automatycznie wykryje dostawcę.

| Dostawca | Domyślny model | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | Wywoływanie funkcji |
| OpenAI | `gpt-5.4` | Responses API |
| Anthropic | `claude-sonnet-4-6` | Wiadomości + użycie narzędzi |
| xAI | `grok-4.20-0309-reasoning` | Responses API |
| OpenRouter | `google/gemini-3-flash-preview` | Kompatybilne z OpenAI |

Przykłady:

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## Testowanie

Testy znajdują się wraz z definicjami narzędzi:

```typescript
defineTool({
  name: "create_task",
  // ...
  tests: [
    { name: "creates a task", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } }, // tworzy zadanie
    { name: "fails without subject", input: { title: "Read ch5" }, expect: { success: false } }, // nie powodzi się bez tematu
  ],
});
```

Rejestr waliduje parametry przed uruchomieniem handlerów, więc błędy schematu są wyświetlane wystarczająco jasno, aby zarówno ludzie, jak i LLM mogli je naprawić.

## Przykłady

| Domena | Narzędzia | Wzorzec |
|--------|-------|---------|
| Śledzenie nauki | `create_task`, `list_tasks`, `complete_task` | CRUD + Magazyn |
| Menedżer zakładek | `save_link`, `search_links`, `tag_link` | Tablice + Wyszukiwanie |
| Przechowywanie przepisów | `save_recipe`, `search_recipes`, `get_random` | Zagnieżdżone dane + Losowe |
| Dzielenie wydatków | `add_expense`, `split_bill`, `get_balances` | Matematyka + Obliczenia |
| Rejestrator treningów | `log_workout`, `get_stats`, `suggest_workout` | Filtrowanie dat + Statystyki |
| Słownik | `define_word`, `find_synonyms` | Zewnętrzne API (bez klucza) |
| Generator quizów | `create_quiz`, `answer_question`, `get_score` | Gra stanowa |
| Narzędzia AI | `summarize_text`, `generate_flashcards` | Narzędzie wywołuje LLM |
| Narzędzia użytkowe | `calculate`, `convert_units`, `format_date` | Bezstanowe pomocniki |

## Dokumentacja

- [Architektura](docs/ARCHITECTURE.md): model środowiska uruchomieniowego, filtrowane rejestry, syntetyczne narzędzia i ścieżki wykonania
- [RAG](docs/RAG.md): semantyczne dzielenie na fragmenty, embeddingi Gemini/OpenAI, schemat pgvector, wyszukiwanie HNSW i integracja narzędzi

## Wtyczki

### ExecuFunction dla OpenClaw

Wtyczka [`@openfunctions/openclaw-execufunction`](plugins/openclaw-execufunction/) podłącza [ExecuFunction](https://execufunction.com) do ekosystemu agentów [OpenClaw](https://github.com/openclaw/openclaw) — 17 narzędzi w 6 domenach:

| Domena | Narzędzia | Co robi |
|--------|-------|--------------|
| Zadania | `exf_tasks_list`, `exf_tasks_create`, `exf_tasks_update`, `exf_tasks_complete` | Strukturalne zarządzanie zadaniami z priorytetami (do_now/do_next/do_later/delegate/drop) |
| Kalendarz | `exf_calendar_list`, `exf_calendar_create`, `exf_calendar_update` | Planowanie i wyszukiwanie wydarzeń |
| Wiedza | `exf_notes_search`, `exf_notes_create`, `exf_notes_get` | Semantyczne wyszukiwanie w bazie wiedzy |
| Projekty | `exf_projects_list`, `exf_projects_context` | Status projektu i pełny kontekst (zadania, notatki, sygnały) |
| Ludzie/CRM | `exf_people_search`, `exf_person_create`, `exf_org_search` | Zarządzanie kontaktami i organizacjami |
| Baza kodu | `exf_codebase_search`, `exf_code_who_knows` | Semantyczne wyszukiwanie kodu i śledzenie ekspertyzy |

Instalacja:

```bash
openclaw plugins install @openfunctions/openclaw-execufunction
```

Ustaw `EXF_PAT` w swoim środowisku (lub skonfiguruj przez ustawienia wtyczki OpenClaw), a Twój agent OpenClaw otrzyma trwałe zadania, świadomość kalendarza, semantyczne wyszukiwanie wiedzy, CRM i analitykę kodu — wspierane przez API chmurowe ExecuFunction.

Szczegóły w [README wtyczki](plugins/openclaw-execufunction/).

## Struktura projektu

```text
openFunctions/
├── src/
│   ├── framework/              # Podstawowe środowisko uruchomieniowe + warstwy kompozycji
│   │   ├── chat-agent.ts       # createChatAgent() — fabryka komponowalnych agentów czatu
│   │   ├── chat-agent-types.ts # Typy ChatAgent, ChatAgentConfig, ChatResult
│   │   ├── chat-agent-resolve.ts # Rozwiązywanie konfiguracji, autodetekcja dostawcy
│   │   ├── chat-agent-http.ts  # Serwer HTTP dla agent.serve()
│   │   ├── context.ts          # Interfejs dostawcy kontekstu
│   │   └── ...                 # tool, registry, agents, memory, rag, workflows
│   ├── providers/
│   │   └── execufunction/      # Dostawca kontekstu ExecuFunction (implementacja referencyjna)
│   ├── examples/               # Wzorce narzędzi referencyjnych
│   ├── my-tools/               # Twoje narzędzia
│   └── index.ts                # Punkt wejścia MCP
├── plugins/
│   └── openclaw-execufunction/ # Wtyczka ExecuFunction dla OpenClaw
├── docs/                       # Dokumentacja architektury
├── scripts/                    # chat, create-tool, docs
├── test-client/                # Tester CLI + uruchamiacz testów
├── system-prompts/             # Presety promptów
└── package.json
```

## Licencja

MIT — zobacz [LICENSE](LICENSE)
