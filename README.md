# openFunctions

**Build AI agent tools in minutes.** Define once, use with any AI.

openFunctions is a lightweight TypeScript framework for building [MCP](https://modelcontextprotocol.io) (Model Context Protocol) servers — the open standard for giving AI agents tools to call. Your tools work with Claude, Gemini, ChatGPT, and any MCP-compatible client, with zero rewriting.

```
┌─────────────────────────────────────────────────────────┐
│                  Your Tool Definitions                   │
│              (define once with openFunctions)              │
└──────────┬──────────────┬──────────────┬────────────────┘
           │              │              │
     ┌─────▼─────┐ ┌─────▼─────┐ ┌─────▼──────┐
     │  Claude    │ │  Gemini   │ │  ChatGPT   │
     │  (MCP)    │ │ (fn call) │ │  (tools)   │
     └───────────┘ └───────────┘ └────────────┘
```

## Quick Start

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
```

That's it. You have a working MCP server with 10 example tools.

## Test Your Tools

Three ways to verify everything works:

```bash
# 1. Interactive CLI (no API key needed)
npm run test-tools

# 2. MCP Inspector (visual web UI)
npm run inspect

# 3. Chat with Gemini using your tools
export GEMINI_API_KEY=your-key-here
npm run gemini
```

## Build Your Own Tools

Open `src/my-tools/index.ts` and start building. Here's the pattern:

```typescript
import { defineTool, ok, err } from "../framework/index.js";

// 1. Define your data
interface Expense {
  id: string;
  description: string;
  amount: number;
  paidBy: string;
}

const expenses: Expense[] = [];

// 2. Define your param types (these match your inputSchema)
interface AddExpenseParams {
  description: string;
  amount: number;
  paidBy: string;
}

// 3. Define a tool
export const addExpense = defineTool<AddExpenseParams>({
  name: "add_expense",
  description: "Add a shared expense to split with friends",
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "What was purchased" },
      amount:      { type: "number", description: "Cost in dollars" },
      paidBy:      { type: "string", description: "Who paid" },
    },
    required: ["description", "amount", "paidBy"],
  },
  handler: async ({ description, amount, paidBy }) => {
    const expense = {
      id: String(expenses.length + 1),
      description,
      amount,
      paidBy,
    };
    expenses.push(expense);
    return ok(expense, `Added: ${description} ($${amount}, paid by ${paidBy})`);
  },
});

// 4. Export your tools
export const myTools = [addExpense];
```

Then restart: `npm start`

## Project Structure

```
openFunctions/
├── src/
│   ├── framework/           # The core framework (you don't need to edit this)
│   │   ├── tool.ts          # defineTool() — how you create tools
│   │   ├── registry.ts      # Tool registry + provider format adapters
│   │   ├── server.ts        # MCP server wrapper
│   │   └── types.ts         # TypeScript interfaces
│   ├── examples/            # Read these to learn the pattern
│   │   ├── study-tracker/   # Task management (simplest example)
│   │   ├── bookmark-manager/# Save & search links (arrays, search)
│   │   └── quiz-generator/  # Quiz game (stateful, complex params)
│   ├── my-tools/            # YOUR tools go here
│   │   └── index.ts         # Start building!
│   └── index.ts             # Entry point — registers tools, starts server
├── test-client/
│   └── cli.ts               # Interactive CLI tool tester
├── gemini-bridge/
│   ├── bridge.ts            # Converts tools → Gemini function calling format
│   └── test-with-gemini.ts  # Chat with Gemini using your tools
├── claude-config/
│   └── README.md            # How to connect to Claude Desktop
├── setup.sh                 # One-command setup
└── package.json
```

## How It Works

openFunctions is built on three concepts:

**1. Tools** — Functions an AI can call. Each tool has a name, description (the AI reads this to decide when to use it), parameter schema, and a handler function.

**2. Registry** — Manages all your tools and converts them to the format each AI provider expects. Define once, use with Claude (MCP), Gemini (function calling), or OpenAI (tools API).

**3. MCP Server** — Exposes your tools over the [Model Context Protocol](https://modelcontextprotocol.io), the open standard for AI tool interoperability. Any MCP client can discover and call your tools.

## Domain Menu

Pick a domain and build 2-3 tools:

| Domain | Tools | Difficulty |
|--------|-------|-----------|
| Study Tracker | `create_task`, `list_tasks`, `complete_task` | Beginner |
| Bookmark Manager | `save_link`, `search_links`, `tag_link` | Beginner |
| Expense Splitter | `add_expense`, `split_bill`, `get_balances` | Intermediate |
| Workout Logger | `log_workout`, `get_stats`, `suggest_workout` | Intermediate |
| Recipe Keeper | `save_recipe`, `search_recipes`, `get_random` | Beginner |
| Quiz Generator | `create_quiz`, `answer_question`, `get_score` | Advanced |
| Or invent your own! | Whatever you want | You decide |

## Connecting to AI Clients

### Claude Desktop / Claude.ai
See [claude-config/README.md](claude-config/README.md) for setup instructions.

### Gemini (Google AI Studio)
```bash
export GEMINI_API_KEY=your-key-here
npm run gemini
```

### MCP Inspector
```bash
npm run inspect
```

## Architecture

This framework is derived from [ExecuFunction](https://execufunction.com)'s production tool system, which powers ~150 AI-callable tools across task management, calendar, knowledge, code search, and more. openFunctions extracts the core pattern and strips away the production complexity (auth, RLS, activity events, billing) so you can focus on building tools.

The key insight: **the AI model is interchangeable, but the tool layer is what makes agents actually useful.** openFunctions proves this by making the same tool definitions work across Claude, Gemini, and any MCP client.

## License

MIT
