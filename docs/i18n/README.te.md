[English](../../README.md) | [తెలుగు](README.te.md)

<p align="center">
  <img src="../../assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>ముందుగా AI టూల్స్ నిర్మించండి. అవసరమైనప్పుడు ఏజెంట్లను అనుసంధానించండి.</strong>
</p>

<p align="center">
  <a href="#quick-start">త్వరిత ప్రారంభం</a> &middot;
  <a href="#the-mental-model">మానసిక నమూనా</a> &middot;
  <a href="#choose-the-right-primitive">సరైన ప్రిమిటివ్‌ను ఎంచుకోండి</a> &middot;
  <a href="#capability-ladder">సామర్థ్యాల స్థాయిలు</a> &middot;
  <a href="#providers">ప్రొవైడర్లు</a> &middot;
  <a href="#examples">ఉదాహరణలు</a> &middot;
  <a href="#docs">డాక్యుమెంట్లు</a>
</p>

---

openFunctions అనేది AI-కాల్ చేయగల టూల్స్‌ను నిర్మించడానికి మరియు వాటిని [MCP](https://modelcontextprotocol.io), చాట్ అడాప్టర్‌లు, వర్క్‌ఫ్లోలు మరియు ఏజెంట్ల ద్వారా బహిర్గతం చేయడానికి MIT-లైసెన్స్ పొందిన TypeScript ఫ్రేమ్‌వర్క్. దీని ప్రధాన రన్‌టైమ్ సులభం:

`ToolDefinition -> ToolRegistry -> AIAdapter`

మిగతావన్నీ దీని ఆధారంగా నిర్మించబడతాయి:

- `workflows` అనేవి టూల్స్ చుట్టూ నిర్దిష్ట ఆర్కెస్ట్రేషన్
- `agents` అనేవి ఫిల్టర్ చేయబడిన రిజిస్ట్రీపై LLM లూప్‌లు
- `structured output` అనేది ఒక సింథటిక్ టూల్ నమూనా
- `memory` మరియు `rag` అనేవి స్టేట్‌ఫుల్ సిస్టమ్స్, వీటిని తిరిగి టూల్స్‌గా మార్చవచ్చు

మీకు టూల్ రన్‌టైమ్ అర్థమైతే, ఫ్రేమ్‌వర్క్‌లోని మిగతా భాగం స్పష్టంగా ఉంటుంది.

```text
defineTool() -> registry.register() -> adapter/server executes tool
                                    -> workflows compose tools
                                    -> agents use filtered tools
                                    -> memory/rag expose more tools
```

## త్వరిత ప్రారంభం

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

నిర్మించాల్సిన మొదటి విషయం ఒక టూల్, ఏజెంట్ కాదు.

## మానసిక నమూనా

ఒక టూల్ అనేది మీ వ్యాపార లాజిక్ మరియు AI చదవగలిగే స్కీమా:

```typescript
import { defineTool, ok } from "../framework/index.js";

export const rollDice = defineTool({
  name: "roll_dice",
  description: "Roll a dice with the given number of sides", // ఇచ్చిన భుజాల సంఖ్యతో పాచికను వేయండి
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "number", description: "Number of sides (default 6)" }, // భుజాల సంఖ్య (డిఫాల్ట్ 6)
    },
  },
  handler: async ({ sides }) => {
    const rolled = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled });
  },
});
```

ఆ ఒక్క నిర్వచనం ఇలా ఉండవచ్చు:

- `registry.execute()` ద్వారా నేరుగా అమలు చేయబడుతుంది
- MCP ద్వారా Claude/డెస్క్‌టాప్‌కు బహిర్గతం చేయబడుతుంది
- ఇంటరాక్టివ్ చాట్ లూప్‌లో ఉపయోగించబడుతుంది
- వర్క్‌ఫ్లోలలో ఇమిడి ఉంటుంది
- ఏజెంట్-నిర్దిష్ట రిజిస్ట్రీలలోకి ఫిల్టర్ చేయబడుతుంది

మరింత చదవండి: [ఆర్కిటెక్చర్](../../docs/ARCHITECTURE.md)

## సరైన ప్రిమిటివ్‌ను ఎంచుకోండి

| దీన్ని ఉపయోగించండి | మీకు ఇది కావాలంటే | అది నిజంగా ఏమిటి |
|----------|---------------|-------------------|
| `defineTool()` | కాల్ చేయగల AI-ఆధారిత వ్యాపార లాజిక్ | ప్రధాన ప్రిమిటివ్ |
| `createChatAgent()` | ఒక కంపోజబుల్, ఎంబెడ్ చేయగల AI ఏజెంట్ | టూల్స్ + మెమరీ + కాంటెక్స్ట్ + అడాప్టర్ ఒక కాన్ఫిగ్‌లో |
| `pipe()` | నిర్దిష్ట ఆర్కెస్ట్రేషన్ | కోడ్-ఆధారిత టూల్/LLM పైప్‌లైన్ |
| `defineAgent()` | అనుకూల బహుళ-దశల టూల్ వినియోగం | ఫిల్టర్ చేయబడిన రిజిస్ట్రీపై LLM లూప్ |
| `createConversationMemory()` / `createFactMemory()` | థ్రెడ్/ఫ్యాక్ట్ స్థితి | పర్సిస్టెన్స్ ప్లస్ మెమరీ టూల్స్ |
| `createRAG()` | సెమాంటిక్ డాక్యుమెంట్ రిట్రీవల్ | pgvector + ఎంబెడింగ్‌లు + టూల్స్ |
| `connectProvider()` | బాహ్య సిస్టమ్ కాంటెక్స్ట్ | ExecuFunction, Obsidian మొదలైన వాటి నుండి నిర్మాణాత్మక టూల్స్ |
| `createStore()` / `createPgStore()` | పర్సిస్టెన్స్ | స్టోరేజ్ లేయర్, రిట్రీవల్ కాదు |

సాధారణ నియమం:

- టూల్‌తో ప్రారంభించండి.
- మీకు మెమరీ మరియు కాంటెక్స్ట్‌తో పూర్తి ఏజెంట్ కావాలంటే `createChatAgent()` ఉపయోగించండి.
- మీకు క్రమం తెలిసినప్పుడు వర్క్‌ఫ్లోను ఉపయోగించండి.
- క్రూల లోపల ప్రత్యేక ఏజెంట్లు అవసరమైనప్పుడు `defineAgent()` ఉపయోగించండి.
- మీరు నియంత్రించే స్థితి కోసం మెమరీని జోడించండి.
- అర్థం ద్వారా డాక్యుమెంట్ రిట్రీవల్ కోసం RAGని జోడించండి.
- మీకు బాహ్య సిస్టమ్‌లు (టాస్క్‌లు, క్యాలెండర్, CRM) అవసరమైనప్పుడు కాంటెక్స్ట్ ప్రొవైడర్‌ను జోడించండి.

## సామర్థ్యాల స్థాయిలు

### 1. ఒక టూల్‌ను నిర్మించండి

```bash
npm run create-tool expense_tracker
```

`src/my-tools/expense_tracker.ts`ని సవరించండి, ఆపై అమలు చేయండి:

```bash
npm run test-tools
npm test
```

### 2. MCP లేదా చాట్ ద్వారా దీన్ని బహిర్గతం చేయండి

```bash
npm start
npm run chat -- gemini
```

అదే రిజిస్ట్రీ రెండింటికీ శక్తినిస్తుంది.

### 3. వర్క్‌ఫ్లోలతో దీన్ని అనుసంధానించండి

వర్క్‌ఫ్లోలు డిఫాల్ట్ "అధునాతన" ప్రిమిటివ్, ఎందుకంటే నియంత్రణ ప్రవాహం స్పష్టంగా ఉంటుంది:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}"));

await research.run({ word: "ephemeral" });
```

### 4. చాట్ ఏజెంట్‌ను నిర్మించండి

`createChatAgent()` టూల్స్, మెమరీ, కాంటెక్స్ట్ ప్రొవైడర్లు మరియు AI అడాప్టర్‌ను ఒకే ఎంబెడ్ చేయగల ఏజెంట్‌గా కంపోజ్ చేస్తుంది:

```typescript
import { createChatAgent } from "./framework/index.js";

const agent = await createChatAgent({
  provider: "gemini",
  preset: "study-buddy",
  memory: true,                    // సంభాషణ + ఫ్యాక్ట్ మెమరీ (డిఫాల్ట్‌గా ఆన్)
  providers: ["execufunction"],    // బాహ్య కాంటెక్స్ట్ కనెక్ట్ చేయండి
});

// నాలుగు విధాలుగా ఉపయోగించండి:
await agent.interactive();                          // CLI
const result = await agent.chat("Create a task");   // ప్రోగ్రమాటిక్
for await (const chunk of agent.chat("hello", { stream: true })) { ... }  // స్ట్రీమింగ్
await agent.serve({ port: 3000 });                  // HTTP సర్వర్
```

అదే కాన్ఫిగ్ కోడ్, CLI ఫ్లాగ్‌లు లేదా YAML ఫైల్స్ నుండి పనిచేస్తుంది. మెమరీ డిఫాల్ట్‌గా ఆన్ — ఏజెంట్ సెషన్ల మధ్య గుర్తుంచుకుంటుంది.

### 5. ఏజెంట్లతో అనుకూల ప్రవర్తనను జోడించండి

`defineAgent()` క్రూలు మరియు వర్క్‌ఫ్లోల లోపల ప్రత్యేక ఏజెంట్ల కోసం — ఫిల్టర్ చేయబడిన రిజిస్ట్రీలు మరియు రీజనింగ్ లూప్‌లు:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst",
  goal: "Find accurate information using available tools",
  toolTags: ["search"],
});
```

బహుళ ప్రత్యేక ఏజెంట్లు సహకరించాల్సిన అవసరం ఉన్నప్పుడు క్రూలను ఉపయోగించండి.

### 6. అవసరమైనప్పుడు మాత్రమే స్థితిని జోడించండి

పర్సిస్టెన్స్:

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

మెమరీ:

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

RAG డాక్యుమెంట్లు: [docs/RAG.md](../../docs/RAG.md)

### 7. బాహ్య కాంటెక్స్ట్‌ను కనెక్ట్ చేయండి

కాంటెక్స్ట్ ప్రొవైడర్లు బాహ్య సిస్టమ్‌లను (టాస్క్ మేనేజర్లు, క్యాలెండర్, CRM, నాలెడ్జ్ బేస్‌లు) ఏజెంట్ రన్‌టైమ్‌లోకి టూల్స్‌గా తీసుకొస్తాయి:

```typescript
import { connectProvider, contextPrompt } from "./framework/index.js";
import { createExecuFunctionProvider } from "./providers/execufunction/index.js";

// కనెక్ట్ చేయండి — "context" + "context:execufunction" ట్యాగ్ చేయబడిన 17 టూల్స్‌ను రిజిస్టర్ చేస్తుంది
const exf = await connectProvider(
  createExecuFunctionProvider({ token: process.env.EXF_PAT }),
  registry,
);

// ఏజెంట్ సిస్టమ్ ప్రాంప్ట్‌లలోకి యాక్టివ్ టాస్క్‌లు + రాబోయే ఈవెంట్‌లను ఇంజెక్ట్ చేయండి
const context = await contextPrompt([exf]);
```

`ContextProvider` ఇంటర్‌ఫేస్ ప్లగబుల్ — ఏదైనా బ్యాక్‌ఎండ్‌ను ఫ్రేమ్‌వర్క్‌లోకి తీసుకురావడానికి `metadata`, `connect()`, మరియు `createTools()` ను అమలు చేయండి. పూర్తి ఇంటర్‌ఫేస్ కోసం [ఆర్కిటెక్చర్](../../docs/ARCHITECTURE.md#context-providers) చూడండి.

| ప్రొవైడర్ | స్థితి | సామర్థ్యాలు |
|----------|--------|--------------|
| [ExecuFunction](../../src/providers/execufunction/) | అంతర్నిర్మితం | టాస్క్‌లు, ప్రాజెక్ట్‌లు, క్యాలెండర్, నాలెడ్జ్, వ్యక్తులు, సంస్థలు, కోడ్‌బేస్ |
| Obsidian | టెంప్లేట్ (ప్రణాళికలో) | నాలెడ్జ్ |
| Notion | టెంప్లేట్ (ప్రణాళికలో) | నాలెడ్జ్, టాస్క్‌లు, ప్రాజెక్ట్‌లు |

## ఆదేశాలు

```bash
npm run test-tools          # ఇంటరాక్టివ్ CLI — టూల్స్‌ను స్థానికంగా పరీక్షించండి
npm run dev                 # డెవ్ మోడ్ — సేవ్ చేసినప్పుడు ఆటో-రీస్టార్ట్ అవుతుంది
npm test                    # టూల్-నిర్వచించిన ఆటోమేటెడ్ టెస్ట్‌లను అమలు చేయండి
npm run chat                # మీ టూల్స్‌ను ఉపయోగించి AIతో చాట్ చేయండి
npm run chat -- gemini      # నిర్దిష్ట ప్రొవైడర్‌ను బలవంతం చేయండి
npm run chat -- --no-memory # శాశ్వత మెమరీ లేకుండా చాట్ చేయండి
npm run create-tool <name>  # కొత్త టూల్‌ను స్కాఫోల్డ్ చేయండి
npm run docs                # టూల్ రిఫరెన్స్ డాక్యుమెంట్‌లను రూపొందించండి
npm run inspect             # MCP ఇన్‌స్పెక్టర్ వెబ్ UI
npm start                   # Claude డెస్క్‌టాప్ / కర్సర్ కోసం MCP సర్వర్‌ను ప్రారంభించండి
```

## ప్రొవైడర్లు

`.env`లో ఒక API కీని సెట్ చేయండి మరియు చాట్ లూప్ ప్రొవైడర్‌ను ఆటో-డిటెక్ట్ చేస్తుంది.

| ప్రొవైడర్ | డిఫాల్ట్ మోడల్ | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | ఫంక్షన్ కాలింగ్ |
| OpenAI | `gpt-5.4` | రెస్పాన్సెస్ API |
| Anthropic | `claude-sonnet-4-6` | మెసేజెస్ + tool_use |
| xAI | `grok-4.20-0309-reasoning` | రెస్పాన్సెస్ API |
| OpenRouter | `google/gemini-3-flash-preview` | OpenAI-అనుకూలమైనది |

ఉదాహరణలు:

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## టెస్టింగ్

టెస్ట్‌లు టూల్ నిర్వచనాలతో ఉంటాయి:

```typescript
defineTool({
  name: "create_task",
  // ...
  tests: [
    { name: "creates a task", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } }, // ఒక పనిని సృష్టిస్తుంది
    { name: "fails without subject", input: { title: "Read ch5" }, expect: { success: false } }, // సబ్జెక్ట్ లేకుండా విఫలమవుతుంది
  ],
});
```

హ్యాండ్లర్‌లు అమలు కావడానికి ముందు రిజిస్ట్రీ పారామీటర్‌లను ధృవీకరిస్తుంది, కాబట్టి స్కీమా లోపాలు మానవులకు మరియు LLMలకు స్పష్టంగా కనిపించేలా ఉంటాయి.

## ఉదాహరణలు

| డొమైన్ | టూల్స్ | నమూనా |
|--------|-------|---------|
| స్టడీ ట్రాకర్ | `create_task`, `list_tasks`, `complete_task` | CRUD + స్టోర్ |
| బుక్‌మార్క్ మేనేజర్ | `save_link`, `search_links`, `tag_link` | శ్రేణులు + శోధన |
| రెసిపీ కీపర్ | `save_recipe`, `search_recipes`, `get_random` | నెస్టెడ్ డేటా + రాండమ్ |
| ఖర్చుల స్ప్లిటర్ | `add_expense`, `split_bill`, `get_balances` | గణితం + లెక్కలు |
| వర్కౌట్ లాగర్ | `log_workout`, `get_stats`, `suggest_workout` | తేదీ ఫిల్టరింగ్ + గణాంకాలు |
| నిఘంటువు | `define_word`, `find_synonyms` | బాహ్య API (కీ లేదు) |
| క్విజ్ జనరేటర్ | `create_quiz`, `answer_question`, `get_score` | స్టేట్‌ఫుల్ గేమ్ |
| AI టూల్స్ | `summarize_text`, `generate_flashcards` | టూల్ ఒక LLMని కాల్ చేస్తుంది |
| యుటిలిటీస్ | `calculate`, `convert_units`, `format_date` | స్టేట్‌లెస్ హెల్పర్స్ |

## డాక్యుమెంట్లు

- [ఆర్కిటెక్చర్](../../docs/ARCHITECTURE.md): రన్‌టైమ్ మోడల్, ఫిల్టర్ చేయబడిన రిజిస్ట్రీలు, సింథటిక్ టూల్స్ మరియు అమలు మార్గాలు
- [RAG](../../docs/RAG.md): సెమాంటిక్ చంకింగ్, Gemini/OpenAI ఎంబెడింగ్‌లు, pgvector స్కీమా, HNSW శోధన మరియు టూల్ ఇంటిగ్రేషన్

## ప్లగిన్లు

### OpenClaw కోసం ExecuFunction

[`@openfunctions/openclaw-execufunction`](../../plugins/openclaw-execufunction/) ప్లగిన్ [ExecuFunction](https://execufunction.com)ను [OpenClaw](https://github.com/openclaw/openclaw) ఏజెంట్ ఈకోసిస్టమ్‌లోకి తీసుకువస్తుంది — 6 డొమైన్‌లలో 17 టూల్స్:

| డొమైన్ | టూల్స్ | ఇది ఏమి చేస్తుంది |
|--------|-------|--------------|
| టాస్క్‌లు | `exf_tasks_list`, `exf_tasks_create`, `exf_tasks_update`, `exf_tasks_complete` | ప్రాధాన్యతలతో (do_now/do_next/do_later/delegate/drop) నిర్మాణాత్మక టాస్క్ మేనేజ్‌మెంట్ |
| క్యాలెండర్ | `exf_calendar_list`, `exf_calendar_create`, `exf_calendar_update` | ఈవెంట్ షెడ్యూలింగ్ మరియు లుకప్ |
| నాలెడ్జ్ | `exf_notes_search`, `exf_notes_create`, `exf_notes_get` | నాలెడ్జ్ బేస్‌లో సెమాంటిక్ శోధన |
| ప్రాజెక్ట్‌లు | `exf_projects_list`, `exf_projects_context` | ప్రాజెక్ట్ స్థితి మరియు పూర్తి కాంటెక్స్ట్ (టాస్క్‌లు, నోట్స్, సిగ్నల్స్) |
| వ్యక్తులు/CRM | `exf_people_search`, `exf_person_create`, `exf_org_search` | కాంటాక్ట్ మరియు సంస్థ మేనేజ్‌మెంట్ |
| కోడ్‌బేస్ | `exf_codebase_search`, `exf_code_who_knows` | సెమాంటిక్ కోడ్ శోధన మరియు నైపుణ్య ట్రాకింగ్ |

ఇన్‌స్టాల్ చేయండి:

```bash
openclaw plugins install @openfunctions/openclaw-execufunction
```

మీ ఎన్విరాన్‌మెంట్‌లో `EXF_PAT` సెట్ చేయండి (లేదా OpenClaw ప్లగిన్ సెట్టింగ్‌ల ద్వారా కాన్ఫిగర్ చేయండి), మరియు మీ OpenClaw ఏజెంట్‌కు శాశ్వత టాస్క్‌లు, క్యాలెండర్ అవగాహన, సెమాంటిక్ నాలెడ్జ్ శోధన, CRM మరియు కోడ్ ఇంటెలిజెన్స్ అందుబాటులోకి వస్తాయి — ExecuFunction క్లౌడ్ API ద్వారా మద్దతు.

వివరాల కోసం [ప్లగిన్ README](../../plugins/openclaw-execufunction/) చూడండి.

## ప్రాజెక్ట్ నిర్మాణం

```text
openFunctions/
├── src/
│   ├── framework/              # ప్రధాన రన్‌టైమ్ + కంపోజిషన్ లేయర్‌లు
│   │   ├── chat-agent.ts       # createChatAgent() — కంపోజబుల్ చాట్ ఏజెంట్ ఫ్యాక్టరీ
│   │   ├── chat-agent-types.ts # ChatAgent, ChatAgentConfig, ChatResult టైప్‌లు
│   │   ├── chat-agent-resolve.ts # కాన్ఫిగ్ రెజొల్యూషన్, ప్రొవైడర్ ఆటో-డిటెక్షన్
│   │   ├── chat-agent-http.ts  # agent.serve() కోసం HTTP సర్వర్
│   │   ├── context.ts          # కాంటెక్స్ట్ ప్రొవైడర్ ఇంటర్‌ఫేస్
│   │   └── ...                 # టూల్, రిజిస్ట్రీ, ఏజెంట్‌లు, మెమరీ, RAG, వర్క్‌ఫ్లోలు
│   ├── providers/
│   │   └── execufunction/      # ExecuFunction కాంటెక్స్ట్ ప్రొవైడర్ (రిఫరెన్స్ ఇంప్లిమెంటేషన్)
│   ├── examples/               # రిఫరెన్స్ టూల్ నమూనాలు
│   ├── my-tools/               # మీ టూల్స్
│   └── index.ts                # MCP ఎంట్రీపాయింట్
├── plugins/
│   └── openclaw-execufunction/ # OpenClaw కోసం ExecuFunction ప్లగిన్
├── docs/                       # ఆర్కిటెక్చర్ డాక్యుమెంట్లు
├── scripts/                    # చాట్, క్రియేట్-టూల్, డాక్యుమెంట్లు
├── test-client/                # CLI టెస్టర్ + టెస్ట్ రన్నర్
├── system-prompts/             # ప్రాంప్ట్ ప్రీసెట్‌లు
└── package.json
```

## లైసెన్స్

MIT — [LICENSE](../../LICENSE) చూడండి
