[English](../../README.md) | [Português](README.pt-BR.md)

<p align="center">
  <img src="../../assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Construa ferramentas de IA primeiro. Componha agentes quando precisar deles.</strong>
</p>

<p align="center">
  <a href="#início-rápido">Início Rápido</a> &middot;
  <a href="#o-modelo-mental">Modelo Mental</a> &middot;
  <a href="#escolha-a-primitiva-certa">Escolha a Primitiva Certa</a> &middot;
  <a href="#escada-de-capacidades">Escada de Capacidades</a> &middot;
  <a href="#provedores">Provedores</a> &middot;
  <a href="#exemplos">Exemplos</a> &middot;
  <a href="#documentação">Documentação</a>
</p>

---

openFunctions é um framework TypeScript com licença MIT para construir ferramentas invocáveis por IA e expô-las através de [MCP](https://modelcontextprotocol.io), adaptadores de chat, fluxos de trabalho e agentes. Seu tempo de execução central é simples:

`ToolDefinition -> ToolRegistry -> AIAdapter`

Todo o resto se compõe sobre isso:

- `workflows` (fluxos de trabalho) são orquestrações determinísticas em torno de ferramentas
- `agents` (agentes) são loops de LLM sobre um registro filtrado
- `structured output` (saída estruturada) é um padrão de ferramenta sintética
- `memory` (memória) e `rag` (RAG) são sistemas com estado que podem ser encapsulados de volta em ferramentas

Se você entender o tempo de execução da ferramenta, o restante do framework permanece legível.

```text
defineTool() -> registry.register() -> adapter/server executes tool
                                    -> workflows compose tools // fluxos de trabalho compõem ferramentas
                                    -> agents use filtered tools // agentes usam ferramentas filtradas
                                    -> memory/rag expose more tools // memory/rag expõem mais ferramentas
```

## Início Rápido

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

A primeira coisa a construir é uma ferramenta, não um agente.

## O Modelo Mental

Uma ferramenta é a sua lógica de negócios mais um esquema que a IA pode ler:

```typescript
import { defineTool, ok } from "../framework/index.js";

export const rollDice = defineTool({
  name: "roll_dice",
  description: "Roll a dice with the given number of sides", // Rola um dado com o número de lados fornecido
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "number", description: "Number of sides (default 6)" }, // Número de lados (padrão 6)
    },
  },
  handler: async ({ sides }) => {
    const rolled = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled });
  },
});
```

Essa única definição pode ser:

- executada diretamente por `registry.execute()`
- exposta a Claude/Desktop via MCP
- usada dentro do loop de chat interativo
- composta em fluxos de trabalho
- filtrada em registros específicos de agentes

Leia mais: [Arquitetura](../../docs/ARCHITECTURE.md)

## Escolha a Primitiva Certa

| Use isto | Quando você quer | O que realmente é |
|----------|---------------|-------------------|
| `defineTool()` | lógica de negócios invocável pela IA | a primitiva central |
| `createChatAgent()` | um agente de IA componível e integrável | ferramentas + memória + contexto + adaptador em uma só configuração |
| `pipe()` | orquestração determinística | pipeline de ferramenta/LLM baseado em código |
| `defineAgent()` | uso adaptativo de ferramentas em várias etapas | um loop de LLM sobre um registro filtrado |
| `createConversationMemory()` / `createFactMemory()` | estado de thread/fato | persistência mais ferramentas de memória |
| `createRAG()` | recuperação semântica de documentos | pgvector + embeddings + ferramentas |
| `connectProvider()` | contexto de sistemas externos | ferramentas estruturadas de ExecuFunction, Obsidian, etc. |
| `createStore()` / `createPgStore()` | persistência | camada de armazenamento, não recuperação |

Regra geral:

- Comece com uma ferramenta.
- Use `createChatAgent()` quando quiser um agente completo com memória e contexto.
- Use um fluxo de trabalho quando souber a sequência.
- Use `defineAgent()` quando precisar de agentes especializados dentro de equipes.
- Adicione memória para o estado que você controla.
- Adicione RAG para recuperação de documentos por significado.
- Adicione um provedor de contexto quando precisar de sistemas externos (tarefas, calendários, CRM).

## Escada de Capacidades

### 1. Construa uma ferramenta

```bash
npm run create-tool expense_tracker
```

Edite `src/my-tools/expense_tracker.ts`, então execute:

```bash
npm run test-tools
npm test
```

### 2. Exponha-a através de MCP ou chat

```bash
npm start
npm run chat -- gemini
```

O mesmo registro alimenta ambos.

### 3. Componha-a com fluxos de trabalho

Fluxos de trabalho são a primitiva "avançada" padrão porque o fluxo de controle permanece explícito:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}")); // Explique isso de forma simples: {{input}}

await research.run({ word: "ephemeral" });
```

### 4. Construa um agente de chat

`createChatAgent()` compõe ferramentas, memória, provedores de contexto e um adaptador de IA em um único agente integrável:

```typescript
import { createChatAgent } from "./framework/index.js";

const agent = await createChatAgent({
  provider: "gemini",
  preset: "study-buddy",
  memory: true,                    // memória de conversação + fatos (ativada por padrão)
  providers: ["execufunction"],    // conectar contexto externo
});

// Use-o de quatro formas:
await agent.interactive();                          // CLI
const result = await agent.chat("Create a task");   // programático
for await (const chunk of agent.chat("hello", { stream: true })) { ... }  // streaming
await agent.serve({ port: 3000 });                  // servidor HTTP
```

A mesma configuração funciona a partir de código, opções de CLI ou arquivos YAML. A memória é ativada por padrão — o agente lembra entre sessões.

### 5. Adicione comportamento adaptativo com agentes

`defineAgent()` é para agentes especializados dentro de equipes e fluxos de trabalho — registros filtrados e loops de raciocínio:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst", // Analista de Pesquisa
  goal: "Find accurate information using available tools", // Encontrar informações precisas usando as ferramentas disponíveis
  toolTags: ["search"],
});
```

Use equipes (crews) quando múltiplos agentes especializados precisarem colaborar.

### 6. Adicione estado apenas quando necessário

Persistência:

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

Memória:

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

Documentação RAG: [docs/RAG.md](../../docs/RAG.md)

### 7. Conecte contexto externo

Provedores de contexto trazem sistemas externos (gerenciadores de tarefas, calendários, CRM, bases de conhecimento) para o tempo de execução do agente como ferramentas:

```typescript
import { connectProvider, contextPrompt } from "./framework/index.js";
import { createExecuFunctionProvider } from "./providers/execufunction/index.js";

// Conectar — registra 17 ferramentas com as tags "context" + "context:execufunction"
const exf = await connectProvider(
  createExecuFunctionProvider({ token: process.env.EXF_PAT }),
  registry,
);

// Injetar tarefas ativas + próximos eventos nos prompts de sistema do agente
const context = await contextPrompt([exf]);
```

A interface `ContextProvider` é extensível — implemente `metadata`, `connect()` e `createTools()` para integrar qualquer backend ao framework. Veja [Arquitetura](../../docs/ARCHITECTURE.md#context-providers) para a interface completa.

| Provedor | Status | Capacidades |
|----------|--------|-------------|
| [ExecuFunction](../../src/providers/execufunction/) | Integrado | tarefas, projetos, calendário, conhecimento, pessoas, organizações, código |
| Obsidian | Modelo (planejado) | conhecimento |
| Notion | Modelo (planejado) | conhecimento, tarefas, projetos |

## Comandos

```bash
npm run test-tools          # CLI Interativo — teste ferramentas localmente
npm run dev                 # Modo de desenvolvimento — reinicia automaticamente ao salvar
npm test                    # Executa testes automatizados definidos pela ferramenta
npm run chat                # Converse com a IA usando suas ferramentas
npm run chat -- gemini      # Força um provedor específico
npm run chat -- --no-memory # Chat sem memória persistente
npm run create-tool <name>  # Cria um novo esqueleto de ferramenta
npm run docs                # Gera documentação de referência da ferramenta
npm run inspect             # UI web do Inspetor MCP
npm start                   # Inicia o servidor MCP para Claude Desktop / Cursor
```

## Provedores

Defina uma chave de API em `.env` e o loop de chat detectará automaticamente o provedor.

| Provedor | Modelo Padrão | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | Function calling |
| OpenAI | `gpt-5.4` | Responses API |
| Anthropic | `claude-sonnet-4-6` | Messages + tool_use |
| xAI | `grok-4.20-0309-reasoning` | Responses API |
| OpenRouter | `google/gemini-3-flash-preview` | OpenAI-compatible |

Exemplos:

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## Testes

Os testes vivem com as definições das ferramentas:

```typescript
defineTool({
  name: "create_task",
  // ...
  tests: [
    { name: "creates a task", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } }, // cria uma tarefa
    { name: "fails without subject", input: { title: "Read ch5" }, expect: { success: false } }, // falha sem assunto
  ],
});
```

O registro valida os parâmetros antes que os handlers sejam executados, de modo que os erros de esquema são exibidos de forma clara o suficiente para que tanto humanos quanto LLMs possam se recuperar.

## Exemplos

| Domínio | Ferramentas | Padrão |
|--------|-------|---------|
| Rastreador de Estudos | `create_task`, `list_tasks`, `complete_task` | CRUD + Armazenamento |
| Gerenciador de Favoritos | `save_link`, `search_links`, `tag_link` | Arrays + Busca |
| Guardião de Receitas | `save_recipe`, `search_recipes`, `get_random` | Dados Aninhados + Aleatório |
| Divisor de Despesas | `add_expense`, `split_bill`, `get_balances` | Matemática + Cálculos |
| Registrador de Treinos | `log_workout`, `get_stats`, `suggest_workout` | Filtragem por Data + Estatísticas |
| Dicionário | `define_word`, `find_synonyms` | API Externa (sem chave) |
| Gerador de Quiz | `create_quiz`, `answer_question`, `get_score` | Jogo com Estado |
| Ferramentas de IA | `summarize_text`, `generate_flashcards` | Ferramenta Chama um LLM |
| Utilitários | `calculate`, `convert_units`, `format_date` | Ajudantes Sem Estado |

## Documentação

- [Arquitetura](../../docs/ARCHITECTURE.md): o modelo de tempo de execução, registros filtrados, ferramentas sintéticas e caminhos de execução
- [RAG](../../docs/RAG.md): chunking semântico, embeddings Gemini/OpenAI, esquema pgvector, busca HNSW e integração de ferramentas

## Plugins

### ExecuFunction para OpenClaw

O plugin [`@openfunctions/openclaw-execufunction`](../../plugins/openclaw-execufunction/) traz o [ExecuFunction](https://execufunction.com) para o ecossistema de agentes do [OpenClaw](https://github.com/openclaw/openclaw) — 17 ferramentas em 6 domínios:

| Domínio | Ferramentas | O que faz |
|---------|-------------|-----------|
| Tarefas | `exf_tasks_list`, `exf_tasks_create`, `exf_tasks_update`, `exf_tasks_complete` | Gerenciamento estruturado de tarefas com prioridades (do_now/do_next/do_later/delegate/drop) |
| Calendário | `exf_calendar_list`, `exf_calendar_create`, `exf_calendar_update` | Agendamento e consulta de eventos |
| Conhecimento | `exf_notes_search`, `exf_notes_create`, `exf_notes_get` | Busca semântica em uma base de conhecimento |
| Projetos | `exf_projects_list`, `exf_projects_context` | Status do projeto e contexto completo (tarefas, notas, sinais) |
| Pessoas/CRM | `exf_people_search`, `exf_person_create`, `exf_org_search` | Gerenciamento de contatos e organizações |
| Código | `exf_codebase_search`, `exf_code_who_knows` | Busca semântica de código e rastreamento de expertise |

Instalar:

```bash
openclaw plugins install @openfunctions/openclaw-execufunction
```

Defina `EXF_PAT` no seu ambiente (ou configure pelas configurações do plugin OpenClaw), e seu agente OpenClaw ganha tarefas persistentes, consciência de calendário, busca semântica de conhecimento, CRM e inteligência de código — tudo respaldado pela API em nuvem do ExecuFunction.

Veja o [README do plugin](../../plugins/openclaw-execufunction/) para mais detalhes.

## Estrutura do Projeto

```text
openFunctions/
├── src/
│   ├── framework/              # Tempo de execução central + camadas de composição
│   │   ├── chat-agent.ts       # createChatAgent() — fábrica de agentes de chat componíveis
│   │   ├── chat-agent-types.ts # Tipos ChatAgent, ChatAgentConfig, ChatResult
│   │   ├── chat-agent-resolve.ts # Resolução de configuração, detecção automática de provedor
│   │   ├── chat-agent-http.ts  # Servidor HTTP para agent.serve()
│   │   ├── context.ts          # Interface de provedores de contexto
│   │   └── ...                 # tool, registry, agents, memory, rag, workflows
│   ├── providers/
│   │   └── execufunction/      # Provedor de contexto ExecuFunction (implementação de referência)
│   ├── examples/               # Padrões de ferramentas de referência
│   ├── my-tools/               # Suas ferramentas
│   └── index.ts                # Ponto de entrada MCP
├── plugins/
│   └── openclaw-execufunction/ # Plugin ExecuFunction para OpenClaw
├── docs/                       # Documentação de arquitetura
├── scripts/                    # chat, create-tool, docs
├── test-client/                # Testador CLI + executor de testes
├── system-prompts/             # Predefinições de prompt
└── package.json
```

## Licença

MIT — veja [LICENSE](../../LICENSE)
