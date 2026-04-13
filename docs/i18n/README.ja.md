[English](../../README.md) | [日本語](README.ja.md)

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

openFunctionsは、AIから呼び出し可能なツールを構築し、それらを[MCP](https://modelcontextprotocol.io)、チャットアダプター、ワークフロー、およびエージェントを通じて公開するための、MITライセンスのTypeScriptフレームワークです。そのコアランタイムはシンプルです：

`ToolDefinition -> ToolRegistry -> AIAdapter`

その他すべては、その上に構成されます：

- `workflows`はツールを中心とした決定論的なオーケストレーションです
- `agents`はフィルタリングされたレジストリを介したLLMループです
- `structured output`は合成ツールパターンです
- `memory`と`rag`は、ツールとして再ラップできるステートフルなシステムです

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

ツールとは、AIが読み取れるスキーマとビジネスロジックを組み合わせたものです：

```typescript
import { defineTool, ok } from "../framework/index.js";

export const rollDice = defineTool({
  name: "roll_dice",
  description: "Roll a dice with the given number of sides", // 指定された面数のサイコロを振る
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "number", description: "Number of sides (default 6)" }, // 面数（デフォルト6）
    },
  },
  handler: async ({ sides }) => {
    const rolled = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled });
  },
});
```

この単一の定義は、次の目的で使用できます：

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
| `createChatAgent()` | 構成可能で埋め込み可能なAIエージェント | ツール + メモリー + コンテキスト + アダプターを1つの設定にまとめたもの |
| `pipe()` | 決定論的なオーケストレーション | コード駆動のツール/LLMパイプライン |
| `defineAgent()` | 適応的な多段階ツール使用 | フィルタリングされたレジストリを介したLLMループ |
| `createConversationMemory()` / `createFactMemory()` | スレッド/ファクトの状態 | 永続化とメモリーツール |
| `createRAG()` | 意味的なドキュメント検索 | pgvector + 埋め込み + ツール |
| `connectProvider()` | 外部システムコンテキスト | ExecuFunction、Obsidianなどからの構造化ツール |
| `createStore()` / `createPgStore()` | 永続化 | ストレージ層であり、検索ではない |

一般的なルール：

- まずツールから始めます。
- メモリーとコンテキストを持つ完全なエージェントが必要な場合は`createChatAgent()`を使用します。
- シーケンスが分かっている場合はワークフローを使用します。
- クルー内で専門エージェントが必要な場合は`defineAgent()`を使用します。
- 制御する状態のためにメモリーを追加します。
- 意味によるドキュメント検索のためにRAGを追加します。
- 外部システム（タスク、カレンダー、CRM）が必要な場合はコンテキストプロバイダーを追加します。

## 機能ラダー

### 1. ツールを構築する

```bash
npm run create-tool expense_tracker
```

`src/my-tools/expense_tracker.ts`を編集し、次に以下を実行します：

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

ワークフローは、制御フローが明示的であるため、デフォルトの「高度な」プリミティブです：

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}")); // これを簡単に説明して：{{input}}

await research.run({ word: "ephemeral" });
```

### 4. チャットエージェントを構築する

`createChatAgent()`は、ツール、メモリー、コンテキストプロバイダー、AIアダプターを単一の埋め込み可能なエージェントに構成します：

```typescript
import { createChatAgent } from "./framework/index.js";

const agent = await createChatAgent({
  provider: "gemini",
  preset: "study-buddy",
  memory: true,                    // 会話 + ファクトメモリー（デフォルトでオン）
  providers: ["execufunction"],    // 外部コンテキストに接続
});

// 4つの方法で使用:
await agent.interactive();                          // CLI
const result = await agent.chat("Create a task");   // プログラマティック
for await (const chunk of agent.chat("hello", { stream: true })) { ... }  // ストリーミング
await agent.serve({ port: 3000 });                  // HTTPサーバー
```

同じ設定がコード、CLIフラグ、またはYAMLファイルから機能します。メモリーはデフォルトでオンです — エージェントはセッション間で記憶を保持します。

### 5. エージェントで適応的な動作を追加する

`defineAgent()`は、クルーやワークフロー内の専門エージェント向けです — フィルタリングされたレジストリと推論ループ：

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst", // リサーチアナリスト
  goal: "Find accurate information using available tools", // 利用可能なツールを使用して正確な情報を見つける
  toolTags: ["search"],
});
```

複数の専門エージェントが協力する必要がある場合は、クルーを使用します。

### 6. 必要な場合にのみ状態を追加する

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

### 7. 外部コンテキストに接続する

コンテキストプロバイダーは、外部システム（タスクマネージャー、カレンダー、CRM、ナレッジベース）をツールとしてエージェントランタイムに取り込みます：

```typescript
import { connectProvider, contextPrompt } from "./framework/index.js";
import { createExecuFunctionProvider } from "./providers/execufunction/index.js";

// 接続 — "context" + "context:execufunction" タグ付きの17ツールを登録
const exf = await connectProvider(
  createExecuFunctionProvider({ token: process.env.EXF_PAT }),
  registry,
);

// アクティブなタスク + 今後のイベントをエージェントのシステムプロンプトに注入
const context = await contextPrompt([exf]);
```

`ContextProvider`インターフェースはプラガブルです — `metadata`、`connect()`、`createTools()`を実装することで、任意のバックエンドをフレームワークに統合できます。完全なインターフェースについては[アーキテクチャ](docs/ARCHITECTURE.md#context-providers)を参照してください。

| プロバイダー | 状態 | 機能 |
|----------|--------|--------------|
| [ExecuFunction](src/providers/execufunction/) | 組み込み | タスク、プロジェクト、カレンダー、ナレッジ、人物、組織、コードベース |
| Obsidian | テンプレート（計画中） | ナレッジ |
| Notion | テンプレート（計画中） | ナレッジ、タスク、プロジェクト |

## コマンド

```bash
npm run test-tools          # 対話型CLI — ツールをローカルでテスト
npm run dev                 # 開発モード — 保存時に自動再起動
npm test                    # ツール定義の自動テストを実行
npm run chat                # ツールを使用してAIとチャット
npm run chat -- gemini      # 特定のプロバイダーを強制
npm run chat -- --no-memory # 永続メモリーなしでチャット
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

テストはツール定義と共に存在します：

```typescript
defineTool({
  name: "create_task",
  // ...
  tests: [
    { name: "creates a task", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } }, // タスクを作成する
    { name: "fails without subject", input: { title: "Read ch5" }, expect: { success: false } }, // サブジェクトなしで失敗する
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

## プラグイン

### ExecuFunction for OpenClaw

[`@openfunctions/openclaw-execufunction`](plugins/openclaw-execufunction/)プラグインは、[ExecuFunction](https://execufunction.com)を[OpenClaw](https://github.com/openclaw/openclaw)エージェントエコシステムに統合します — 6ドメインにわたる17ツール：

| ドメイン | ツール | 機能 |
|--------|-------|--------------|
| タスク | `exf_tasks_list`, `exf_tasks_create`, `exf_tasks_update`, `exf_tasks_complete` | 優先度付きの構造化タスク管理 (do_now/do_next/do_later/delegate/drop) |
| カレンダー | `exf_calendar_list`, `exf_calendar_create`, `exf_calendar_update` | イベントのスケジューリングと検索 |
| ナレッジ | `exf_notes_search`, `exf_notes_create`, `exf_notes_get` | ナレッジベース全体のセマンティック検索 |
| プロジェクト | `exf_projects_list`, `exf_projects_context` | プロジェクトのステータスと完全なコンテキスト（タスク、ノート、シグナル） |
| 人物/CRM | `exf_people_search`, `exf_person_create`, `exf_org_search` | 連絡先と組織の管理 |
| コードベース | `exf_codebase_search`, `exf_code_who_knows` | セマンティックコード検索と専門知識の追跡 |

インストール:

```bash
openclaw plugins install @openfunctions/openclaw-execufunction
```

環境に`EXF_PAT`を設定（またはOpenClawプラグイン設定で構成）すると、OpenClawエージェントにExecuFunctionのクラウドAPIを基盤とした永続タスク、カレンダー認識、セマンティックナレッジ検索、CRM、コードインテリジェンスが追加されます。

詳細は[プラグインREADME](plugins/openclaw-execufunction/)を参照してください。

## プロジェクト構造

```text
openFunctions/
├── src/
│   ├── framework/              # コアランタイム + 構成レイヤー
│   │   ├── chat-agent.ts       # createChatAgent() — 構成可能なチャットエージェントファクトリー
│   │   ├── chat-agent-types.ts # ChatAgent, ChatAgentConfig, ChatResult 型
│   │   ├── chat-agent-resolve.ts # 設定解決、プロバイダー自動検出
│   │   ├── chat-agent-http.ts  # agent.serve() 用HTTPサーバー
│   │   ├── context.ts          # コンテキストプロバイダーインターフェース
│   │   └── ...                 # ツール、レジストリ、エージェント、メモリー、RAG、ワークフロー
│   ├── providers/
│   │   └── execufunction/      # ExecuFunctionコンテキストプロバイダー（リファレンス実装）
│   ├── examples/               # リファレンスツールパターン
│   ├── my-tools/               # あなたのツール
│   └── index.ts                # MCPエントリーポイント
├── plugins/
│   └── openclaw-execufunction/ # OpenClaw用ExecuFunctionプラグイン
├── docs/                       # アーキテクチャドキュメント
├── scripts/                    # チャット、ツール作成、ドキュメント
├── test-client/                # CLIテスター + テストランナー
├── system-prompts/             # プロンプトプリセット
└── package.json
```

## ライセンス

MIT — [LICENSE](LICENSE)を参照
