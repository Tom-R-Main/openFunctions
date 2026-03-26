[English](../README.md) | [Japanese](README.ja.md)

<p align="center">
  <img src="../../assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>まずAIツールを構築します。必要に応じてエージェントを構成します。</strong>
</p>

<p align="center">
  <a href="#quick-start">クイックスタート</a> &middot;
  <a href="#the-mental-model">メンタルモデル</a> &middot;
  <a href="#choose-the-right-primitive">適切なプリミティブを選択する</a> &middot;
  <a href="#capability-ladder">機能ラダー</a> &middot;
  <a href="#providers">プロバイダー</a> &middot;
  <a href="#examples">例</a> &middot;
  <a href="#docs">ドキュメント</a>
</p>

---

openFunctionsは、AIから呼び出し可能なツールを構築し、それらを[MCP](https://modelcontextprotocol.io)、チャットアダプター、ワークフロー、およびエージェントを通じて公開するための、MITライセンスのTypeScriptフレームワークです。そのコアランタイムはシンプルです。

`ToolDefinition -> ToolRegistry -> AIAdapter`

その他すべては、その上に構成されます。

- `workflows`はツールを中心とした決定論的なオーケストレーションです。
- `agents`はフィルタリングされたレジストリを介したLLMループです。
- `structured output`は合成ツールパターンです。
- `memory`と`rag`は、ツールとして再ラップできるステートフルなシステムです。

ツールランタイムを理解すれば、フレームワークの残りの部分も理解しやすくなります。

```text
defineTool() -> registry.register() -> adapter/server executes tool
                                    -> workflows compose tools
                                    -> agents use filtered tools
                                    -> memory/rag expose more tools
```

## クイックスタート

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

最初に構築すべきはツールであり、エージェントではありません。

## メンタルモデル

ツールとは、AIが読み取れるスキーマとビジネスロジックを組み合わせたものです。

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

この単一の定義は、次の目的で使用できます。

- `registry.execute()`によって直接実行される
- MCPを介してClaude/Desktopに公開される
- 対話型チャットループ内で使用される
- ワークフローに構成される
- エージェント固有のレジストリにフィルタリングされる

詳細はこちら: [アーキテクチャ](docs/ARCHITECTURE.md)

## 適切なプリミティブを選択する

| これを使用する | 目的 | 実体 |
|----------|---------------|-------------------|
| `defineTool()` | AIから呼び出し可能なビジネスロジック | コアプリミティブ |
| `pipe()` | 決定論的なオーケストレーション | コード駆動のツール/LLMパイプライン |
| `defineAgent()` | 適応的な多段階ツール使用 | フィルタリングされたレジストリを介したLLMループ |
| `createConversationMemory()` / `createFactMemory()` | スレッド/ファクトの状態 | 永続化とメモリーツール |
| `createRAG()` | 意味的なドキュメント検索 | pgvector + 埋め込み + ツール |
| `createStore()` / `createPgStore()` | 永続化 | ストレージ層であり、検索ではない |

一般的なルール:

- まずツールから始めます。
- シーケンスが分かっている場合はワークフローを使用します。
- モデルが次に何をすべきかを選択する必要がある場合にのみエージェントを使用します。
- 制御する状態のためにメモリーを追加します。
- 意味によるドキュメント検索のためにRAGを追加します。

## 機能ラダー

### 1. ツールを構築する

```bash
npm run create-tool expense_tracker
```

`src/my-tools/expense_tracker.ts`を編集し、次に以下を実行します。

```bash
npm run test-tools
npm test
```

### 2. MCPまたはチャットを通じて公開する

```bash
npm start
npm run chat -- gemini
```

同じレジストリが両方を動かします。

### 3. ワークフローで構成する

ワークフローは、制御フローが明示的であるため、デフォルトの「高度な」プリミティブです。

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}"));

await research.run({ word: "ephemeral" });
```

### 4. エージェントで適応的な動作を追加する

エージェントは同じツールを使用しますが、フィルタリングされたレジストリと推論ループを介して使用します。

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst",
  goal: "Find accurate information using available tools",
  toolTags: ["search"],
});
```

複数の専門エージェントが協力する必要がある場合は、クルーを使用します。

### 5. 必要な場合にのみ状態を追加する

永続化:

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

メモリー:

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

RAGドキュメント: [docs/RAG.md](docs/RAG.md)

## コマンド

```bash
npm run test-tools          # 対話型CLI — ツールをローカルでテスト
npm run dev                 # 開発モード — 保存時に自動再起動
npm test                    # ツール定義の自動テストを実行
npm run chat                # ツールを使用してAIとチャット
npm run chat -- gemini      # 特定のプロバイダーを強制
npm run create-tool <name>  # 新しいツールをスキャフォールド
npm run docs                # ツールリファレンスドキュメントを生成
npm run inspect             # MCPインスペクターWeb UI
npm start                   # Claude Desktop / Cursor 用のMCPサーバーを起動
```

## プロバイダー

`.env`にAPIキーを1つ設定すると、チャットループがプロバイダーを自動検出します。

| プロバイダー | デフォルトモデル | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | Function calling |
| OpenAI | `gpt-5.4` | Responses API |
| Anthropic | `claude-sonnet-4-6` | Messages + tool_use |
| xAI | `grok-4.20-0309-reasoning` | Responses API |
| OpenRouter | `google/gemini-3-flash-preview` | OpenAI-compatible |

例:

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## テスト

テストはツール定義と共に存在します。

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

レジストリはハンドラーが実行される前にパラメーターを検証するため、スキーマエラーは人間とLLMの両方が回復できるほど明確に表示されます。

## 例

| ドメイン | ツール | パターン |
|--------|-------|---------|
| Study Tracker | `create_task`, `list_tasks`, `complete_task` | CRUD + ストア |
| Bookmark Manager | `save_link`, `search_links`, `tag_link` | 配列 + 検索 |
| Recipe Keeper | `save_recipe`, `search_recipes`, `get_random` | ネストされたデータ + ランダム |
| Expense Splitter | `add_expense`, `split_bill`, `get_balances` | 数学 + 計算 |
| Workout Logger | `log_workout`, `get_stats`, `suggest_workout` | 日付フィルタリング + 統計 |
| Dictionary | `define_word`, `find_synonyms` | 外部API (キー不要) |
| Quiz Generator | `create_quiz`, `answer_question`, `get_score` | ステートフルゲーム |
| AI Tools | `summarize_text`, `generate_flashcards` | ツールがLLMを呼び出す |
| Utilities | `calculate`, `convert_units`, `format_date` | ステートレスヘルパー |

## ドキュメント

- [アーキテクチャ](docs/ARCHITECTURE.md): ランタイムモデル、フィルタリングされたレジストリ、合成ツール、および実行パス
- [RAG](docs/RAG.md): 意味的チャンキング、Gemini/OpenAI埋め込み、pgvectorスキーマ、HNSW検索、およびツール統合

## プロジェクト構造

```text
openFunctions/
├── src/
│   ├── framework/              # Core runtime + composition layers
│   ├── examples/               # Reference tool patterns
│   ├── my-tools/               # Your tools
│   └── index.ts                # MCP entrypoint
├── docs/                       # Architecture docs
├── scripts/                    # chat, create-tool, docs
├── test-client/                # CLI tester + test runner
├── system-prompts/             # Prompt presets
└── package.json
```

## ライセンス

MIT — [LICENSE](LICENSE)を参照
