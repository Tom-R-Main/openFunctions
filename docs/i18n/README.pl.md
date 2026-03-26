[English](../README.md) | [Polish](README.pl.md)

<p align="center">
  <img src="../../assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Najpierw buduj narzędzia AI. Komponuj agentów, gdy ich potrzebujesz.</strong>
</p>

<p align="center">
  <a href="#quick-start">Szybki Start</a> &middot;
  <a href="#the-mental-model">Model Mentalny</a> &middot;
  <a href="#choose-the-right-primitive">Wybierz Prymityw</a> &middot;
  <a href="#capability-ladder">Drabina Możliwości</a> &middot;
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

## Szybki Start

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

Pierwszą rzeczą do zbudowania jest narzędzie, a nie agent.

## Model Mentalny

Narzędzie to Twoja logika biznesowa plus schemat, który AI może odczytać:

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

Ta jedna definicja może być:

- wykonywana bezpośrednio przez `registry.execute()`
- udostępniana Claude/Desktop poprzez MCP
- używana w interaktywnej pętli czatu
- komponowana w przepływy pracy
- filtrowana do rejestrów specyficznych dla agentów

Czytaj więcej: [Architektura](docs/ARCHITECTURE.md)

## Wybierz Odpowiedni Prymityw

| Użyj tego | Gdy chcesz | Czym to naprawdę jest |
|----------|---------------|-------------------|
| `defineTool()` | wywoływalna logika biznesowa dla AI | podstawowy prymityw |
| `pipe()` | deterministyczna orkiestracja | potok narzędzi/LLM sterowany kodem |
| `defineAgent()` | adaptacyjne wieloetapowe użycie narzędzi | pętla LLM działająca na filtrowanym rejestrze |
| `createConversationMemory()` / `createFactMemory()` | stan wątku/faktu | trwałość plus narzędzia pamięci |
| `createRAG()` | semantyczne wyszukiwanie dokumentów | pgvector + embeddings + tools |
| `createStore()` / `createPgStore()` | trwałość | warstwa przechowywania, nie wyszukiwania |

Ogólna zasada:

- Zacznij od narzędzia.
- Użyj przepływu pracy, gdy znasz sekwencję.
- Użyj agenta tylko wtedy, gdy model musi wybrać, co zrobić dalej.
- Dodaj pamięć dla stanu, który kontrolujesz.
- Dodaj RAG do wyszukiwania dokumentów według znaczenia.

## Drabina Możliwości

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

Przepływy pracy są domyślnym „zaawansowanym” prymitywem, ponieważ przepływ sterowania pozostaje jawny:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}"));

await research.run({ word: "ephemeral" });
```

### 4. Dodaj adaptacyjne zachowanie za pomocą agentów

Agenci używają tych samych narzędzi, ale poprzez filtrowany rejestr i pętlę rozumowania:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst",
  goal: "Find accurate information using available tools",
  toolTags: ["search"],
});
```

Użyj zespołów (crews), gdy wielu wyspecjalizowanych agentów musi współpracować.

### 5. Dodaj stan tylko wtedy, gdy jest to potrzebne

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

## Polecenia

```bash
npm run test-tools          # Interaktywny CLI — testuj narzędzia lokalnie
npm run dev                 # Tryb deweloperski — automatyczne ponowne uruchamianie po zapisie
npm test                    # Uruchom zdefiniowane przez narzędzia testy automatyczne
npm run chat                # Czatuj z AI używając swoich narzędzi
npm run chat -- gemini      # Wymuś konkretnego dostawcę
npm run create-tool <name>  # Utwórz szkielet nowego narzędzia
npm run docs                # Generuj dokumentację referencyjną narzędzi
npm run inspect             # Interfejs webowy inspektora MCP
npm start                   # Uruchom serwer MCP dla Claude Desktop / Cursor
```

## Dostawcy

Ustaw jeden klucz API w `.env`, a pętla czatu automatycznie wykryje dostawcę.

| Dostawca | Domyślny Model | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | Wywoływanie funkcji |
| OpenAI | `gpt-5.4` | API odpowiedzi |
| Anthropic | `claude-sonnet-4-6` | Wiadomości + użycie narzędzi |
| xAI | `grok-4.20-0309-reasoning` | API odpowiedzi |
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
    { name: "creates a task", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } },
    { name: "fails without subject", input: { title: "Read ch5" }, expect: { success: false } },
  ],
});
```

Rejestr waliduje parametry przed uruchomieniem handlerów, więc błędy schematu są wyświetlane wystarczająco jasno, aby zarówno ludzie, jak i LLM mogli je naprawić.

## Przykłady

| Domena | Narzędzia | Wzorzec |
|--------|-------|---------|
| Śledzenie Nauki | `create_task`, `list_tasks`, `complete_task` | CRUD + Store |
| Menedżer Zakładek | `save_link`, `search_links`, `tag_link` | Arrays + Search |
| Przechowywanie Przepisów | `save_recipe`, `search_recipes`, `get_random` | Nested Data + Random |
| Dzielenie Wydatków | `add_expense`, `split_bill`, `get_balances` | Math + Calculations |
| Rejestrator Treningów | `log_workout`, `get_stats`, `suggest_workout` | Date Filtering + Stats |
| Słownik | `define_word`, `find_synonyms` | Zewnętrzne API (bez klucza) |
| Generator Quizów | `create_quiz`, `answer_question`, `get_score` | Gra Stanowa |
| Narzędzia AI | `summarize_text`, `generate_flashcards` | Narzędzie Wywołuje LLM |
| Narzędzia Użytkowe | `calculate`, `convert_units`, `format_date` | Bezstanowe Pomocniki |

## Dokumentacja

- [Architektura](docs/ARCHITECTURE.md): model środowiska uruchomieniowego, filtrowane rejestry, syntetyczne narzędzia i ścieżki wykonania
- [RAG](docs/RAG.md): semantyczne dzielenie na fragmenty, embeddingi Gemini/OpenAI, schemat pgvector, wyszukiwanie HNSW i integracja narzędzi

## Struktura Projektu

```text
openFunctions/
├── src/
│   ├── framework/              # Podstawowe środowisko uruchomieniowe + warstwy kompozycji
│   ├── examples/               # Wzorce narzędzi referencyjnych
│   ├── my-tools/               # Twoje narzędzia
│   └── index.ts                # Punkt wejścia MCP
├── docs/                       # Dokumentacja architektury
├── scripts/                    # czat, create-tool, docs
├── test-client/                # Tester CLI + uruchamiacz testów
├── system-prompts/             # Presety promptów
└── package.json
```

## Licencja

MIT — zobacz [LICENSE](LICENSE)
