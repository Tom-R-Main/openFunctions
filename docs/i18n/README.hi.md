[English](../README.md) | [Hindi](README.hi.md)

<p align="center">
  <img src="assets/logo.svg" alt="openFunctions" width="600">
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

वह एक परिभाषा हो सकती है:

- `registry.execute()` द्वारा सीधे निष्पादित
- MCP के माध्यम से Claude/Desktop पर उजागर
- इंटरैक्टिव चैट लूप के अंदर उपयोग किया जाता है
- वर्कफ़्लो में संयोजित
- एजेंट-विशिष्ट रजिस्ट्रियों में फ़िल्टर किया गया

और पढ़ें: [आर्किटेक्चर](docs/ARCHITECTURE.md)

## सही प्रिमिटिव चुनें

| इसका उपयोग करें | जब आप चाहते हैं | यह वास्तव में क्या है |
|----------|---------------|-------------------|
| `defineTool()` | कॉल करने योग्य AI-उन्मुख व्यावसायिक तर्क | मुख्य प्रिमिटिव |
| `pipe()` | नियतात्मक ऑर्केस्ट्रेशन | कोड-संचालित टूल/LLM पाइपलाइन |
| `defineAgent()` | अनुकूली बहु-चरणीय टूल उपयोग | एक फ़िल्टर्ड रजिस्ट्री पर एक LLM लूप |
| `createConversationMemory()` / `createFactMemory()` | थ्रेड/तथ्य स्थिति | परसिस्टेंस और मेमोरी टूल |
| `createRAG()` | सिमेंटिक दस्तावेज़ पुनर्प्राप्ति | pgvector + एम्बेडिंग + टूल |
| `createStore()` / `createPgStore()` | परसिस्टेंस | स्टोरेज लेयर, पुनर्प्राप्ति नहीं |

अंगूठे का नियम:

- एक टूल से शुरू करें।
- जब आप अनुक्रम जानते हों तो वर्कफ़्लो का उपयोग करें।
- एजेंट का उपयोग तभी करें जब मॉडल को यह चुनने की आवश्यकता हो कि आगे क्या करना है।
- आपके द्वारा नियंत्रित स्थिति के लिए मेमोरी जोड़ें।
- अर्थ के आधार पर दस्तावेज़ पुनर्प्राप्ति के लिए RAG जोड़ें।

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

### 4. एजेंटों के साथ अनुकूली व्यवहार जोड़ें

एजेंट उन्हीं टूल का उपयोग करते हैं, लेकिन एक फ़िल्टर्ड रजिस्ट्री और एक तर्क लूप के माध्यम से:

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

### 5. आवश्यकता पड़ने पर ही स्थिति जोड़ें

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

RAG दस्तावेज़: [docs/RAG.md](docs/RAG.md)

## कमांड

```bash
npm run test-tools          # इंटरैक्टिव CLI — टूल का स्थानीय रूप से परीक्षण करें
npm run dev                 # देव मोड — सहेजने पर स्वतः-पुनः प्रारंभ होता है
npm test                    # टूल-परिभाषित स्वचालित परीक्षण चलाएं
npm run chat                # अपने टूल का उपयोग करके AI के साथ चैट करें
npm run chat -- gemini      # एक विशिष्ट प्रदाता को बाध्य करें
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

- [आर्किटेक्चर](docs/ARCHITECTURE.md): रनटाइम मॉडल, फ़िल्टर्ड रजिस्ट्रियां, सिंथेटिक टूल और निष्पादन पथ
- [RAG](docs/RAG.md): सिमेंटिक चंकिंग, Gemini/OpenAI एम्बेडिंग, pgvector स्कीमा, HNSW सर्च और टूल इंटीग्रेशन

## प्रोजेक्ट संरचना

```text
openFunctions/
├── src/
│   ├── framework/              # कोर रनटाइम + कंपोज़िशन लेयर्स
│   ├── examples/               # संदर्भ टूल पैटर्न
│   ├── my-tools/               # आपके टूल
│   └── index.ts                # MCP एंट्रीपॉइंट
├── docs/                       # आर्किटेक्चर दस्तावेज़
├── scripts/                    # चैट, create-tool, docs
├── test-client/                # CLI टेस्टर + टेस्ट रनर
├── system-prompts/             # प्रॉम्प्ट प्रीसेट
└── package.json
```

## लाइसेंस

MIT — [LICENSE](LICENSE) देखें
