[English](../../README.md) | [Español](README.es.md)

<p align="center">
  <img src="../../assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Construye herramientas de IA primero. Compón agentes cuando los necesites.</strong>
</p>

<p align="center">
  <a href="#inicio-rápido">Inicio Rápido</a> &middot;
  <a href="#el-modelo-mental">Modelo Mental</a> &middot;
  <a href="#elige-la-primitiva-correcta">Elige una Primitiva</a> &middot;
  <a href="#escalera-de-capacidades">Escalera de Capacidades</a> &middot;
  <a href="#proveedores">Proveedores</a> &middot;
  <a href="#ejemplos">Ejemplos</a> &middot;
  <a href="#documentación">Documentación</a>
</p>

---

openFunctions es un framework TypeScript con licencia MIT para construir herramientas invocables por IA y exponerlas a través de [MCP](https://modelcontextprotocol.io), adaptadores de chat, flujos de trabajo y agentes. Su tiempo de ejecución central es simple:

`ToolDefinition -> ToolRegistry -> AIAdapter`

Todo lo demás se compone sobre eso:

- `workflows` son orquestaciones deterministas alrededor de herramientas
- `agents` son bucles de LLM sobre un registro filtrado
- `structured output` es un patrón de herramienta sintético
- `memory` y `rag` son sistemas con estado que pueden ser envueltos de nuevo en herramientas

Si entiendes el tiempo de ejecución de las herramientas, el resto del framework sigue siendo legible.

```text
defineTool() -> registry.register() -> adapter/server executes tool
                                    -> workflows compose tools // los flujos de trabajo componen herramientas
                                    -> agents use filtered tools // los agentes usan herramientas filtradas
                                    -> memory/rag expose more tools // la memoria/rag expone más herramientas
```

## Inicio Rápido

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

Lo primero que hay que construir es una herramienta, no un agente.

## El Modelo Mental

Una herramienta es tu lógica de negocio más un esquema que la IA puede leer:

```typescript
import { defineTool, ok } from "../framework/index.js";

export const rollDice = defineTool({
  name: "roll_dice",
  description: "Roll a dice with the given number of sides", // Lanza un dado con el número de caras dado
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "number", description: "Number of sides (default 6)" }, // Número de caras (por defecto 6)
    },
  },
  handler: async ({ sides }) => {
    const rolled = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled });
  },
});
```

Esa única definición puede ser:

- ejecutada directamente por `registry.execute()`
- expuesta a Claude/Desktop a través de MCP
- utilizada dentro del bucle de chat interactivo
- compuesta en flujos de trabajo
- filtrada en registros específicos de agentes

Leer más: [Arquitectura](../../docs/ARCHITECTURE.md)

## Elige la Primitiva Correcta

| Usa esto | Cuando quieras | Lo que realmente es |
|----------|---------------|-------------------|
| `defineTool()` | lógica de negocio invocable por IA | la primitiva central |
| `createChatAgent()` | un agente de IA componible e integrable | herramientas + memoria + contexto + adaptador en una sola configuración |
| `pipe()` | orquestación determinista | pipeline de herramientas/LLM impulsado por código |
| `defineAgent()` | uso adaptativo de herramientas en múltiples pasos | un bucle de LLM sobre un registro filtrado |
| `createConversationMemory()` / `createFactMemory()` | estado de hilo/hecho | persistencia más herramientas de memoria |
| `createRAG()` | recuperación semántica de documentos | pgvector + embeddings + herramientas |
| `connectProvider()` | contexto de sistemas externos | herramientas estructuradas desde ExecuFunction, Obsidian, etc. |
| `createStore()` / `createPgStore()` | persistencia | capa de almacenamiento, no de recuperación |

Regla general:

- Empieza con una herramienta.
- Usa `createChatAgent()` cuando quieras un agente completo con memoria y contexto.
- Usa un flujo de trabajo cuando conozcas la secuencia.
- Usa `defineAgent()` cuando necesites agentes especializados dentro de equipos.
- Añade memoria para el estado que controlas.
- Añade RAG para la recuperación de documentos por significado.
- Añade un proveedor de contexto cuando necesites sistemas externos (tareas, calendarios, CRM).

## Escalera de Capacidades

### 1. Construye una herramienta

```bash
npm run create-tool expense_tracker
```

Edita `src/my-tools/expense_tracker.ts`, luego ejecuta:

```bash
npm run test-tools
npm test
```

### 2. Expónla a través de MCP o chat

```bash
npm start
npm run chat -- gemini
```

El mismo registro alimenta a ambos.

### 3. Compónla con flujos de trabajo

Los flujos de trabajo son la primitiva "avanzada" por defecto porque el flujo de control permanece explícito:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}")); // Explica esto de forma sencilla: {{input}}

await research.run({ word: "ephemeral" });
```

### 4. Construye un agente de chat

`createChatAgent()` compone herramientas, memoria, proveedores de contexto y un adaptador de IA en un solo agente integrable:

```typescript
import { createChatAgent } from "./framework/index.js";

const agent = await createChatAgent({
  provider: "gemini",
  preset: "study-buddy",
  memory: true,                    // memoria de conversación + hechos (activada por defecto)
  providers: ["execufunction"],    // conectar contexto externo
});

// Úsalo de cuatro formas:
await agent.interactive();                          // CLI
const result = await agent.chat("Create a task");   // programático
for await (const chunk of agent.chat("hello", { stream: true })) { ... }  // streaming
await agent.serve({ port: 3000 });                  // servidor HTTP
```

La misma configuración funciona desde código, opciones de CLI o archivos YAML. La memoria está activada por defecto: el agente recuerda entre sesiones.

### 5. Añade comportamiento adaptativo con agentes

`defineAgent()` es para agentes especializados dentro de equipos y flujos de trabajo: registros filtrados y bucles de razonamiento:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst", // Analista de Investigación
  goal: "Find accurate information using available tools", // Encontrar información precisa usando las herramientas disponibles
  toolTags: ["search"],
});
```

Usa equipos (crews) cuando múltiples agentes especializados necesiten colaborar.

### 6. Añade estado solo cuando sea necesario

Persistencia:

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

Memoria:

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

Documentación de RAG: [docs/RAG.md](../../docs/RAG.md)

### 7. Conecta contexto externo

Los proveedores de contexto traen sistemas externos (gestores de tareas, calendarios, CRM, bases de conocimiento) al tiempo de ejecución del agente como herramientas:

```typescript
import { connectProvider, contextPrompt } from "./framework/index.js";
import { createExecuFunctionProvider } from "./providers/execufunction/index.js";

// Conectar — registra 17 herramientas etiquetadas "context" + "context:execufunction"
const exf = await connectProvider(
  createExecuFunctionProvider({ token: process.env.EXF_PAT }),
  registry,
);

// Inyectar tareas activas + próximos eventos en los prompts del sistema del agente
const context = await contextPrompt([exf]);
```

La interfaz `ContextProvider` es extensible: implementa `metadata`, `connect()` y `createTools()` para integrar cualquier backend al framework. Consulta [Arquitectura](../../docs/ARCHITECTURE.md#context-providers) para la interfaz completa.

| Proveedor | Estado | Capacidades |
|-----------|--------|-------------|
| [ExecuFunction](../../src/providers/execufunction/) | Integrado | tareas, proyectos, calendario, conocimiento, personas, organizaciones, código |
| Obsidian | Plantilla (planeado) | conocimiento |
| Notion | Plantilla (planeado) | conocimiento, tareas, proyectos |

## Comandos

```bash
npm run test-tools          # CLI interactivo — prueba herramientas localmente
npm run dev                 # Modo de desarrollo — se reinicia automáticamente al guardar
npm test                    # Ejecuta pruebas automatizadas definidas por herramientas
npm run chat                # Chatea con la IA usando tus herramientas
npm run chat -- gemini      # Fuerza un proveedor específico
npm run chat -- --no-memory # Chat sin memoria persistente
npm run create-tool <name>  # Crea un andamio para una nueva herramienta
npm run docs                # Genera documentación de referencia de herramientas
npm run inspect             # Interfaz web del Inspector MCP
npm start                   # Inicia el servidor MCP para Claude Desktop / Cursor
```

## Proveedores

Establece una clave API en `.env` y el bucle de chat detectará automáticamente el proveedor.

| Proveedor | Modelo por Defecto | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | Llamada a funciones |
| OpenAI | `gpt-5.4` | API de respuestas |
| Anthropic | `claude-sonnet-4-6` | Mensajes + uso de herramientas |
| xAI | `grok-4.20-0309-reasoning` | API de respuestas |
| OpenRouter | `google/gemini-3-flash-preview` | Compatible con OpenAI |

Ejemplos:

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## Pruebas

Las pruebas residen con las definiciones de las herramientas:

```typescript
defineTool({
  name: "create_task",
  // ...
  tests: [
    { name: "creates a task", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } }, // crea una tarea
    { name: "fails without subject", input: { title: "Read ch5" }, expect: { success: false } }, // falla sin asunto
  ],
});
```

El registro valida los parámetros antes de que se ejecuten los manejadores, por lo que los errores de esquema se muestran con suficiente claridad para que tanto humanos como LLM puedan recuperarse.

## Ejemplos

| Dominio | Herramientas | Patrón |
|--------|-------|---------|
| Rastreador de Estudio | `create_task`, `list_tasks`, `complete_task` | CRUD + Almacén |
| Gestor de Marcadores | `save_link`, `search_links`, `tag_link` | Arrays + Búsqueda |
| Guardián de Recetas | `save_recipe`, `search_recipes`, `get_random` | Datos Anidados + Aleatorio |
| Divisor de Gastos | `add_expense`, `split_bill`, `get_balances` | Matemáticas + Cálculos |
| Registrador de Entrenamientos | `log_workout`, `get_stats`, `suggest_workout` | Filtrado por Fecha + Estadísticas |
| Diccionario | `define_word`, `find_synonyms` | API Externa (sin clave) |
| Generador de Cuestionarios | `create_quiz`, `answer_question`, `get_score` | Juego con Estado |
| Herramientas de IA | `summarize_text`, `generate_flashcards` | La Herramienta Llama a un LLM |
| Utilidades | `calculate`, `convert_units`, `format_date` | Ayudantes sin Estado |

## Documentación

- [Arquitectura](../../docs/ARCHITECTURE.md): el modelo de tiempo de ejecución, registros filtrados, herramientas sintéticas y rutas de ejecución
- [RAG](../../docs/RAG.md): fragmentación semántica, embeddings de Gemini/OpenAI, esquema pgvector, búsqueda HNSW e integración de herramientas

## Plugins

### ExecuFunction para OpenClaw

El plugin [`@openfunctions/openclaw-execufunction`](../../plugins/openclaw-execufunction/) trae [ExecuFunction](https://execufunction.com) al ecosistema de agentes de [OpenClaw](https://github.com/openclaw/openclaw) — 17 herramientas en 6 dominios:

| Dominio | Herramientas | Qué hace |
|---------|--------------|----------|
| Tareas | `exf_tasks_list`, `exf_tasks_create`, `exf_tasks_update`, `exf_tasks_complete` | Gestión estructurada de tareas con prioridades (do_now/do_next/do_later/delegate/drop) |
| Calendario | `exf_calendar_list`, `exf_calendar_create`, `exf_calendar_update` | Programación y consulta de eventos |
| Conocimiento | `exf_notes_search`, `exf_notes_create`, `exf_notes_get` | Búsqueda semántica en una base de conocimiento |
| Proyectos | `exf_projects_list`, `exf_projects_context` | Estado del proyecto y contexto completo (tareas, notas, señales) |
| Personas/CRM | `exf_people_search`, `exf_person_create`, `exf_org_search` | Gestión de contactos y organizaciones |
| Código | `exf_codebase_search`, `exf_code_who_knows` | Búsqueda semántica de código y rastreo de expertise |

Instalar:

```bash
openclaw plugins install @openfunctions/openclaw-execufunction
```

Establece `EXF_PAT` en tu entorno (o configúralo mediante los ajustes del plugin de OpenClaw), y tu agente OpenClaw obtiene tareas persistentes, conciencia de calendario, búsqueda semántica de conocimiento, CRM e inteligencia de código, todo respaldado por la API en la nube de ExecuFunction.

Consulta el [README del plugin](../../plugins/openclaw-execufunction/) para más detalles.

## Estructura del Proyecto

```text
openFunctions/
├── src/
│   ├── framework/              # Núcleo del tiempo de ejecución + capas de composición
│   │   ├── chat-agent.ts       # createChatAgent() — fábrica de agentes de chat componibles
│   │   ├── chat-agent-types.ts # Tipos ChatAgent, ChatAgentConfig, ChatResult
│   │   ├── chat-agent-resolve.ts # Resolución de configuración, detección automática de proveedor
│   │   ├── chat-agent-http.ts  # Servidor HTTP para agent.serve()
│   │   ├── context.ts          # Interfaz de proveedores de contexto
│   │   └── ...                 # tool, registry, agents, memory, rag, workflows
│   ├── providers/
│   │   └── execufunction/      # Proveedor de contexto ExecuFunction (implementación de referencia)
│   ├── examples/               # Patrones de herramientas de referencia
│   ├── my-tools/               # Tus herramientas
│   └── index.ts                # Punto de entrada MCP
├── plugins/
│   └── openclaw-execufunction/ # Plugin de ExecuFunction para OpenClaw
├── docs/                       # Documentación de arquitectura
├── scripts/                    # chat, create-tool, docs
├── test-client/                # Probador CLI + ejecutor de pruebas
├── system-prompts/             # Presets de prompts
└── package.json
```

## Licencia

MIT — ver [LICENSE](../../LICENSE)
