[English](../README.md) | [Ukrainian](README.uk.md)

<p align="center">
  <img src="assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Створюйте інструменти ШІ спочатку. Компонуйте агентів, коли вони вам потрібні.</strong>
</p>

<p align="center">
  <a href="#quick-start">Швидкий старт</a> &middot;
  <a href="#the-mental-model">Ментальна модель</a> &middot;
  <a href="#choose-the-right-primitive">Виберіть примітив</a> &middot;
  <a href="#capability-ladder">Сходи можливостей</a> &middot;
  <a href="#providers">Провайдери</a> &middot;
  <a href="#examples">Приклади</a> &middot;
  <a href="#docs">Документація</a>
</p>

---

openFunctions — це TypeScript-фреймворк з ліцензією MIT для створення інструментів, що викликаються ШІ, та їхнього представлення через [MCP](https://modelcontextprotocol.io), чат-адаптери, робочі процеси та агентів. Його основне середовище виконання просте:

`ToolDefinition -> ToolRegistry -> AIAdapter`

Все інше компонується поверх цього:

- `workflows` — це детермінована оркестрація навколо інструментів
- `agents` — це цикли LLM над відфільтрованим реєстром
- `structured output` — це шаблон синтетичного інструменту
- `memory` та `rag` — це системи зі станом, які можна знову обгорнути в інструменти

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

Перше, що потрібно створити, це інструмент, а не агент.

## Ментальна модель

Інструмент — це ваша бізнес-логіка плюс схема, яку може прочитати ШІ:

```typescript
import { defineTool, ok } from "../framework/index.js";

export const rollDice = defineTool({
  name: "roll_dice",
  description: "Roll a dice with the given number of sides", // Кинути кубик із заданою кількістю сторін
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "number", description: "Number of sides (default 6)" }, // Кількість сторін (за замовчуванням 6)
    },
  },
  handler: async ({ sides }) => {
    const rolled = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled });
  },
});
```

Це одне визначення може бути:

- виконано безпосередньо за допомогою `registry.execute()`
- представлено Claude/Desktop через MCP
- використано всередині інтерактивного циклу чату
- скомпоновано в робочі процеси
- відфільтровано в реєстри, специфічні для агентів

Детальніше: [Архітектура](docs/ARCHITECTURE.md)

## Виберіть правильний примітив

| Використовуйте це | Коли ви хочете | Що це насправді |
|-------------------|---------------------------------------|-------------------------------------------|
| `defineTool()`    | викликана бізнес-логіка, орієнтована на ШІ | основний примітив                         |
| `pipe()`          | детермінована оркестрація             | керований кодом конвеєр інструментів/LLM  |
| `defineAgent()`   | адаптивне багатоетапне використання інструментів | цикл LLM над відфільтрованим реєстром     |
| `createConversationMemory()` / `createFactMemory()` | стан потоку/факту                     | стійкість плюс інструменти пам'яті       |
| `createRAG()`     | семантичне вилучення документів       | pgvector + вбудовування + інструменти     |
| `createStore()` / `createPgStore()` | стійкість                             | шар зберігання, а не вилучення            |

Загальне правило:

- Почніть з інструменту.
- Використовуйте робочий процес, коли знаєте послідовність.
- Використовуйте агента лише тоді, коли модель повинна вибрати, що робити далі.
- Додайте пам'ять для стану, який ви контролюєте.
- Додайте RAG для вилучення документів за значенням.

## Сходи можливостей

### 1. Створіть інструмент

```bash
npm run create-tool expense_tracker
```

Відредагуйте `src/my-tools/expense_tracker.ts`, потім запустіть:

```bash
npm run test-tools
npm test
```

### 2. Представте його через MCP або чат

```bash
npm start
npm run chat -- gemini
```

Один і той же реєстр забезпечує роботу обох.

### 3. Компонуйте його за допомогою робочих процесів

Робочі процеси є примітивом за замовчуванням для «просунутих» завдань, оскільки потік керування залишається явним:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}")); // Поясніть це просто: {{input}}

await research.run({ word: "ephemeral" });
```

### 4. Додайте адаптивну поведінку за допомогою агентів

Агенти використовують ті ж інструменти, але через відфільтрований реєстр та цикл міркувань:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst", // Аналітик-дослідник
  goal: "Find accurate information using available tools", // Знайти точну інформацію за допомогою доступних інструментів
  toolTags: ["search"],
});
```

Використовуйте команди (crews), коли кільком спеціалізованим агентам потрібно співпрацювати.

### 5. Додавайте стан лише за потреби

Стійкість:

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

## Команди

```bash
npm run test-tools          # Інтерактивний CLI — тестування інструментів локально
npm run dev                 # Режим розробки — автоматичний перезапуск при збереженні
npm test                    # Запуск автоматизованих тестів, визначених інструментом
npm run chat                # Чат зі ШІ за допомогою ваших інструментів
npm run chat -- gemini      # Примусове використання певного провайдера
npm run create-tool <name>  # Створення нового інструменту
npm run docs                # Генерація довідкової документації інструментів
npm run inspect             # Веб-інтерфейс MCP Inspector
npm start                   # Запуск сервера MCP для Claude Desktop / Cursor
```

## Провайдери

Встановіть один ключ API у `.env`, і цикл чату автоматично визначить провайдера.

| Провайдер | Модель за замовчуванням | API |
|-----------|-------------------------|---------------------------|
| Gemini    | `gemini-3-flash-preview`| Виклик функцій            |
| OpenAI    | `gpt-5.4`               | API відповідей            |
| Anthropic | `claude-sonnet-4-6`     | Повідомлення + використання інструментів |
| xAI       | `grok-4.20-0309-reasoning`| API відповідей            |
| OpenRouter| `google/gemini-3-flash-preview`| Сумісний з OpenAI         |

Приклади:

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## Тестування

Тести знаходяться разом з визначеннями інструментів:

```typescript
defineTool({
  name: "create_task",
  // ...
  tests: [
    { name: "creates a task", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } }, // створює завдання
    { name: "fails without subject", input: { title: "Read ch5" }, expect: { success: false } }, // не вдається без теми
  ],
});
```

Реєстр перевіряє параметри перед виконанням обробників, тому помилки схеми відображаються достатньо чітко, щоб як люди, так і LLM могли їх виправити.

## Приклади

| Домен           | Інструменти                                | Шаблон                        |
|-----------------|--------------------------------------------|-------------------------------|
| Трекер навчання | `create_task`, `list_tasks`, `complete_task` | CRUD + Сховище                |
| Менеджер закладок | `save_link`, `search_links`, `tag_link`    | Масиви + Пошук                |
| Зберігач рецептів | `save_recipe`, `search_recipes`, `get_random`| Вкладені дані + Випадкові     |
| Розділювач витрат | `add_expense`, `split_bill`, `get_balances`| Математика + Обчислення       |
| Журнал тренувань | `log_workout`, `get_stats`, `suggest_workout`| Фільтрація за датою + Статистика |
| Словник         | `define_word`, `find_synonyms`             | Зовнішній API (без ключа)     |
| Генератор тестів | `create_quiz`, `answer_question`, `get_score`| Гра зі станом                 |
| Інструменти ШІ  | `summarize_text`, `generate_flashcards`    | Інструмент викликає LLM       |
| Утиліти         | `calculate`, `convert_units`, `format_date`| Допоміжні функції без стану   |

## Документація

- [Архітектура](docs/ARCHITECTURE.md): модель виконання, відфільтровані реєстри, синтетичні інструменти та шляхи виконання
- [RAG](docs/RAG.md): семантичне розбиття на фрагменти, вбудовування Gemini/OpenAI, схема pgvector, пошук HNSW та інтеграція інструментів

## Структура проєкту

```text
openFunctions/
├── src/
│   ├── framework/              # Основне середовище виконання + шари композиції
│   ├── examples/               # Зразки шаблонів інструментів
│   ├── my-tools/               # Ваші інструменти
│   └── index.ts                # Точка входу MCP
├── docs/                       # Документація архітектури
├── scripts/                    # chat, create-tool, docs
├── test-client/                # CLI тестер + засіб запуску тестів
├── system-prompts/             # Заздалегідь встановлені промпти
└── package.json
```

## Ліцензія

MIT — дивіться [LICENSE](LICENSE)
