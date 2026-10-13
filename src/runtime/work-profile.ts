/** Trusted single-user deployment configuration for a bounded local work runtime. */
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ToolRegistry } from "../framework/registry.js";
import type { ToolDefinition } from "../framework/types.js";
import { readPrivateFile, JournalInvariantError, initializePrivateRoot } from "../framework/journal-file.js";
import { LocalGrantStore } from "../framework/work/grants.js";
import { LocalWorkBackend, type LocalWorkItem } from "../framework/work/local-backend.js";
import { WorkAttemptController } from "../framework/work/controller.js";
import { createWorkTools } from "../framework/work/tools.js";
import { createLocalFixtureBindings } from "../framework/work/local-fixture.js";
import { scopedPath } from "../framework/work/verification.js";
import type { ResolvedWorkGrant, VerificationBinding, WorkStepBinding } from "../framework/work/types.js";

export interface WorkProfileConfig {
  schemaVersion: 1;
  workspaceRoot: string;
  dataDir: string;
  grantDir: string;
  backend: { kind: "local"; backendId: string; workspaceId: string; projectId?: string; workItems: LocalWorkItem[] };
  stepCatalog: { kind: "fixture"; fixturePath: string; verifierPath: string } | { kind: "module"; modulePath: string };
  limits?: ResolvedWorkGrant["limits"];
  grantTtlMs?: number;
  claimOwner?: string;
  leaseSeconds?: number;
}
export interface TrustedWorkBindings {
  tools: ToolDefinition[];
  steps: Record<string, WorkStepBinding>;
  verificationBindings: readonly VerificationBinding[];
}
export interface WorkProfile {
  config: Readonly<WorkProfileConfig>;
  configPath: string;
  controller: WorkAttemptController;
  registry: ToolRegistry;
  grants: LocalGrantStore;
  limits: ResolvedWorkGrant["limits"];
  grantTtlMs: number;
}
const defaultLimits = { maxAttempts: 1, maxDurationMs: 60 * 60 * 1000, maxActions: 20, maxOutputBytes: 64 * 1024 * 1024 };

/** Revocation remains available even when a job's target or module is missing. */
export function readWorkGrantDirectory(configPath: string): string {
  if (!isAbsolute(configPath)) throw new JournalInvariantError("Work config path must be absolute");
  const config = JSON.parse(readPrivateFile(configPath, 1024 * 1024).toString("utf8")) as { schemaVersion?: number; grantDir?: string };
  if (config?.schemaVersion !== 1 || typeof config.grantDir !== "string" || !isAbsolute(config.grantDir)) throw new JournalInvariantError("Invalid trusted grant directory config");
  return config.grantDir;
}

export function readWorkProfileConfig(configPath: string): WorkProfileConfig {
  if (!isAbsolute(configPath)) throw new JournalInvariantError("Work config path must be absolute");
  let config: WorkProfileConfig;
  try { config = JSON.parse(readPrivateFile(configPath, 1024 * 1024).toString("utf8")) as WorkProfileConfig; }
  catch (error) { if (error instanceof SyntaxError) throw new JournalInvariantError("Work config is not valid JSON"); throw error; }
  if (!config || config.schemaVersion !== 1 || !config.backend || config.backend.kind !== "local" || !config.backend.backendId || !config.backend.workspaceId || !Array.isArray(config.backend.workItems) || !config.backend.workItems.length) throw new JournalInvariantError("Invalid local work profile identity/backend");
  const rejectUnknown = (value: object, allowed: readonly string[], label: string): void => {
    if (Object.keys(value).some((key) => !allowed.includes(key))) throw new JournalInvariantError(`Unexpected ${label} field`);
  };
  rejectUnknown(config, ["schemaVersion", "workspaceRoot", "dataDir", "grantDir", "backend", "stepCatalog", "limits", "grantTtlMs", "claimOwner", "leaseSeconds"], "work config");
  rejectUnknown(config.backend, ["kind", "backendId", "workspaceId", "projectId", "workItems"], "local backend");
  for (const key of ["workspaceRoot", "dataDir", "grantDir"] as const) {
    if (typeof config[key] !== "string" || !isAbsolute(config[key])) throw new JournalInvariantError(`Work profile ${key} must be absolute`);
  }
  scopedPath(config.workspaceRoot, ".");
  if (!config.stepCatalog || !["fixture", "module"].includes(config.stepCatalog.kind)) throw new JournalInvariantError("Work profile requires a finite trusted step catalog");
  rejectUnknown(config.stepCatalog, config.stepCatalog.kind === "fixture" ? ["kind", "fixturePath", "verifierPath"] : ["kind", "modulePath"], "step catalog");
  if (config.stepCatalog.kind === "fixture") {
    if (typeof config.stepCatalog.fixturePath !== "string" || typeof config.stepCatalog.verifierPath !== "string") throw new JournalInvariantError("Fixture catalog requires bound file paths");
    scopedPath(config.workspaceRoot, config.stepCatalog.fixturePath);
    scopedPath(config.workspaceRoot, config.stepCatalog.verifierPath);
  } else if (!isAbsolute(config.stepCatalog.modulePath)) throw new JournalInvariantError("Trusted module path must be absolute");
  for (const item of config.backend.workItems) {
    if (!item.workItemId || !item.contract || item.contract.version !== 1 || !Array.isArray(item.contract.roots) || !item.contract.roots.length || !item.plan || item.plan.state !== "active") throw new JournalInvariantError("Work profile has an invalid work contract or inactive verification plan");
    for (const root of item.contract.roots) { if (!isAbsolute(root)) throw new JournalInvariantError("Contract roots must be absolute"); scopedPath(config.workspaceRoot, root); }
  }
  if (config.limits) rejectUnknown(config.limits, Object.keys(defaultLimits), "work limits");
  for (const [key, value] of Object.entries(config.limits ?? defaultLimits)) if (!Number.isSafeInteger(value) || value <= 0) throw new JournalInvariantError(`Work limit ${key} must be a positive safe integer`);
  if (config.limits && Object.keys(defaultLimits).some((key) => !(key in config.limits!))) throw new JournalInvariantError("All work limits must be specified together");
  if (config.grantTtlMs !== undefined && (!Number.isSafeInteger(config.grantTtlMs) || config.grantTtlMs <= 0)) throw new JournalInvariantError("Grant TTL must be a positive safe integer");
  if (config.leaseSeconds !== undefined && (!Number.isFinite(config.leaseSeconds) || config.leaseSeconds <= 0)) throw new JournalInvariantError("Lease seconds must be positive");
  return config;
}

export async function createWorkProfile(configPath: string): Promise<WorkProfile> {
  const config = readWorkProfileConfig(configPath);
  initializePrivateRoot(config.dataDir);
  const grants = new LocalGrantStore({ rootDir: config.grantDir });
  let bindings: TrustedWorkBindings;
  if (config.stepCatalog.kind === "fixture") {
    bindings = createLocalFixtureBindings({ workspaceRoot: config.workspaceRoot, fixturePath: config.stepCatalog.fixturePath, verifierPath: config.stepCatalog.verifierPath });
  } else {
    // The module is explicitly selected by the trusted config, never tool arguments.
    const module = await import(pathToFileURL(resolve(config.stepCatalog.modulePath)).href);
    if (typeof module.createWorkBindings !== "function") throw new JournalInvariantError("Trusted module must export createWorkBindings({ workspaceRoot })");
    bindings = await module.createWorkBindings({ workspaceRoot: config.workspaceRoot });
  }
  if (!bindings || !Array.isArray(bindings.tools) || !bindings.steps || !Object.keys(bindings.steps).length || !Array.isArray(bindings.verificationBindings) || !bindings.verificationBindings.length) throw new JournalInvariantError("Trusted catalog must export tools, finite steps, and verification bindings");
  const executionRegistry = new ToolRegistry();
  executionRegistry.registerAll(bindings.tools);
  const backend = new LocalWorkBackend({ rootDir: join(config.dataDir, "backend"), backendId: config.backend.backendId, workspaceId: config.backend.workspaceId, ...(config.backend.projectId ? { projectId: config.backend.projectId } : {}), workItems: config.backend.workItems });
  const controller = new WorkAttemptController({ backend, registry: executionRegistry, grantResolver: grants, journalRoot: join(config.dataDir, "attempts"), artifactRoot: join(config.dataDir, "artifacts"), workspaceRoot: config.workspaceRoot, claimOwner: config.claimOwner ?? `local:${config.backend.workspaceId}`, steps: bindings.steps, verificationBindings: bindings.verificationBindings, ...(config.leaseSeconds === undefined ? {} : { leaseSeconds: config.leaseSeconds }) });
  const registry = new ToolRegistry();
  registry.registerAll(createWorkTools(controller));
  return { config, configPath, controller, registry, grants, limits: config.limits ?? { ...defaultLimits }, grantTtlMs: config.grantTtlMs ?? defaultLimits.maxDurationMs };
}
