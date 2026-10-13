/** Trusted local grant custody. Only CLI/application code may issue grants.
 * Same-user processes able to write this directory can change local authority;
 * stronger custody requires OS isolation and host-native authenticated issuers.
 */
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { digestValue } from "../runs.js";
import { snapshotJson } from "../session.js";
import { acquireJournalOwnership, initializePrivateRoot, JournalInvariantError, SecureJsonlJournal, type JournalEnvelope } from "../journal-file.js";
import type { WorkAuthorizationBinding, WorkGrantResolver, ResolvedWorkGrant } from "./types.js";

export type GrantPurpose = "execution" | "completion";
export interface GrantRecord extends ResolvedWorkGrant {
  schemaVersion: 1;
  purpose: GrantPurpose;
  decisionRef: string;
  issuer: { kind: "local_user"; reference: string };
  issuedAt: number;
  binding: WorkAuthorizationBinding;
  bindingDigest: string;
  executionGrantId?: string;
  revokedAt?: number;
}
export type IssueGrantOptions = Omit<ResolvedWorkGrant, "id" | "completion"> & { purpose: GrantPurpose; executionGrantId?: string };
export interface GrantSummary {
  id: string; purpose: GrantPurpose; decisionRef: string; issuedAt: number;
  expiresAt: number; workItemId: string; backendId: string;
  contractDigest: string; planDigest: string; roots: string[];
  actions: string[]; completion: boolean; revokedAt?: number;
  limits: ResolvedWorkGrant["limits"];
}
interface GrantEvent extends JournalEnvelope {
  eventId: string; timestamp: number;
  type: "issued" | "revoked" | "attempt" | "action" | "output";
  grantId: string; record?: GrantRecord; attemptId?: string; bytes?: number; outputExecutionId?: string;
}
interface Usage { startedAt: number; actions: number; outputBytes: number; }

function jsonCopy<T>(value: T): T { return snapshotJson(JSON.parse(JSON.stringify(value)) as T); }
function bindingDigest(binding: WorkAuthorizationBinding): string { return digestValue(jsonCopy(binding)); }
function opaqueId(id: string): void {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new JournalInvariantError("Invalid grant reference");
}
function assertRecord(record: GrantRecord): void {
  if (!record || typeof record !== "object" || record.schemaVersion !== 1
      || !["execution", "completion"].includes(record.purpose)
      || record.issuer?.kind !== "local_user" || !record.issuer.reference
      || !Number.isFinite(record.issuedAt) || !Number.isFinite(record.expiresAt)
      || record.expiresAt <= record.issuedAt || record.completion !== (record.purpose === "completion")
      || !record.binding || bindingDigest(record.binding) !== record.bindingDigest) throw new JournalInvariantError("Invalid grant record/binding");
  opaqueId(record.id); opaqueId(record.decisionRef);
  for (const key of ["backendId", "workItemId", "workspaceId", "contractDigest", "planId", "planDigest", "scopeDigest"] as const) {
    if (typeof record.binding[key] !== "string" || !record.binding[key]) throw new JournalInvariantError("Invalid grant identity");
  }
  if (typeof record.binding.revision !== "string" || !record.binding.revision || !Number.isSafeInteger(record.binding.planVersion) || record.binding.planVersion < 1) throw new JournalInvariantError("Invalid grant revision/plan version");
  if (record.actions.some((action) => !["read","write","test","network","vault","deploy","migrate"].includes(action))) throw new JournalInvariantError("Unsupported grant action");
  for (const list of [record.actions, record.roots, record.include, record.exclude, record.acceptanceMethods]) {
    if (!Array.isArray(list) || list.some((value) => typeof value !== "string" || !value)) throw new JournalInvariantError("Invalid grant scope list");
  }
  if (!record.roots.length || record.roots.some((root) => !isAbsolute(root))) throw new JournalInvariantError("Grant roots must be absolute");
  if (!record.stepBindings || typeof record.stepBindings !== "object" || Array.isArray(record.stepBindings)
      || Object.values(record.stepBindings).some((step) => !step || typeof step.toolName !== "string" || !step.toolName || typeof step.capabilityDigest !== "string" || !step.capabilityDigest)) throw new JournalInvariantError("Invalid grant step bindings");
  for (const value of Object.values(record.limits ?? {})) if (!Number.isSafeInteger(value) || value <= 0) throw new JournalInvariantError("Grant limits must be positive safe integers");
  if (!record.limits || ["maxAttempts", "maxDurationMs", "maxActions", "maxOutputBytes"].some((key) => !(key in record.limits))) throw new JournalInvariantError("Grant limits missing");
  if (record.purpose === "completion") { opaqueId(record.executionGrantId ?? ""); if (!record.acceptanceMethods.length) throw new JournalInvariantError("Completion requires acceptance methods"); }
}
function validateEvent(event: Readonly<GrantEvent>, previous: readonly Readonly<GrantEvent>[]): void {
  opaqueId(event.eventId); opaqueId(event.grantId);
  if (!Number.isFinite(event.timestamp) || !["issued", "revoked", "attempt", "action", "output"].includes(event.type)) throw new JournalInvariantError("Invalid grant audit event");
  if (event.outputExecutionId !== undefined) {
    if (event.type !== "output" || typeof event.outputExecutionId !== "string" || !event.outputExecutionId.trim()) throw new JournalInvariantError("Invalid output execution identity");
    const prior = previous.find((value) => value.type === "output" && value.grantId === event.grantId && value.attemptId === event.attemptId && value.outputExecutionId === event.outputExecutionId);
    if (prior) throw new JournalInvariantError(prior.bytes === event.bytes ? "Duplicate output execution identity" : "Conflicting output execution accounting");
  }
  if (event.type === "issued") {
    if (!event.record || event.record.id !== event.grantId || previous.some((value) => value.grantId === event.grantId)) throw new JournalInvariantError("Grant issuance identity conflict");
    assertRecord(event.record);
  } else {
    if (!previous.some((value) => value.grantId === event.grantId && value.type === "issued")) throw new JournalInvariantError("Grant audit references missing issuance");
    if (["attempt", "action", "output"].includes(event.type) && (typeof event.attemptId !== "string" || !event.attemptId)) throw new JournalInvariantError("Grant usage requires attempt identity");
    if (event.type === "attempt" && previous.some((value) => value.grantId === event.grantId && value.type === "attempt" && value.attemptId === event.attemptId)) throw new JournalInvariantError("Duplicate grant attempt reservation");
    if (["action", "output"].includes(event.type) && !previous.some((value) => value.grantId === event.grantId && value.type === "attempt" && value.attemptId === event.attemptId)) throw new JournalInvariantError("Usage lacks attempt reservation");
    if (event.type === "output" && (!Number.isSafeInteger(event.bytes) || event.bytes! < 0)) throw new JournalInvariantError("Invalid grant output usage");
  }
}

/** Persisted resolver binds current work state; model-provided grant IDs are ignored. */
export class LocalGrantStore implements WorkGrantResolver {
  readonly rootDir: string;
  private readonly journal: SecureJsonlJournal<GrantEvent>;
  constructor(options: { rootDir: string; clock?: () => number }) {
    this.rootDir = initializePrivateRoot(options.rootDir);
    this.clock = options.clock ?? Date.now;
    this.journal = new SecureJsonlJournal({ rootDir: this.rootDir, streamId: "local-grants-v1", scopeDigest: digestValue(this.rootDir), schemaVersion: 1, validate: validateEvent });
    this.journal.read();
  }
  private readonly clock: () => number;
  private records(): GrantRecord[] {
    const records = new Map<string, GrantRecord>();
    for (const event of this.journal.read()) {
      if (event.type === "issued") records.set(event.grantId, jsonCopy(event.record!));
      if (event.type === "revoked") { const record = records.get(event.grantId)!; records.set(event.grantId, { ...record, revokedAt: event.timestamp }); }
    }
    return [...records.values()];
  }
  private append(event: Omit<GrantEvent, keyof JournalEnvelope | "eventId" | "timestamp">): void {
    const prior = this.journal.read();
    this.journal.append({ ...event, schemaVersion: 1, streamId: "local-grants-v1", scopeDigest: digestValue(this.rootDir), seq: prior.length + 1, eventId: randomUUID(), timestamp: this.clock() }, prior.length);
  }
  /** Trusted application operation; never expose this as a model-callable tool. */
  issue(binding: WorkAuthorizationBinding, options: IssueGrantOptions): Readonly<GrantRecord> {
    const lock = acquireJournalOwnership(this.rootDir, "grant-state");
    try {
      const record = jsonCopy<GrantRecord>({ ...options, schemaVersion: 1, id: randomUUID(), decisionRef: randomUUID(), issuer: { kind: "local_user", reference: typeof process.getuid === "function" ? `uid:${process.getuid()}` : "local-user" }, issuedAt: this.clock(), binding, bindingDigest: bindingDigest(binding), completion: options.purpose === "completion" });
      assertRecord(record);
      if (record.expiresAt <= this.clock()) throw new JournalInvariantError("Grant expiry must be in the future");
      if (record.purpose === "completion") {
        const execution = this.records().find((value) => value.id === record.executionGrantId);
        if (!execution || execution.purpose !== "execution" || execution.revokedAt !== undefined || execution.expiresAt < record.expiresAt || execution.bindingDigest !== record.bindingDigest) throw new JournalInvariantError("Completion must bind an active matching execution grant");
      }
      this.append({ type: "issued", grantId: record.id, record });
      return jsonCopy(record);
    } finally { lock.release(); }
  }
  list(): readonly Readonly<GrantSummary>[] {
    return this.records().map((record) => jsonCopy({ id: record.id, purpose: record.purpose, decisionRef: record.decisionRef, issuedAt: record.issuedAt, expiresAt: record.expiresAt, workItemId: record.binding.workItemId, backendId: record.binding.backendId, contractDigest: record.binding.contractDigest, planDigest: record.binding.planDigest, roots: record.roots, actions: record.actions, completion: record.completion, revokedAt: record.revokedAt, limits: record.limits }));
  }
  revoke(id: string): void {
    opaqueId(id);
    const lock = acquireJournalOwnership(this.rootDir, "grant-state");
    try {
      const record = this.records().find((value) => value.id === id);
      if (!record) throw new JournalInvariantError("Unknown grant");
      if (record.revokedAt === undefined) this.append({ type: "revoked", grantId: id });
    } finally { lock.release(); }
  }
  async resolve(binding: WorkAuthorizationBinding, purpose: GrantPurpose): Promise<ResolvedWorkGrant | undefined> {
    const digest = bindingDigest(binding); const now = this.clock(); const records = this.records();
    const selected = records.reverse().find((record) => {
      if (record.purpose !== purpose || record.bindingDigest !== digest || record.revokedAt !== undefined || record.issuedAt > now || record.expiresAt <= now) return false;
      if (purpose === "completion") return records.some((execution) => execution.id === record.executionGrantId && execution.purpose === "execution" && execution.revokedAt === undefined && execution.expiresAt > now && execution.bindingDigest === digest);
      return true;
    });
    return selected ? jsonCopy(selected) : undefined;
  }
  private usage(grantId: string): Map<string, Usage> {
    const attempts = new Map<string, Usage>();
    for (const event of this.journal.read()) {
      if (event.grantId !== grantId || !event.attemptId) continue;
      if (event.type === "attempt") attempts.set(event.attemptId, { startedAt: event.timestamp, actions: 0, outputBytes: 0 });
      if (event.type === "action") { const usage = attempts.get(event.attemptId); if (!usage) throw new JournalInvariantError("Action lacks attempt reservation"); usage.actions++; }
      if (event.type === "output") { const usage = attempts.get(event.attemptId); if (!usage) throw new JournalInvariantError("Output lacks attempt reservation"); usage.outputBytes += event.bytes!; }
    }
    return attempts;
  }
  async reserveAttempt(binding: WorkAuthorizationBinding, attemptId: string): Promise<void> {
    await this.updateUsage(binding, attemptId, "attempt");
  }
  async reserveAction(binding: WorkAuthorizationBinding, attemptId: string): Promise<void> {
    await this.updateUsage(binding, attemptId, "action");
  }
  /** A stable executor ID makes retries of acknowledged accounting effect-free. */
  async recordOutput(binding: WorkAuthorizationBinding, attemptId: string, bytes: number, executionId?: string): Promise<void> {
    await this.updateUsage(binding, attemptId, "output", bytes, executionId);
  }
  private async updateUsage(binding: WorkAuthorizationBinding, attemptId: string, type: "attempt" | "action" | "output", bytes?: number, executionId?: string): Promise<void> {
    if (!attemptId) throw new JournalInvariantError("Attempt identity required");
    if (executionId !== undefined && (type !== "output" || typeof executionId !== "string" || !executionId.trim())) throw new JournalInvariantError("Invalid output execution identity");
    const lock = acquireJournalOwnership(this.rootDir, "grant-state");
    try {
      const grant = await this.resolve(binding, "execution");
      if (!grant) throw new JournalInvariantError("Execution grant is expired, revoked, or mismatched");
      if (type === "output" && executionId !== undefined) {
        const prior = this.journal.read().find((event) => event.type === "output" && event.grantId === grant.id && event.attemptId === attemptId && event.outputExecutionId === executionId);
        if (prior) {
          if (prior.bytes !== bytes) throw new JournalInvariantError("Conflicting output execution accounting");
          return;
        }
      }
      const attempts = this.usage(grant.id); const usage = attempts.get(attemptId);
      if (type === "attempt") {
        if (usage) return;
        if (attempts.size >= grant.limits.maxAttempts) throw new JournalInvariantError("Grant attempt limit exhausted");
      } else {
        if (!usage) throw new JournalInvariantError("Attempt must reserve its grant first");
        if (this.clock() - usage.startedAt >= grant.limits.maxDurationMs) throw new JournalInvariantError("Grant duration limit exhausted");
        if (type === "action" && usage.actions >= grant.limits.maxActions) throw new JournalInvariantError("Grant action limit exhausted");
        if (type === "output" && (!Number.isSafeInteger(bytes) || bytes! < 0 || usage.outputBytes + bytes! > grant.limits.maxOutputBytes)) throw new JournalInvariantError("Grant output limit exhausted");
      }
      this.append({ type, grantId: grant.id, attemptId, ...(bytes === undefined ? {} : { bytes }), ...(executionId === undefined ? {} : { outputExecutionId: executionId }) });
    } finally { lock.release(); }
  }
}
