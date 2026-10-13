/** Provision the pinned host only through Hermes's own managed runtime launcher. */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
const flags = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!["--hermes-root", "--runtime-dir", "--data-dir", "--out"].includes(key) || !process.argv[i + 1]) throw Error(`Invalid option ${key}`);
  flags[key.slice(2)] = process.argv[i + 1];
}
for (const key of ["hermes-root", "runtime-dir", "data-dir", "out"]) if (!flags[key] || !isAbsolute(flags[key])) throw Error(`Provisioning requires absolute --${key}`);
const commit = "7cc3fb8cb55898747dd1dfa56fda3e16ebba028e";
if (execFileSync("git", ["rev-parse", "HEAD"], { cwd: flags["hermes-root"], encoding: "utf8" }).trim() !== commit) throw Error("Wrong Hermes checkout; expected pinned commit " + commit);
mkdirSync(flags["data-dir"], { recursive: true, mode: 0o700 });
mkdirSync(flags["runtime-dir"], { recursive: true, mode: 0o700 });
const child = spawn(join(flags["hermes-root"], "scripts/run-in-hermes-env"), ["python", "-c", "import sys; print(sys.executable)"], { cwd: flags["hermes-root"], env: { ...process.env, HERMES_HOME: flags["data-dir"], HERMES_RUNTIME_DIR: flags["runtime-dir"] }, stdio: ["ignore", "pipe", "inherit"] });
let stdout = "";
child.stdout.on("data", chunk => { stdout += chunk; });
const status = await new Promise((accept, reject) => { child.once("error", reject); child.once("exit", (code, signal) => accept({ code, signal })); });
if (status.code !== 0) throw Error(`Hermes PM provisioning failed (${status.code ?? status.signal}); host boundary remains unproven`);
const python = stdout.trim();
if (!isAbsolute(python) || !existsSync(python) || python.includes("\n")) throw Error("Official launcher did not return one valid absolute managed interpreter path");
mkdirSync(dirname(flags.out), { recursive: true });
writeFileSync(flags.out, JSON.stringify({ schemaVersion: 1, hermesCommit: commit, hermesRoot: resolve(flags["hermes-root"]), python, runtimeDir: resolve(flags["runtime-dir"]), provisioningHome: resolve(flags["data-dir"]) }, null, 2), { mode: 0o600 });
console.log(`Pinned Hermes runtime provisioned; interpreter record: ${flags.out}`);
