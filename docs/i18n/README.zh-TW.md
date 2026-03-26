[English](../README.md) | [Traditional Chinese](README.zh-TW.md)

<p align="center">
  <img src="../../assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>優先建構 AI 工具。在需要時組合代理程式。</strong>
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

openFunctions 是一個採用 MIT 授權的 TypeScript 框架，用於建構可供 AI 呼叫的工具，並透過 [MCP](https://modelcontextprotocol.io)、聊天轉接器、工作流程和代理程式來公開這些工具。其核心執行時非常簡單：

`ToolDefinition -> ToolRegistry -> AIAdapter`

所有其他功能都以此為基礎進行組合：

- `workflows` 是圍繞工具的確定性編排
- `agents` 是對經過篩選的註冊表進行的 LLM 迴圈
- `structured output` 是一種合成工具模式
- `memory` 和 `rag` 是可重新包裝成工具的狀態系統

如果您理解工具執行時，框架的其餘部分將保持清晰易懂。

```text
defineTool() -> registry.register() -> adapter/server executes tool
                                    -> workflows compose tools
                                    -> agents use filtered tools
                                    -> memory/rag expose more tools
```

## 快速開始

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

首先要建構的是工具，而不是代理程式。

## 心智模型

工具是您的業務邏輯加上 AI 可讀取的綱要：

```typescript
import { defineTool, ok } from "../framework/index.js";

export const rollDice = defineTool({
  name: "roll_dice",
  description: "Roll a dice with the given number of sides", // 擲一個具有指定面數的骰子
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "number", description: "Number of sides (default 6)" }, // 面數（預設為 6）
    },
  },
  handler: async ({ sides }) => {
    const rolled = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled });
  },
});
```

該定義可以：

- 由 `registry.execute()` 直接執行
- 透過 MCP 公開給 Claude/Desktop
- 在互動式聊天迴圈中使用
- 組合到工作流程中
- 篩選到代理程式專屬的註冊表中

閱讀更多：[架構](docs/ARCHITECTURE.md)

## 選擇合適的基元

| 使用此項 | 當您想要 | 它實際上是 |
|----------|---------------|-------------------|
| `defineTool()` | 可呼叫的 AI 導向業務邏輯 | 核心基元 |
| `pipe()` | 確定性編排 | 程式碼驅動的工具/LLM 管道 |
| `defineAgent()` | 自適應多步驟工具使用 | 對經過篩選的註冊表進行的 LLM 迴圈 |
| `createConversationMemory()` / `createFactMemory()` | 執行緒/事實狀態 | 持久性加上記憶工具 |
| `createRAG()` | 語義文件檢索 | pgvector + 嵌入 + 工具 |
| `createStore()` / `createPgStore()` | 持久性 | 儲存層，而非檢索層 |

經驗法則：

- 從工具開始。
- 當您知道序列時，使用工作流程。
- 僅當模型需要選擇下一步操作時，才使用代理程式。
- 為您控制的狀態添加記憶。
- 為按意義檢索文件添加 RAG。

## 能力階梯

### 1. 建構工具

```bash
npm run create-tool expense_tracker
```

編輯 `src/my-tools/expense_tracker.ts`，然後執行：

```bash
npm run test-tools
npm test
```

### 2. 透過 MCP 或聊天公開

```bash
npm start
npm run chat -- gemini
```

相同的註冊表為兩者提供支援。

### 3. 與工作流程組合

工作流程是預設的「進階」基元，因為控制流保持明確：

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}")); // 簡單解釋一下這個：{{input}}

await research.run({ word: "ephemeral" });
```

### 4. 添加代理程式的自適應行為

代理程式使用相同的工具，但透過經過篩選的註冊表和推理迴圈：

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst", // 研究分析師
  goal: "Find accurate information using available tools", // 使用可用工具尋找準確資訊
  toolTags: ["search"],
});
```

當多個專業代理程式需要協作時，使用團隊 (crews)。

### 5. 僅在需要時添加狀態

持久性：

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

記憶：

```typescript
const conversations = createConversationMemory();
const facts = createFactMemory();
registry.registerAll(createMemoryTools(conversations, facts));
```

RAG：

```typescript
const rag = await createRAG({ embeddingProvider: "gemini" });
registry.registerAll(rag.createTools());
```

RAG 文件：[docs/RAG.md](docs/RAG.md)

## 命令

```bash
npm run test-tools          # 互動式 CLI — 在本地測試工具
npm run dev                 # 開發模式 — 儲存時自動重啟
npm test                    # 執行工具定義的自動化測試
npm run chat                # 使用您的工具與 AI 聊天
npm run chat -- gemini      # 強制使用特定供應商
npm run create-tool <name>  # 建立新工具的骨架
npm run docs                # 生成工具參考文件
npm run inspect             # MCP 檢查器網頁使用者介面
npm start                   # 啟動 MCP 伺服器以供 Claude Desktop / Cursor 使用
```

## 供應商

在 `.env` 中設定一個 API 金鑰，聊天迴圈將自動偵測供應商。

| 供應商 | 預設模型 | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | 函數呼叫 |
| OpenAI | `gpt-5.4` | 回應 API |
| Anthropic | `claude-sonnet-4-6` | 訊息 + 工具使用 |
| xAI | `grok-4.20-0309-reasoning` | 回應 API |
| OpenRouter | `google/gemini-3-flash-preview` | 與 OpenAI 相容 |

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
defineTool({
  name: "create_task",
  // ...
  tests: [
    { name: "creates a task", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } }, // 建立一個任務
    { name: "fails without subject", input: { title: "Read ch5" }, expect: { success: false } }, // 沒有主題時失敗
  ],
});
```

註冊表在處理器執行前驗證參數，因此綱要錯誤會清晰地呈現，足以讓人類和 LLM 都能恢復。

## 範例

| 領域 | 工具 | 模式 |
|--------|-------|---------|
| 學習追蹤器 | `create_task`, `list_tasks`, `complete_task` | CRUD + 儲存 |
| 書籤管理器 | `save_link`, `search_links`, `tag_link` | 陣列 + 搜尋 |
| 食譜管理器 | `save_recipe`, `search_recipes`, `get_random` | 巢狀資料 + 隨機 |
| 費用分攤器 | `add_expense`, `split_bill`, `get_balances` | 數學 + 計算 |
| 運動記錄器 | `log_workout`, `get_stats`, `suggest_workout` | 日期篩選 + 統計 |
| 字典 | `define_word`, `find_synonyms` | 外部 API (無需金鑰) |
| 測驗生成器 | `create_quiz`, `answer_question`, `get_score` | 有狀態遊戲 |
| AI 工具 | `summarize_text`, `generate_flashcards` | 工具呼叫 LLM |
| 公用程式 | `calculate`, `convert_units`, `format_date` | 無狀態輔助工具 |

## 文件

- [架構](docs/ARCHITECTURE.md)：執行時模型、篩選後的註冊表、合成工具和執行路徑
- [RAG](docs/RAG.md)：語義分塊、Gemini/OpenAI 嵌入、pgvector 綱要、HNSW 搜尋和工具整合

## 專案結構

```text
openFunctions/
├── src/
│   ├── framework/              # 核心執行時 + 組合層
│   ├── examples/               # 參考工具模式
│   ├── my-tools/               # 您的工具
│   └── index.ts                # MCP 入口點
├── docs/                       # 架構文件
├── scripts/                    # 聊天、建立工具、文件
├── test-client/                # CLI 測試器 + 測試執行器
├── system-prompts/             # 提示預設集
└── package.json
```

## 授權

MIT — 請參閱 [LICENSE](LICENSE)
