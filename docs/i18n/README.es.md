[English](../README.md) | [Spanish](README.es.md)

<p align="center">
  <img src="assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Construye herramientas de IA primero. Compón agentes cuando los necesites.</strong>
</p>

<p align="center">
  <a href="#quick-start">Inicio Rápido</a> &middot;
  <a href="#the-mental-model">Modelo Mental</a> &middot;
  <a href="#choose-the-right-primitive">Elige una Primitiva</a> &middot;
  <a href="#capability-ladder">Escalera de Capacidades</a> &middot;
  <a href="#providers">Proveedores</a> &middot;
  <a href="#examples">Ejemplos</a> &middot;
  <a href="#docs">Documentación</a>
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

Leer más: [Arquitectura](docs/ARCHITECTURE.md)

## Elige la Primitiva Correcta

| Usa esto | Cuando quieras | Lo que realmente es |
|----------|---------------|-------------------|
| `defineTool()` | lógica de negocio invocable por IA | la primitiva central |
| `pipe()` | orquestación determinista | pipeline de herramientas/LLM impulsado por código |
| `defineAgent()` | uso adaptativo de herramientas en múltiples pasos | un bucle de LLM sobre un registro filtrado |
| `createConversationMemory()` / `createFactMemory()` | estado de hilo/hecho | persistencia más herramientas de memoria |
| `createRAG()` | recuperación semántica de documentos | pgvector + embeddings + herramientas |
| `createStore()` / `createPgStore()` | persistencia | capa de almacenamiento, no de recuperación |

Regla general:

- Empieza con una herramienta.
- Usa un flujo de trabajo cuando conozcas la secuencia.
- Usa un agente solo cuando el modelo necesite elegir qué hacer a continuación.
- Añade memoria para el estado que controlas.
- Añade RAG para la recuperación de documentos por significado.

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

### 4. Añade comportamiento adaptativo con agentes

Los agentes usan las mismas herramientas, pero a través de un registro filtrado y un bucle de razonamiento:

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

### 5. Añade estado solo cuando sea necesario

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

Documentación de RAG: [docs/RAG.md](docs/RAG.md)

## Comandos

```bash
npm run test-tools          # CLI interactivo — prueba herramientas localmente
npm run dev                 # Modo de desarrollo — se reinicia automáticamente al guardar
npm test                    # Ejecuta pruebas automatizadas definidas por herramientas
npm run chat                # Chatea con la IA usando tus herramientas
npm run chat -- gemini      # Fuerza un proveedor específico
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
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

- [Arquitectura](docs/ARCHITECTURE.md): el modelo de tiempo de ejecución, registros filtrados, herramientas sintéticas y rutas de ejecución
- [RAG](docs/RAG.md): fragmentación semántica, embeddings de Gemini/OpenAI, esquema pgvector, búsqueda HNSW e integración de herramientas

## Estructura del Proyecto

```text
openFunctions/
├── src/
│   ├── framework/              # Núcleo del tiempo de ejecución + capas de composición
│   ├── examples/               # Patrones de herramientas de referencia
│   ├── my-tools/               # Tus herramientas
│   └── index.ts                # Punto de entrada de MCP
├── docs/                       # Documentación de arquitectura
├── scripts/                    # chat, create-tool, docs
├── test-client/                # Probador CLI + ejecutor de pruebas
├── system-prompts/             # Presets de prompts
└── package.json
```

## Licencia

MIT — ver [LICENSE](LICENSE)
