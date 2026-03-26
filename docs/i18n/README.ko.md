[English](../README.md) | [Korean](README.ko.md)

<p align="center">
  <img src="../../assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>AI 도구를 먼저 구축하세요. 필요할 때 에이전트를 구성하세요.</strong>
</p>

<p align="center">
  <a href="#quick-start">빠른 시작</a> &middot;
  <a href="#the-mental-model">멘탈 모델</a> &middot;
  <a href="#choose-the-right-primitive">적절한 기본 요소 선택</a> &middot;
  <a href="#capability-ladder">기능 사다리</a> &middot;
  <a href="#providers">제공자</a> &middot;
  <a href="#examples">예시</a> &middot;
  <a href="#docs">문서</a>
</p>

---

openFunctions는 AI 호출 가능 도구를 구축하고 이를 [MCP](https://modelcontextprotocol.io), 채팅 어댑터, 워크플로 및 에이전트를 통해 노출하기 위한 MIT 라이선스 TypeScript 프레임워크입니다. 핵심 런타임은 간단합니다:

`ToolDefinition -> ToolRegistry -> AIAdapter`

그 외의 모든 것은 그 위에 구성됩니다:

- `workflows`는 도구를 중심으로 한 결정론적 오케스트레이션입니다.
- `agents`는 필터링된 레지스트리를 통한 LLM 루프입니다.
- `structured output`은 합성 도구 패턴입니다.
- `memory`와 `rag`는 도구로 다시 래핑될 수 있는 상태 저장 시스템입니다.

도구 런타임을 이해하면 프레임워크의 나머지 부분도 쉽게 이해할 수 있습니다.

```text
defineTool() -> registry.register() -> adapter/server executes tool
                                    -> workflows compose tools
                                    -> agents use filtered tools
                                    -> memory/rag expose more tools
```

## 빠른 시작

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

가장 먼저 구축해야 할 것은 에이전트가 아닌 도구입니다.

## 멘탈 모델

도구는 AI가 읽을 수 있는 스키마와 비즈니스 로직을 결합한 것입니다:

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

이 하나의 정의는 다음 용도로 사용될 수 있습니다:

- `registry.execute()`에 의해 직접 실행
- MCP를 통해 Claude/Desktop에 노출
- 대화형 채팅 루프 내에서 사용
- 워크플로로 구성
- 에이전트별 레지스트리로 필터링

더 읽어보기: [아키텍처](docs/ARCHITECTURE.md)

## 적절한 기본 요소 선택

| 이것을 사용하세요 | 원할 때 | 실제로는 무엇인가요 |
|----------|---------------|-------------------|
| `defineTool()` | 호출 가능한 AI 대면 비즈니스 로직 | 핵심 기본 요소 |
| `pipe()` | 결정론적 오케스트레이션 | 코드 기반 도구/LLM 파이프라인 |
| `defineAgent()` | 적응형 다단계 도구 사용 | 필터링된 레지스트리를 통한 LLM 루프 |
| `createConversationMemory()` / `createFactMemory()` | 스레드/팩트 상태 | 지속성 및 메모리 도구 |
| `createRAG()` | 의미론적 문서 검색 | pgvector + 임베딩 + 도구 |
| `createStore()` / `createPgStore()` | 지속성 | 저장 계층, 검색 아님 |

경험 법칙:

- 도구로 시작하세요.
- 순서를 알고 있을 때는 워크플로를 사용하세요.
- 모델이 다음에 무엇을 할지 선택해야 할 때만 에이전트를 사용하세요.
- 제어하는 상태를 위해 메모리를 추가하세요.
- 의미에 따른 문서 검색을 위해 RAG를 추가하세요.

## 기능 사다리

### 1. 도구 구축

```bash
npm run create-tool expense_tracker
```

`src/my-tools/expense_tracker.ts`를 편집한 다음 다음을 실행하세요:

```bash
npm run test-tools
npm test
```

### 2. MCP 또는 채팅을 통해 노출

```bash
npm start
npm run chat -- gemini
```

동일한 레지스트리가 둘 다를 지원합니다.

### 3. 워크플로로 구성

워크플로는 제어 흐름이 명시적으로 유지되므로 기본 "고급" 기본 요소입니다:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}"));

await research.run({ word: "ephemeral" });
```

### 4. 에이전트로 적응형 동작 추가

에이전트는 동일한 도구를 사용하지만, 필터링된 레지스트리와 추론 루프를 통해 사용합니다:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst",
  goal: "Find accurate information using available tools",
  toolTags: ["search"],
});
```

여러 전문 에이전트가 협업해야 할 때는 크루를 사용하세요.

### 5. 필요할 때만 상태 추가

지속성:

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

메모리:

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

RAG 문서: [docs/RAG.md](docs/RAG.md)

## 명령어

```bash
npm run test-tools          # 대화형 CLI — 도구를 로컬에서 테스트합니다.
npm run dev                 # 개발 모드 — 저장 시 자동 재시작됩니다.
npm test                    # 도구 정의 자동화 테스트를 실행합니다.
npm run chat                # 도구를 사용하여 AI와 채팅합니다.
npm run chat -- gemini      # 특정 제공자를 강제합니다.
npm run create-tool <name>  # 새 도구의 스캐폴드를 생성합니다.
npm run docs                # 도구 참조 문서를 생성합니다.
npm run inspect             # MCP Inspector 웹 UI
npm start                   # Claude Desktop / Cursor용 MCP 서버를 시작합니다.
```

## 제공자

`.env`에 하나의 API 키를 설정하면 채팅 루프가 제공자를 자동으로 감지합니다.

| 제공자 | 기본 모델 | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | Function calling |
| OpenAI | `gpt-5.4` | Responses API |
| Anthropic | `claude-sonnet-4-6` | Messages + tool_use |
| xAI | `grok-4.20-0309-reasoning` | Responses API |
| OpenRouter | `google/gemini-3-flash-preview` | OpenAI-compatible |

예시:

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## 테스트

테스트는 도구 정의와 함께 존재합니다:

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

레지스트리는 핸들러가 실행되기 전에 매개변수를 검증하므로, 스키마 오류는 사람과 LLM 모두가 복구할 수 있을 만큼 명확하게 드러납니다.

## 예시

| 도메인 | 도구 | 패턴 |
|--------|-------|---------|
| 학습 추적기 | `create_task`, `list_tasks`, `complete_task` | CRUD + 저장소 |
| 북마크 관리자 | `save_link`, `search_links`, `tag_link` | 배열 + 검색 |
| 레시피 보관함 | `save_recipe`, `search_recipes`, `get_random` | 중첩 데이터 + 무작위 |
| 지출 분할기 | `add_expense`, `split_bill`, `get_balances` | 수학 + 계산 |
| 운동 기록기 | `log_workout`, `get_stats`, `suggest_workout` | 날짜 필터링 + 통계 |
| 사전 | `define_word`, `find_synonyms` | 외부 API (키 없음) |
| 퀴즈 생성기 | `create_quiz`, `answer_question`, `get_score` | 상태 저장 게임 |
| AI 도구 | `summarize_text`, `generate_flashcards` | LLM을 호출하는 도구 |
| 유틸리티 | `calculate`, `convert_units`, `format_date` | 상태 비저장 헬퍼 |

## 문서

- [아키텍처](docs/ARCHITECTURE.md): 런타임 모델, 필터링된 레지스트리, 합성 도구 및 실행 경로
- [RAG](docs/RAG.md): 의미론적 청킹, Gemini/OpenAI 임베딩, pgvector 스키마, HNSW 검색 및 도구 통합

## 프로젝트 구조

```text
openFunctions/
├── src/
│   ├── framework/              # 핵심 런타임 + 구성 계층
│   ├── examples/               # 참조 도구 패턴
│   ├── my-tools/               # 사용자 도구
│   └── index.ts                # MCP 진입점
├── docs/                       # 아키텍처 문서
├── scripts/                    # chat, create-tool, docs
├── test-client/                # CLI 테스터 + 테스트 러너
├── system-prompts/             # 프롬프트 사전 설정
└── package.json
```

## 라이선스

MIT — [LICENSE](LICENSE) 참조