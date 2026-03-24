/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║                    YOUR TOOLS GO HERE                           ║
 * ║                                                                  ║
 * ║  Pick a domain from the menu and build 2-3 tools.               ║
 * ║  Look at the examples/ folder to see the pattern.               ║
 * ║                                                                  ║
 * ║  Domains to choose from:                                         ║
 * ║    - Study Tracker: create_task, list_tasks, complete_task       ║
 * ║    - Bookmark Manager: save_link, search_links, tag_link         ║
 * ║    - Quiz Generator: create_quiz, answer_question, get_score     ║
 * ║    - Expense Splitter: add_expense, split_bill, get_balances     ║
 * ║    - Workout Logger: log_workout, get_stats, suggest_workout     ║
 * ║    - Recipe Keeper: save_recipe, search_recipes, get_random      ║
 * ║    - Or invent your own!                                         ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

// Note: imports use .js extensions — this is required by Node.js ESM, even though the files are .ts
import { defineTool, ok, err } from "../framework/index.js";

// ─── Example starter tool (replace this with your own!) ────────────────────

interface HelloParams { name: string }

export const helloWorld = defineTool<HelloParams>({
  name: "hello_world",
  description: "A starter tool that greets someone. Replace this with your own tools!",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The name of the person to greet",
      },
    },
    required: ["name"],
  },
  handler: async ({ name }) => {
    return ok(
      { greeting: `Hello, ${name}! Welcome to OpenFunction.` },
      `Greeted ${name}`,
    );
  },
});

// ─── Export all your tools here ────────────────────────────────────────────

export const myTools = [helloWorld];

// ─── WORKSHOP STEPS ────────────────────────────────────────────────────────
//
// Step 1: Choose your domain from the menu above
//
// Step 2: Define your data structure (what are you storing?)
//         Example: interface Expense { id: string; amount: number; ... }
//
// Step 3: Create an in-memory store
//         Example: const expenses = new Map<string, Expense>();
//
// Step 4: Define your tools using defineTool()
//         Copy the pattern from any example in examples/
//
//         Why do params appear twice? The TypeScript interface gives YOU type
//         safety. The inputSchema gives the AI a description of each parameter.
//         They should match, but the schema has descriptions the AI reads.
//
// Step 5: Add your tools to the myTools array above
//
// Step 6: Test with:  npm run dev          (auto-restarts on save)
//         Or:         npm run test-tools   (interactive CLI)
//         Or MCP:     npm start
//
// Need help? Look at examples/study-tracker/tools.ts for the simplest example.
