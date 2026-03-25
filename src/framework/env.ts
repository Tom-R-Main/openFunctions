/**
 * OpenFunction — Environment Loader
 *
 * Loads .env file if it exists. No dependencies needed —
 * uses Node's built-in fs to parse KEY=VALUE lines.
 *
 * Import this at the top of any entry point that needs env vars:
 *   import "../src/framework/env.js";
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = join(__dirname, "..", "..", ".env");

if (existsSync(envPath)) {
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    // Don't overwrite existing env vars (explicit exports take priority)
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
