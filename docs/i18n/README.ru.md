[English](../../README.md) | [Русский](README.ru.md)

<p align="center">
  <img src="../../assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Сначала создавайте инструменты ИИ. Составляйте агентов, когда они вам понадобятся.</strong>
</p>

<p align="center">
  <a href="#quick-start">Быстрый старт</a> &middot;
  <a href="#the-mental-model">Ментальная модель</a> &middot;
  <a href="#choose-the-right-primitive">Выберите примитив</a> &middot;
  <a href="#capability-ladder">Лестница возможностей</a> &middot;
  <a href="#providers">Провайдеры</a> &middot;
  <a href="#examples">Примеры</a> &middot;
  <a href="#docs">Документация</a>
</p>

---

openFunctions — это TypeScript-фреймворк с лицензией MIT для создания инструментов, вызываемых ИИ, и их предоставления через [MCP](https://modelcontextprotocol.io), чат-адаптеры, рабочие процессы и агентов. Его основная среда выполнения проста:

`ToolDefinition -> ToolRegistry -> AIAdapter`

Все остальное строится поверх этого:

- `workflows` — это детерминированная оркестровка вокруг инструментов
- `agents` — это циклы LLM над отфильтрованным реестром
- `structured output` — это шаблон синтетического инструмента
- `memory` и `rag` — это системы с состоянием, которые могут быть снова обернуты в инструменты

Если вы понимаете среду выполнения инструментов, остальная часть фреймворка остается понятной.

```text
defineTool() -> registry.register() -> adapter/server executes tool
                                    -> workflows compose tools
                                    -> agents use filtered tools
                                    -> memory/rag expose more tools
```

## Быстрый старт

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

Первое, что нужно создать — это инструмент, а не агент.

## Ментальная модель

Инструмент — это ваша бизнес-логика плюс схема, которую может прочитать ИИ:

```typescript
import { defineTool, ok } from "../framework/index.js";

export const rollDice = defineTool({
  name: "roll_dice",
  description: "Roll a dice with the given number of sides", // Бросить кубик с заданным количеством граней
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "number", description: "Number of sides (default 6)" }, // Количество граней (по умолчанию 6)
    },
  },
  handler: async ({ sides }) => {
    const rolled = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled });
  },
});
```

Это одно определение может быть:

- выполнено напрямую через `registry.execute()`
- предоставлено Claude/Desktop через MCP
- использовано внутри интерактивного чат-цикла
- скомпоновано в рабочие процессы
- отфильтровано в реестры, специфичные для агентов

Подробнее: [Архитектура](docs/ARCHITECTURE.md)

## Выберите правильный примитив

| Используйте это | Когда вы хотите | Что это на самом деле |
|----------|---------------|-------------------|
| `defineTool()` | вызываемая бизнес-логика, ориентированная на ИИ | основной примитив |
| `createChatAgent()` | компонуемый, встраиваемый ИИ-агент | инструменты + память + контекст + адаптер в одной конфигурации |
| `pipe()` | детерминированная оркестровка | конвейер инструментов/LLM, управляемый кодом |
| `defineAgent()` | адаптивное многошаговое использование инструментов | цикл LLM над отфильтрованным реестром |
| `createConversationMemory()` / `createFactMemory()` | состояние потока/факта | персистентность плюс инструменты памяти |
| `createRAG()` | семантический поиск документов | pgvector + embeddings + инструменты |
| `connectProvider()` | контекст из внешней системы | структурированные инструменты из ExecuFunction, Obsidian и т.д. |
| `createStore()` / `createPgStore()` | персистентность | уровень хранения, а не извлечения |

Эмпирическое правило:

- Начните с инструмента.
- Используйте `createChatAgent()`, когда вам нужен полноценный агент с памятью и контекстом.
- Используйте рабочий процесс, когда вы знаете последовательность.
- Используйте `defineAgent()`, когда вам нужны специализированные агенты в командах.
- Добавьте память для состояния, которое вы контролируете.
- Добавьте RAG для извлечения документов по смыслу.
- Добавьте провайдер контекста, когда вам нужны внешние системы (задачи, календари, CRM).

## Лестница возможностей

### 1. Создайте инструмент

```bash
npm run create-tool expense_tracker
```

Отредактируйте `src/my-tools/expense_tracker.ts`, затем запустите:

```bash
npm run test-tools
npm test
```

### 2. Предоставьте его через MCP или чат

```bash
npm start
npm run chat -- gemini
```

Один и тот же реестр обеспечивает работу обоих.

### 3. Компонуйте его с рабочими процессами

Рабочие процессы являются примитивом «продвинутого» уровня по умолчанию, потому что поток управления остается явным:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}"));

await research.run({ word: "ephemeral" });
```

### 4. Создайте чат-агента

`createChatAgent()` компонует инструменты, память, провайдеры контекста и адаптер ИИ в единого встраиваемого агента:

```typescript
import { createChatAgent } from "./framework/index.js";

const agent = await createChatAgent({
  provider: "gemini",
  preset: "study-buddy",
  memory: true,                    // память разговоров + фактов (включена по умолчанию)
  providers: ["execufunction"],    // подключить внешний контекст
});

// Четыре способа использования:
await agent.interactive();                          // CLI
const result = await agent.chat("Create a task");   // программный вызов
for await (const chunk of agent.chat("hello", { stream: true })) { ... }  // потоковая передача
await agent.serve({ port: 3000 });                  // HTTP-сервер
```

Одна и та же конфигурация работает из кода, флагов CLI или YAML-файлов. Память включена по умолчанию — агент запоминает между сессиями.

### 5. Добавьте адаптивное поведение с агентами

`defineAgent()` предназначен для специализированных агентов в командах и рабочих процессах — отфильтрованные реестры и циклы рассуждений:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst", // Аналитик-исследователь
  goal: "Find accurate information using available tools", // Находить точную информацию с помощью доступных инструментов
  toolTags: ["search"],
});
```

Используйте команды, когда нескольким специализированным агентам необходимо сотрудничать.

### 6. Добавляйте состояние только при необходимости

Персистентность:

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

Память:

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

Документация по RAG: [docs/RAG.md](docs/RAG.md)

### 7. Подключите внешний контекст

Провайдеры контекста подключают внешние системы (менеджеры задач, календари, CRM, базы знаний) к среде выполнения агентов как инструменты:

```typescript
import { connectProvider, contextPrompt } from "./framework/index.js";
import { createExecuFunctionProvider } from "./providers/execufunction/index.js";

// Подключение — регистрирует 17 инструментов с тегами "context" + "context:execufunction"
const exf = await connectProvider(
  createExecuFunctionProvider({ token: process.env.EXF_PAT }),
  registry,
);

// Внедряет активные задачи + предстоящие события в системные промпты агента
const context = await contextPrompt([exf]);
```

Интерфейс `ContextProvider` является подключаемым — реализуйте `metadata`, `connect()` и `createTools()` для интеграции любого бэкенда во фреймворк. Подробнее в [Архитектура](docs/ARCHITECTURE.md#context-providers).

| Провайдер | Статус | Возможности |
|----------|--------|--------------|
| [ExecuFunction](src/providers/execufunction/) | Встроен | задачи, проекты, календарь, знания, люди, организации, кодовая база |
| Obsidian | Шаблон (планируется) | знания |
| Notion | Шаблон (планируется) | знания, задачи, проекты |

## Команды

```bash
npm run test-tools          # Интерактивный CLI — тестирование инструментов локально
npm run dev                 # Режим разработки — автоматический перезапуск при сохранении
npm test                    # Запуск автоматических тестов, определенных инструментом
npm run chat                # Общение с ИИ с использованием ваших инструментов
npm run chat -- gemini      # Принудительное использование конкретного провайдера
npm run chat -- --no-memory # Чат без постоянной памяти
npm run create-tool <name>  # Создание нового инструмента
npm run docs                # Генерация справочной документации по инструментам
npm run inspect             # Веб-интерфейс инспектора MCP
npm start                   # Запуск сервера MCP для Claude Desktop / Cursor
```

## Провайдеры

Установите один ключ API в `.env`, и чат-цикл автоматически определит провайдера.

| Провайдер | Модель по умолчанию | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | Function calling |
| OpenAI | `gpt-5.4` | Responses API |
| Anthropic | `claude-sonnet-4-6` | Messages + tool_use |
| xAI | `grok-4.20-0309-reasoning` | Responses API |
| OpenRouter | `google/gemini-3-flash-preview` | OpenAI-compatible |

Примеры:

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## Тестирование

Тесты находятся вместе с определениями инструментов:

```typescript
defineTool({
  name: "create_task",
  // ...
  tests: [
    { name: "creates a task", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } }, // создает задачу
    { name: "fails without subject", input: { title: "Read ch5" }, expect: { success: false } }, // не проходит без темы
  ],
});
```

Реестр проверяет параметры до выполнения обработчиков, поэтому ошибки схемы отображаются достаточно четко, чтобы как люди, так и LLM могли их исправить.

## Примеры

| Область | Инструменты | Шаблон |
|--------|-------|---------|
| Трекер обучения | `create_task`, `list_tasks`, `complete_task` | CRUD + Хранилище |
| Менеджер закладок | `save_link`, `search_links`, `tag_link` | Массивы + Поиск |
| Хранитель рецептов | `save_recipe`, `search_recipes`, `get_random` | Вложенные данные + Случайный выбор |
| Разделитель расходов | `add_expense`, `split_bill`, `get_balances` | Математика + Вычисления |
| Журнал тренировок | `log_workout`, `get_stats`, `suggest_workout` | Фильтрация по дате + Статистика |
| Словарь | `define_word`, `find_synonyms` | Внешний API (без ключа) |
| Генератор викторин | `create_quiz`, `answer_question`, `get_score` | Игра с состоянием |
| Инструменты ИИ | `summarize_text`, `generate_flashcards` | Инструмент вызывает LLM |
| Утилиты | `calculate`, `convert_units`, `format_date` | Вспомогательные функции без состояния |

## Документация

- [Архитектура](docs/ARCHITECTURE.md): модель среды выполнения, отфильтрованные реестры, синтетические инструменты и пути выполнения
- [RAG](docs/RAG.md): семантическое разбиение на чанки, встраивания Gemini/OpenAI, схема pgvector, поиск HNSW и интеграция инструментов

## Плагины

### ExecuFunction для OpenClaw

Плагин [`@openfunctions/openclaw-execufunction`](plugins/openclaw-execufunction/) подключает [ExecuFunction](https://execufunction.com) к экосистеме агентов [OpenClaw](https://github.com/openclaw/openclaw) — 17 инструментов в 6 областях:

| Область | Инструменты | Что он делает |
|--------|-------|--------------|
| Задачи | `exf_tasks_list`, `exf_tasks_create`, `exf_tasks_update`, `exf_tasks_complete` | Структурированное управление задачами с приоритетами (do_now/do_next/do_later/delegate/drop) |
| Календарь | `exf_calendar_list`, `exf_calendar_create`, `exf_calendar_update` | Планирование и поиск событий |
| Знания | `exf_notes_search`, `exf_notes_create`, `exf_notes_get` | Семантический поиск по базе знаний |
| Проекты | `exf_projects_list`, `exf_projects_context` | Статус проекта и полный контекст (задачи, заметки, сигналы) |
| Люди/CRM | `exf_people_search`, `exf_person_create`, `exf_org_search` | Управление контактами и организациями |
| Кодовая база | `exf_codebase_search`, `exf_code_who_knows` | Семантический поиск по коду и отслеживание экспертизы |

Установка:

```bash
openclaw plugins install @openfunctions/openclaw-execufunction
```

Установите `EXF_PAT` в окружении (или настройте через параметры плагина OpenClaw), и ваш агент OpenClaw получит постоянные задачи, осведомленность о календаре, семантический поиск по знаниям, CRM и аналитику кода — все на основе облачного API ExecuFunction.

Подробнее в [README плагина](plugins/openclaw-execufunction/).

## Структура проекта

```text
openFunctions/
├── src/
│   ├── framework/              # Основная среда выполнения + уровни композиции
│   │   ├── chat-agent.ts       # createChatAgent() — фабрика компонуемых чат-агентов
│   │   ├── chat-agent-types.ts # Типы ChatAgent, ChatAgentConfig, ChatResult
│   │   ├── chat-agent-resolve.ts # Разрешение конфигурации, автоопределение провайдера
│   │   ├── chat-agent-http.ts  # HTTP-сервер для agent.serve()
│   │   ├── context.ts          # Интерфейс провайдера контекста
│   │   └── ...                 # tool, registry, agents, memory, rag, workflows
│   ├── providers/
│   │   └── execufunction/      # Провайдер контекста ExecuFunction (эталонная реализация)
│   ├── examples/               # Эталонные шаблоны инструментов
│   ├── my-tools/               # Ваши инструменты
│   └── index.ts                # Точка входа MCP
├── plugins/
│   └── openclaw-execufunction/ # Плагин ExecuFunction для OpenClaw
├── docs/                       # Документация по архитектуре
├── scripts/                    # chat, create-tool, docs
├── test-client/                # CLI-тестер + запускатель тестов
├── system-prompts/             # Пресеты промптов
└── package.json
```

## Лицензия

MIT — см. [LICENSE](LICENSE)
