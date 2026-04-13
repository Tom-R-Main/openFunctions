[English](../../README.md) | [Українська](README.uk.md)

<p align="center">
  <img src="../../assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Спочатку створюйте інструменти ШІ. Складайте агентів, коли вони вам знадобляться.</strong>
</p>

<p align="center">
  <a href="#quick-start">Швидкий старт</a> &middot;
  <a href="#the-mental-model">Ментальна модель</a> &middot;
  <a href="#choose-the-right-primitive">Оберіть примітив</a> &middot;
  <a href="#capability-ladder">Драбина можливостей</a> &middot;
  <a href="#providers">Провайдери</a> &middot;
  <a href="#examples">Приклади</a> &middot;
  <a href="#docs">Документація</a>
</p>

---

openFunctions — це TypeScript-фреймворк з ліцензією MIT для створення інструментів, що викликаються ШІ, та їх надання через [MCP](https://modelcontextprotocol.io), чат-адаптери, робочі процеси та агентів. Його основне середовище виконання просте:

`ToolDefinition -> ToolRegistry -> AIAdapter`

Все інше будується поверх цього:

- `workflows` — це детермінована оркестрація навколо інструментів
- `agents` — це цикли LLM над відфільтрованим реєстром
- `structured output` — це шаблон синтетичного інструменту
- `memory` та `rag` — це системи зі станом, які можуть бути знову обгорнуті в інструменти

Якщо ви розумієте середовище виконання інструментів, решта фреймворку залишається зрозумілою.

```text
defineTool() -> registry.register() -> adapter/server executes tool
                                    -> workflows compose tools
                                    -> agents use filtered tools
                                    -> memory/rag expose more tools
```

## Швидкий старт

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

Перше, що потрібно створити — це інструмент, а не агент.

## Ментальна модель

Інструмент — це ваша бізнес-логіка плюс схема, яку може прочитати ШІ:

```typescript
import { defineTool, ok } from "../framework/index.js";

export const rollDice = defineTool({
  name: "roll_dice",
  description: "Roll a dice with the given number of sides", // Кинути кубик із заданою кількістю граней
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "number", description: "Number of sides (default 6)" }, // Кількість граней (за замовчуванням 6)
    },
  },
  handler: async ({ sides }) => {
    const rolled = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled });
  },
});
```

Це одне визначення може бути:

- виконане безпосередньо через `registry.execute()`
- надане Claude/Desktop через MCP
- використане всередині інтерактивного чат-циклу
- скомпоноване в робочі процеси
- відфільтроване в реєстри, специфічні для агентів

Детальніше: [Архітектура](docs/ARCHITECTURE.md)

## Оберіть правильний примітив

| Використовуйте це | Коли ви хочете | Що це насправді |
|----------|---------------|-------------------|
| `defineTool()` | бізнес-логіка, що викликається ШІ | основний примітив |
| `createChatAgent()` | компонований, вбудований ШІ-агент | інструменти + пам'ять + контекст + адаптер в одній конфігурації |
| `pipe()` | детермінована оркестрація | конвеєр інструментів/LLM, керований кодом |
| `defineAgent()` | адаптивне багатокрокове використання інструментів | цикл LLM над відфільтрованим реєстром |
| `createConversationMemory()` / `createFactMemory()` | стан потоку/факту | персистентність плюс інструменти пам'яті |
| `createRAG()` | семантичний пошук документів | pgvector + embeddings + інструменти |
| `connectProvider()` | контекст із зовнішньої системи | структуровані інструменти з ExecuFunction, Obsidian тощо |
| `createStore()` / `createPgStore()` | персистентність | рівень зберігання, а не вилучення |

Емпіричне правило:

- Почніть з інструменту.
- Використовуйте `createChatAgent()`, коли вам потрібен повноцінний агент із пам'яттю та контекстом.
- Використовуйте робочий процес, коли ви знаєте послідовність.
- Використовуйте `defineAgent()`, коли вам потрібні спеціалізовані агенти в командах.
- Додайте пам'ять для стану, який ви контролюєте.
- Додайте RAG для вилучення документів за змістом.
- Додайте провайдер контексту, коли вам потрібні зовнішні системи (завдання, календарі, CRM).

## Драбина можливостей

### 1. Створіть інструмент

```bash
npm run create-tool expense_tracker
```

Відредагуйте `src/my-tools/expense_tracker.ts`, потім запустіть:

```bash
npm run test-tools
npm test
```

### 2. Надайте його через MCP або чат

```bash
npm start
npm run chat -- gemini
```

Один і той самий реєстр забезпечує роботу обох.

### 3. Компонуйте його з робочими процесами

Робочі процеси є примітивом «просунутого» рівня за замовчуванням, бо потік керування залишається явним:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}"));

await research.run({ word: "ephemeral" });
```

### 4. Створіть чат-агента

`createChatAgent()` компонує інструменти, пам'ять, провайдери контексту та адаптер ШІ в єдиного вбудованого агента:

```typescript
import { createChatAgent } from "./framework/index.js";

const agent = await createChatAgent({
  provider: "gemini",
  preset: "study-buddy",
  memory: true,                    // пам'ять розмов + фактів (увімкнена за замовчуванням)
  providers: ["execufunction"],    // підключити зовнішній контекст
});

// Чотири способи використання:
await agent.interactive();                          // CLI
const result = await agent.chat("Create a task");   // програмний виклик
for await (const chunk of agent.chat("hello", { stream: true })) { ... }  // потокова передача
await agent.serve({ port: 3000 });                  // HTTP-сервер
```

Одна й та сама конфігурація працює з коду, прапорців CLI або YAML-файлів. Пам'ять увімкнена за замовчуванням — агент запам'ятовує між сесіями.

### 5. Додайте адаптивну поведінку з агентами

`defineAgent()` призначений для спеціалізованих агентів у командах та робочих процесах — відфільтровані реєстри та цикли міркувань:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst", // Аналітик-дослідник
  goal: "Find accurate information using available tools", // Знаходити точну інформацію за допомогою доступних інструментів
  toolTags: ["search"],
});
```

Використовуйте команди, коли кільком спеціалізованим агентам потрібно співпрацювати.

### 6. Додавайте стан лише за потреби

Персистентність:

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

Пам'ять:

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

Документація RAG: [docs/RAG.md](docs/RAG.md)

### 7. Підключіть зовнішній контекст

Провайдери контексту підключають зовнішні системи (менеджери завдань, календарі, CRM, бази знань) до середовища виконання агентів як інструменти:

```typescript
import { connectProvider, contextPrompt } from "./framework/index.js";
import { createExecuFunctionProvider } from "./providers/execufunction/index.js";

// Підключення — реєструє 17 інструментів з тегами "context" + "context:execufunction"
const exf = await connectProvider(
  createExecuFunctionProvider({ token: process.env.EXF_PAT }),
  registry,
);

// Впроваджує активні завдання + майбутні події в системні промпти агента
const context = await contextPrompt([exf]);
```

Інтерфейс `ContextProvider` є підключаємим — реалізуйте `metadata`, `connect()` та `createTools()` для інтеграції будь-якого бекенда у фреймворк. Детальніше в [Архітектура](docs/ARCHITECTURE.md#context-providers).

| Провайдер | Статус | Можливості |
|----------|--------|--------------|
| [ExecuFunction](src/providers/execufunction/) | Вбудований | завдання, проєкти, календар, знання, люди, організації, кодова база |
| Obsidian | Шаблон (заплановано) | знання |
| Notion | Шаблон (заплановано) | знання, завдання, проєкти |

## Команди

```bash
npm run test-tools          # Інтерактивний CLI — тестування інструментів локально
npm run dev                 # Режим розробки — автоматичний перезапуск при збереженні
npm test                    # Запуск автоматичних тестів, визначених інструментом
npm run chat                # Спілкування з ШІ за допомогою ваших інструментів
npm run chat -- gemini      # Примусове використання конкретного провайдера
npm run chat -- --no-memory # Чат без постійної пам'яті
npm run create-tool <name>  # Створення нового інструменту
npm run docs                # Генерація довідкової документації інструментів
npm run inspect             # Веб-інтерфейс інспектора MCP
npm start                   # Запуск сервера MCP для Claude Desktop / Cursor
```

## Провайдери

Встановіть один ключ API в `.env`, і чат-цикл автоматично визначить провайдера.

| Провайдер | Модель за замовчуванням | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | Function calling |
| OpenAI | `gpt-5.4` | Responses API |
| Anthropic | `claude-sonnet-4-6` | Messages + tool_use |
| xAI | `grok-4.20-0309-reasoning` | Responses API |
| OpenRouter | `google/gemini-3-flash-preview` | OpenAI-compatible |

Приклади:

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## Тестування

Тести знаходяться разом із визначеннями інструментів:

```typescript
defineTool({
  name: "create_task",
  // ...
  tests: [
    { name: "creates a task", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } }, // створює завдання
    { name: "fails without subject", input: { title: "Read ch5" }, expect: { success: false } }, // не проходить без теми
  ],
});
```

Реєстр перевіряє параметри до виконання обробників, тому помилки схеми відображаються достатньо чітко, щоб як люди, так і LLM могли їх виправити.

## Приклади

| Область | Інструменти | Шаблон |
|--------|-------|---------|
| Трекер навчання | `create_task`, `list_tasks`, `complete_task` | CRUD + Сховище |
| Менеджер закладок | `save_link`, `search_links`, `tag_link` | Масиви + Пошук |
| Зберігач рецептів | `save_recipe`, `search_recipes`, `get_random` | Вкладені дані + Випадковий вибір |
| Розділювач витрат | `add_expense`, `split_bill`, `get_balances` | Математика + Обчислення |
| Журнал тренувань | `log_workout`, `get_stats`, `suggest_workout` | Фільтрація за датою + Статистика |
| Словник | `define_word`, `find_synonyms` | Зовнішній API (без ключа) |
| Генератор вікторин | `create_quiz`, `answer_question`, `get_score` | Гра зі станом |
| Інструменти ШІ | `summarize_text`, `generate_flashcards` | Інструмент викликає LLM |
| Утиліти | `calculate`, `convert_units`, `format_date` | Допоміжні функції без стану |

## Документація

- [Архітектура](docs/ARCHITECTURE.md): модель середовища виконання, відфільтровані реєстри, синтетичні інструменти та шляхи виконання
- [RAG](docs/RAG.md): семантичне розбиття на частини, вбудовування Gemini/OpenAI, схема pgvector, пошук HNSW та інтеграція інструментів

## Плагіни

### ExecuFunction для OpenClaw

Плагін [`@openfunctions/openclaw-execufunction`](plugins/openclaw-execufunction/) підключає [ExecuFunction](https://execufunction.com) до екосистеми агентів [OpenClaw](https://github.com/openclaw/openclaw) — 17 інструментів у 6 областях:

| Область | Інструменти | Що він робить |
|--------|-------|--------------|
| Завдання | `exf_tasks_list`, `exf_tasks_create`, `exf_tasks_update`, `exf_tasks_complete` | Структуроване управління завданнями з пріоритетами (do_now/do_next/do_later/delegate/drop) |
| Календар | `exf_calendar_list`, `exf_calendar_create`, `exf_calendar_update` | Планування та пошук подій |
| Знання | `exf_notes_search`, `exf_notes_create`, `exf_notes_get` | Семантичний пошук по базі знань |
| Проєкти | `exf_projects_list`, `exf_projects_context` | Статус проєкту та повний контекст (завдання, нотатки, сигнали) |
| Люди/CRM | `exf_people_search`, `exf_person_create`, `exf_org_search` | Управління контактами та організаціями |
| Кодова база | `exf_codebase_search`, `exf_code_who_knows` | Семантичний пошук по коду та відстеження експертизи |

Встановлення:

```bash
openclaw plugins install @openfunctions/openclaw-execufunction
```

Встановіть `EXF_PAT` в оточенні (або налаштуйте через параметри плагіна OpenClaw), і ваш агент OpenClaw отримає постійні завдання, обізнаність про календар, семантичний пошук по знаннях, CRM та аналітику коду — все на основі хмарного API ExecuFunction.

Детальніше в [README плагіна](plugins/openclaw-execufunction/).

## Структура проєкту

```text
openFunctions/
├── src/
│   ├── framework/              # Основне середовище виконання + рівні композиції
│   │   ├── chat-agent.ts       # createChatAgent() — фабрика компонованих чат-агентів
│   │   ├── chat-agent-types.ts # Типи ChatAgent, ChatAgentConfig, ChatResult
│   │   ├── chat-agent-resolve.ts # Розв'язання конфігурації, автовизначення провайдера
│   │   ├── chat-agent-http.ts  # HTTP-сервер для agent.serve()
│   │   ├── context.ts          # Інтерфейс провайдера контексту
│   │   └── ...                 # tool, registry, agents, memory, rag, workflows
│   ├── providers/
│   │   └── execufunction/      # Провайдер контексту ExecuFunction (еталонна реалізація)
│   ├── examples/               # Еталонні шаблони інструментів
│   ├── my-tools/               # Ваші інструменти
│   └── index.ts                # Точка входу MCP
├── plugins/
│   └── openclaw-execufunction/ # Плагін ExecuFunction для OpenClaw
├── docs/                       # Документація з архітектури
├── scripts/                    # chat, create-tool, docs
├── test-client/                # CLI-тестер + запускач тестів
├── system-prompts/             # Пресети промптів
└── package.json
```

## Ліцензія

MIT — див. [LICENSE](LICENSE)
