/** Durable single-user backend. State and receipts commit together under file CAS. */
import { randomUUID } from "node:crypto";
import { digestJson, snapshotJson } from "../session.js";
import { JournalInvariantError, SecureJsonlJournal, type JournalEnvelope } from "../journal-file.js";
import type { BackendCapabilities, BackendReceipt, LeaseRef, OperationKind, OperationRef, ReconciliationResult, VerificationEvidence, VerificationPlanSnapshot, WorkBackend, WorkContract, WorkSnapshot } from "./types.js";
export interface LocalWorkItem {workItemId:string;contract:WorkContract;plan:Omit<VerificationPlanSnapshot,"digest"|"coverage">;dependencies?:string[];humanReviewRequired?:boolean;}
export interface LocalWorkBackendOptions {rootDir:string;backendId:string;workspaceId:string;projectId?:string;workItems:readonly LocalWorkItem[];clock?:()=>number;}
interface LocalState {snapshot:WorkSnapshot;plan:VerificationPlanSnapshot;receipts:Record<string,BackendReceipt>;openDigests:Record<string,string>;}
interface LocalEvent extends JournalEnvelope {state:LocalState;}
export class LocalWorkBackend implements WorkBackend {
 readonly capabilities:BackendCapabilities={version:"local-file-v1",keyedOperations:["open","start","heartbeat","evidence","complete","review","block","fail","release"],receiptLookup:["open","start","heartbeat","evidence","complete","review","block","fail","release"],missingReceiptProvesNotStarted:true,expiredLeaseRelease:true};
 private readonly items=new Map<string,LocalWorkItem>();
 constructor(private readonly options:LocalWorkBackendOptions){
   if(!options.backendId || !options.workspaceId)throw new JournalInvariantError("Local backend identity required");
   for(const item of options.workItems){if(this.items.has(item.workItemId))throw new JournalInvariantError("Duplicate local work identity");this.items.set(item.workItemId,snapshotJson(item) as LocalWorkItem);}
 }
 private now():number {return this.options.clock?.() ?? Date.now();}
 private file(id:string):SecureJsonlJournal<LocalEvent>{
   if(!this.items.has(id))throw new JournalInvariantError("Unknown selected work item");
   return new SecureJsonlJournal({rootDir:this.options.rootDir,streamId:`local-work:${id}`,scopeDigest:digestJson({backendId:this.options.backendId,workspaceId:this.options.workspaceId,projectId:this.options.projectId}),schemaVersion:1,validate:event=>{
     if(!event.state || event.state.snapshot.backendId !== this.options.backendId || event.state.snapshot.workItemId !== id || event.state.snapshot.workspaceId !== this.options.workspaceId || event.state.snapshot.contractDigest !== digestJson(event.state.snapshot.contract))throw new JournalInvariantError("Invalid local backend state");
   }});
 }
 private initial(id:string):LocalState {
   const item=this.items.get(id)!;const plan={...item.plan,digest:digestJson(item.plan),coverage:{}};
   return {snapshot:{backendId:this.options.backendId,workItemId:id,workspaceId:this.options.workspaceId,...(this.options.projectId ? {projectId:this.options.projectId}:{}),revision:"1",contract:item.contract,contractDigest:digestJson(item.contract),state:"ready",claimable:true,dependenciesSatisfied:true,humanReviewRequired:item.humanReviewRequired ?? false,sourceRefs:[`local:${this.options.backendId}:${id}`]},plan,receipts:{},openDigests:{}};
 }
 private load(id:string):LocalState {const events=this.file(id).read();return structuredClone(events[events.length-1]?.state ?? this.initial(id));}
 private mutate<T>(id:string,fn:(state:LocalState)=>T):T {
   const file=this.file(id);const owner=file.acquireOwnership();
   try{const events=file.read();const state=structuredClone(events[events.length-1]?.state ?? this.initial(id));const result=fn(state);file.append({schemaVersion:1,streamId:`local-work:${id}`,scopeDigest:digestJson({backendId:this.options.backendId,workspaceId:this.options.workspaceId,projectId:this.options.projectId}),seq:events.length+1,state},events.length);return snapshotJson(result) as T;}finally{owner.release();}
 }
 async inspect(id:string):Promise<WorkSnapshot> {
   const state=this.load(id);const item=this.items.get(id)!;
   const dependenciesSatisfied=(item.dependencies ?? []).every(dep=>this.load(dep).snapshot.state === "completed");
   return snapshotJson({...state.snapshot,dependenciesSatisfied,claimable:dependenciesSatisfied && ["ready","released"].includes(state.snapshot.state) && (!state.snapshot.lease || state.snapshot.lease.expiresAt <= this.now())}) as WorkSnapshot;
 }
 async getVerificationPlan(id:string):Promise<VerificationPlanSnapshot>{return snapshotJson(this.load(id).plan) as VerificationPlanSnapshot;}
 async open(input:{workItemId:string;claimOwner:string;leaseSeconds:number;idempotencyKey:string}):Promise<LeaseRef> {
   if(!input.claimOwner || !Number.isFinite(input.leaseSeconds) || input.leaseSeconds <= 0 || !input.idempotencyKey)throw new JournalInvariantError("Invalid local claim");
   const dependenciesSatisfied=(this.items.get(input.workItemId)?.dependencies ?? []).every(dep=>this.load(dep).snapshot.state === "completed");
   return this.mutate(input.workItemId,state=>{
     const digest=digestJson(input);const prior=state.receipts[input.idempotencyKey];
     if(prior){if(state.openDigests[input.idempotencyKey] !== digest)throw new JournalInvariantError("Conflicting idempotency payload");return prior.lease!;}
     if(!dependenciesSatisfied || !["ready","released"].includes(state.snapshot.state) || state.snapshot.lease && state.snapshot.lease.expiresAt > this.now())throw new JournalInvariantError("Work is not claimable");
     const lease:LeaseRef={id:randomUUID(),backendId:this.options.backendId,workItemId:input.workItemId,owner:input.claimOwner,expiresAt:this.now()+input.leaseSeconds*1000};
     state.snapshot.lease=lease;state.snapshot.state="claimed";state.snapshot.claimable=false;
     state.openDigests[input.idempotencyKey]=digest;
     state.receipts[input.idempotencyKey]={id:randomUUID(),operationId:input.idempotencyKey,kind:"open",payloadDigest:digest,workItemId:input.workItemId,state:"claimed",lease};return lease;
   });
 }
 private assertLease(state:LocalState,lease:LeaseRef):LeaseRef {
   const live=state.snapshot.lease;
   if(!live || lease.backendId !== this.options.backendId || live.id !== lease.id || live.owner !== lease.owner || live.expiresAt <= this.now())throw new JournalInvariantError("Expired or mismatched local lease");return live;
 }
 private keyed(state:LocalState,key:string,kind:OperationKind,payload:unknown,fn:()=>Partial<BackendReceipt>):BackendReceipt {
   const digest=digestJson(payload);const old=state.receipts[key];
   if(old){if(old.kind !== kind || old.payloadDigest !== digest)throw new JournalInvariantError("Conflicting idempotency payload");return old;}
   if(!key)throw new JournalInvariantError("Operation key required");
   const receipt:BackendReceipt={id:randomUUID(),operationId:key,kind,payloadDigest:digest,workItemId:state.snapshot.workItemId,state:state.snapshot.state,...fn()};
   receipt.state=state.snapshot.state;state.receipts[key]=receipt;return receipt;
 }
 async transition(lease:LeaseRef,action:Exclude<OperationKind,"open"|"evidence"|"release">,payload:Record<string,unknown>,key:string):Promise<BackendReceipt> {
   return this.mutate(lease.workItemId,state=>this.keyed(state,key,action,{leaseId:lease.id,action,payload},()=>{
     const live=this.assertLease(state,lease);
     if(action === "start"){if(state.snapshot.state !== "claimed")throw new JournalInvariantError("Start requires claim");state.snapshot.state="running";}
     else if(action === "heartbeat") {if(!["claimed","running"].includes(state.snapshot.state))throw new JournalInvariantError("Terminal lease cannot renew");const seconds=payload.leaseSeconds;if(typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0)throw new JournalInvariantError("Lease duration required");live.expiresAt=this.now()+seconds*1000;}
     else {
       if(!["claimed","running"].includes(state.snapshot.state))throw new JournalInvariantError("Transition requires active work");
       if(action === "complete" && (state.snapshot.humanReviewRequired || !state.plan.steps.some(step=>step.required) || !state.plan.steps.filter(step=>step.required).every(step=>state.plan.coverage[step.id]?.outcome === "passed")))throw new JournalInvariantError("Completion proof missing or review required");
       state.snapshot.state=action === "complete" ? "completed" : action === "review" ? "needs_review" : action === "block" ? "blocked" : "failed";
     }
     return {lease:{...live}};
   }));
 }
 async submitEvidence(lease:LeaseRef,evidence:VerificationEvidence,operation:OperationRef):Promise<BackendReceipt> {
   if(operation.kind !== "evidence" || operation.payloadDigest !== digestJson(evidence) || operation.capabilityVersion !== this.capabilities.version)throw new JournalInvariantError("Evidence operation binding mismatch");
   return this.mutate(lease.workItemId,state=>this.keyed(state,operation.backendKey ?? operation.id,"evidence",evidence,()=>{
     this.assertLease(state,lease);const step=state.plan.steps.find(step=>step.id === evidence.stepId);
     if(state.snapshot.state !== "running" || evidence.backendId !== this.options.backendId || evidence.workItemId !== lease.workItemId || evidence.planId !== state.plan.id || evidence.planVersion !== state.plan.version || !step || step.specDigest !== evidence.specDigest || step.environment !== evidence.environment)throw new JournalInvariantError("Evidence work/plan binding mismatch");
     state.plan.coverage[evidence.stepId]=evidence;return {evidenceId:evidence.id};
   }));
 }
 async release(lease:LeaseRef,key:string):Promise<BackendReceipt>{return this.mutate(lease.workItemId,state=>this.keyed(state,key,"release",{leaseId:lease.id},()=>{
   const current=state.snapshot.lease;
   // Deliberate local recovery rule: an expired owner may explicitly release
   // only its unchanged lease. CAS and id/owner matching fence a successor.
   // This never marks effects reconciled or proves their absence.
   if(!current || current.id !== lease.id || current.owner !== lease.owner || lease.backendId !== this.options.backendId || !["claimed","running"].includes(state.snapshot.state))throw new JournalInvariantError("Release lease does not match current local custody");
   state.snapshot.state="released";state.snapshot.claimable=true;delete state.snapshot.lease;return {};
 }));}
 async reconcileOperation(operation:OperationRef):Promise<ReconciliationResult> {
   for(const id of this.items.keys()) {
     const state=this.load(id);const receipt=state.receipts[operation.backendKey ?? operation.id];
     if(receipt){if(receipt.kind !== operation.kind || receipt.payloadDigest !== operation.payloadDigest)throw new JournalInvariantError("Operation reconciliation payload mismatch");return {state:"settled",receipt,sourceRefs:state.snapshot.sourceRefs};}
   }
   return {state:"authoritatively_not_started",sourceRefs:[`local:${this.options.backendId}:committed-receipts`]};
 }
}
