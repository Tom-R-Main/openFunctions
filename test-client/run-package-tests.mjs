/** Real tarball consumer checks, not repository-relative source import probes. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "openfunction-package-"));
const consumer = join(scratch, "consumer");
function run(command, args, cwd = consumer) {
  return execFileSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, DATABASE_URL: "" }, timeout: command === "npm" ? 180000 : 30000, stdio: ["ignore", "pipe", "pipe"] });
}
try {
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const pack = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", scratch], root))[0];
  const names = pack.files.map((file) => file.path);
  assert.ok(names.includes("dist/src/cli.js"));
  assert.ok(names.includes("dist/system-prompts/default.md"));
  assert.ok(names.every((name) => name.startsWith("dist/") || ["package.json", "README.md", "LICENSE"].includes(name)), "tarball leaked development files");
  run("npm", ["install", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund", join(scratch, pack.filename)]);
  assert.ok(names.every((name) => !/^(?:dist\/(?:test-client|scripts|gemini-bridge)\/|\.env|\.data)/.test(name)), "tarball leaked development runtime or state");
  const installed = join(consumer, "node_modules/openfunction");
  const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  const subpaths = Object.keys(pkg.exports).map((key) => key === "." ? "openfunction" : `openfunction${key.slice(1)}`);
  // Resolve pg only on demand and share concurrent pool initialization.
  run("node", ["--input-type=module", "-e", `process.env.DATABASE_URL = 'postgres://fixture'; const m = await import('openfunction/framework/pg-store'); await m.closePgPool(); await m.createPgStore('missing').then(() => { throw Error('missing peer accepted'); }, e => { if (!e.message.includes('optional pg')) throw e; });`]);
  const fakePg = join(consumer, "node_modules/pg"); mkdirSync(fakePg);
  writeFileSync(join(fakePg, "package.json"), JSON.stringify({ name: "pg", version: "8.22.0", type: "module", main: "index.js" }));
  writeFileSync(join(fakePg, "index.js"), `globalThis.pgLoads = (globalThis.pgLoads ?? 0) + 1; export default { Pool: class { constructor() { globalThis.pgPools = (globalThis.pgPools ?? 0) + 1; } async query() { return {rows: []}; } async end() { globalThis.pgEnds = (globalThis.pgEnds ?? 0) + 1; } } };`);
  run("node", ["--input-type=module", "-e", `process.env.DATABASE_URL = 'postgres://fixture'; const m = await import('openfunction/framework/pg-store'); if (globalThis.pgLoads) throw Error('eager load'); const [a,b] = await Promise.all([m.createPgStore('a'), m.createPgStore('b')]); a.set('x', 1); b.set('y', 2); await m.closePgPool(); if (globalThis.pgLoads !== 1 || globalThis.pgPools !== 1 || globalThis.pgEnds !== 1) throw Error('pool sharing/close failed');`]);
  rmSync(fakePg, { recursive: true, force: true });
  writeFileSync(join(consumer, ".env"), "OPENFUNCTION_PACKAGE_IMPORT_SENTINEL=loaded\n");
  // Install optional dev versions only after the minimal root/core proof.
  run("node", ["--input-type=module", "-e", `const root = await import('openfunction'); await import('openfunction/framework'); await import('openfunction/framework/core'); await import('openfunction/framework/pg-store').then(m => m.closePgPool()); if (root.registry.getAll().length) throw Error('import registered tools'); if (process.env.OPENFUNCTION_PACKAGE_IMPORT_SENTINEL) throw Error('import loaded .env');`]);
  assert.equal(existsSync(join(consumer, ".data")), false, "library imports created store files");
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", `pg@${pkg.devDependencies.pg}`, `@siftable/mcp-server@${pkg.devDependencies['@siftable/mcp-server']}`]);
  const imports = run("node", ["--input-type=module", "-e", `for (const name of ${JSON.stringify(subpaths)}) await import(name);`]);
  assert.equal(imports, "", "public imports wrote to stdout");
  const bin = join(consumer, "node_modules/.bin/openfunction");
  assert.match(run(bin, ["help"]), /serve --module/);
  const unknown = spawnSync(bin, ["unknown"], { cwd: consumer, encoding: "utf8" });
  assert.equal(unknown.status, 1); assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /Unknown command/);
  const typeSource = `import { createStore, type Store, type PgStore } from "openfunction";\nconst store: Store<{count:number}> = createStore("typed", {dataDir:"caller-state"}); store.set("x", {count:1});\nconst acknowledge = (store: PgStore<unknown>): Promise<void> => store.flush(); void acknowledge;\n` + subpaths.map((name, index) => `import * as entry${index} from ${JSON.stringify(name)}; void entry${index};`).join("\n");
  writeFileSync(join(consumer, "consumer.ts"), typeSource);
  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "Node16", moduleResolution: "Node16", strict: true, skipLibCheck: true, noEmit: true } }));
  run(join(root, "node_modules/.bin/tsc"), ["-p", join(consumer, "tsconfig.json")]);
  // Read-only package install must load presets and write only caller-owned state.
  function readonly(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name); if (entry.isDirectory()) readonly(child); else chmodSync(child, 0o444);
    }
    chmodSync(path, 0o555);
  }
  readonly(installed);
  run("node", ["--input-type=module", "-e", `import {ToolRegistry, createStore, loadPromptPreset, listPresets} from 'openfunction'; if (!listPresets().includes('default')) throw Error('no default'); if (!loadPromptPreset('default', new ToolRegistry())) throw Error('empty preset'); createStore('caller').set('x', 1); createStore('override', {dataDir: ${JSON.stringify(join(scratch, "explicit-data"))}}).set('x', 2);`]);
  assert.ok(existsSync(join(consumer, ".data/caller.json")));
  assert.ok(existsSync(join(scratch, "explicit-data/override.json")));
  assert.equal(existsSync(join(installed, ".data")), false);
  console.log(`Package verified (${process.version}): ${subpaths.length} public imports, declarations, compiled CLI, presets, caller-owned stores, optional-backend-free core.`);
} finally {
  // Restore directory write access before deleting the read-only install.
  function restoreDirectories(path) {
    if (!existsSync(path)) return;
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) restoreDirectories(join(path, entry.name));
  }
  restoreDirectories(scratch);
  rmSync(scratch, { recursive: true, force: true });
}
