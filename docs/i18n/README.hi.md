[English](../../README.md) | [हिन्दी](README.hi.md)

<p align="center">
  <img src="../../assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>पहले AI टूल बनाएं। जब ज़रूरत हो तब एजेंटों को संयोजित करें।</strong>
</p>

<p align="center">
  <a href="#quick-start">त्वरित शुरुआत</a> &middot;
  <a href="#the-mental-model">मानसिक मॉडल</a> &middot;
  <a href="#choose-the-right-primitive">सही प्रिमिटिव चुनें</a> &middot;
  <a href="#capability-ladder">क्षमता सीढ़ी</a> &middot;
  <a href="#providers">प्रदाता</a> &middot;
  <a href="#examples">उदाहरण</a> &middot;
  <a href="#docs">दस्तावेज़</a>
</p>

---

openFunctions एक MIT-लाइसेंस प्राप्त TypeScript फ्रेमवर्क है जो AI-कॉल करने योग्य टूल बनाने और उन्हें [MCP](https://modelcontextprotocol.io), चैट एडेप्टर, वर्कफ़्लो और एजेंटों के माध्यम से उजागर करने के लिए है। इसका मुख्य रनटाइम सरल है:

`ToolDefinition -> ToolRegistry -> AIAdapter`

बाकी सब कुछ इसके ऊपर संयोजित होता है:

- `workflows` (वर्कफ़्लो) टूल के चारों ओर नियतात्मक ऑर्केस्ट्रेशन हैं
- `agents` (एजेंट) एक फ़िल्टर्ड रजिस्ट्री पर LLM लूप हैं
- `structured output` (संरचित आउटपुट) एक सिंथेटिक टूल पैटर्न है
- `memory` (मेमोरी) और `rag` (आरएजी) स्टेटफुल सिस्टम हैं जिन्हें वापस टूल में लपेटा जा सकता है

यदि आप टूल रनटाइम को समझते हैं, तो फ्रेमवर्क का बाकी हिस्सा सुपाठ्य रहता है।

```text
defineTool() -> registry.register() -> adapter/server executes tool
                                    -> workflows compose tools
                                    -> agents use filtered tools
                                    -> memory/rag expose more tools
```

## त्वरित शुरुआत

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

बनाने वाली पहली चीज़ एक टूल है, एजेंट नहीं।

## मानसिक मॉडल

एक टूल आपका व्यावसायिक तर्क है और एक स्कीमा है जिसे AI पढ़ सकता है:

```typescript
import { defineTool, ok } from "../framework/index.js";

export const rollDice = defineTool({
  name: "roll_dice",
  description: "Roll a dice with the given number of sides", // दिए गए पक्षों की संख्या वाला पासा फेंकें
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "number", description: "Number of sides (default 6)" }, // पक्षों की संख्या (डिफ़ॉल्ट 6)
    },
  },
  handler: async ({ sides }) => {
    const rolled = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled });
  },
});
```

वह एक परिभाषा हो सकती है:

- `registry.execute()` द्वारा सीधे निष्पादित
- MCP के माध्यम से Claude/Desktop पर उजागर
- इंटरैक्टिव चैट लूप के अंदर उपयोग किया जाता है
- वर्कफ़्लो में संयोजित
- एजेंट-विशिष्ट रजिस्ट्रियों में फ़िल्टर किया गया

और पढ़ें: [आर्किटेक्चर](../../docs/ARCHITECTURE.md)

## सही प्रिमिटिव चुनें

| इसका उपयोग करें | जब आप चाहते हैं | यह वास्तव में क्या है |
|----------|---------------|-------------------|
| `defineTool()` | कॉल करने योग्य AI-उन्मुख व्यावसायिक तर्क | मुख्य प्रिमिटिव |
| `createChatAgent()` | एक संयोजनीय, एम्बेड करने योग्य AI एजेंट | टूल + मेमोरी + संदर्भ + एडेप्टर एक कॉन्फ़िग में |
| `pipe()` | नियतात्मक ऑर्केस्ट्रेशन | कोड-संचालित टूल/LLM पाइपलाइन |
| `defineAgent()` | अनुकूली बहु-चरणीय टूल उपयोग | एक फ़िल्टर्ड रजिस्ट्री पर एक LLM लूप |
| `createConversationMemory()` / `createFactMemory()` | थ्रेड/तथ्य स्थिति | परसिस्टेंस और मेमोरी टूल |
| `createRAG()` | सिमेंटिक दस्तावेज़ पुनर्प्राप्ति | pgvector + एम्बेडिंग + टूल |
| `connectProvider()` | बाहरी सिस्टम संदर्भ | ExecuFunction, Obsidian आदि से संरचित टूल |
| `createStore()` / `createPgStore()` | परसिस्टेंस | स्टोरेज लेयर, पुनर्प्राप्ति नहीं |

अंगूठे का नियम:

- एक टूल से शुरू करें।
- जब आप एक संपूर्ण एजेंट चाहें जिसमें मेमोरी और संदर्भ हो तो `createChatAgent()` का उपयोग करें।
- जब आप अनुक्रम जानते हों तो वर्कफ़्लो का उपयोग करें।
- जब आपको क्रू के अंदर विशेष एजेंटों की आवश्यकता हो तो `defineAgent()` का उपयोग करें।
- आपके द्वारा नियंत्रित स्थिति के लिए मेमोरी जोड़ें।
- अर्थ के आधार पर दस्तावेज़ पुनर्प्राप्ति के लिए RAG जोड़ें।
- जब आपको बाहरी सिस्टम (कार्य, कैलेंडर, CRM) की आवश्यकता हो तो एक संदर्भ प्रदाता जोड़ें।

## क्षमता सीढ़ी

### 1. एक टूल बनाएं

```bash
npm run create-tool expense_tracker
```

`src/my-tools/expense_tracker.ts` को संपादित करें, फिर चलाएं:

```bash
npm run test-tools
npm test
```

### 2. इसे MCP या चैट के माध्यम से उजागर करें

```bash
npm start
npm run chat -- gemini
```

वही रजिस्ट्री दोनों को शक्ति प्रदान करती है।

### 3. इसे वर्कफ़्लो के साथ संयोजित करें

वर्कफ़्लो डिफ़ॉल्ट "उन्नत" प्रिमिटिव हैं क्योंकि नियंत्रण प्रवाह स्पष्ट रहता है:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}"));

await research.run({ word: "ephemeral" });
```

### 4. एक चैट एजेंट बनाएं

`createChatAgent()` टूल, मेमोरी, संदर्भ प्रदाताओं और एक AI एडेप्टर को एकल एम्बेड करने योग्य एजेंट में संयोजित करता है:

```typescript
import { createChatAgent } from "./framework/index.js";

const agent = await createChatAgent({
  provider: "gemini",
  preset: "study-buddy",
  memory: true,                    // वार्तालाप + तथ्य मेमोरी (डिफ़ॉल्ट रूप से चालू)
  providers: ["execufunction"],    // बाहरी संदर्भ जोड़ें
});

// इसे चार तरीकों से उपयोग करें:
await agent.interactive();                          // CLI
const result = await agent.chat("Create a task");   // प्रोग्रामेटिक
for await (const chunk of agent.chat("hello", { stream: true })) { ... }  // स्ट्रीमिंग
await agent.serve({ port: 3000 });                  // HTTP सर्वर
```

वही कॉन्फ़िग कोड, CLI फ्लैग, या YAML फ़ाइलों से काम करता है। मेमोरी डिफ़ॉल्ट रूप से चालू है — एजेंट सत्रों के बीच याद रखता है।

### 5. एजेंटों के साथ अनुकूली व्यवहार जोड़ें

`defineAgent()` क्रू और वर्कफ़्लो के अंदर विशेष एजेंटों के लिए है — फ़िल्टर्ड रजिस्ट्रियां और तर्क लूप:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst",
  goal: "Find accurate information using available tools",
  toolTags: ["search"],
});
```

जब कई विशेष एजेंटों को सहयोग करने की आवश्यकता हो तो क्रू का उपयोग करें।

### 6. आवश्यकता पड़ने पर ही स्थिति जोड़ें

परसिस्टेंस:

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

मेमोरी:

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

RAG दस्तावेज़: [docs/RAG.md](../../docs/RAG.md)

### 7. बाहरी संदर्भ जोड़ें

संदर्भ प्रदाता बाहरी सिस्टम (कार्य प्रबंधक, कैलेंडर, CRM, ज्ञान आधार) को एजेंट रनटाइम में टूल के रूप में लाते हैं:

```typescript
import { connectProvider, contextPrompt } from "./framework/index.js";
import { createExecuFunctionProvider } from "./providers/execufunction/index.js";

// कनेक्ट करें — "context" + "context:execufunction" टैग वाले 17 टूल पंजीकृत करता है
const exf = await connectProvider(
  createExecuFunctionProvider({ token: process.env.EXF_PAT }),
  registry,
);

// एजेंट सिस्टम प्रॉम्प्ट में सक्रिय कार्य + आगामी इवेंट इंजेक्ट करें
const context = await contextPrompt([exf]);
```

`ContextProvider` इंटरफ़ेस प्लगेबल है — किसी भी बैकएंड को फ्रेमवर्क में लाने के लिए `metadata`, `connect()`, और `createTools()` को लागू करें। पूर्ण इंटरफ़ेस के लिए [आर्किटेक्चर](../../docs/ARCHITECTURE.md#context-providers) देखें।

| प्रदाता | स्थिति | क्षमताएं |
|----------|--------|--------------|
| [ExecuFunction](../../src/providers/execufunction/) | अंतर्निहित | कार्य, परियोजनाएं, कैलेंडर, ज्ञान, लोग, संगठन, कोडबेस |
| Obsidian | टेम्पलेट (योजनाबद्ध) | ज्ञान |
| Notion | टेम्पलेट (योजनाबद्ध) | ज्ञान, कार्य, परियोजनाएं |

## कमांड

```bash
npm run test-tools          # इंटरैक्टिव CLI — टूल का स्थानीय रूप से परीक्षण करें
npm run dev                 # देव मोड — सहेजने पर स्वतः-पुनः प्रारंभ होता है
npm test                    # टूल-परिभाषित स्वचालित परीक्षण चलाएं
npm run chat                # अपने टूल का उपयोग करके AI के साथ चैट करें
npm run chat -- gemini      # एक विशिष्ट प्रदाता को बाध्य करें
npm run chat -- --no-memory # बिना स्थायी मेमोरी के चैट करें
npm run create-tool <name>  # एक नया टूल स्केफोल्ड करें
npm run docs                # टूल संदर्भ दस्तावेज़ जेनरेट करें
npm run inspect             # MCP इंस्पेक्टर वेब UI
npm start                   # Claude Desktop / Cursor के लिए MCP सर्वर प्रारंभ करें
```

## प्रदाता

`.env` में एक API कुंजी सेट करें और चैट लूप प्रदाता का स्वतः पता लगा लेगा।

| प्रदाता | डिफ़ॉल्ट मॉडल | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | फ़ंक्शन कॉलिंग |
| OpenAI | `gpt-5.4` | रिस्पॉन्स API |
| Anthropic | `claude-sonnet-4-6` | मैसेज + tool_use |
| xAI | `grok-4.20-0309-reasoning` | रिस्पॉन्स API |
| OpenRouter | `google/gemini-3-flash-preview` | OpenAI-संगत |

उदाहरण:

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## परीक्षण

परीक्षण टूल परिभाषाओं के साथ रहते हैं:

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

हैंडलर चलने से पहले रजिस्ट्री मापदंडों को मान्य करती है, इसलिए स्कीमा त्रुटियों को मनुष्यों और LLM दोनों के लिए ठीक होने के लिए पर्याप्त स्पष्ट रूप से उजागर किया जाता है।

## उदाहरण

| डोमेन | टूल | पैटर्न |
|--------|-------|---------|
| स्टडी ट्रैकर | `create_task`, `list_tasks`, `complete_task` | CRUD + स्टोर |
| बुकमार्क मैनेजर | `save_link`, `search_links`, `tag_link` | एरेज़ + सर्च |
| रेसिपी कीपर | `save_recipe`, `search_recipes`, `get_random` | नेस्टेड डेटा + रैंडम |
| खर्च स्प्लिटर | `add_expense`, `split_bill`, `get_balances` | गणित + गणना |
| वर्कआउट लॉगर | `log_workout`, `get_stats`, `suggest_workout` | दिनांक फ़िल्टरिंग + स्टैट्स |
| डिक्शनरी | `define_word`, `find_synonyms` | बाहरी API (कोई कुंजी नहीं) |
| क्विज़ जेनरेटर | `create_quiz`, `answer_question`, `get_score` | स्टेटफुल गेम |
| AI टूल | `summarize_text`, `generate_flashcards` | टूल एक LLM को कॉल करता है |
| यूटिलिटीज़ | `calculate`, `convert_units`, `format_date` | स्टेटलेस हेल्पर |

## दस्तावेज़

- [आर्किटेक्चर](../../docs/ARCHITECTURE.md): रनटाइम मॉडल, फ़िल्टर्ड रजिस्ट्रियां, सिंथेटिक टूल और निष्पादन पथ
- [RAG](../../docs/RAG.md): सिमेंटिक चंकिंग, Gemini/OpenAI एम्बेडिंग, pgvector स्कीमा, HNSW सर्च और टूल इंटीग्रेशन

## प्लगइन

### OpenClaw के लिए ExecuFunction

[`@openfunctions/openclaw-execufunction`](../../plugins/openclaw-execufunction/) प्लगइन [ExecuFunction](https://execufunction.com) को [OpenClaw](https://github.com/openclaw/openclaw) एजेंट इकोसिस्टम में लाता है — 6 डोमेन में 17 टूल:

| डोमेन | टूल | यह क्या करता है |
|--------|-------|--------------|
| कार्य | `exf_tasks_list`, `exf_tasks_create`, `exf_tasks_update`, `exf_tasks_complete` | प्राथमिकताओं (do_now/do_next/do_later/delegate/drop) के साथ संरचित कार्य प्रबंधन |
| कैलेंडर | `exf_calendar_list`, `exf_calendar_create`, `exf_calendar_update` | इवेंट शेड्यूलिंग और लुकअप |
| ज्ञान | `exf_notes_search`, `exf_notes_create`, `exf_notes_get` | ज्ञान आधार में सिमेंटिक सर्च |
| परियोजनाएं | `exf_projects_list`, `exf_projects_context` | परियोजना स्थिति और पूर्ण संदर्भ (कार्य, नोट्स, सिग्नल) |
| लोग/CRM | `exf_people_search`, `exf_person_create`, `exf_org_search` | संपर्क और संगठन प्रबंधन |
| कोडबेस | `exf_codebase_search`, `exf_code_who_knows` | सिमेंटिक कोड सर्च और विशेषज्ञता ट्रैकिंग |

इंस्टॉल करें:

```bash
openclaw plugins install @openfunctions/openclaw-execufunction
```

अपने वातावरण में `EXF_PAT` सेट करें (या OpenClaw प्लगइन सेटिंग्स के माध्यम से कॉन्फ़िगर करें), और आपके OpenClaw एजेंट को स्थायी कार्य, कैलेंडर जागरूकता, सिमेंटिक ज्ञान खोज, CRM, और कोड इंटेलिजेंस मिल जाता है — ExecuFunction के क्लाउड API द्वारा समर्थित।

विवरण के लिए [प्लगइन README](../../plugins/openclaw-execufunction/) देखें।

## प्रोजेक्ट संरचना

```text
openFunctions/
├── src/
│   ├── framework/              # कोर रनटाइम + कंपोज़िशन लेयर्स
│   │   ├── chat-agent.ts       # createChatAgent() — संयोजनीय चैट एजेंट फैक्ट्री
│   │   ├── chat-agent-types.ts # ChatAgent, ChatAgentConfig, ChatResult प्रकार
│   │   ├── chat-agent-resolve.ts # कॉन्फ़िग रिज़ॉल्यूशन, प्रदाता ऑटो-डिटेक्शन
│   │   ├── chat-agent-http.ts  # agent.serve() के लिए HTTP सर्वर
│   │   ├── context.ts          # संदर्भ प्रदाता इंटरफ़ेस
│   │   └── ...                 # टूल, रजिस्ट्री, एजेंट, मेमोरी, RAG, वर्कफ़्लो
│   ├── providers/
│   │   └── execufunction/      # ExecuFunction संदर्भ प्रदाता (संदर्भ कार्यान्वयन)
│   ├── examples/               # संदर्भ टूल पैटर्न
│   ├── my-tools/               # आपके टूल
│   └── index.ts                # MCP एंट्रीपॉइंट
├── plugins/
│   └── openclaw-execufunction/ # OpenClaw के लिए ExecuFunction प्लगइन
├── docs/                       # आर्किटेक्चर दस्तावेज़
├── scripts/                    # चैट, create-tool, docs
├── test-client/                # CLI टेस्टर + टेस्ट रनर
├── system-prompts/             # प्रॉम्प्ट प्रीसेट
└── package.json
```

## लाइसेंस

MIT — [LICENSE](../../LICENSE) देखें
