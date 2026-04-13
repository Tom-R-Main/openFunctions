[English](../../README.md) | [العربية](README.ar.md)

<p align="center">
  <img src="../../assets/logo.svg" alt="openFunctions" width="600">
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
  description: "Roll a dice with the given number of sides", // ارمِ نردًا بعدد الأوجه المحدد
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "number", description: "Number of sides (default 6)" }, // عدد الأوجه (الافتراضي 6)
    },
  },
  handler: async ({ sides }) => {
    const rolled = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled });
  },
});
```

يمكن أن يكون هذا التعريف الواحد:

- يُنفَّذ مباشرة بواسطة `registry.execute()`
- يُعرَض على Claude/Desktop عبر MCP
- يُستخدَم داخل حلقة الدردشة التفاعلية
- يُدمَج في سير العمل
- يُصفَّى في سجلات خاصة بالوكلاء

اقرأ المزيد: [البنية المعمارية](docs/ARCHITECTURE.md)

## اختر البدائية الصحيحة

| استخدم هذا | عندما تريد | ما هو حقًا |
|----------|---------------|-------------------|
| `defineTool()` | منطق عمل قابل للاستدعاء يواجه الذكاء الاصطناعي | البدائية الأساسية |
| `createChatAgent()` | وكيل ذكاء اصطناعي قابل للتركيب والتضمين | أدوات + ذاكرة + سياق + محول في إعداد واحد |
| `pipe()` | تنسيق حتمي | مسار أداة/LLM مدفوع بالتعليمات البرمجية |
| `defineAgent()` | استخدام أداة متعدد الخطوات التكيفي | حلقة LLM فوق سجل مصفى |
| `createConversationMemory()` / `createFactMemory()` | حالة الخيط/الحقيقة | استمرارية بالإضافة إلى أدوات الذاكرة |
| `createRAG()` | استرجاع المستندات الدلالي | pgvector + embeddings + أدوات |
| `connectProvider()` | سياق من نظام خارجي | أدوات منظمة من ExecuFunction وObsidian وغيرها |
| `createStore()` / `createPgStore()` | استمرارية | طبقة تخزين، وليست استرجاع |

قاعدة عامة:

- ابدأ بأداة.
- استخدم `createChatAgent()` عندما تريد وكيلًا كاملًا بالذاكرة والسياق.
- استخدم سير العمل عندما تعرف التسلسل.
- استخدم `defineAgent()` عندما تحتاج وكلاء متخصصين داخل فرق.
- أضف ذاكرة للحالة التي تتحكم فيها.
- أضف RAG لاسترجاع المستندات حسب المعنى.
- أضف موفر سياق عندما تحتاج أنظمة خارجية (مهام، تقاويم، CRM).

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

### 4. بناء وكيل دردشة

`createChatAgent()` يجمع الأدوات والذاكرة وموفري السياق ومحول الذكاء الاصطناعي في وكيل واحد قابل للتضمين:

```typescript
import { createChatAgent } from "./framework/index.js";

const agent = await createChatAgent({
  provider: "gemini",
  preset: "study-buddy",
  memory: true,                    // ذاكرة المحادثات + الحقائق (مفعّلة افتراضيًا)
  providers: ["execufunction"],    // ربط سياق خارجي
});

// أربع طرق للاستخدام:
await agent.interactive();                          // CLI — واجهة سطر الأوامر
const result = await agent.chat("Create a task");   // استدعاء برمجي
for await (const chunk of agent.chat("hello", { stream: true })) { ... }  // بث مباشر
await agent.serve({ port: 3000 });                  // خادم HTTP
```

نفس الإعداد يعمل من الكود أو أعلام CLI أو ملفات YAML. الذاكرة مفعّلة افتراضيًا — الوكيل يتذكر عبر الجلسات.

### 5. إضافة سلوك تكيفي مع الوكلاء

`defineAgent()` مخصص للوكلاء المتخصصين داخل الفرق وسير العمل — سجلات مصفاة وحلقات استدلال:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst", // محلل أبحاث
  goal: "Find accurate information using available tools", // إيجاد معلومات دقيقة باستخدام الأدوات المتاحة
  toolTags: ["search"],
});
```

استخدم الفرق عندما يحتاج العديد من الوكلاء المتخصصين إلى التعاون.

### 6. إضافة الحالة فقط عند الحاجة

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

### 7. ربط السياق الخارجي

موفرو السياق يربطون الأنظمة الخارجية (مدراء المهام، التقاويم، CRM، قواعد المعرفة) ببيئة تشغيل الوكلاء كأدوات:

```typescript
import { connectProvider, contextPrompt } from "./framework/index.js";
import { createExecuFunctionProvider } from "./providers/execufunction/index.js";

// الربط — يسجل 17 أداة موسومة بـ "context" + "context:execufunction"
const exf = await connectProvider(
  createExecuFunctionProvider({ token: process.env.EXF_PAT }),
  registry,
);

// حقن المهام النشطة + الأحداث القادمة في إرشادات نظام الوكيل
const context = await contextPrompt([exf]);
```

واجهة `ContextProvider` قابلة للتوصيل — نفّذ `metadata` و`connect()` و`createTools()` لدمج أي خلفية في إطار العمل. انظر [البنية المعمارية](docs/ARCHITECTURE.md#context-providers) للواجهة الكاملة.

| الموفر | الحالة | القدرات |
|----------|--------|--------------|
| [ExecuFunction](src/providers/execufunction/) | مدمج | المهام، المشاريع، التقويم، المعرفة، الأشخاص، المنظمات، قاعدة الكود |
| Obsidian | قالب (مخطط) | المعرفة |
| Notion | قالب (مخطط) | المعرفة، المهام، المشاريع |

## الأوامر

```bash
npm run test-tools          # واجهة سطر أوامر تفاعلية — لاختبار الأدوات محليًا
npm run dev                 # وضع التطوير — يعاد التشغيل تلقائيًا عند الحفظ
npm test                    # تشغيل الاختبارات الآلية المعرفة بالأداة
npm run chat                # الدردشة مع الذكاء الاصطناعي باستخدام أدواتك
npm run chat -- gemini      # فرض موفر معين
npm run chat -- --no-memory # دردشة بدون ذاكرة دائمة
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
    { name: "creates a task", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } }, // ينشئ مهمة
    { name: "fails without subject", input: { title: "Read ch5" }, expect: { success: false } }, // يفشل بدون موضوع
  ],
});
```

يقوم السجل بالتحقق من صحة المعلمات قبل تشغيل المعالجات، لذلك تظهر أخطاء المخطط بوضوح كافٍ لكل من البشر ونماذج اللغات الكبيرة (LLMs) للتعافي.

## الأمثلة

| المجال | الأدوات | النمط |
|--------|-------|---------|
| متتبع الدراسة | `create_task`, `list_tasks`, `complete_task` | CRUD + تخزين |
| مدير الإشارات المرجعية | `save_link`, `search_links`, `tag_link` | مصفوفات + بحث |
| حافظ الوصفات | `save_recipe`, `search_recipes`, `get_random` | بيانات متداخلة + عشوائي |
| مقسم النفقات | `add_expense`, `split_bill`, `get_balances` | رياضيات + حسابات |
| مسجل التمارين | `log_workout`, `get_stats`, `suggest_workout` | تصفية التاريخ + إحصائيات |
| القاموس | `define_word`, `find_synonyms` | API خارجي (بدون مفتاح) |
| مولد الاختبارات | `create_quiz`, `answer_question`, `get_score` | لعبة ذات حالة |
| أدوات الذكاء الاصطناعي | `summarize_text`, `generate_flashcards` | أداة تستدعي LLM |
| الأدوات المساعدة | `calculate`, `convert_units`, `format_date` | مساعدون عديمو الحالة |

## الوثائق

- [البنية المعمارية](docs/ARCHITECTURE.md): نموذج وقت التشغيل، السجلات المصفاة، الأدوات الاصطناعية، ومسارات التنفيذ
- [RAG](docs/RAG.md): التقطيع الدلالي، تضمينات Gemini/OpenAI، مخطط pgvector، بحث HNSW، وتكامل الأدوات

## الإضافات

### ExecuFunction لـ OpenClaw

إضافة [`@openfunctions/openclaw-execufunction`](plugins/openclaw-execufunction/) تجلب [ExecuFunction](https://execufunction.com) إلى نظام وكلاء [OpenClaw](https://github.com/openclaw/openclaw) — 17 أداة في 6 مجالات:

| المجال | الأدوات | ماذا تفعل |
|--------|-------|--------------|
| المهام | `exf_tasks_list`, `exf_tasks_create`, `exf_tasks_update`, `exf_tasks_complete` | إدارة مهام منظمة بأولويات (do_now/do_next/do_later/delegate/drop) |
| التقويم | `exf_calendar_list`, `exf_calendar_create`, `exf_calendar_update` | جدولة الأحداث والبحث فيها |
| المعرفة | `exf_notes_search`, `exf_notes_create`, `exf_notes_get` | بحث دلالي عبر قاعدة المعرفة |
| المشاريع | `exf_projects_list`, `exf_projects_context` | حالة المشروع والسياق الكامل (المهام، الملاحظات، الإشارات) |
| الأشخاص/CRM | `exf_people_search`, `exf_person_create`, `exf_org_search` | إدارة جهات الاتصال والمنظمات |
| قاعدة الكود | `exf_codebase_search`, `exf_code_who_knows` | بحث دلالي في الكود وتتبع الخبرة |

التثبيت:

```bash
openclaw plugins install @openfunctions/openclaw-execufunction
```

عيّن `EXF_PAT` في بيئتك (أو قم بالإعداد عبر إعدادات إضافة OpenClaw)، وسيحصل وكيل OpenClaw الخاص بك على مهام دائمة، والوعي بالتقويم، والبحث الدلالي في المعرفة، وCRM، وذكاء الكود — مدعومًا بواجهة برمجة التطبيقات السحابية لـ ExecuFunction.

انظر [README الإضافة](plugins/openclaw-execufunction/) للتفاصيل.

## هيكل المشروع

```text
openFunctions/
├── src/
│   ├── framework/              # بيئة التشغيل الأساسية + طبقات التكوين
│   │   ├── chat-agent.ts       # createChatAgent() — مصنع وكيل دردشة قابل للتركيب
│   │   ├── chat-agent-types.ts # أنواع ChatAgent, ChatAgentConfig, ChatResult
│   │   ├── chat-agent-resolve.ts # حل الإعدادات، الكشف التلقائي عن الموفر
│   │   ├── chat-agent-http.ts  # خادم HTTP لـ agent.serve()
│   │   ├── context.ts          # واجهة موفر السياق
│   │   └── ...                 # tool, registry, agents, memory, rag, workflows
│   ├── providers/
│   │   └── execufunction/      # موفر سياق ExecuFunction (تنفيذ مرجعي)
│   ├── examples/               # أنماط الأدوات المرجعية
│   ├── my-tools/               # أدواتك
│   └── index.ts                # نقطة دخول MCP
├── plugins/
│   └── openclaw-execufunction/ # إضافة ExecuFunction لـ OpenClaw
├── docs/                       # وثائق البنية
├── scripts/                    # chat, create-tool, docs
├── test-client/                # أداة اختبار CLI + مشغل الاختبارات
├── system-prompts/             # إعدادات مسبقة للمطالبات
└── package.json
```

## الترخيص

MIT — انظر [LICENSE](LICENSE)
