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

```bash
# Interactive CLI — test any tool, no API key needed
npm run test-tools

# Dev mode — auto-restarts when you edit code
npm run dev

# MCP Inspector — visual web UI for your server
npm run inspect

# Chat with Gemini using your tools
export GEMINI_API_KEY=your-key-here
npm run gemini
```

## Build Your Own Tools

Open `src/my-tools/index.ts` and start building. Here's the simplest possible tool:

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
    const result = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled: result });
  },
});

export const myTools = [rollDice];
```

Run `npm run dev` to auto-restart on save, then `npm run test-tools` to try it.

For a full example with typed params, in-memory storage, and error handling, see `src/examples/study-tracker/tools.ts`.

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
