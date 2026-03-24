/**
 * OpenFunction — Entry Point
 *
 * This file registers all tools and starts the MCP server.
 * When you run `npm start`, this is what executes.
 *
 * To add your own tools:
 *   1. Define them in src/my-tools/index.ts
 *   2. They're automatically registered below
 *   3. Restart the server: npm start
 */

import { registry, startServer } from "./framework/index.js";

// ── Register example tools ─────────────────────────────────────────────────
import { studyTrackerTools } from "./examples/study-tracker/tools.js";
import { bookmarkManagerTools } from "./examples/bookmark-manager/tools.js";
import { quizGeneratorTools } from "./examples/quiz-generator/tools.js";
import { expenseSplitterTools } from "./examples/expense-splitter/tools.js";
import { workoutLoggerTools } from "./examples/workout-logger/tools.js";
import { recipeKeeperTools } from "./examples/recipe-keeper/tools.js";
import { dictionaryTools } from "./examples/dictionary/tools.js";
import { aiTools } from "./examples/ai-tools/tools.js";
import { utilityTools } from "./examples/utilities/tools.js";

registry.registerAll(studyTrackerTools);
registry.registerAll(bookmarkManagerTools);
registry.registerAll(quizGeneratorTools);
registry.registerAll(expenseSplitterTools);
registry.registerAll(workoutLoggerTools);
registry.registerAll(recipeKeeperTools);
registry.registerAll(dictionaryTools);
registry.registerAll(aiTools);
registry.registerAll(utilityTools);

// ── Register YOUR tools ────────────────────────────────────────────────────
import { myTools } from "./my-tools/index.js";

registry.registerAll(myTools);

// ── Start the MCP server ───────────────────────────────────────────────────
startServer(registry, {
  name: "openfunction",
  version: "1.0.0",
});
