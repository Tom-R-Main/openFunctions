[English](../README.md) | [Bengali](README.bn.md)

<p align="center">
  <img src="../../assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>প্রথমে AI টুল তৈরি করুন। যখন প্রয়োজন হবে তখন এজেন্টদের একত্রিত করুন।</strong>
</p>

<p align="center">
  <a href="#quick-start">দ্রুত শুরু</a> &middot;
  <a href="#the-mental-model">মানসিক মডেল</a> &middot;
  <a href="#choose-the-right-primitive">একটি আদিম উপাদান বেছে নিন</a> &middot;
  <a href="#capability-ladder">ক্ষমতার সিঁড়ি</a> &middot;
  <a href="#providers">প্রোভাইডারগণ</a> &middot;
  <a href="#examples">উদাহরণ</a> &middot;
  <a href="#docs">ডকুমেন্টেশন</a>
</p>

---

openFunctions হল একটি MIT-লাইসেন্সপ্রাপ্ত TypeScript ফ্রেমওয়ার্ক যা AI-কলযোগ্য টুল তৈরি করতে এবং সেগুলিকে [MCP](https://modelcontextprotocol.io), চ্যাট অ্যাডাপ্টার, ওয়ার্কফ্লো এবং এজেন্টদের মাধ্যমে প্রকাশ করতে ব্যবহৃত হয়। এর মূল রানটাইম সহজ:

`ToolDefinition -> ToolRegistry -> AIAdapter`

অন্য সবকিছু এর উপরে গঠিত হয়:

- `workflows` হল টুলগুলির চারপাশে সুনির্দিষ্ট অর্কেস্ট্রেশন
- `agents` হল একটি ফিল্টার করা রেজিস্ট্রি জুড়ে LLM লুপ
- `structured output` হল একটি সিন্থেটিক টুল প্যাটার্ন
- `memory` এবং `rag` হল স্টেটফুল সিস্টেম যা টুলগুলিতে আবার মোড়ানো যেতে পারে

আপনি যদি টুল রানটাইম বোঝেন, তাহলে ফ্রেমওয়ার্কের বাকি অংশটি সহজে বোধগম্য থাকবে।

```text
defineTool() -> registry.register() -> adapter/server executes tool
                                    -> workflows compose tools
                                    -> agents use filtered tools
                                    -> memory/rag expose more tools
```

## দ্রুত শুরু

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

প্রথমে একটি টুল তৈরি করতে হবে, এজেন্ট নয়।

## মানসিক মডেল

একটি টুল হল আপনার ব্যবসায়িক যুক্তি এবং একটি স্কিমা যা AI পড়তে পারে:

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

সেই একটি সংজ্ঞা হতে পারে:

- `registry.execute()` দ্বারা সরাসরি কার্যকর করা
- MCP এর মাধ্যমে Claude/Desktop-এ প্রকাশ করা
- ইন্টারেক্টিভ চ্যাট লুপের ভিতরে ব্যবহার করা
- ওয়ার্কফ্লোতে একত্রিত করা
- এজেন্ট-নির্দিষ্ট রেজিস্ট্রিগুলিতে ফিল্টার করা

আরও পড়ুন: [আর্কিটেকচার](docs/ARCHITECTURE.md)

## সঠিক আদিম উপাদান বেছে নিন

| এটি ব্যবহার করুন | যখন আপনি চান | এটি আসলে কী |
|----------|---------------|-------------------|
| `defineTool()` | কলযোগ্য AI-মুখী ব্যবসায়িক যুক্তি | মূল আদিম উপাদান |
| `pipe()` | সুনির্দিষ্ট অর্কেস্ট্রেশন | কোড-চালিত টুল/LLM পাইপলাইন |
| `defineAgent()` | অভিযোজিত বহু-ধাপের টুল ব্যবহার | একটি ফিল্টার করা রেজিস্ট্রি জুড়ে একটি LLM লুপ |
| `createConversationMemory()` / `createFactMemory()` | থ্রেড/ফ্যাক্ট স্টেট | পার্সিসটেন্স এবং মেমরি টুল |
| `createRAG()` | সিমান্টিক ডকুমেন্ট পুনরুদ্ধার | pgvector + embeddings + টুল |
| `createStore()` / `createPgStore()` | পার্সিসটেন্স | স্টোরেজ লেয়ার, পুনরুদ্ধার নয় |

সাধারণ নিয়ম:

- একটি টুল দিয়ে শুরু করুন।
- যখন আপনি ক্রম জানেন তখন একটি ওয়ার্কফ্লো ব্যবহার করুন।
- শুধুমাত্র তখনই একটি এজেন্ট ব্যবহার করুন যখন মডেলকে পরবর্তী কী করতে হবে তা বেছে নিতে হবে।
- আপনার নিয়ন্ত্রিত অবস্থার জন্য মেমরি যোগ করুন।
- অর্থ দ্বারা ডকুমেন্ট পুনরুদ্ধারের জন্য RAG যোগ করুন।

## ক্ষমতার সিঁড়ি

### 1. একটি টুল তৈরি করুন

```bash
npm run create-tool expense_tracker
```

`src/my-tools/expense_tracker.ts` সম্পাদনা করুন, তারপর চালান:

```bash
npm run test-tools
npm test
```

### 2. MCP বা চ্যাটের মাধ্যমে এটি প্রকাশ করুন

```bash
npm start
npm run chat -- gemini
```

একই রেজিস্ট্রি উভয়কে শক্তি যোগায়।

### 3. ওয়ার্কফ্লো দিয়ে এটি একত্রিত করুন

ওয়ার্কফ্লো হল ডিফল্ট “উন্নত” আদিম উপাদান কারণ নিয়ন্ত্রণ প্রবাহ সুস্পষ্ট থাকে:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}"));

await research.run({ word: "ephemeral" });
```

### 4. এজেন্টদের সাথে অভিযোজিত আচরণ যোগ করুন

এজেন্টরা একই টুল ব্যবহার করে, তবে একটি ফিল্টার করা রেজিস্ট্রি এবং একটি যুক্তি লুপের মাধ্যমে:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst",
  goal: "Find accurate information using available tools",
  toolTags: ["search"],
});
```

যখন একাধিক বিশেষায়িত এজেন্টের সহযোগিতা প্রয়োজন হয় তখন ক্রু ব্যবহার করুন।

### 5. শুধুমাত্র প্রয়োজনে স্টেট যোগ করুন

পার্সিসটেন্স:

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

মেমরি:

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

RAG ডকুমেন্টেশন: [docs/RAG.md](docs/RAG.md)

## কমান্ডসমূহ

```bash
npm run test-tools          # ইন্টারেক্টিভ CLI — স্থানীয়ভাবে টুল পরীক্ষা করুন
npm run dev                 # ডেভ মোড — সেভ করার পর স্বয়ংক্রিয়ভাবে রিস্টার্ট হয়
npm test                    # টুল-সংজ্ঞায়িত স্বয়ংক্রিয় পরীক্ষা চালান
npm run chat                # আপনার টুল ব্যবহার করে AI এর সাথে চ্যাট করুন
npm run chat -- gemini      # একটি নির্দিষ্ট প্রোভাইডারকে জোর করুন
npm run create-tool <name>  # একটি নতুন টুল তৈরি করুন
npm run docs                # টুল রেফারেন্স ডকুমেন্টেশন তৈরি করুন
npm run inspect             # MCP ইন্সপেক্টর ওয়েব UI
npm start                   # Claude Desktop / Cursor এর জন্য MCP সার্ভার শুরু করুন
```

## প্রোভাইডারগণ

`.env`-এ একটি API কী সেট করুন এবং চ্যাট লুপ স্বয়ংক্রিয়ভাবে প্রোভাইডার সনাক্ত করবে।

| প্রোভাইডার | ডিফল্ট মডেল | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | Function calling |
| OpenAI | `gpt-5.4` | Responses API |
| Anthropic | `claude-sonnet-4-6` | Messages + tool_use |
| xAI | `grok-4.20-0309-reasoning` | Responses API |
| OpenRouter | `google/gemini-3-flash-preview` | OpenAI-সামঞ্জস্যপূর্ণ |

উদাহরণ:

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## টেস্টিং

পরীক্ষাগুলি টুল সংজ্ঞাগুলির সাথে থাকে:

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

হ্যান্ডলারগুলি চালানোর আগে রেজিস্ট্রি প্যারামিটারগুলি যাচাই করে, তাই স্কিমা ত্রুটিগুলি মানুষ এবং LLM উভয়কেই পুনরুদ্ধার করার জন্য যথেষ্ট স্পষ্টভাবে প্রদর্শিত হয়।

## উদাহরণ

| ডোমেইন | টুলস | প্যাটার্ন |
|--------|-------|---------|
| স্টাডি ট্র্যাকার | `create_task`, `list_tasks`, `complete_task` | CRUD + স্টোর |
| বুকমার্ক ম্যানেজার | `save_link`, `search_links`, `tag_link` | অ্যারে + সার্চ |
| রেসিপি কিপার | `save_recipe`, `search_recipes`, `get_random` | নেস্টেড ডেটা + র‍্যান্ডম |
| খরচ বিভাজক | `add_expense`, `split_bill`, `get_balances` | গণিত + গণনা |
| ওয়ার্কআউট লগার | `log_workout`, `get_stats`, `suggest_workout` | তারিখ ফিল্টারিং + পরিসংখ্যান |
| অভিধান | `define_word`, `find_synonyms` | বাহ্যিক API (কোন কী নেই) |
| কুইজ জেনারেটর | `create_quiz`, `answer_question`, `get_score` | স্টেটফুল গেম |
| AI টুলস | `summarize_text`, `generate_flashcards` | টুল একটি LLM কল করে |
| ইউটিলিটিস | `calculate`, `convert_units`, `format_date` | স্টেটলেস হেল্পার |

## ডকুমেন্টেশন

- [আর্কিটেকচার](docs/ARCHITECTURE.md): রানটাইম মডেল, ফিল্টার করা রেজিস্ট্রি, সিন্থেটিক টুল এবং এক্সিকিউশন পাথ
- [RAG](docs/RAG.md): সিমান্টিক চাঙ্কিং, Gemini/OpenAI এম্বেডিং, pgvector স্কিমা, HNSW সার্চ এবং টুল ইন্টিগ্রেশন

## প্রকল্পের কাঠামো

```text
openFunctions/
├── src/
│   ├── framework/              # মূল রানটাইম + কম্পোজিশন লেয়ার
│   ├── examples/               # রেফারেন্স টুল প্যাটার্ন
│   ├── my-tools/               # আপনার টুলস
│   └── index.ts                # MCP এন্ট্রি পয়েন্ট
├── docs/                       # আর্কিটেকচার ডকুমেন্টেশন
├── scripts/                    # চ্যাট, টুল তৈরি, ডকুমেন্টেশন
├── test-client/                # CLI টেস্টার + টেস্ট রানার
├── system-prompts/             # প্রম্পট প্রিসেট
└── package.json
```

## লাইসেন্স

MIT — দেখুন [LICENSE](LICENSE)
