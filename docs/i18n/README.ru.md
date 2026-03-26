[English](../README.md) | [Russian](README.ru.md)

<p align="center">
  <img src="assets/logo.svg" alt="openFunctions" width="600">
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

Первое, что нужно создать, это инструмент, а не агент.

## Ментальная модель

Инструмент — это ваша бизнес-логика плюс схема, которую может прочитать ИИ:

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

Это одно определение может быть:

- выполнено напрямую с помощью `registry.execute()`
- предоставлено Claude/Desktop через MCP
- использовано внутри интерактивного чат-цикла
- скомпоновано в рабочие процессы
- отфильтровано в реестры, специфичные для агентов

Подробнее: [Архитектура](docs/ARCHITECTURE.md)

## Выберите правильный примитив

| Используйте это | Когда вы хотите | Что это на самом деле |
|----------|---------------|-------------------|
| `defineTool()` | вызываемая бизнес-логика, ориентированная на ИИ | основной примитив |
| `pipe()` | детерминированная оркестровка | конвейер инструментов/LLM, управляемый кодом |
| `defineAgent()` | адаптивное многошаговое использование инструментов | цикл LLM над отфильтрованным реестром |
| `createConversationMemory()` / `createFactMemory()` | состояние потока/факта | персистентность плюс инструменты памяти |
| `createRAG()` | семантический поиск документов | `pgvector + embeddings + tools` |
| `createStore()` / `createPgStore()` | персистентность | уровень хранения, а не извлечения |

Эмпирическое правило:

- Начните с инструмента.
- Используйте рабочий процесс, когда вы знаете последовательность.
- Используйте агента только тогда, когда модели нужно выбрать, что делать дальше.
- Добавьте память для состояния, которое вы контролируете.
- Добавьте RAG для извлечения документов по смыслу.

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

### 4. Добавьте адаптивное поведение с агентами

Агенты используют те же инструменты, но через отфильтрованный реестр и цикл рассуждений:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst",
  goal: "Find accurate information using available tools",
  toolTags: ["search"],
});
```

Используйте команды, когда нескольким специализированным агентам необходимо сотрудничать.

### 5. Добавляйте состояние только при необходимости

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

## Команды

```bash
npm run test-tools          # Интерактивный CLI — тестирование инструментов локально
npm run dev                 # Режим разработки — автоматический перезапуск при сохранении
npm test                    # Запуск автоматических тестов, определенных инструментом
npm run chat                # Общение с ИИ с использованием ваших инструментов
npm run chat -- gemini      # Принудительное использование конкретного провайдера
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
    { name: "creates a task", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } },
    { name: "fails without subject", input: { title: "Read ch5" }, expect: { success: false } },
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

## Структура проекта

```text
openFunctions/
├── src/
│   ├── framework/              # Основная среда выполнения + уровни композиции
│   ├── examples/               # Эталонные шаблоны инструментов
│   ├── my-tools/               # Ваши инструменты
│   └── index.ts                # Точка входа MCP
├── docs/                       # Документация по архитектуре
├── scripts/                    # чат, создание инструмента, документация
├── test-client/                # CLI-тестер + запускатель тестов
├── system-prompts/             # Пресеты промптов
└── package.json
```

## Лицензия

MIT — см. [LICENSE](LICENSE)
