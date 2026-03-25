// Load .env file if it exists
import "./framework/env.js";

/**
 * OpenFunction — Entry Point
 *
 * Registers all tools and starts the MCP server.
 * To add your own tools, edit src/my-tools/index.ts.
 */

import { startServer } from "./framework/index.js";
import { registry } from "./register-tools.js";

startServer(registry, {
  name: "openfunction",
  version: "1.0.0",
});
