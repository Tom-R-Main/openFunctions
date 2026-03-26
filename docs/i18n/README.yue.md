[English](../README.md) | [Cantonese](README.yue.md)

<p align="center">
  <img src="assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>首先建立 AI 工具。在需要時才組合代理。</strong>
</p>

<p align="center">
  <a href="#quick-start">快速開始</a> &middot;
  <a href="#the-mental-model">心智模型</a> &middot;
  <a href="#choose-the-right-primitive">選擇合適的基元</a> &middot;
  <a href="#capability-ladder">能力階梯</a> &middot;
  <a href="#providers">供應商</a> &middot;
  <a href="#examples">範例</a> &middot;
  <a href="#docs">文件</a>
</p>

---

openFunctions 是一個採用 MIT 許可證的 TypeScript 框架，用於構建可由 AI 調用的工具，並通過 [MCP](https://modelcontextprotocol.io)、聊天適配器、工作流程和代理來公開這些工具。其核心運行時很簡單：

`ToolDefinition -> ToolRegistry -> AIAdapter`

其他一切都在此基礎上組合：

- `workflows` 是圍繞工具的確定性編排
- `agents` 是對過濾後的註冊表進行的 LLM 循環
- `structured output` 是一種合成工具模式
- `memory` 和 `rag` 是有狀態系統，可以重新包裝成工具

如果你理解工具運行時，框架的其餘部分就會變得清晰易懂。

```text
defineTool() -> registry.register() -> adapter/server executes tool // 定義一個工具，註冊它，然後公開給 AI
                                    -> workflows compose tools      // 工作流程組合工具
                                    -> agents use filtered tools    // 代理使用過濾後的工具
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

首先要構建的是工具，而不是代理。

## 心智模型

工具是你的業務邏輯加上 AI 可以讀取的模式：

```typescript
import { defineTool, ok } from "../framework/index.js";

export const rollDice = defineTool({ // 定義一個工具
  name: "roll_dice", // 工具名稱
  description: "Roll a dice with the given number of sides", // 供 AI 使用的描述
  inputSchema: { // 輸入的模式
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

這一個定義可以：

- 由 `registry.execute()` 直接執行
- 通過 MCP 公開給 Claude/Desktop
- 在互動聊天循環中使用
- 組合到工作流程中
- 過濾到代理專用的註冊表中

閱讀更多：[架構](docs/ARCHITECTURE.md)

## 選擇合適的基元

| 使用此項 | 當你想要 | 它實際上是 |
|----------|---------------|-------------------|
| `defineTool()` | 可由 AI 調用的業務邏輯 | 核心基元 |
| `pipe()` | 確定性編排 | 代碼驅動的工具/LLM 管道 |
| `defineAgent()` | 自適應多步驟工具使用 | 對過濾後的註冊表進行的 LLM 循環 |
| `createConversationMemory()` / `createFactMemory()` | 線程/事實狀態 | 持久化加上記憶工具 |
| `createRAG()` | 語義文檔檢索 | pgvector + 嵌入 + 工具 |
| `createStore()` / `createPgStore()` | 持久化 | 存儲層，而非檢索層 |

經驗法則：

- 從工具開始。
- 當你知道序列時，使用工作流程。
- 僅當模型需要選擇下一步操作時才使用代理。
- 為你控制的狀態添加記憶。
- 為按意義檢索文檔添加 RAG。

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

### 2. 通過 MCP 或聊天公開它

```bash
npm start
npm run chat -- gemini
```

同一個註冊表為兩者提供支持。

### 3. 與工作流程組合

工作流程是默認的「高級」基元，因為控制流保持明確：

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word")) // 定義一個研究管道，第一步：使用工具定義一個詞
  .then(async (result) => result.data?.meanings?.[0] ?? "") // 然後，提取第一個含義
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}")); // 最後，使用 LLM 簡單解釋它

await research.run({ word: "ephemeral" }); // 運行管道
```

### 4. 使用代理添加自適應行為

代理使用相同的工具，但通過過濾後的註冊表和推理循環：

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({ // 定義一個代理
  name: "researcher", // 代理名稱
  role: "Research Analyst", // 代理角色
  goal: "Find accurate information using available tools", // 代理目標
  toolTags: ["search"], // 代理可以使用的工具（按標籤）
});
```

當多個專業代理需要協作時，請使用團隊（crews）。

### 5. 僅在需要時添加狀態

持久化：

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

記憶：

```typescript
const conversations = createConversationMemory(); // 創建對話和事實記憶
const facts = createFactMemory();
registry.registerAll(createMemoryTools(conversations, facts)); // 註冊記憶工具
```

RAG：

```typescript
const rag = await createRAG({ embeddingProvider: "gemini" }); // 使用 Gemini 嵌入創建 RAG
registry.registerAll(rag.createTools()); // 註冊 RAG 工具
```

RAG 文件：[docs/RAG.md](docs/RAG.md)

## 命令

```bash
npm run test-tools          # 互動式 CLI — 在本地測試工具
npm run dev                 # 開發模式 — 保存時自動重啟
npm test                    # 運行工具定義的自動化測試
npm run chat                # 使用你的工具與 AI 聊天
npm run chat -- gemini      # 強制使用特定供應商
npm run create-tool <name>  # 搭建新工具
npm run docs                # 生成工具參考文件
npm run inspect             # MCP 檢查器網頁 UI
npm start                   # 啟動 MCP 服務器以供 Claude Desktop / Cursor 使用
```

## 供應商

在 `.env` 中設置一個 API 密鑰，聊天循環將自動檢測供應商。

| 供應商 | 默認模型 | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | 函數調用 |
| OpenAI | `gpt-5.4` | 回應 API |
| Anthropic | `claude-sonnet-4-6` | 消息 + 工具使用 |
| xAI | `grok-4.20-0309-reasoning` | 回應 API |
| OpenRouter | `google/gemini-3-flash-preview` | 與 OpenAI 兼容 |

範例：

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## 測試

測試與工具定義共存：

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

註冊表在處理程序運行之前驗證參數，因此模式錯誤會清晰地呈現，足以讓人類和 LLM 恢復。

## 範例

| 領域 | 工具 | 模式 |
|--------|-------|---------|
| 學習追蹤器 | `create_task`, `list_tasks`, `complete_task` | CRUD + 存儲 |
| 書籤管理器 | `save_link`, `search_links`, `tag_link` | 數組 + 搜索 |
| 食譜保管器 | `save_recipe`, `search_recipes`, `get_random` | 嵌套數據 + 隨機 |
| 費用分攤器 | `add_expense`, `split_bill`, `get_balances` | 數學 + 計算 |
| 鍛煉記錄器 | `log_workout`, `get_stats`, `suggest_workout` | 日期過濾 + 統計 |
| 詞典 | `define_word`, `find_synonyms` | 外部 API（無需密鑰） |
| 測驗生成器 | `create_quiz`, `answer_question`, `get_score` | 有狀態遊戲 |
| AI 工具 | `summarize_text`, `generate_flashcards` | 工具調用 LLM |
| 實用工具 | `calculate`, `convert_units`, `format_date` | 無狀態助手 |

## 文件

- [架構](docs/ARCHITECTURE.md)：運行時模型、過濾後的註冊表、合成工具和執行路徑
- [RAG](docs/RAG.md)：語義分塊、Gemini/OpenAI 嵌入、pgvector 模式、HNSW 搜索和工具集成

## 項目結構

```text
openFunctions/
├── src/
│   ├── framework/              # 核心運行時 + 組合層
│   ├── examples/               # 參考工具模式
│   ├── my-tools/               # 你的工具
│   └── index.ts                # MCP 入口點
├── docs/                       # 架構文件
├── scripts/                    # 聊天、創建工具、文件
├── test-client/                # CLI 測試器 + 測試運行器
├── system-prompts/             # 提示預設
└── package.json
```

## 許可證

MIT — 請參閱 [LICENSE](LICENSE)
