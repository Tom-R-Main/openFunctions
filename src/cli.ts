#!/usr/bin/env node
/** Executable entry; the public library itself has no startup side effects. */
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { digestJson } from "./framework/session.js";
import { readPrivateFile, writePrivateFileAtomic } from "./framework/journal-file.js";
import type { WorkPreview } from "./framework/work/types.js";
import type { WorkProfile } from "./runtime/work-profile.js";

interface AuthorizationPreview { schemaVersion: 1; configPath: string; configDigest: string; work: WorkPreview; digest: string; }
function flags(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!; const value = args[index + 1];
    if (!allowed.includes(key) || value === undefined || value.startsWith("--") || key in result) throw new Error(`Unexpected or missing option ${key}`);
    result[key] = value;
  }
  return result;
}
function required(options: Record<string, string>, name: string, absolute = false): string {
  const value = options[name];
  if (!value) throw new Error(`Missing ${name}`);
  if (absolute && !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}
function emit(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }
async function profile(config: string): Promise<WorkProfile> {
  const { createWorkProfile } = await import("./runtime/work-profile.js");
  return createWorkProfile(config);
}
function readPreview(path: string): AuthorizationPreview {
  const preview = JSON.parse(readPrivateFile(path, 4 * 1024 * 1024).toString("utf8")) as AuthorizationPreview;
  if (!preview || preview.schemaVersion !== 1 || !preview.work || !preview.configPath || !preview.configDigest || !preview.digest) throw new Error("Invalid authorization preview");
  const { digest, ...rest } = preview;
  if (digestJson(rest) !== digest) throw new Error("Authorization preview digest mismatch");
  return preview;
}
async function assertCurrentPreview(runtime: WorkProfile, saved: AuthorizationPreview): Promise<WorkPreview> {
  if (saved.configPath !== runtime.configPath || saved.configDigest !== digestJson(runtime.config)) throw new Error("Configuration changed; prepare a new authorization preview");
  const { readWorkProfileConfig } = await import("./runtime/work-profile.js");
  if (saved.configDigest !== digestJson(readWorkProfileConfig(runtime.configPath))) throw new Error("Configuration changed during review; prepare again");
  const fresh = await runtime.controller.prepare(saved.work.binding.workItemId);
  const relevant = (work: WorkPreview) => ({ binding: work.binding, steps: work.steps, contract: work.snapshot.contract, plan: { id: work.plan.id, version: work.plan.version, digest: work.plan.digest, state: work.plan.state, steps: work.plan.steps } });
  if (digestJson(relevant(fresh)) !== digestJson(relevant(saved.work))) throw new Error("Work contract, scope, catalog or verification plan changed; prepare again");
  return fresh;
}
async function authorize(runtime: WorkProfile, saved: AuthorizationPreview): Promise<void> {
  const preview = await assertCurrentPreview(runtime, saved);
  const expiresAt = Date.now() + runtime.grantTtlMs;
  emit({ review: { backend: preview.binding.backendId, workItem: preview.binding.workItemId, binding: preview.binding, roots: preview.snapshot.contract.roots, include: preview.snapshot.contract.include, exclude: preview.snapshot.contract.exclude, actions: preview.snapshot.contract.actions, steps: preview.steps, trustedCatalog: runtime.config.stepCatalog, ...(runtime.config.stepCatalog.kind === "fixture" ? { verificationCommand: { executable: process.execPath, argv: [resolve(runtime.config.workspaceRoot, runtime.config.stepCatalog.verifierPath), resolve(runtime.config.workspaceRoot, runtime.config.stepCatalog.fixturePath)], environment: "local-node", nodeVersion: process.version } } : {}), verification: preview.plan.steps, acceptanceMethods: preview.snapshot.contract.acceptanceCriteria, limits: runtime.limits, expiresAt: new Date(expiresAt).toISOString(), automaticCompletionDefault: false } });
  const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
  const answers = readline[Symbol.asyncIterator]();
  async function decision(prompt: string): Promise<string> {
    process.stdout.write(prompt);
    const result = await answers.next();
    return result.done ? "" : result.value.trim();
  }
  try {
    if (await decision("Type AUTHORIZE to grant execution for this exact scope (anything else refuses): ") !== "AUTHORIZE") {
      emit({ authorized: false }); return;
    }
    await assertCurrentPreview(runtime, saved);
    const common = { expiresAt, actions: preview.snapshot.contract.actions, roots: preview.snapshot.contract.roots, include: preview.snapshot.contract.include, exclude: preview.snapshot.contract.exclude, stepBindings: Object.fromEntries(Object.entries(preview.steps).map(([key, step]) => [key, { toolName: step.toolName, capabilityDigest: step.capabilityDigest }])), acceptanceMethods: preview.snapshot.contract.acceptanceCriteria.map((criterion) => criterion.method), limits: runtime.limits };
    const execution = runtime.grants.issue(preview.binding, { ...common, purpose: "execution" });
    const completionDecision = await decision("Automatic completion requires every displayed method and fresh evidence. Type COMPLETE to grant it; Enter keeps it off: ");
    let completionId: string | undefined;
    if (completionDecision === "COMPLETE") {
      await assertCurrentPreview(runtime, saved);
      completionId = runtime.grants.issue(preview.binding, { ...common, purpose: "completion", executionGrantId: execution.id }).id;
    }
    emit({ authorized: true, executionGrantId: execution.id, ...(completionId ? { completionGrantId: completionId } : {}), automaticCompletion: Boolean(completionId), expiresAt: new Date(expiresAt).toISOString() });
  } finally { readline.close(); }
}
async function workCommand(args: string[]): Promise<void> {
  const [operation, ...rest] = args;
  if (operation === "prepare") {
    const options = flags(rest, ["--config", "--work-item", "--out"]);
    const configPath = required(options, "--config", true); const output = required(options, "--out", true);
    const runtime = await profile(configPath);
    const work = await runtime.controller.prepare(required(options, "--work-item"));
    const data = { schemaVersion: 1 as const, configPath, configDigest: digestJson(runtime.config), work };
    writePrivateFileAtomic(output, Buffer.from(JSON.stringify({ ...data, digest: digestJson(data) }, null, 2)), true);
    emit({ prepared: true, previewPath: output, workItemId: work.binding.workItemId, contractDigest: work.binding.contractDigest, planDigest: work.binding.planDigest });
    return;
  }
  if (operation === "authorize") {
    const options = flags(rest, ["--config", "--preview"]);
    const runtime = await profile(required(options, "--config", true));
    await authorize(runtime, readPreview(required(options, "--preview", true)));
    return;
  }
  if (operation === "grants") {
    const [action, ...grantArgs] = rest;
    const options = flags(grantArgs, action === "list" ? ["--config"] : ["--config", "--grant"]);
    // Grant inspection/revocation never needs a functioning job or step module.
    const { readWorkGrantDirectory } = await import("./runtime/work-profile.js");
    const { LocalGrantStore } = await import("./framework/work/grants.js");
    const grantDir = readWorkGrantDirectory(required(options, "--config", true));
    const store = new LocalGrantStore({ rootDir: grantDir });
    if (action === "list") { emit(store.list()); return; }
    if (action === "revoke") { const id = required(options, "--grant"); store.revoke(id); emit({ revoked: true, grantId: id }); return; }
  }
  throw new Error("Usage: openfunction work prepare|authorize|grants list|grants revoke --config <absolute-json-path> ...");
}
async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) {
    console.log("Usage: openfunction <command>\n\n" +
      "  serve --module <path>                         Serve an exported ToolRegistry over MCP stdio\n" +
      "  serve --profile work --config <absolute-path> Serve bounded local work tools\n" +
      "  work prepare --config <path> --work-item <id> --out <path>\n" +
      "  work authorize --config <path> --preview <path>\n" +
      "  work grants list --config <path>\n" +
      "  work grants revoke --config <path> --grant <id>\n" +
      "  hermes-config --config <path> [--command <executable>]\n" +
      "  workshop                                     Run the bundled workshop tools\n" +
      "  help                                         Show this help");
    return;
  }
  if (command === "work") { await workCommand(args); return; }
  if (command === "workshop") {
    if (args.length) throw new Error("workshop does not accept arguments");
    await import("./workshop.js"); return;
  }
  if (command === "hermes-config") {
    const options = flags(args, ["--config", "--command"]); const runtime = await profile(required(options, "--config", true));
    const { createHermesMcpConfig } = await import("./framework/hermes.js");
    const customCommand = options["--command"];
    emit(createHermesMcpConfig(runtime.registry, { command: customCommand ?? process.execPath, args: [...(customCommand ? [] : [fileURLToPath(import.meta.url)]), "serve", "--profile", "work", "--config", runtime.configPath], cwd: runtime.config.dataDir, trust: "untrusted", protocol: "legacy", resources: false, prompts: false, supportsParallelToolCalls: false }));
    return;
  }
  if (command === "serve") {
    const options = flags(args, ["--module", "--profile", "--config"]);
    const { startServer, createMcpServer } = await import("./framework/server.js");
    if (options["--profile"] === "work" && !options["--module"]) {
      const runtime = await profile(required(options, "--config", true));
      const handle = createMcpServer(runtime.registry, { name: "openfunction-work", version: "1.0.0" });
      let stopping = false;
      const stop = () => {
        if (stopping) return; stopping = true;
        void Promise.resolve(runtime.controller.shutdown()).then(() => handle.close()).then(() => {
          process.stdin.pause(); process.exitCode = 0;
        }, (error: unknown) => { console.error(error instanceof Error ? error.message : "Work shutdown failed"); process.exitCode = 1; });
      };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      process.stdin.once("end", stop);
      await handle.connect(); return;
    }
    if (options["--module"] && !options["--profile"] && !options["--config"]) {
      const entry = await import(pathToFileURL(resolve(options["--module"])).href);
      const { ToolRegistry } = await import("./framework/registry.js");
      const registry = entry.registry ?? entry.default;
      if (!(registry instanceof ToolRegistry)) throw new Error("The module must export registry (or default) as a ToolRegistry");
      await startServer(registry, { name: "openfunction", version: "1.0.0" }); return;
    }
    throw new Error("Usage: openfunction serve --module <path> OR serve --profile work --config <absolute-json-path>");
  }
  throw new Error(`Unknown command: ${command}. Run openfunction help.`);
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "OpenFunction failed");
  process.exitCode = 1;
});
