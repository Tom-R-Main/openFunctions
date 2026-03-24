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

registry.registerAll(studyTrackerTools);
registry.registerAll(bookmarkManagerTools);
registry.registerAll(quizGeneratorTools);

// ── Register YOUR tools ────────────────────────────────────────────────────
import { myTools } from "./my-tools/index.js";

registry.registerAll(myTools);

// ── Start the MCP server ───────────────────────────────────────────────────
startServer(registry, {
  name: "openfunction",
  version: "1.0.0",
});
