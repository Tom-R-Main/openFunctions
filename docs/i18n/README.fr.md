[English](../README.md) | [French](README.fr.md)

<p align="center">
  <img src="../../assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Créez d'abord des outils d'IA. Composez des agents lorsque vous en avez besoin.</strong>
</p>

<p align="center">
  <a href="#quick-start">Démarrage Rapide</a> &middot;
  <a href="#the-mental-model">Modèle Mental</a> &middot;
  <a href="#choose-the-right-primitive">Choisir la Bonne Primitive</a> &middot;
  <a href="#capability-ladder">Échelle des Capacités</a> &middot;
  <a href="#providers">Fournisseurs</a> &middot;
  <a href="#examples">Exemples</a> &middot;
  <a href="#docs">Documentation</a>
</p>

---

openFunctions est un framework TypeScript sous licence MIT pour la création d'outils appelables par l'IA et leur exposition via [MCP](https://modelcontextprotocol.io), des adaptateurs de chat, des workflows et des agents. Son runtime principal est simple :

`ToolDefinition -> ToolRegistry -> AIAdapter`

Tout le reste se compose par-dessus :

- `workflows` sont une orchestration déterministe autour des outils
- `agents` sont des boucles LLM sur un registre filtré
- `structured output` est un modèle d'outil synthétique
- `memory` et `rag` sont des systèmes à état qui peuvent être réintégrés en outils

Si vous comprenez le runtime des outils, le reste du framework reste lisible.

```text
defineTool() -> registry.register() -> adapter/server executes tool
                                    -> workflows compose tools
                                    -> agents use filtered tools
                                    -> memory/rag expose more tools
```

## Démarrage Rapide

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

La première chose à construire est un outil, pas un agent.

## Le Modèle Mental

Un outil est votre logique métier plus un schéma que l'IA peut lire :

```typescript
import { defineTool, ok } from "../framework/index.js";

export const rollDice = defineTool({
  name: "roll_dice",
  description: "Lance un dé avec le nombre de faces donné",
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "number", description: "Nombre de faces (par défaut 6)" },
    },
  },
  handler: async ({ sides }) => {
    const rolled = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled });
  },
});
```

Cette définition unique peut être :

- exécutée directement par `registry.execute()`
- exposée à Claude/Desktop via MCP
- utilisée dans la boucle de chat interactive
- composée en workflows
- filtrée dans des registres spécifiques aux agents

En savoir plus : [Architecture](docs/ARCHITECTURE.md)

## Choisir la Bonne Primitive

| Utilisez ceci | Lorsque vous voulez | Ce que c'est réellement |
|---------------|--------------------|-------------------------|
| `defineTool()` | une logique métier appelable par l'IA | la primitive principale |
| `pipe()` | une orchestration déterministe | un pipeline outil/LLM piloté par le code |
| `defineAgent()` | une utilisation adaptative d'outils en plusieurs étapes | une boucle LLM sur un registre filtré |
| `createConversationMemory()` / `createFactMemory()` | l'état du fil de discussion/des faits | la persistance plus les outils de mémoire |
| `createRAG()` | la récupération sémantique de documents | pgvector + embeddings + outils |
| `createStore()` / `createPgStore()` | la persistance | une couche de stockage, pas de récupération |

Règle générale :

- Commencez par un outil.
- Utilisez un workflow lorsque vous connaissez la séquence.
- N'utilisez un agent que lorsque le modèle doit choisir la prochaine action.
- Ajoutez de la mémoire pour l'état que vous contrôlez.
- Ajoutez RAG pour la récupération de documents par signification.

## Échelle des Capacités

### 1. Construire un outil

```bash
npm run create-tool expense_tracker
```

Modifiez `src/my-tools/expense_tracker.ts`, puis exécutez :

```bash
npm run test-tools
npm test
```

### 2. L'exposer via MCP ou le chat

```bash
npm start
npm run chat -- gemini
```

Le même registre alimente les deux.

### 3. Le composer avec des workflows

Les workflows sont la primitive « avancée » par défaut car le flux de contrôle reste explicite :

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}")); // Expliquez ceci simplement : {{input}}

await research.run({ word: "ephemeral" });
```

### 4. Ajouter un comportement adaptatif avec des agents

Les agents utilisent les mêmes outils, mais via un registre filtré et une boucle de raisonnement :

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Analyste de recherche",
  goal: "Trouver des informations précises en utilisant les outils disponibles",
  toolTags: ["search"],
});
```

Utilisez des équipes (crews) lorsque plusieurs agents spécialisés doivent collaborer.

### 5. Ajouter l'état uniquement lorsque nécessaire

Persistance :

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

Mémoire :

```typescript
const conversations = createConversationMemory();
const facts = createFactMemory();
registry.registerAll(createMemoryTools(conversations, facts));
```

RAG :

```typescript
const rag = await createRAG({ embeddingProvider: "gemini" });
registry.registerAll(rag.createTools());
```

Documentation RAG : [docs/RAG.md](docs/RAG.md)

## Commandes

```bash
npm run test-tools          # CLI interactive — testez les outils localement
npm run dev                 # Mode dev — redémarre automatiquement à la sauvegarde
npm test                    # Exécute les tests automatisés définis par l'outil
npm run chat                # Discutez avec l'IA en utilisant vos outils
npm run chat -- gemini      # Force un fournisseur spécifique
npm run create-tool <name>  # Génère un nouvel outil
npm run docs                # Génère la documentation de référence des outils
npm run inspect             # Interface web de l'inspecteur MCP
npm start                   # Démarre le serveur MCP pour Claude Desktop / Cursor
```

## Fournisseurs

Définissez une clé API dans `.env` et la boucle de chat détectera automatiquement le fournisseur.

| Fournisseur | Modèle par défaut | API |
|-------------|-------------------|-----|
| Gemini      | `gemini-3-flash-preview` | Function calling |
| OpenAI      | `gpt-5.4`         | Responses API |
| Anthropic   | `claude-sonnet-4-6` | Messages + tool_use |
| xAI         | `grok-4.20-0309-reasoning` | Responses API |
| OpenRouter  | `google/gemini-3-flash-preview` | OpenAI-compatible |

Exemples :

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## Tests

Les tests sont définis avec les définitions d'outils :

```typescript
defineTool({
  name: "create_task",
  // ...
  tests: [
    { name: "crée une tâche", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } },
    { name: "échoue sans sujet", input: { title: "Read ch5" }, expect: { success: false } },
  ],
});
```

Le registre valide les paramètres avant l'exécution des gestionnaires, de sorte que les erreurs de schéma sont clairement signalées, permettant aux humains et aux LLM de les corriger.

## Exemples

| Domaine | Outils | Modèle |
|---------|--------|--------|
| Suivi d'études | `create_task`, `list_tasks`, `complete_task` | CRUD + Store |
| Gestionnaire de favoris | `save_link`, `search_links`, `tag_link` | Tableaux + Recherche |
| Garde-recettes | `save_recipe`, `search_recipes`, `get_random` | Données imbriquées + Aléatoire |
| Partage de dépenses | `add_expense`, `split_bill`, `get_balances` | Mathématiques + Calculs |
| Journal d'entraînement | `log_workout`, `get_stats`, `suggest_workout` | Filtrage par date + Statistiques |
| Dictionnaire | `define_word`, `find_synonyms` | API externe (pas de clé) |
| Générateur de quiz | `create_quiz`, `answer_question`, `get_score` | Jeu à état |
| Outils d'IA | `summarize_text`, `generate_flashcards` | L'outil appelle un LLM |
| Utilitaires | `calculate`, `convert_units`, `format_date` | Assistants sans état |

## Documentation

- [Architecture](docs/ARCHITECTURE.md) : le modèle d'exécution, les registres filtrés, les outils synthétiques et les chemins d'exécution
- [RAG](docs/RAG.md) : découpage sémantique, embeddings Gemini/OpenAI, schéma pgvector, recherche HNSW et intégration d'outils

## Structure du Projet

```text
openFunctions/
├── src/
│   ├── framework/              # Runtime principal + couches de composition
│   ├── examples/               # Modèles d'outils de référence
│   ├── my-tools/               # Vos outils
│   └── index.ts                # Point d'entrée MCP
├── docs/                       # Documentation d'architecture
├── scripts/                    # chat, create-tool, docs
├── test-client/                # Testeur CLI + exécuteur de tests
├── system-prompts/             # Préréglages de prompts
└── package.json
```

## Licence

MIT — voir [LICENSE](LICENSE)
