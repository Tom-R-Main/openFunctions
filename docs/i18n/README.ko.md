[English](../../README.md) | [한국어](README.ko.md)

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

- `workflows`는 도구를 중심으로 한 결정론적 오케스트레이션입니다
- `agents`는 필터링된 레지스트리를 통한 LLM 루프입니다
- `structured output`은 합성 도구 패턴입니다
- `memory`와 `rag`는 도구로 다시 래핑될 수 있는 상태 저장 시스템입니다

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
  description: "Roll a dice with the given number of sides", // 주어진 면 수로 주사위를 굴린다
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "number", description: "Number of sides (default 6)" }, // 면 수 (기본값 6)
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
| `createChatAgent()` | 구성 가능하고 임베드 가능한 AI 에이전트 | 도구 + 메모리 + 컨텍스트 + 어댑터를 하나의 설정으로 |
| `pipe()` | 결정론적 오케스트레이션 | 코드 기반 도구/LLM 파이프라인 |
| `defineAgent()` | 적응형 다단계 도구 사용 | 필터링된 레지스트리를 통한 LLM 루프 |
| `createConversationMemory()` / `createFactMemory()` | 스레드/팩트 상태 | 지속성 및 메모리 도구 |
| `createRAG()` | 의미론적 문서 검색 | pgvector + 임베딩 + 도구 |
| `connectProvider()` | 외부 시스템 컨텍스트 | ExecuFunction, Obsidian 등의 구조화된 도구 |
| `createStore()` / `createPgStore()` | 지속성 | 저장 계층, 검색 아님 |

경험 법칙:

- 도구로 시작하세요.
- 메모리와 컨텍스트를 갖춘 완전한 에이전트가 필요할 때 `createChatAgent()`를 사용하세요.
- 순서를 알고 있을 때는 워크플로를 사용하세요.
- 크루 내에서 전문 에이전트가 필요할 때 `defineAgent()`를 사용하세요.
- 제어하는 상태를 위해 메모리를 추가하세요.
- 의미에 따른 문서 검색을 위해 RAG를 추가하세요.
- 외부 시스템(작업, 캘린더, CRM)이 필요할 때 컨텍스트 제공자를 추가하세요.

## 기능 사다리

### 1. 도구 구축

```bash
npm run create-tool expense_tracker
```

`src/my-tools/expense_tracker.ts`를 편집한 다음 실행하세요:

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
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}")); // 이것을 간단하게 설명해줘: {{input}}

await research.run({ word: "ephemeral" });
```

### 4. 채팅 에이전트 구축

`createChatAgent()`는 도구, 메모리, 컨텍스트 제공자, AI 어댑터를 하나의 임베드 가능한 에이전트로 구성합니다:

```typescript
import { createChatAgent } from "./framework/index.js";

const agent = await createChatAgent({
  provider: "gemini",
  preset: "study-buddy",
  memory: true,                    // 대화 + 팩트 메모리 (기본적으로 활성화)
  providers: ["execufunction"],    // 외부 컨텍스트 연결
});

// 네 가지 방법으로 사용:
await agent.interactive();                          // CLI
const result = await agent.chat("Create a task");   // 프로그래밍 방식
for await (const chunk of agent.chat("hello", { stream: true })) { ... }  // 스트리밍
await agent.serve({ port: 3000 });                  // HTTP 서버
```

동일한 설정이 코드, CLI 플래그 또는 YAML 파일에서 작동합니다. 메모리는 기본적으로 활성화되어 있으며 — 에이전트는 세션 간에 기억을 유지합니다.

### 5. 에이전트로 적응형 동작 추가

`defineAgent()`는 크루와 워크플로 내의 전문 에이전트를 위한 것입니다 — 필터링된 레지스트리와 추론 루프:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst", // 리서치 분석가
  goal: "Find accurate information using available tools", // 사용 가능한 도구를 사용하여 정확한 정보 찾기
  toolTags: ["search"],
});
```

여러 전문 에이전트가 협업해야 할 때는 크루를 사용하세요.

### 6. 필요할 때만 상태 추가

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

### 7. 외부 컨텍스트 연결

컨텍스트 제공자는 외부 시스템(작업 관리자, 캘린더, CRM, 지식 기반)을 도구로서 에이전트 런타임에 가져옵니다:

```typescript
import { connectProvider, contextPrompt } from "./framework/index.js";
import { createExecuFunctionProvider } from "./providers/execufunction/index.js";

// 연결 — "context" + "context:execufunction" 태그가 있는 17개 도구 등록
const exf = await connectProvider(
  createExecuFunctionProvider({ token: process.env.EXF_PAT }),
  registry,
);

// 활성 작업 + 다가오는 이벤트를 에이전트 시스템 프롬프트에 주입
const context = await contextPrompt([exf]);
```

`ContextProvider` 인터페이스는 플러그형입니다 — `metadata`, `connect()`, `createTools()`를 구현하여 모든 백엔드를 프레임워크에 통합할 수 있습니다. 전체 인터페이스는 [아키텍처](docs/ARCHITECTURE.md#context-providers)를 참조하세요.

| 제공자 | 상태 | 기능 |
|----------|--------|--------------|
| [ExecuFunction](src/providers/execufunction/) | 내장 | 작업, 프로젝트, 캘린더, 지식, 사람, 조직, 코드베이스 |
| Obsidian | 템플릿 (계획 중) | 지식 |
| Notion | 템플릿 (계획 중) | 지식, 작업, 프로젝트 |

## 명령어

```bash
npm run test-tools          # 대화형 CLI — 도구를 로컬에서 테스트
npm run dev                 # 개발 모드 — 저장 시 자동 재시작
npm test                    # 도구 정의 자동화 테스트 실행
npm run chat                # 도구를 사용하여 AI와 채팅
npm run chat -- gemini      # 특정 제공자 강제
npm run chat -- --no-memory # 영구 메모리 없이 채팅
npm run create-tool <name>  # 새 도구 스캐폴드 생성
npm run docs                # 도구 참조 문서 생성
npm run inspect             # MCP Inspector 웹 UI
npm start                   # Claude Desktop / Cursor용 MCP 서버 시작
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
    { name: "creates a task", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } }, // 작업 생성
    { name: "fails without subject", input: { title: "Read ch5" }, expect: { success: false } }, // 과목 없이 실패
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

## 플러그인

### ExecuFunction for OpenClaw

[`@openfunctions/openclaw-execufunction`](plugins/openclaw-execufunction/) 플러그인은 [ExecuFunction](https://execufunction.com)을 [OpenClaw](https://github.com/openclaw/openclaw) 에이전트 생태계에 통합합니다 — 6개 도메인에 걸쳐 17개 도구:

| 도메인 | 도구 | 기능 |
|--------|-------|--------------|
| 작업 | `exf_tasks_list`, `exf_tasks_create`, `exf_tasks_update`, `exf_tasks_complete` | 우선순위 기반 구조화된 작업 관리 (do_now/do_next/do_later/delegate/drop) |
| 캘린더 | `exf_calendar_list`, `exf_calendar_create`, `exf_calendar_update` | 이벤트 스케줄링 및 조회 |
| 지식 | `exf_notes_search`, `exf_notes_create`, `exf_notes_get` | 지식 기반 전체 의미론적 검색 |
| 프로젝트 | `exf_projects_list`, `exf_projects_context` | 프로젝트 상태 및 전체 컨텍스트 (작업, 노트, 시그널) |
| 사람/CRM | `exf_people_search`, `exf_person_create`, `exf_org_search` | 연락처 및 조직 관리 |
| 코드베이스 | `exf_codebase_search`, `exf_code_who_knows` | 의미론적 코드 검색 및 전문 지식 추적 |

설치:

```bash
openclaw plugins install @openfunctions/openclaw-execufunction
```

환경에 `EXF_PAT`를 설정하면(또는 OpenClaw 플러그인 설정으로 구성), OpenClaw 에이전트에 ExecuFunction 클라우드 API 기반의 영구 작업, 캘린더 인식, 의미론적 지식 검색, CRM, 코드 인텔리전스가 추가됩니다.

자세한 내용은 [플러그인 README](plugins/openclaw-execufunction/)를 참조하세요.

## 프로젝트 구조

```text
openFunctions/
├── src/
│   ├── framework/              # 핵심 런타임 + 구성 계층
│   │   ├── chat-agent.ts       # createChatAgent() — 구성 가능한 채팅 에이전트 팩토리
│   │   ├── chat-agent-types.ts # ChatAgent, ChatAgentConfig, ChatResult 타입
│   │   ├── chat-agent-resolve.ts # 설정 해석, 제공자 자동 감지
│   │   ├── chat-agent-http.ts  # agent.serve()용 HTTP 서버
│   │   ├── context.ts          # 컨텍스트 제공자 인터페이스
│   │   └── ...                 # 도구, 레지스트리, 에이전트, 메모리, RAG, 워크플로
│   ├── providers/
│   │   └── execufunction/      # ExecuFunction 컨텍스트 제공자 (레퍼런스 구현)
│   ├── examples/               # 참조 도구 패턴
│   ├── my-tools/               # 사용자 도구
│   └── index.ts                # MCP 진입점
├── plugins/
│   └── openclaw-execufunction/ # OpenClaw용 ExecuFunction 플러그인
├── docs/                       # 아키텍처 문서
├── scripts/                    # 채팅, 도구 생성, 문서
├── test-client/                # CLI 테스터 + 테스트 러너
├── system-prompts/             # 프롬프트 사전 설정
└── package.json
```

## 라이선스

MIT — [LICENSE](LICENSE) 참조
