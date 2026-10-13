/** Work lifecycle evidence references executions without copying their output. */
import { randomUUID } from "node:crypto";
import { assertNoAuthorityCustody } from "../execution-journal.js";
import { JournalInvariantError, SecureJsonlJournal, type JournalEnvelope, type JournalFileLock } from "../journal-file.js";
export type WorkJournalEventType = "prepared" | "authorized" | "claimed" | "running" | "operation_started" | "operation_settled" | "step" | "verification" | "evidence_submitted" | "renewed" | "reconciled" | "review" | "blocked" | "failed" | "completed" | "closed";
export interface WorkJournalEvent { type: WorkJournalEventType; data: Record<string,unknown>; executionId?: string; receiptRef?: string; }
export interface StoredWorkJournalEvent extends JournalEnvelope, WorkJournalEvent { eventId:string; timestamp:string; }
export interface WorkAttemptJournalOptions { rootDir:string; attemptId:string; scopeDigest:string; clock?:()=>Date; requireExisting?:boolean; }
export class WorkAttemptJournal {
  private readonly file:SecureJsonlJournal<StoredWorkJournalEvent>;
  constructor(private readonly options:WorkAttemptJournalOptions) {
    this.file=new SecureJsonlJournal({rootDir:options.rootDir,streamId:options.attemptId,scopeDigest:options.scopeDigest,schemaVersion:1,requireExisting:options.requireExisting,validate:validateWorkEvent});
    this.file.read();
  }
  acquireOwnership():JournalFileLock {return this.file.acquireOwnership();}
  read():readonly Readonly<StoredWorkJournalEvent>[] {return this.file.read();}
  record(event:WorkJournalEvent):void {
    const previous=this.file.read();
    this.file.append({...event,schemaVersion:1,streamId:this.options.attemptId,scopeDigest:this.options.scopeDigest,seq:previous.length+1,eventId:randomUUID(),timestamp:(this.options.clock?.() ?? new Date()).toISOString()},previous.length);
  }
  /** Pure recovery projection; no backend calls, retry or effect dispatch. */
  recover(): {events:readonly Readonly<StoredWorkJournalEvent>[]; unresolvedOperationIds:readonly string[]; terminal:boolean} {
    const events=this.read(); const unresolved=new Set<string>();
    for(const event of events){ const id=event.data.operationId; if(typeof id !== "string")continue; if(event.type === "operation_started")unresolved.add(id); if(event.type === "operation_settled")unresolved.delete(id); }
    return Object.freeze({events,unresolvedOperationIds:Object.freeze([...unresolved]),terminal:events.some(event=>["completed","failed","closed"].includes(event.type))});
  }
}
const types = new Set<WorkJournalEventType>(["prepared","authorized","claimed","running","operation_started","operation_settled","step","verification","evidence_submitted","renewed","reconciled","review","blocked","failed","completed","closed"]);
function validateWorkEvent(event:Readonly<StoredWorkJournalEvent>,previous:readonly Readonly<StoredWorkJournalEvent>[]):void {
  if(!types.has(event.type) || !event.eventId || !Number.isFinite(Date.parse(event.timestamp)) || !event.data || typeof event.data !== "object" || Array.isArray(event.data))throw new JournalInvariantError("Malformed work event");
  assertNoAuthorityCustody(event.data);
  for(const key of ["result","modelContent","output","receipt"]) if(Object.hasOwn(event.data,key))throw new JournalInvariantError("Work journal must reference execution output");
  if(!previous.length && event.type !== "prepared")throw new JournalInvariantError("Work attempt must start prepared");
  if(previous.length && event.type === "prepared")throw new JournalInvariantError("Work attempt already prepared");
  if(previous.some(prior=>prior.eventId === event.eventId))throw new JournalInvariantError("Duplicate work event id");
  if(previous.some(prior=>prior.type === "closed"))throw new JournalInvariantError("Work attempt is closed");
  if(previous.some(prior=>["completed","failed"].includes(prior.type)) && event.type !== "closed")throw new JournalInvariantError("Terminal work attempt accepts only close");
  if(event.type === "step" && (!event.executionId || !event.receiptRef))throw new JournalInvariantError("Work step needs execution and receipt references");
  if(event.type === "operation_started" || event.type === "operation_settled") {
    const id=event.data.operationId; if(typeof id !== "string" || !id)throw new JournalInvariantError("Operation identity required");
    const own=previous.filter(prior=>prior.data.operationId === id && (prior.type === "operation_started" || prior.type === "operation_settled"));
    if(event.type === "operation_started" && own.length)throw new JournalInvariantError("Operation identity reused");
    if(event.type === "operation_settled" && own[own.length-1]?.type !== "operation_started")throw new JournalInvariantError("Settlement requires durable operation start");
  }
}
