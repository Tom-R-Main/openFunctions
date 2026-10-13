/** Standalone execution evidence. Reopening and replay never dispatch handlers. */
import { randomUUID } from "node:crypto";
import { snapshotJson, digestJson } from "./session.js";
import { JournalInvariantError, SecureJsonlJournal, type JournalEnvelope, type JournalFileLock } from "./journal-file.js";

import type { ExecutionJournalEvent } from "./execution-types.js";
export type { ExecutionJournalEvent } from "./execution-types.js";
export interface StoredExecutionEvent extends JournalEnvelope, ExecutionJournalEvent { eventId: string; timestamp: string; }
export interface ExecutionJournalOptions { rootDir: string; streamId: string; scopeDigest: string; clock?: () => Date; requireExisting?:boolean; expectedFileIdentity?:{dev:string;ino:string}; }
export interface RecoveredExecution {
  executionId: string;
  state: "not_started" | "unknown" | "settled";
  events: readonly Readonly<StoredExecutionEvent>[];
  /** Recorded canonical receipt/result/modelContent, returned exactly as evidence. */
  settled?: Readonly<Record<string, unknown>>;
}

/** Authority custody is excluded, not merely hidden from model-facing output. */
export function assertNoAuthorityCustody(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(authorization|credentials?|api[_-]?key|access[_-]?token|refresh[_-]?token|claim[_-]?token|raw[_-]?token|session[_-]?handle|bearer|password|private[_-]?key|grants?|approval)$/i.test(key)) throw new JournalInvariantError(`Authority custody field forbidden in journal: ${key}`);
    assertNoAuthorityCustody(child);
  }
}

export class ExecutionJournal {
  private readonly file: SecureJsonlJournal<StoredExecutionEvent>;
  private readonly options: ExecutionJournalOptions;
  constructor(options: ExecutionJournalOptions) {
    this.options = {...options};
    this.file = new SecureJsonlJournal({...options, schemaVersion:1, validate:validateExecutionEvent});
    // Verify the entire committed stream immediately; do not defer corruption to dispatch.
    this.file.initialize();
  }
  fileIdentity():{dev:string;ino:string} {return this.file.fileIdentity();}
  acquireOwnership(): JournalFileLock { return this.file.acquireOwnership(); }
  read(): readonly Readonly<StoredExecutionEvent>[] { return this.file.read(); }
  record(candidate: ExecutionJournalEvent): void {
    const event = snapshotJson(candidate, "execution event");
    const previous = this.file.read();
    this.file.append({...event, schemaVersion:1, streamId:this.options.streamId, scopeDigest:this.options.scopeDigest, seq:previous.length+1, eventId:randomUUID(), timestamp:(this.options.clock?.() ?? new Date()).toISOString()},previous.length);
  }
  getExecution(id: string): RecoveredExecution | undefined { return this.recover().find(item => item.executionId === id); }
  recover(): readonly RecoveredExecution[] {
    const grouped = new Map<string, Readonly<StoredExecutionEvent>[]>();
    for (const event of this.read()) { const items=grouped.get(event.executionId) ?? []; items.push(event); grouped.set(event.executionId,items); }
    return Object.freeze([...grouped].map(([executionId, events]) => {
      const final=events[events.length-1]!;
      const settled=final.type === "settled" || final.type === "rejected" ? final.data : undefined;
      return Object.freeze({executionId, state: settled ? "settled" as const : events.some(event=>event.type === "started") ? "unknown" as const : "not_started" as const,events:Object.freeze(events), ...(settled ? {settled} : {})});
    }));
  }
}
function validateExecutionEvent(event: Readonly<StoredExecutionEvent>, previous: readonly Readonly<StoredExecutionEvent>[]):void {
  if (!event.executionId || !event.eventId || !Number.isFinite(Date.parse(event.timestamp)) || !event.data || Array.isArray(event.data) || typeof event.data !== "object") throw new JournalInvariantError("Malformed execution event");
  assertNoAuthorityCustody(event.data);
  if(previous.some(prior=>prior.eventId === event.eventId)) throw new JournalInvariantError("Duplicate execution event id");
  const own=previous.filter(prior=>prior.executionId === event.executionId);
  const prior=own[own.length-1]?.type;
  const valid = event.type === "requested" ? prior === undefined : event.type === "admitted" || event.type === "rejected" ? prior === "requested" : event.type === "started" ? prior === "admitted" : event.type === "settled" ? prior === "started" || prior === "admitted" : false;
  if(!valid)throw new JournalInvariantError(`Invalid execution lifecycle ${prior ?? "none"} -> ${event.type}`);
  if(event.type === "settled" || event.type === "rejected") {
    if(!event.data.result || typeof event.data.result !== "object" || typeof (event.data.result as {success?:unknown}).success !== "boolean" || typeof event.data.modelContent !== "string")throw new JournalInvariantError("Settlement requires canonical result and model content");
    try{if(digestJson(JSON.parse(event.data.modelContent)) !== digestJson(event.data.result))throw new JournalInvariantError("Model content/result mismatch");}catch{throw new JournalInvariantError("Invalid canonical model content");}
    const receipt=event.data.receipt as Record<string,unknown> | undefined;
    if(!receipt || receipt.executionId !== event.executionId || receipt.schemaVersion !== 1 || !["succeeded","failed","unknown"].includes(String(receipt.executionOutcome)))throw new JournalInvariantError("Receipt execution identity mismatch");
    const requested=own[0]!.data;
    for(const key of ["toolName","inputDigest","capabilityDigest"]) {
      if(requested[key] !== undefined && receipt[key] !== requested[key])throw new JournalInvariantError(`Receipt ${key} binding mismatch`);
    }
    if(receipt.resultDigest !== digestJson(event.data.result))throw new JournalInvariantError("Receipt result digest mismatch");
  }
  if(event.type === "settled" && prior === "started") {
    const receipt=event.data.receipt as {phase?:unknown;admission?:unknown;startedAt?:unknown};
    if(receipt.phase !== "settled" && !(receipt.phase === "not_started" && receipt.admission === "rejected" && receipt.startedAt === undefined))throw new JournalInvariantError("Started settlement requires settled or proven-not-dispatched phase");
  }
  // Cancellation between admission and dispatch can settle only as not-started.
  if(event.type === "settled" && prior === "admitted") {
    const receipt=event.data.receipt as Record<string,unknown> | undefined;
    if(receipt?.phase !== "not_started") throw new JournalInvariantError("Unstarted settlement requires a not-started receipt");
  }
  if(event.type === "rejected") {
    const receipt=event.data.receipt as Record<string,unknown> | undefined;
    if(receipt?.phase !== "not_started" || receipt.admission !== "rejected")throw new JournalInvariantError("Rejection requires a not-started receipt");
  }
}
