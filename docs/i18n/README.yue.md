[English](../../README.md) | [粵語](README.yue.md)

<p align="center">
  <img src="../../assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>首先建立 AI 工具。需要嘅時候先組合代理。</strong>
</p>

<p align="center">
  <a href="#quick-start">快速開始</a> &middot;
  <a href="#the-mental-model">心智模型</a> &middot;
  <a href="#choose-the-right-primitive">揀啱嘅基元</a> &middot;
  <a href="#capability-ladder">能力階梯</a> &middot;
  <a href="#providers">供應商</a> &middot;
  <a href="#examples">範例</a> &middot;
  <a href="#docs">文件</a>
</p>

---

openFunctions 係一個採用 MIT 許可證嘅 TypeScript 框架，用嚟構建可以俾 AI 調用嘅工具，並且通過 [MCP](https://modelcontextprotocol.io)、聊天適配器、工作流程同代理嚟公開呢啲工具。佢嘅核心運行時好簡單：

`ToolDefinition -> ToolRegistry -> AIAdapter`

其他嘢全部都喺呢個基礎上面組合：

- `workflows` 係圍繞工具嘅確定性編排
- `agents` 係對過濾咗嘅註冊表進行嘅 LLM 循環
- `structured output` 係一種合成工具模式
- `memory` 同 `rag` 係有狀態系統，可以重新包裝成工具

如果你明白工具運行時，框架嘅其餘部分就會變得清楚易明。

```text
defineTool() -> registry.register() -> adapter/server executes tool // 定義一個工具，註冊佢，然後公開俾 AI
                                    -> workflows compose tools      // 工作流程組合工具
                                    -> agents use filtered tools    // 代理使用過濾咗嘅工具
                                    -> memory/rag expose more tools // 記憶/RAG 公開更多工具
```

## 快速開始

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

首先要構建嘅係工具，唔係代理。

## 心智模型

工具係你嘅業務邏輯加上 AI 可以讀取嘅模式：

```typescript
import { defineTool, ok } from "../framework/index.js";

export const rollDice = defineTool({ // 定義一個工具
  name: "roll_dice", // 工具名稱
  description: "Roll a dice with the given number of sides", // 俾 AI 睇嘅描述
  inputSchema: { // 輸入嘅模式
    type: "object",
    properties: {
      sides: { type: "number", description: "Number of sides (default 6)" },
    },
  },
  handler: async ({ sides }) => { // 處理函數
    const rolled = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled }); // 返回成功結果
  },
});
```

呢一個定義可以：

- 由 `registry.execute()` 直接執行
- 通過 MCP 公開俾 Claude/Desktop
- 喺互動聊天循環入面使用
- 組合到工作流程入面
- 過濾到代理專用嘅註冊表入面

閱讀更多：[架構](docs/ARCHITECTURE.md)

## 揀啱嘅基元

| 使用呢個 | 當你想要 | 佢實際上係 |
|----------|---------------|-------------------|
| `defineTool()` | 可以俾 AI 調用嘅業務邏輯 | 核心基元 |
| `createChatAgent()` | 可組合、可嵌入嘅 AI 代理 | 工具 + 記憶 + 上下文 + 適配器合成一個設定 |
| `pipe()` | 確定性編排 | 代碼驅動嘅工具/LLM 管道 |
| `defineAgent()` | 自適應多步驟工具使用 | 對過濾咗嘅註冊表進行嘅 LLM 循環 |
| `createConversationMemory()` / `createFactMemory()` | 線程/事實狀態 | 持久化加上記憶工具 |
| `createRAG()` | 語義文檔檢索 | pgvector + 嵌入 + 工具 |
| `connectProvider()` | 外部系統上下文 | 嚟自 ExecuFunction、Obsidian 等嘅結構化工具 |
| `createStore()` / `createPgStore()` | 持久化 | 存儲層，唔係檢索層 |

經驗法則：

- 由工具開始。
- 當你需要有記憶同上下文嘅完整代理時，用 `createChatAgent()`。
- 當你知道序列時，用工作流程。
- 當你需要團隊內嘅專業代理時，用 `defineAgent()`。
- 為你控制嘅狀態加記憶。
- 為按意義檢索文檔加 RAG。
- 當你需要外部系統（任務、日曆、CRM）時，加上下文供應商。

## 能力階梯

### 1. 構建工具

```bash
npm run create-tool expense_tracker
```

編輯 `src/my-tools/expense_tracker.ts`，然後運行：

```bash
npm run test-tools
npm test
```

### 2. 通過 MCP 或者聊天公開佢

```bash
npm start
npm run chat -- gemini
```

同一個註冊表為兩者提供支持。

### 3. 同工作流程組合

工作流程係默認嘅「高級」基元，因為控制流保持明確：

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word")) // 定義一個研究管道，第一步：用工具定義一個詞
  .then(async (result) => result.data?.meanings?.[0] ?? "") // 然後，提取第一個含義
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}")); // 最後，用 LLM 簡單解釋佢

await research.run({ word: "ephemeral" }); // 運行管道
```

### 4. 構建聊天代理

`createChatAgent()` 將工具、記憶、上下文供應商同 AI 適配器組合成一個可嵌入嘅代理：

```typescript
import { createChatAgent } from "./framework/index.js";

const agent = await createChatAgent({
  provider: "gemini",
  preset: "study-buddy",
  memory: true,                    // 對話 + 事實記憶（默認開啟）
  providers: ["execufunction"],    // 連接外部上下文
});

// 四種使用方式：
await agent.interactive();                          // CLI
const result = await agent.chat("Create a task");   // 程式化方式
for await (const chunk of agent.chat("hello", { stream: true })) { ... }  // 串流
await agent.serve({ port: 3000 });                  // HTTP 伺服器
```

同一個設定可以喺代碼、CLI 旗標或者 YAML 檔案度運作。記憶默認開啟 — 代理喺工作階段之間保持記憶。

### 5. 用代理添加自適應行為

`defineAgent()` 係為團隊同工作流程入面嘅專業代理而設 — 過濾咗嘅註冊表同推理循環：

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({ // 定義一個代理
  name: "researcher", // 代理名稱
  role: "Research Analyst", // 代理角色
  goal: "Find accurate information using available tools", // 代理目標
  toolTags: ["search"], // 代理可以用嘅工具（按標籤）
});
```

當多個專業代理需要協作時，用團隊（crews）。

### 6. 淨係需要時先添加狀態

持久化：

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

記憶：

```typescript
const conversations = createConversationMemory(); // 創建對話同事實記憶
const facts = createFactMemory();
registry.registerAll(createMemoryTools(conversations, facts)); // 註冊記憶工具
```

RAG：

```typescript
const rag = await createRAG({ embeddingProvider: "gemini" }); // 用 Gemini 嵌入創建 RAG
registry.registerAll(rag.createTools()); // 註冊 RAG 工具
```

RAG 文件：[docs/RAG.md](docs/RAG.md)

### 7. 連接外部上下文

上下文供應商將外部系統（任務管理器、日曆、CRM、知識庫）作為工具引入代理運行時：

```typescript
import { connectProvider, contextPrompt } from "./framework/index.js";
import { createExecuFunctionProvider } from "./providers/execufunction/index.js";

// 連接 — 註冊 17 個帶有 "context" + "context:execufunction" 標籤嘅工具
const exf = await connectProvider(
  createExecuFunctionProvider({ token: process.env.EXF_PAT }),
  registry,
);

// 將進行中嘅任務 + 即將嚟嘅事件注入代理系統提示
const context = await contextPrompt([exf]);
```

`ContextProvider` 介面係可插拔嘅 — 實現 `metadata`、`connect()` 同 `createTools()` 就可以將任何後端引入框架。完整介面請睇[架構](docs/ARCHITECTURE.md#context-providers)。

| 供應商 | 狀態 | 功能 |
|----------|--------|--------------|
| [ExecuFunction](src/providers/execufunction/) | 內建 | 任務、項目、日曆、知識、人物、組織、代碼庫 |
| Obsidian | 範本（規劃中） | 知識 |
| Notion | 範本（規劃中） | 知識、任務、項目 |

## 命令

```bash
npm run test-tools          # 互動式 CLI — 喺本地測試工具
npm run dev                 # 開發模式 — 保存時自動重啟
npm test                    # 運行工具定義嘅自動化測試
npm run chat                # 用你嘅工具同 AI 聊天
npm run chat -- gemini      # 強制使用特定供應商
npm run chat -- --no-memory # 冇持久記憶模式聊天
npm run create-tool <name>  # 搭建新工具
npm run docs                # 生成工具參考文件
npm run inspect             # MCP 檢查器網頁 UI
npm start                   # 啟動 MCP 伺服器以供 Claude Desktop / Cursor 使用
```

## 供應商

喺 `.env` 入面設置一個 API 密鑰，聊天循環就會自動檢測供應商。

| 供應商 | 默認模型 | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | 函數調用 |
| OpenAI | `gpt-5.4` | 回應 API |
| Anthropic | `claude-sonnet-4-6` | 消息 + 工具使用 |
| xAI | `grok-4.20-0309-reasoning` | 回應 API |
| OpenRouter | `google/gemini-3-flash-preview` | 同 OpenAI 兼容 |

範例：

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## 測試

測試同工具定義共存：

```typescript
defineTool({ // 工具定義
  name: "create_task",
  // ...
  tests: [ // 測試案例
    { name: "creates a task", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } }, // 測試名稱，測試輸入，預期輸出
    { name: "fails without subject", input: { title: "Read ch5" }, expect: { success: false } }, // 另一個測試案例，測試輸入，預期輸出
  ],
});
```

註冊表喺處理程序運行之前驗證參數，所以模式錯誤會清晰咁呈現，足以俾人類同 LLM 恢復。

## 範例

| 領域 | 工具 | 模式 |
|--------|-------|---------|
| 學習追蹤器 | `create_task`, `list_tasks`, `complete_task` | CRUD + 存儲 |
| 書籤管理器 | `save_link`, `search_links`, `tag_link` | 數組 + 搜索 |
| 食譜保管器 | `save_recipe`, `search_recipes`, `get_random` | 嵌套數據 + 隨機 |
| 費用分攤器 | `add_expense`, `split_bill`, `get_balances` | 數學 + 計算 |
| 鍛煉記錄器 | `log_workout`, `get_stats`, `suggest_workout` | 日期過濾 + 統計 |
| 詞典 | `define_word`, `find_synonyms` | 外部 API（唔使密鑰） |
| 測驗生成器 | `create_quiz`, `answer_question`, `get_score` | 有狀態遊戲 |
| AI 工具 | `summarize_text`, `generate_flashcards` | 工具調用 LLM |
| 實用工具 | `calculate`, `convert_units`, `format_date` | 無狀態助手 |

## 文件

- [架構](docs/ARCHITECTURE.md)：運行時模型、過濾咗嘅註冊表、合成工具同執行路徑
- [RAG](docs/RAG.md)：語義分塊、Gemini/OpenAI 嵌入、pgvector 模式、HNSW 搜索同工具集成

## 插件

### ExecuFunction for OpenClaw

[`@openfunctions/openclaw-execufunction`](plugins/openclaw-execufunction/) 插件將 [ExecuFunction](https://execufunction.com) 引入 [OpenClaw](https://github.com/openclaw/openclaw) 代理生態系統 — 跨 6 個領域嘅 17 個工具：

| 領域 | 工具 | 功能 |
|--------|-------|--------------|
| 任務 | `exf_tasks_list`, `exf_tasks_create`, `exf_tasks_update`, `exf_tasks_complete` | 帶優先級嘅結構化任務管理 (do_now/do_next/do_later/delegate/drop) |
| 日曆 | `exf_calendar_list`, `exf_calendar_create`, `exf_calendar_update` | 事件調度同查詢 |
| 知識 | `exf_notes_search`, `exf_notes_create`, `exf_notes_get` | 跨知識庫嘅語義搜索 |
| 項目 | `exf_projects_list`, `exf_projects_context` | 項目狀態同完整上下文（任務、筆記、信號） |
| 人物/CRM | `exf_people_search`, `exf_person_create`, `exf_org_search` | 聯繫人同組織管理 |
| 代碼庫 | `exf_codebase_search`, `exf_code_who_knows` | 語義代碼搜索同專業知識追蹤 |

安裝：

```bash
openclaw plugins install @openfunctions/openclaw-execufunction
```

喺環境入面設定 `EXF_PAT`（或者通過 OpenClaw 插件設定進行配置），你嘅 OpenClaw 代理就會獲得基於 ExecuFunction 雲端 API 嘅持久任務、日曆感知、語義知識搜索、CRM 同代碼智能。

詳情請睇[插件 README](plugins/openclaw-execufunction/)。

## 項目結構

```text
openFunctions/
├── src/
│   ├── framework/              # 核心運行時 + 組合層
│   │   ├── chat-agent.ts       # createChatAgent() — 可組合嘅聊天代理工廠
│   │   ├── chat-agent-types.ts # ChatAgent, ChatAgentConfig, ChatResult 型別
│   │   ├── chat-agent-resolve.ts # 設定解析、供應商自動檢測
│   │   ├── chat-agent-http.ts  # agent.serve() 嘅 HTTP 伺服器
│   │   ├── context.ts          # 上下文供應商介面
│   │   └── ...                 # 工具、註冊表、代理、記憶、RAG、工作流程
│   ├── providers/
│   │   └── execufunction/      # ExecuFunction 上下文供應商（參考實現）
│   ├── examples/               # 參考工具模式
│   ├── my-tools/               # 你嘅工具
│   └── index.ts                # MCP 入口點
├── plugins/
│   └── openclaw-execufunction/ # OpenClaw 嘅 ExecuFunction 插件
├── docs/                       # 架構文件
├── scripts/                    # 聊天、創建工具、文件
├── test-client/                # CLI 測試器 + 測試運行器
├── system-prompts/             # 提示預設
└── package.json
```

## 許可證

MIT — 請睇 [LICENSE](LICENSE)
