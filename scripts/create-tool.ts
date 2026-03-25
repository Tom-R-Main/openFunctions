#!/usr/bin/env tsx
/**
 * OpenFunction — Tool Scaffolder
 *
 * Creates a new tool file with the full pattern pre-filled.
 * Usage:  npm run create-tool <name>
 *
 * Example: npm run create-tool expense_tracker
 *   → Creates src/my-tools/expense_tracker.ts
 *   → Adds import + registration to src/my-tools/index.ts
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

const name = process.argv[2];

if (!name) {
  console.error("\n  Usage: npm run create-tool <name>\n");
  console.error("  Example: npm run create-tool expense_tracker");
  console.error("  Name must be snake_case (lowercase, underscores)\n");
  process.exit(1);
}

if (!/^[a-z][a-z0-9_]*$/.test(name)) {
  console.error(`\n  ❌ "${name}" is not valid snake_case.`);
  console.error("  Use lowercase letters, numbers, and underscores.");
  console.error("  Example: expense_tracker, my_api, word_counter\n");
  process.exit(1);
}

// Convert snake_case to PascalCase for the interface name
const pascal = name
  .split("_")
  .map((w) => w[0].toUpperCase() + w.slice(1))
  .join("");

const toolFile = join(ROOT, "src", "my-tools", `${name}.ts`);

if (existsSync(toolFile)) {
  console.error(`\n  ❌ ${toolFile} already exists.\n`);
  process.exit(1);
}

// ── Generate the tool file ─────────────────────────────────────────────────

const template = `/**
 * ${pascal} — Custom Tool
 *
 * Created with: npm run create-tool ${name}
 *
 * Edit this file to implement your tool, then test with:
 *   npm run test-tools   (interactive CLI)
 *   npm test             (run automated tests)
 *   npm run dev          (auto-restart on save)
 */

// Note: .js extension is required by Node.js ESM, even though files are .ts
import { defineTool, ok, err, createStore } from "../framework/index.js";

// ─── Data ───────────────────────────────────────────────────────────────────

interface ${pascal}Item {
  id: string;
  name: string;
  // TODO: add your fields here
  createdAt: string;
}

export interface Create${pascal}Params {
  // TODO: add your required/optional params
  name: string;
}

/** Persistent store — data saved to .data/${name}.json */
const store = createStore<${pascal}Item>("${name}");
let nextId = store.size + 1;

// ─── Tools ──────────────────────────────────────────────────────────────────

export const create_${name} = defineTool<Create${pascal}Params>({
  name: "create_${name}",
  description: "Create a new ${name.replace(/_/g, " ")}. TODO: write a clear description for the AI.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "TODO: describe this parameter",
      },
    },
    required: ["name"],
  },
  tests: [
    {
      name: "creates an item",
      input: { name: "Test" },
      expect: { success: true, data: { name: "Test" } },
    },
  ],
  handler: async ({ name }) => {
    const id = String(nextId++);
    const item: ${pascal}Item = {
      id,
      name,
      // TODO: add your fields here
      createdAt: new Date().toISOString(),
    };
    store.set(id, item);
    return ok(item, \`Created: "\${name}"\`);
  },
});

// ─── Export ─────────────────────────────────────────────────────────────────

export const ${name}Tools = [create_${name}];
`;

writeFileSync(toolFile, template);
console.log(`\n  ✅ Created ${toolFile}\n`);

// ── Update my-tools/index.ts to import and register ────────────────────────

const indexFile = join(ROOT, "src", "my-tools", "index.ts");
let indexContent = readFileSync(indexFile, "utf-8");

// Add import at the top (after the last import line)
const importLine = `import { ${name}Tools } from "./${name}.js";`;
if (!indexContent.includes(importLine)) {
  // Find the last import line
  const lines = indexContent.split("\n");
  let lastImportIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("import ")) {
      lastImportIdx = i;
    }
  }
  if (lastImportIdx >= 0) {
    lines.splice(lastImportIdx + 1, 0, importLine);
  }

  // Add to the myTools array
  const arrayMatch = indexContent.match(
    /export const myTools = \[([^\]]*)\]/
  );
  if (arrayMatch) {
    const currentTools = arrayMatch[1].trim();
    const newTools = currentTools
      ? `${currentTools}, ...${name}Tools`
      : `...${name}Tools`;
    indexContent = lines.join("\n").replace(
      /export const myTools = \[[^\]]*\]/,
      `export const myTools = [${newTools}]`
    );
  } else {
    indexContent = lines.join("\n");
  }

  writeFileSync(indexFile, indexContent);
  console.log(`  ✅ Registered in src/my-tools/index.ts\n`);
}

console.log("  Next steps:");
console.log(`    1. Edit src/my-tools/${name}.ts — add your fields and logic`);
console.log("    2. Test:  npm run test-tools");
console.log("    3. Run:   npm test\n");
