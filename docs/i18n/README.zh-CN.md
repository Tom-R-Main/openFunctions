[English](../README.md) | [Simplified Chinese](README.zh-CN.md)

<p align="center">
  <img src="assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>优先构建 AI 工具。在需要时再组合智能体。</strong>
</p>

<p align="center">
  <a href="#quick-start">快速开始</a> &middot;
  <a href="#the-mental-model">心智模型</a> &middot;
  <a href="#choose-the-right-primitive">选择合适的原语</a> &middot;
  <a href="#capability-ladder">能力阶梯</a> &middot;
  <a href="#providers">提供商</a> &middot;
  <a href="#examples">示例</a> &middot;
  <a href="#docs">文档</a>
</p>

---

openFunctions 是一个采用 MIT 许可的 TypeScript 框架，用于构建可供 AI 调用的工具，并通过 [MCP](https://modelcontextprotocol.io)、聊天适配器、工作流和智能体来暴露这些工具。其核心运行时非常简单：

`ToolDefinition -> ToolRegistry -> AIAdapter`

所有其他功能都在此基础上进行组合：

- `workflows` 是围绕工具的确定性编排
- `agents` 是在过滤后的注册表上运行的 LLM 循环
- `structured output` 是一种合成工具模式
- `memory` 和 `rag` 是有状态系统，可以重新封装成工具

如果你理解了工具运行时，框架的其余部分也将易于理解。

```text
defineTool() -> registry.register() -> adapter/server executes tool
                                    -> workflows compose tools
                                    -> agents use filtered tools
                                    -> memory/rag expose more tools
```

## 快速开始

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

首先要构建的是工具，而不是智能体。

## 心智模型

工具是你的业务逻辑加上 AI 可读的 schema：

```typescript
import { defineTool, ok } from "../framework/index.js";

export const rollDice = defineTool({
  name: "roll_dice",
  description: "Roll a dice with the given number of sides", // 掷一个具有给定面数的骰子
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "number", description: "Number of sides (default 6)" }, // 面数（默认为 6）
    },
  },
  handler: async ({ sides }) => {
    const rolled = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled });
  },
});
```

这一个定义可以用于：

- 由 `registry.execute()` 直接执行
- 通过 MCP 暴露给 Claude/Desktop
- 在交互式聊天循环中使用
- 组合到工作流中
- 过滤到智能体特定的注册表

阅读更多：[架构](docs/ARCHITECTURE.md)

## 选择合适的原语

| 使用此项 | 当你需要 | 它的本质是 |
|----------|---------------|-------------------|
| `defineTool()` | 可供 AI 调用的业务逻辑 | 核心原语 |
| `pipe()` | 确定性编排 | 代码驱动的工具/LLM 管道 |
| `defineAgent()` | 自适应多步工具使用 | 在过滤后的注册表上运行的 LLM 循环 |
| `createConversationMemory()` / `createFactMemory()` | 线程/事实状态 | 持久化加内存工具 |
| `createRAG()` | 语义文档检索 | pgvector + 嵌入 + 工具 |
| `createStore()` / `createPgStore()` | 持久化 | 存储层，而非检索层 |

经验法则：

- 从工具开始。
- 当你知道序列时，使用工作流。
- 仅当模型需要选择下一步做什么时，才使用智能体。
- 为你控制的状态添加内存。
- 为按含义检索文档添加 RAG。

## 能力阶梯

### 1. 构建工具

```bash
npm run create-tool expense_tracker
```

编辑 `src/my-tools/expense_tracker.ts`，然后运行：

```bash
npm run test-tools
npm test
```

### 2. 通过 MCP 或聊天暴露工具

```bash
npm start
npm run chat -- gemini
```

同一个注册表为两者提供支持。

### 3. 与工作流组合

工作流是默认的“高级”原语，因为其控制流保持显式：

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}")); // 简单解释一下：{{input}}

await research.run({ word: "ephemeral" });
```

### 4. 添加智能体的自适应行为

智能体使用相同的工具，但通过过滤后的注册表和推理循环：

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst", // 研究分析师
  goal: "Find accurate information using available tools", // 使用可用工具查找准确信息
  toolTags: ["search"],
});
```

当多个专业智能体需要协作时，使用“团队”（crews）。

### 5. 仅在需要时添加状态

持久化：

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

内存：

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

RAG 文档：[docs/RAG.md](docs/RAG.md)

## 命令

```bash
npm run test-tools          # 交互式 CLI — 在本地测试工具
npm run dev                 # 开发模式 — 保存时自动重启
npm test                    # 运行工具定义的自动化测试
npm run chat                # 使用你的工具与 AI 聊天
npm run chat -- gemini      # 强制使用特定提供商
npm run create-tool <name>  # 脚手架生成新工具
npm run docs                # 生成工具参考文档
npm run inspect             # MCP 检查器 Web UI
npm start                   # 启动 MCP 服务器，用于 Claude Desktop / Cursor
```

## 提供商

在 `.env` 中设置一个 API 密钥，聊天循环将自动检测提供商。

| 提供商 | 默认模型 | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | Function calling |
| OpenAI | `gpt-5.4` | Responses API |
| Anthropic | `claude-sonnet-4-6` | Messages + tool_use |
| xAI | `grok-4.20-0309-reasoning` | Responses API |
| OpenRouter | `google/gemini-3-flash-preview` | OpenAI-compatible |

示例：

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## 测试

测试与工具定义共存：

```typescript
defineTool({
  name: "create_task",
  // ...
  tests: [
    { name: "creates a task", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } }, // 创建一个任务
    { name: "fails without subject", input: { title: "Read ch5" }, expect: { success: false } }, // 没有主题时失败
  ],
});
```

注册表在处理程序运行之前验证参数，因此 schema 错误会清晰地显示出来，足以让人类和 LLM 都能恢复。

## 示例

| 领域 | 工具 | 模式 |
|--------|-------|---------|
| 学习追踪器 | `create_task`, `list_tasks`, `complete_task` | CRUD + 存储 |
| 书签管理器 | `save_link`, `search_links`, `tag_link` | 数组 + 搜索 |
| 食谱管理器 | `save_recipe`, `search_recipes`, `get_random` | 嵌套数据 + 随机 |
| 费用分摊器 | `add_expense`, `split_bill`, `get_balances` | 数学 + 计算 |
| 锻炼记录器 | `log_workout`, `get_stats`, `suggest_workout` | 日期过滤 + 统计 |
| 词典 | `define_word`, `find_synonyms` | 外部 API (无需密钥) |
| 测验生成器 | `create_quiz`, `answer_question`, `get_score` | 有状态游戏 |
| AI 工具 | `summarize_text`, `generate_flashcards` | 工具调用 LLM |
| 实用工具 | `calculate`, `convert_units`, `format_date` | 无状态辅助工具 |

## 文档

- [架构](docs/ARCHITECTURE.md)：运行时模型、过滤后的注册表、合成工具和执行路径
- [RAG](docs/RAG.md)：语义分块、Gemini/OpenAI 嵌入、pgvector schema、HNSW 搜索和工具集成

## 项目结构

```text
openFunctions/
├── src/
│   ├── framework/              # 核心运行时 + 组合层
│   ├── examples/               # 参考工具模式
│   ├── my-tools/               # 你的工具
│   └── index.ts                # MCP 入口点
├── docs/                       # 架构文档
├── scripts/                    # 聊天、创建工具、文档
├── test-client/                # CLI 测试器 + 测试运行器
├── system-prompts/             # 提示预设
└── package.json
```

## 许可证

MIT — 参见 [LICENSE](LICENSE)
