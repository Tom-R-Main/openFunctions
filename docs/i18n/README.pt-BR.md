[English](../README.md) | [Brazilian Portuguese](README.pt-BR.md)

<p align="center">
  <img src="assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Construa ferramentas de IA primeiro. Componha agentes quando precisar deles.</strong>
</p>

<p align="center">
  <a href="#quick-start">Início Rápido</a> &middot;
  <a href="#the-mental-model">Modelo Mental</a> &middot;
  <a href="#choose-the-right-primitive">Escolha a Primitiva Certa</a> &middot;
  <a href="#capability-ladder">Escada de Capacidades</a> &middot;
  <a href="#providers">Provedores</a> &middot;
  <a href="#examples">Exemplos</a> &middot;
  <a href="#docs">Documentação</a>
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
                                    -> workflows compose tools
                                    -> agents use filtered tools
                                    -> memory/rag expose more tools
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

Leia mais: [Arquitetura](docs/ARCHITECTURE.md)

## Escolha a Primitiva Certa

| Use isto | Quando você quer | O que realmente é |
|----------|---------------|-------------------|
| `defineTool()` | lógica de negócios invocável pela IA | a primitiva central |
| `pipe()` | orquestração determinística | pipeline de ferramenta/LLM baseado em código |
| `defineAgent()` | uso adaptativo de ferramentas em várias etapas | um loop de LLM sobre um registro filtrado |
| `createConversationMemory()` / `createFactMemory()` | estado de thread/fato | persistência mais ferramentas de memória |
| `createRAG()` | recuperação semântica de documentos | pgvector + embeddings + ferramentas |
| `createStore()` / `createPgStore()` | persistência | camada de armazenamento, não recuperação |

Regra geral:

- Comece com uma ferramenta.
- Use um fluxo de trabalho quando souber a sequência.
- Use um agente apenas quando o modelo precisar escolher o que fazer em seguida.
- Adicione memória para o estado que você controla.
- Adicione RAG para recuperação de documentos por significado.

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

### 4. Adicione comportamento adaptativo com agentes

Agentes usam as mesmas ferramentas, mas através de um registro filtrado e um loop de raciocínio:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst", // Analista de Pesquisa
  goal: "Find accurate information using available tools", // Encontrar informações precisas usando as ferramentas disponíveis
  toolTags: ["search"],
});
```

Use equipes quando múltiplos agentes especializados precisarem colaborar.

### 5. Adicione estado apenas quando necessário

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

Documentação RAG: [docs/RAG.md](docs/RAG.md)

## Comandos

```bash
npm run test-tools          # CLI Interativo — teste ferramentas localmente
npm run dev                 # Modo de desenvolvimento — reinicia automaticamente ao salvar
npm test                    # Executa testes automatizados definidos pela ferramenta
npm run chat                # Converse com a IA usando suas ferramentas
npm run chat -- gemini      # Força um provedor específico
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

- [Arquitetura](docs/ARCHITECTURE.md): o modelo de tempo de execução, registros filtrados, ferramentas sintéticas e caminhos de execução
- [RAG](docs/RAG.md): chunking semântico, embeddings Gemini/OpenAI, esquema pgvector, busca HNSW e integração de ferramentas

## Estrutura do Projeto

```text
openFunctions/
├── src/
│   ├── framework/              # Tempo de execução central + camadas de composição
│   ├── examples/               # Padrões de ferramentas de referência
│   ├── my-tools/               # Suas ferramentas
│   └── index.ts                # Ponto de entrada MCP
├── docs/                       # Documentação de arquitetura
├── scripts/                    # chat, create-tool, docs
├── test-client/                # Testador CLI + executor de testes
├── system-prompts/             # Predefinições de prompt
└── package.json
```

## Licença

MIT — veja [LICENSE](LICENSE)