/**
 * OpenFunction — Centralized Tool Registration
 *
 * Single source of truth for registering all example + user tools.
 * Used by the MCP server, chat script, test runner, docs generator, and CLI.
 */

import { registry } from "./framework/index.js";

import { studyTrackerTools } from "./examples/study-tracker/tools.js";
import { bookmarkManagerTools } from "./examples/bookmark-manager/tools.js";
import { quizGeneratorTools } from "./examples/quiz-generator/tools.js";
import { expenseSplitterTools } from "./examples/expense-splitter/tools.js";
import { workoutLoggerTools } from "./examples/workout-logger/tools.js";
import { recipeKeeperTools } from "./examples/recipe-keeper/tools.js";
import { dictionaryTools } from "./examples/dictionary/tools.js";
import { aiTools } from "./examples/ai-tools/tools.js";
import { utilityTools } from "./examples/utilities/tools.js";
import { myTools } from "./my-tools/index.js";

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

export { registry };
