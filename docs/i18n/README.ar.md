[English](../README.md) | [Arabic](README.ar.md)

<p align="center">
  <img src="assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>ابنِ أدوات الذكاء الاصطناعي أولاً. قم بتكوين الوكلاء عند الحاجة.</strong>
</p>

<p align="center">
  <a href="#quick-start">بدء سريع</a> &middot;
  <a href="#the-mental-model">النموذج الذهني</a> &middot;
  <a href="#choose-the-right-primitive">اختر البدائية الصحيحة</a> &middot;
  <a href="#capability-ladder">سلم القدرات</a> &middot;
  <a href="#providers">الموفرون</a> &middot;
  <a href="#examples">الأمثلة</a> &middot;
  <a href="#docs">الوثائق</a>
</p>

---

openFunctions هو إطار عمل TypeScript مرخص بموجب ترخيص MIT لبناء أدوات قابلة للاستدعاء بواسطة الذكاء الاصطناعي وعرضها من خلال [MCP](https://modelcontextprotocol.io)، ومحولات الدردشة، وسير العمل، والوكلاء. بيئة التشغيل الأساسية بسيطة:

`ToolDefinition -> ToolRegistry -> AIAdapter`

كل شيء آخر يتكون فوق ذلك:

- `workflows` هي تنسيق حتمي حول الأدوات
- `agents` هي حلقات LLM فوق سجل مصفى
- `structured output` هو نمط أداة اصطناعية
- `memory` و `rag` هي أنظمة ذات حالة يمكن إعادة تغليفها في أدوات

إذا فهمت بيئة تشغيل الأداة، فإن بقية إطار العمل يظل واضحًا.

```text
defineTool() -> registry.register() -> adapter/server executes tool
                                    -> workflows compose tools
                                    -> agents use filtered tools
                                    -> memory/rag expose more tools
```

## بدء سريع

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

أول شيء يجب بناؤه هو أداة، وليس وكيلًا.

## النموذج الذهني

الأداة هي منطق عملك بالإضافة إلى مخطط يمكن للذكاء الاصطناعي قراءته:

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

يمكن أن يكون هذا التعريف الواحد:

- يتم تنفيذه مباشرة بواسطة `registry.execute()`
- يتم عرضه على Claude/Desktop عبر MCP
- يستخدم داخل حلقة الدردشة التفاعلية
- يتم تكوينه في سير العمل
- يتم تصفيته في سجلات خاصة بالوكلاء

اقرأ المزيد: [Architecture](docs/ARCHITECTURE.md)

## اختر البدائية الصحيحة

| استخدم هذا | عندما تريد | ما هو حقًا |
|----------|---------------|-------------------|
| `defineTool()` | منطق عمل قابل للاستدعاء يواجه الذكاء الاصطناعي | البدائية الأساسية |
| `pipe()` | تنسيق حتمي | مسار أداة/LLM مدفوع بالتعليمات البرمجية |
| `defineAgent()` | استخدام أداة متعدد الخطوات التكيفي | حلقة LLM فوق سجل مصفى |
| `createConversationMemory()` / `createFactMemory()` | حالة الخيط/الحقيقة | استمرارية بالإضافة إلى أدوات الذاكرة |
| `createRAG()` | استرجاع المستندات الدلالي | pgvector + embeddings + أدوات |
| `createStore()` / `createPgStore()` | استمرارية | طبقة تخزين، وليست استرجاع |

قاعدة عامة:

- ابدأ بأداة.
- استخدم سير العمل عندما تعرف التسلسل.
- استخدم وكيلًا فقط عندما يحتاج النموذج إلى اختيار ما يجب فعله بعد ذلك.
- أضف ذاكرة للحالة التي تتحكم فيها.
- أضف RAG لاسترجاع المستندات حسب المعنى.

## سلم القدرات

### 1. بناء أداة

```bash
npm run create-tool expense_tracker
```

عدّل `src/my-tools/expense_tracker.ts`، ثم شغّل:

```bash
npm run test-tools
npm test
```

### 2. عرضها من خلال MCP أو الدردشة

```bash
npm start
npm run chat -- gemini
```

نفس السجل يشغل كليهما.

### 3. تكوينها بسير العمل

سير العمل هي البدائية "المتقدمة" الافتراضية لأن تدفق التحكم يظل صريحًا:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}"));

await research.run({ word: "ephemeral" });
```

### 4. إضافة سلوك تكيفي مع الوكلاء

يستخدم الوكلاء نفس الأدوات، ولكن من خلال سجل مصفى وحلقة استدلال:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst",
  goal: "Find accurate information using available tools",
  toolTags: ["search"],
});
```

استخدم الفرق عندما يحتاج العديد من الوكلاء المتخصصين إلى التعاون.

### 5. إضافة الحالة فقط عند الحاجة

الاستمرارية:

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

الذاكرة:

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

وثائق RAG: [docs/RAG.md](docs/RAG.md)

## الأوامر

```bash
npm run test-tools          # واجهة سطر أوامر تفاعلية — لاختبار الأدوات محليًا
npm run dev                 # وضع التطوير — يعاد التشغيل تلقائيًا عند الحفظ
npm test                    # تشغيل الاختبارات الآلية المعرفة بالأداة
npm run chat                # الدردشة مع الذكاء الاصطناعي باستخدام أدواتك
npm run chat -- gemini      # فرض موفر معين
npm run create-tool <name>  # إنشاء هيكل أداة جديدة
npm run docs                # إنشاء وثائق مرجعية للأداة
npm run inspect             # واجهة مستخدم ويب MCP Inspector
npm start                   # بدء خادم MCP لـ Claude Desktop / Cursor
```

## الموفرون

عيّن مفتاح API واحدًا في `.env` وستقوم حلقة الدردشة باكتشاف الموفر تلقائيًا.

| الموفر | النموذج الافتراضي | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | Function calling |
| OpenAI | `gpt-5.4` | Responses API |
| Anthropic | `claude-sonnet-4-6` | Messages + tool_use |
| xAI | `grok-4.20-0309-reasoning` | Responses API |
| OpenRouter | `google/gemini-3-flash-preview` | OpenAI-compatible |

أمثلة:

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## الاختبار

توجد الاختبارات مع تعريفات الأدوات:

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

يقوم السجل بالتحقق من صحة المعلمات قبل تشغيل المعالجات، لذلك تظهر أخطاء المخطط بوضوح كافٍ لكل من البشر ونماذج اللغات الكبيرة (LLMs) للتعافي.

## الأمثلة

| المجال | الأدوات | النمط |
|--------|-------|---------|
| Study Tracker | `create_task`, `list_tasks`, `complete_task` | CRUD + Store |
| Bookmark Manager | `save_link`, `search_links`, `tag_link` | Arrays + Search |
| Recipe Keeper | `save_recipe`, `search_recipes`, `get_random` | Nested Data + Random |
| Expense Splitter | `add_expense`, `split_bill`, `get_balances` | Math + Calculations |
| Workout Logger | `log_workout`, `get_stats`, `suggest_workout` | Date Filtering + Stats |
| Dictionary | `define_word`, `find_synonyms` | External API (no key) |
| Quiz Generator | `create_quiz`, `answer_question`, `get_score` | Stateful Game |
| AI Tools | `summarize_text`, `generate_flashcards` | Tool Calls an LLM |
| Utilities | `calculate`, `convert_units`, `format_date` | Stateless Helpers |

## الوثائق

- [Architecture](docs/ARCHITECTURE.md): نموذج وقت التشغيل، السجلات المصفاة، الأدوات الاصطناعية، ومسارات التنفيذ
- [RAG](docs/RAG.md): التقطيع الدلالي، تضمينات Gemini/OpenAI، مخطط pgvector، بحث HNSW، وتكامل الأدوات

## هيكل المشروع

```text
openFunctions/
├── src/
│   ├── framework/              # بيئة التشغيل الأساسية + طبقات التكوين
│   ├── examples/               # أنماط الأدوات المرجعية
│   ├── my-tools/               # أدواتك
│   └── index.ts                # نقطة دخول MCP
├── docs/                       # وثائق البنية
├── scripts/                    # chat, create-tool, docs
├── test-client/                # أداة اختبار CLI + مشغل الاختبارات
├── system-prompts/             # إعدادات مسبقة للمطالبات
└── package.json
```

## الترخيص

MIT — انظر [LICENSE](LICENSE)
