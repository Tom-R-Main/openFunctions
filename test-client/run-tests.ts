#!/usr/bin/env tsx
/**
 * OpenFunction — Run All Tests
 *
 * Executes every test defined in tool definitions.
 * Run: npm test
 */

import { registry } from "../src/framework/index.js";
import { runTests } from "../src/framework/test-runner.js";

// ── Register all tools (same as index.ts) ──────────────────────────────────
import { studyTrackerTools } from "../src/examples/study-tracker/tools.js";
import { bookmarkManagerTools } from "../src/examples/bookmark-manager/tools.js";
import { quizGeneratorTools } from "../src/examples/quiz-generator/tools.js";
import { expenseSplitterTools } from "../src/examples/expense-splitter/tools.js";
import { workoutLoggerTools } from "../src/examples/workout-logger/tools.js";
import { recipeKeeperTools } from "../src/examples/recipe-keeper/tools.js";
import { dictionaryTools } from "../src/examples/dictionary/tools.js";
import { aiTools } from "../src/examples/ai-tools/tools.js";
import { utilityTools } from "../src/examples/utilities/tools.js";
import { myTools } from "../src/my-tools/index.js";

registry.registerAll(studyTrackerTools);
registry.registerAll(bookmarkManagerTools);
registry.registerAll(quizGeneratorTools);
registry.registerAll(expenseSplitterTools);
registry.registerAll(workoutLoggerTools);
registry.registerAll(recipeKeeperTools);
registry.registerAll(dictionaryTools);
registry.registerAll(aiTools);
registry.registerAll(utilityTools);
registry.registerAll(myTools);

// ── Run tests ──────────────────────────────────────────────────────────────

const { failed } = await runTests(registry);
process.exit(failed > 0 ? 1 : 0);
