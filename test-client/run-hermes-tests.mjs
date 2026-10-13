/** Real pinned Hermes integration. Missing explicit host inputs fail instead of skipping. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!["--hermes-root", "--python", "--runtime-dir", "--tarball", "--mode", "--install-mode", "--out"].includes(key) || !process.argv[i + 1]) throw Error(`Invalid option ${key}`);
  options[key.slice(2)] = process.argv[i + 1];
}
for (const key of ["hermes-root", "python", "runtime-dir"]) {
  if (!options[key] || !isAbsolute(options[key])) throw Error(`test:hermes requires absolute --${key}; provision Hermes with its PM first`);
}
const pin = "7cc3fb8cb55898747dd1dfa56fda3e16ebba028e";
if (options.mode && !["smoke", "portable", "work"].includes(options.mode)) throw Error("Supported --mode values: smoke, portable, work");
if (options["install-mode"] && !["offline", "online"].includes(options["install-mode"])) throw Error("--install-mode must be offline or online (dependency acquisition only)");
if (options.out && !isAbsolute(options.out)) throw Error("--out must be an absolute evidence directory");
function run(command, args, cwd = root, extra = {}) {
  return execFileSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
}
assert.equal(run("git", ["rev-parse", "HEAD"], options["hermes-root"]).trim(), pin, "Hermes must match the reviewed pin");
const scratch = mkdtempSync(join(tmpdir(), "openfunction-hermes-"));
const consumer = join(scratch, "consumer");
mkdirSync(consumer);
writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
const tarball = options.tarball ? resolve(options.tarball) : join(scratch, JSON.parse(run("npm", ["pack", "--json", "--pack-destination", scratch]))[0].filename);
run("npm", ["install", ...(options["install-mode"] === "online" ? [] : ["--offline"]), "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund", tarball], consumer);
assert.equal(existsSync(join(consumer, "node_modules/pg")), false, "Local Hermes proof must not require pg");
assert.equal(existsSync(join(consumer, "node_modules/@siftable/mcp-server")), false, "Local Hermes proof must not require Siftable");
const binary = join(consumer, "node_modules/.bin/openfunction");
const effect = join(scratch, "effects.jsonl");
const fixture = join(consumer, "tools.mjs");
writeFileSync(fixture, `import {ToolRegistry,defineTool,ok} from 'openfunction/framework/core';
import {appendFileSync,readFileSync,existsSync} from 'node:fs';
export const registry=new ToolRegistry();
registry.register(defineTool({name:'smoke_read',description:'Read isolated fixture effect count',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true},handler:async()=>ok({count:existsSync(${JSON.stringify(effect)})?readFileSync(${JSON.stringify(effect)},'utf8').trim().split('\\n').length:0})}));
registry.register(defineTool({name:'smoke_write',description:'Append one isolated fixture effect',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:false},handler:async()=>{appendFileSync(${JSON.stringify(effect)},JSON.stringify({effect:'approved'})+'\\n');return ok({written:true});}}));`);
const home = join(scratch, "profile-a");
mkdirSync(home);
const settings = {
  model: { context_length: 65536 }, // Declared local fixture window; the pinned host requires >=64K.
  mcp_servers: { openfunctions: { command: binary, args: ["serve", "--module", fixture], cwd: consumer, protocol: "legacy", trust: "untrusted", timeout: 30, connect_timeout: 30, supports_parallel_tool_calls: false, tools: { include: ["smoke_read", "smoke_write"], resources: false, prompts: false } } },
};
const configPath = join(home, "config.yaml");
writeFileSync(configPath, JSON.stringify(settings)); // JSON is a YAML subset.
const details = { pin, scratch, binary, fixture, effect, plugin: join(root, "plugins/hermes-openfunctions"), python: options.python, mode: options.mode ?? "smoke", tarball, tarballSha256: createHash("sha256").update(readFileSync(tarball)).digest("hex"), nodeMcpSdk: JSON.parse(readFileSync(join(consumer, "node_modules/@modelcontextprotocol/sdk/package.json"), "utf8")).version, optionalBackendsInstalled: false };
if (details.mode !== "smoke") {
  const gitFixture = join(scratch, "plugin-fixture");
  mkdirSync(gitFixture);
  cpSync(details.plugin, join(gitFixture, "portable"), { recursive: true });
  run("git", ["init", "--quiet"], gitFixture);
  run("git", ["add", "portable"], gitFixture);
  run("git", ["-c", "user.name=OpenFunction test fixture", "-c", "user.email=fixture@localhost", "commit", "--quiet", "-m", "Hermes isolated portable fixture"], gitFixture);
  details.pluginSource = `file://${gitFixture}#portable`;
  details.pluginRef = run("git", ["rev-parse", "HEAD"], gitFixture).trim();
}
writeFileSync(join(scratch, "inputs.json"), JSON.stringify(details));
const env = { ...process.env, HERMES_HOME: home, HERMES_RUNTIME_DIR: options["runtime-dir"], PATH: `${join(consumer, "node_modules/.bin")}:${process.env.PATH}`, OPENAI_API_KEY: "local-fixture-only", OPENROUTER_API_KEY: "", ANTHROPIC_API_KEY: "", DATABASE_URL: "" };
const stdout = openSync(join(scratch, "host.stdout.log"), "w");
const stderr = openSync(join(scratch, "host.stderr.log"), "w");
console.log(`Running pinned Hermes in ${scratch}`);
const child = spawn(join(options["hermes-root"], "scripts/run-in-hermes-env"), [options.python, join(root, "test-client/fixtures/hermes-host-proof.py"), join(scratch, "inputs.json")], { cwd: options["hermes-root"], env, stdio: ["ignore", stdout, stderr], timeout: 600_000 });
const result = await new Promise((accept, reject) => { child.once("error", reject); child.once("exit", (status, signal) => accept({ status, signal })); });
closeSync(stdout); closeSync(stderr);
if (options.out) {
  mkdirSync(options.out, { recursive: true, mode: 0o700 });
  for (const name of ["evidence.json", "inputs.json", "host.stdout.log", "host.stderr.log"]) {
    if (existsSync(join(scratch, name))) copyFileSync(join(scratch, name), join(options.out, name));
  }
}
if (result.status !== 0) throw Error(`Real Hermes proof failed (${result.status ?? result.signal}); logs: ${scratch}\n${readFileSync(join(scratch, "host.stderr.log"), "utf8").slice(-4000)}`);
const evidence = JSON.parse(readFileSync(join(scratch, "evidence.json"), "utf8"));
assert.equal(evidence.hermesCommit, pin);
assert.equal(evidence.approvedEffects, 1);
assert.equal(evidence.refusalEffects, 0);
console.log(`Real Hermes ${details.mode} proof passed; evidence: ${join(scratch, "evidence.json")}`);
