/** Own one explicitly selected bounded attempt. No model loop or implicit recovery effects. */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { FileArtifactStore } from "../artifacts.js";
import { projectWorkOutput } from "./output.js";
import type { ToolResult } from "../types.js";
import { ExecutionJournal } from "../execution-journal.js";
import { capabilityDigest } from "../executor.js";
import { digestJson, snapshotJson } from "../session.js";
import { acquireJournalOwnership, initializePrivateRoot, JournalInvariantError, readPrivateFile, writePrivateFileAtomic, type JournalFileLock } from "../journal-file.js";
import { WorkAttemptJournal } from "./journal.js";
import { fingerprintSubject, pathMatches, scopedPath } from "./verification.js";
import type { BackendReceipt, LeaseRef, OperationKind, OperationRef, ResolvedWorkGrant, VerificationEvidence, WorkAuthorizationBinding, WorkControllerOptions, WorkPreview, WorkSnapshot, WorkState, WorkStepExecution } from "./types.js";
import type { ToolExecution, ExecutionPolicy, ToolExecutionContext, ToolExecutionReceipt, ExecutionJournalSink } from "../execution-types.js";
import type { ToolRegistry } from "../registry.js";

class Mutex {
 private tail:Promise<void>=Promise.resolve();
 async run<T>(callback:()=>Promise<T>):Promise<T>{const before=this.tail;let release!:()=>void;this.tail=new Promise<void>(resolve=>release=resolve);await before;try{return await callback();}finally{release();}}
}
interface PendingOperation {ref:OperationRef;payload:Record<string,unknown>;status:"started"|"settled";backendReceipt?:BackendReceipt;}
interface StepIntent {stepKey:string;inputDigest:string;capabilityDigest:string;admittedPaths:string[];reconciliationMetadata?:Readonly<Record<string,unknown>>;oracleDigest?:string;}
interface PersistedAttempt {
 attemptId:string;workItemId:string;executionFileIdentity?:{dev:string;ino:string};binding:WorkAuthorizationBinding;preview:WorkPreview;state:WorkState;
 startedAt:number;mutationEpoch:number;actions:number;outputBytes:number;accountedOutputs:Record<string,{bytes:number;recorded:boolean}>;lease?:LeaseRef;
 operations:Record<string,PendingOperation>;inflightSteps:Record<string,StepIntent>;unknownSteps:Record<string,StepIntent>;oracleRuns:Record<string,{originalExecutionId:string;oracleDigest:string;inputDigest:string}>;effectResolutions:Record<string,{effect:"verified";readbackExecutionId:string;sourceRefs:string[]}>;
 evidence:Record<string,VerificationEvidence>;verificationRuns:Record<string,{stepId:string;evidenceId:string}>;outputArtifacts:Record<string,string>;unknownExecutions:string[];renewalFailed:boolean;
}
export class WorkAttemptController {
 private readonly admissions=new Mutex();private readonly lifecycle=new Mutex();
 private state?:PersistedAttempt;private journal?:WorkAttemptJournal;private executions?:ExecutionJournal;
 private ownership?:JournalFileLock;private controllerOwnership?:JournalFileLock;private timer?:ReturnType<typeof setTimeout>;private stopping=false;
 private readonly lifetime=new AbortController();private inflight=new Set<Promise<unknown>>();
 private artifacts!:FileArtifactStore;private previewArtifacts?:FileArtifactStore;private readonly registry:ToolRegistry;
 private readonly root:string;private readonly activePath:string;
 constructor(private readonly options:WorkControllerOptions){
   this.root=initializePrivateRoot(options.journalRoot);this.activePath=join(this.root,"active-attempt.json");

   this.registry=options.registry.project({names:Object.values(options.steps).map(step=>step.toolName)},this.policy());
   if(existsSync(this.activePath)) {
     const active=JSON.parse(readPrivateFile(this.activePath,64*1024).toString("utf8")) as {attemptId:string;workItemId:string;scopeDigest:string;executionFileIdentity?:{dev:string;ino:string}};
     if(!active.attemptId || !active.workItemId || !active.scopeDigest)throw new JournalInvariantError("Malformed active work reference");
     this.attach(active.attemptId,active.scopeDigest,true,active.executionFileIdentity);
     const events=this.journal!.read();const last=events[events.length-1];
     if(last){this.state=structuredClone(last.data.state) as PersistedAttempt;this.validateRecovered();}else throw new JournalInvariantError("Active attempt journal has no prepared event");
   }
 }
 /** Bound the facade reply without changing durable work/evidence or certainty. */
 projectOutput(result:ToolResult):ToolResult {
   return projectWorkOutput(result,()=>this.state ? this.artifacts : this.previewArtifactStore());
 }
 private previewArtifactStore():FileArtifactStore {
   return this.previewArtifacts ??= this.options.artifactStore ?? new FileArtifactStore({rootDir:join(this.options.artifactRoot,"previews")});
 }
 /** Opaque IDs select current-attempt or preview outputs; prior attempts are not searched. */
 readOutputArtifact(artifactId:string,options:{offset?:number;length?:number}={}):Record<string,unknown> {
   if(typeof artifactId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(artifactId))throw new JournalInvariantError("Invalid opaque artifact id");
   const stores=[...(this.state ? [this.artifacts] : []),this.previewArtifactStore()];
   let selected:FileArtifactStore|undefined;
   for(const store of stores) {if(existsSync(join(store.rootDir,`${artifactId}.artifact`))){store.metadata(artifactId);selected=store;break;}}
   if(!selected)throw new JournalInvariantError("Output artifact is unavailable in this work profile");
   const artifact=selected.metadata(artifactId);const offset=options.offset ?? 0;
   const length=options.length ?? Math.min(16384,selected.maxReadBytes,Math.max(0,artifact.sizeBytes-offset));
   if(length>16384)throw new JournalInvariantError("Artifact read exceeds work output bounds");
   const bytes=selected.read(artifactId,{offset,length});
   return {artifact,offset,length,encoding:"base64",data:bytes.toString("base64"),hasMore:offset+length<artifact.sizeBytes};
 }
 private assertAdmissionContext(context:ToolExecutionContext={}):void {
   if(this.stopping || this.lifetime.signal.aborted || context.signal?.aborted || context.deadline !== undefined && (!Number.isFinite(context.deadline) || context.deadline <= this.now()))throw new JournalInvariantError("Work admission cancelled or deadline elapsed");
 }
 private requestSignal(context:ToolExecutionContext={}):AbortSignal {return context.signal ? AbortSignal.any([context.signal,this.lifetime.signal]) : this.lifetime.signal;}
 private now():number{return this.options.clock?.() ?? Date.now();}
 private attach(id:string,scope:string,recovery=false,expectedFileIdentity?:{dev:string;ino:string}):void {
   this.artifacts=this.options.artifactStore ?? new FileArtifactStore({rootDir:join(this.options.artifactRoot,id)});
   this.journal=new WorkAttemptJournal({rootDir:this.root,attemptId:id,scopeDigest:scope,requireExisting:recovery});
   this.executions=new ExecutionJournal({rootDir:join(this.root,"executions"),streamId:id,scopeDigest:scope,requireExisting:recovery,expectedFileIdentity});
 }
 private validateRecovered():void {
   const state=this.state!;state.verificationRuns ??= {};state.outputArtifacts ??= {};state.unknownSteps ??= {};state.effectResolutions ??= {};state.accountedOutputs ??= {};state.oracleRuns ??= {};
   if(state.attemptId !== this.journal!.read()[0]!.streamId || state.binding.scopeDigest !== this.journal!.read()[0]!.scopeDigest || state.binding.backendId !== state.preview.binding.backendId || state.binding.workItemId !== state.workItemId)throw new JournalInvariantError("Recovered attempt identity mismatch");
   if(Object.keys(state.inflightSteps).length || Object.keys(state.verificationRuns).length || Object.values(state.operations).some(operation=>operation.status === "started"))state.state="reconciliation_required";
   // A lease from the former process is evidence, never fresh ownership authority.
 }
 private persist(type:Parameters<WorkAttemptJournal["record"]>[0]["type"],data:Record<string,unknown>={},refs:{executionId?:string;receiptRef?:string}={}):void {
   if(!this.state || !this.journal)throw new JournalInvariantError("No work attempt");
   this.journal.record({type,data:{...data,state:snapshotJson(this.state)},...refs});
 }
 private requireState():PersistedAttempt {if(!this.state)throw new JournalInvariantError("No selected work attempt");return this.state;}
 private ensureOwner():void {
   if(this.ownership)return;
   this.controllerOwnership=acquireJournalOwnership(this.root,"active-controller");
   try{this.ownership=this.journal!.acquireOwnership();}catch(error){this.controllerOwnership.release();this.controllerOwnership=undefined;throw error;}
 }
 private releaseOwnership():void {this.ownership?.release();this.ownership=undefined;this.controllerOwnership?.release();this.controllerOwnership=undefined;}
 private async grant(purpose:"execution"|"completion"="execution",cleanup=false):Promise<ResolvedWorkGrant> {
   const state=this.requireState();const grant=await this.options.grantResolver.resolve(state.binding,purpose);
   if(!grant || grant.expiresAt <= this.now() || purpose === "completion" && !grant.completion)throw new JournalInvariantError(`Current ${purpose} grant missing or expired`);
   if(!cleanup && state.outputBytes >= grant.limits.maxOutputBytes)throw new JournalInvariantError("Attempt output budget is exhausted; fresh stronger authorization required");
   if(!cleanup && this.now()-state.startedAt >= grant.limits.maxDurationMs)throw new JournalInvariantError("Attempt duration limit reached");return grant;
 }
 private accountOutput(executionId:string,bytes:number):void {
   const state=this.requireState();if(state.accountedOutputs[executionId])return;
   if(!Number.isSafeInteger(bytes) || bytes < 0)throw new JournalInvariantError("Invalid execution output accounting");
   state.outputBytes+=bytes;state.accountedOutputs[executionId]={bytes,recorded:false};
 }
 private async recordOutput(executionId:string):Promise<void> {
   const state=this.requireState();const entry=state.accountedOutputs[executionId];if(!entry || entry.recorded)return;
   await this.options.grantResolver.reserveAttempt?.(state.binding,state.attemptId);
   await this.options.grantResolver.recordOutput?.(state.binding,state.attemptId,entry.bytes,executionId);
   entry.recorded=true;this.persist("reconciled",{outputAccountedExecutionId:executionId,bytes:entry.bytes});
 }
 private policy():ExecutionPolicy {return {authorize:async ({toolSnapshot,params})=>{
   try {
     const state=this.requireState();
     const accepting=()=>!this.stopping && ["running","verifying"].includes(state.state) && !state.unknownExecutions.length && !state.renewalFailed;
     if(!accepting())return {decision:"deny",reasonCodes:["work_reconciliation_required"]};
     // Queueing and journal I/O can outlive the ownership observed at admission.
     await this.fresh(["running"]);
     const grant=await this.grant();
     if(!accepting() || !state.lease || state.lease.expiresAt <= this.now())return {decision:"deny",reasonCodes:["inactive_work_lease"]};
     const step=Object.entries(this.options.steps).find(([,binding])=>binding.toolName === toolSnapshot.name);
     if(!step || grant.stepBindings[step[0]]?.capabilityDigest !== capabilityDigest(toolSnapshot) || grant.stepBindings[step[0]]?.toolName !== toolSnapshot.name || !grant.actions.includes(step[1].action) || !state.preview.snapshot.contract.actions.includes(step[1].action))return {decision:"deny",reasonCodes:["unbound_work_step"]};
     step[1].validateParams?.(params);this.validatePaths(step[1].paths?.(params) ?? [],grant);return {decision:"allow",authorityGrantRefs:[grant.id],expiresAt:grant.expiresAt};
   }catch{return {decision:"deny",reasonCodes:["work_authority_unavailable"]};}
 }};}
 private validatePaths(paths:readonly string[],grant:ResolvedWorkGrant):void {
   for(const path of paths){const absolute=scopedPath(this.options.workspaceRoot,path,true);const rel=relative(resolve(this.options.workspaceRoot),absolute).replaceAll("\\","/");
     const allowedRoot=grant.roots.some(root=>{const part=relative(resolve(root),absolute);return part !== ".." && !part.startsWith("../") && !isAbsolute(part);});
     const contract=this.requireState().preview.snapshot.contract;
     const contractRoot=contract.roots.some(root=>{const part=relative(resolve(root),absolute);return part !== ".." && !part.startsWith("../") && !isAbsolute(part);});
     if(!allowedRoot || !contractRoot || !pathMatches(rel,grant.include) || pathMatches(rel,grant.exclude) || !pathMatches(rel,contract.include) || pathMatches(rel,contract.exclude))throw new JournalInvariantError("Step path outside granted scope");
   }
 }
 private binding(snapshot:WorkSnapshot,plan:WorkPreview["plan"]):WorkAuthorizationBinding {
   return {backendId:snapshot.backendId,workItemId:snapshot.workItemId,workspaceId:snapshot.workspaceId,...(snapshot.projectId ? {projectId:snapshot.projectId}:{}),contractDigest:snapshot.contractDigest,revision:snapshot.revision,planId:plan.id,planVersion:plan.version,planDigest:plan.digest,scopeDigest:digestJson({backendId:snapshot.backendId,workspaceId:snapshot.workspaceId,projectId:snapshot.projectId,workspaceRoot:resolve(this.options.workspaceRoot),contractDigest:snapshot.contractDigest})};
 }
 async prepare(workItemId:string,context:ToolExecutionContext={}):Promise<WorkPreview> {
   const [snapshot,plan]=await Promise.all([this.options.backend.inspect(workItemId,context.signal),this.options.backend.getVerificationPlan(workItemId,context.signal)]);
   if(snapshot.workItemId !== workItemId || snapshot.contractDigest !== digestJson(snapshot.contract) || plan.state !== "active" || plan.digest !== digestJson({id:plan.id,version:plan.version,state:plan.state,steps:plan.steps}))throw new JournalInvariantError("Selected work contract or active plan invalid");
   const steps=Object.fromEntries(Object.entries(this.options.steps).map(([key,step])=>[key,{toolName:step.toolName,action:step.action,capabilityDigest:step.capabilityDigest}]));
   const binding=this.binding(snapshot,plan);const createdAt=this.now();
   return snapshotJson({binding,snapshot,plan,steps,createdAt,digest:digestJson({binding,snapshot,plan,steps,createdAt})}) as WorkPreview;
 }
 private validateLease(lease:LeaseRef,requireLive=true):void {
   const state=this.requireState();
   if(!lease || typeof lease.id !== "string" || !lease.id || lease.backendId !== state.binding.backendId || lease.workItemId !== state.workItemId || lease.owner !== this.options.claimOwner || !Number.isFinite(lease.expiresAt) || requireLive && lease.expiresAt <= this.now())throw new JournalInvariantError("Lease descriptor identity, owner or expiry mismatch");
 }
 private validateBackendReceipt(receipt:BackendReceipt,operation:OperationRef):void {
   const state=this.requireState();
   if(!receipt || typeof receipt.id !== "string" || !receipt.id || receipt.kind !== operation.kind || receipt.operationId !== (operation.backendKey ?? operation.id) || receipt.payloadDigest !== operation.payloadDigest || receipt.workItemId !== state.workItemId)throw new JournalInvariantError("Backend receipt operation/work binding mismatch");
   const expected={open:["claimed"],start:["running"],heartbeat:["claimed","running"],evidence:["running"],complete:["completed"],review:["needs_review"],block:["blocked"],fail:["failed"],release:["released"]}[operation.kind];
   if(!expected.includes(receipt.state))throw new JournalInvariantError("Backend receipt lifecycle mismatch");
   if(receipt.lease)this.validateLease(receipt.lease,false);
 }
 private async fresh(allowedStates:readonly string[]=["running","completed"]):Promise<{snapshot:WorkSnapshot;plan:WorkPreview["plan"]}> {
   const state=this.requireState();const preview=await this.prepare(state.workItemId);
   if(digestJson(preview.binding) !== digestJson(state.binding))throw new JournalInvariantError("Work contract, plan or scope changed");
   if(!allowedStates.includes(preview.snapshot.state))throw new JournalInvariantError("Selected backend lifecycle is incompatible with dispatch");
   if(state.lease)this.validateLease(state.lease,false);
   if(preview.snapshot.lease)this.validateLease(preview.snapshot.lease);
   if(!state.lease || !preview.snapshot.lease || state.lease.id !== preview.snapshot.lease.id || state.lease.owner !== preview.snapshot.lease.owner || preview.snapshot.lease.expiresAt <= this.now())throw new JournalInvariantError("Fresh backend lease ownership unavailable");
   state.lease=preview.snapshot.lease;return {snapshot:preview.snapshot,plan:preview.plan};
 }
 private operation(kind:OperationKind,payload:Record<string,unknown>,id:string=randomUUID()):OperationRef {
   const caps=this.options.backend.capabilities;
   return {id,kind,payloadDigest:digestJson(payload),capabilityVersion:caps.version,...(caps.keyedOperations.includes(kind) ? {backendKey:id}:{}),...(caps.deduplicationWindowMs ? {deduplicationDeadline:this.now()+caps.deduplicationWindowMs}: {})};
 }
 private async backendOperation(kind:OperationKind,payload:Record<string,unknown>,dispatch:(ref:OperationRef)=>Promise<BackendReceipt>,id?:string,backendKey?:string,context:ToolExecutionContext={}):Promise<BackendReceipt> {
   this.assertAdmissionContext(context);const state=this.requireState();const ref=this.operation(kind,payload,id);if(backendKey){if(!this.options.backend.capabilities.keyedOperations.includes(kind))throw new JournalInvariantError("Backend keyed recovery unsupported");ref.backendKey=backendKey;}state.operations[ref.id]={ref,payload,status:"started"};this.persist("operation_started",{operationId:ref.id,kind,capabilityVersion:ref.capabilityVersion,payloadDigest:ref.payloadDigest});
   try{const receipt=await dispatch(ref);this.validateBackendReceipt(receipt,ref);state.operations[ref.id]!.status="settled";state.operations[ref.id]!.backendReceipt=receipt;if(receipt.lease)state.lease=receipt.lease;this.persist("operation_settled",{operationId:ref.id,backendReceiptRef:receipt.id});return receipt;}
   catch(error){state.state="reconciliation_required";this.stopTimer();this.persist("reconciled",{operationId:ref.id,disposition:"unknown"});throw error;}
 }
 async start(workItemId:string,context:ToolExecutionContext={}):Promise<unknown> {
   return this.admissions.run(async()=>{
     if(this.stopping)throw new JournalInvariantError("Controller shut down");
     if(this.state && !["completed","released","failed"].includes(this.state.state))throw new JournalInvariantError("Existing attempt must be reconciled or finished");
     const preview=await this.prepare(workItemId,context);this.assertAdmissionContext(context);if(!preview.snapshot.claimable || !preview.snapshot.dependenciesSatisfied)throw new JournalInvariantError("Selected work is not claimable");
     const authorized=await this.options.grantResolver.resolve(preview.binding,"execution");this.assertAdmissionContext(context);
     if(!authorized || authorized.expiresAt <= this.now() || authorized.limits.maxAttempts < 1)throw new JournalInvariantError("Current execution grant missing, expired or exhausted");
     const priorState=this.state;const attemptId=this.options.attemptId ?? randomUUID();this.releaseOwnership();this.attach(attemptId,preview.binding.scopeDigest);this.ensureOwner();
     this.state={attemptId,workItemId,executionFileIdentity:this.executions!.fileIdentity(),binding:preview.binding,preview,state:"prepared",startedAt:this.now(),mutationEpoch:0,actions:0,outputBytes:0,accountedOutputs:{},operations:{},inflightSteps:{},unknownSteps:{},oracleRuns:{},effectResolutions:{},evidence:{},verificationRuns:{},outputArtifacts:{},unknownExecutions:[],renewalFailed:false};
     let grant:ResolvedWorkGrant;
     try{grant=await this.grant();await this.options.grantResolver.reserveAttempt?.(preview.binding,attemptId);}catch(error){this.releaseOwnership();this.state=priorState;throw error;}
     this.persist("prepared",{grantRef:grant.id});writePrivateFileAtomic(this.activePath,Buffer.from(JSON.stringify({attemptId,workItemId,scopeDigest:preview.binding.scopeDigest,executionFileIdentity:this.state.executionFileIdentity})),true);
     this.state.state="claiming";
     return this.lifecycle.run(async()=>{
       const id=randomUUID();const payload={workItemId,claimOwner:this.options.claimOwner,leaseSeconds:this.options.leaseSeconds ?? 120,idempotencyKey:id};
       const receipt=await this.backendOperation("open",payload,async()=>{
         const lease=await this.options.backend.open(payload,this.requestSignal(context));this.validateLease(lease);return {id:lease.id,operationId:id,kind:"open",payloadDigest:digestJson(payload),workItemId,state:"claimed",lease};
       },id,undefined,context);
       this.state!.lease=receipt.lease;await this.fresh(["claimed"]);await this.grant();
       await this.backendOperation("start",{leaseId:receipt.lease!.id,action:"start",payload:{}},ref=>this.options.backend.transition(receipt.lease!,"start",{},ref.backendKey ?? ref.id,this.requestSignal(context)),undefined,undefined,context);
       this.state!.state="running";this.persist("running");this.scheduleRenewal();return this.safeStatus();
     });
   });
 }
 async step(stepKey:string,rawParams:Record<string,unknown>,context:ToolExecutionContext={}):Promise<WorkStepExecution> {
   const params=snapshotJson(rawParams,"work step parameters") as Record<string,unknown>;this.assertAdmissionContext(context);
   const admitted=await this.admissions.run(async()=>{
     const state=this.requireState();this.ensureOwner();
     if(this.stopping || !["running","verifying"].includes(state.state) || Object.keys(state.inflightSteps).length && state.state === "verifying")throw new JournalInvariantError("Attempt is not accepting work steps");
     const sourceStep=this.options.steps[stepKey];const step=sourceStep ? Object.freeze({...sourceStep}):undefined;if(state.state === "verifying" && this.inflight.size && step?.action !== "read")throw new JournalInvariantError("Verification freezes work mutations");if(!step)throw new JournalInvariantError("Unregistered work step");
     const grant=await this.grant();await this.fresh();
     if(state.renewalFailed || state.lease!.expiresAt-this.now() <= (this.options.renewalSafetyMs ?? 250) || !grant.actions.includes(step.action) || !state.preview.snapshot.contract.actions.includes(step.action) || grant.stepBindings[stepKey]?.toolName !== step.toolName || grant.stepBindings[stepKey]?.capabilityDigest !== step.capabilityDigest)throw new JournalInvariantError("Step authority or lease unavailable");
     const tool=this.registry.get(step.toolName);if(!tool || capabilityDigest(tool) !== step.capabilityDigest)throw new JournalInvariantError("Step capability changed");
     step.validateParams?.(snapshotJson(params));this.validatePaths(step.paths?.(params) ?? [],grant);
     if(state.actions >= grant.limits.maxActions)throw new JournalInvariantError("Action limit reached");
     const admittedPaths=step.paths?.(params) ?? [];
     const reconciliationMetadata=step.prepareReconciliation ? snapshotJson(step.prepareReconciliation(params,this.options.workspaceRoot),"effect readback metadata"):undefined;
     const oracleDigest=step.prepareReconciliation && step.reconcileEffect && step.reconciliationSpecDigest ? digestJson({specDigest:step.reconciliationSpecDigest,prepare:Function.prototype.toString.call(step.prepareReconciliation),readback:Function.prototype.toString.call(step.reconcileEffect),capabilityDigest:step.capabilityDigest}):undefined;
     await this.options.grantResolver.reserveAttempt?.(state.binding,state.attemptId);
     await this.options.grantResolver.reserveAction?.(state.binding,state.attemptId);
     this.assertAdmissionContext(context);state.actions++;if(step.action !== "read"){state.mutationEpoch++;state.evidence={};state.state="running";}
     const id=randomUUID();state.inflightSteps[id]={stepKey,inputDigest:digestJson(params),capabilityDigest:step.capabilityDigest,admittedPaths,...(reconciliationMetadata ? {reconciliationMetadata}:{}),...(oracleDigest ? {oracleDigest}: {})};
     this.persist("reconciled",{stepIntentId:id,stepKey,inputDigest:digestJson(params),mutationEpoch:state.mutationEpoch});
     return {id,step,grant,context:{...context,callId:id,runId:state.attemptId,expectedCapabilityDigest:step.capabilityDigest,signal:context.signal ? AbortSignal.any([context.signal,this.lifetime.signal]) : this.lifetime.signal,deadline:Math.min(context.deadline ?? Infinity,grant.expiresAt,state.startedAt+grant.limits.maxDurationMs)} satisfies ToolExecutionContext};
   });
   const publishUncertainty=async (receipt:ToolExecutionReceipt)=>{
     // Publish uncertainty while the executor still owns its reservation.
     // Otherwise its next queued effect can start before step() sees the result.
     await this.admissions.run(async()=>{
       const state=this.requireState();state.state="reconciliation_required";
       if(!state.unknownExecutions.includes(receipt.executionId))state.unknownExecutions.push(receipt.executionId);
       state.unknownSteps[receipt.executionId]=state.inflightSteps[admitted.id]!;
       this.persist("reconciled",{disposition:"execution_uncertain",stepIntentId:admitted.id},{executionId:receipt.executionId,receiptRef:receipt.executionId});
     });
   };
   const lifecycle:ExecutionJournalSink={
     record:event=>this.executions!.record(event),
     onSettled:async execution=>{if(execution.outcome === "unknown")await publishUncertainty(execution.receipt);},
   };
   const call=this.registry.executeDetailed(admitted.step.toolName,params,admitted.context,lifecycle);this.inflight.add(call);
   let execution:ToolExecution;
   try{execution=await call;}finally{this.inflight.delete(call);}
   await this.admissions.run(async()=>{
     const state=this.requireState();const intent=state.inflightSteps[admitted.id]!;delete state.inflightSteps[admitted.id];
     const bytes=Buffer.byteLength(execution.modelContent);this.accountOutput(execution.receipt.executionId,bytes);
     if(execution.outcome === "unknown"){state.state="reconciliation_required";if(!state.unknownExecutions.includes(execution.receipt.executionId))state.unknownExecutions.push(execution.receipt.executionId);state.unknownSteps[execution.receipt.executionId]=intent;}
     this.persist("step",{stepIntentId:admitted.id,stepKey,executionOutcome:execution.outcome}, {executionId:execution.receipt.executionId,receiptRef:execution.receipt.executionId});
     try{
       await this.recordOutput(execution.receipt.executionId);
       if(state.outputBytes > admitted.grant.limits.maxOutputBytes)throw new JournalInvariantError("Work output limit reached");
     }catch(error){state.state="reconciliation_required";this.persist("reconciled",{disposition:"output_accounting_failed",executionRef:execution.receipt.executionId});throw error;}
   });
   if(Buffer.byteLength(JSON.stringify(execution))>30*1024){
     try{const artifact=this.artifacts.put(execution.modelContent,{mediaType:"application/json"});this.requireState().outputArtifacts[execution.receipt.executionId]=artifact.id;this.persist("reconciled",{outputArtifactRef:artifact.id,executionRef:execution.receipt.executionId});return {...execution,artifactProjection:{artifact,executionId:execution.receipt.executionId,receiptRef:execution.receipt.executionId}};}
     catch(error){this.requireState().state="reconciliation_required";this.persist("reconciled",{disposition:"output_artifact_failed",executionRef:execution.receipt.executionId});throw error;}
   }

   return execution;
 }
 private async verificationAdmission(stepId:string):Promise<{binding:WorkControllerOptions["verificationBindings"][number];plan:WorkPreview["plan"]}> {
   return this.admissions.run(async()=>{
     const state=this.requireState();this.ensureOwner();if(this.stopping || !["running","verifying"].includes(state.state) || Object.keys(state.inflightSteps).length || state.unknownExecutions.length || this.inflight.size)throw new JournalInvariantError("Work effects must drain before verification");
     await this.grant();const {plan}=await this.fresh();const step=plan.steps.find(step=>step.id === stepId);const binding=this.options.verificationBindings.find(binding=>binding.stepId === stepId && binding.specDigest === step?.specDigest && binding.environment === step.environment);
     if(!step || !binding || ["human","external"].includes(step.kind))throw new JournalInvariantError("Verification method unsupported or unbound");
     state.state="verifying";this.persist("reconciled",{verificationIntent:stepId});return {binding,plan};
   });
 }
 async verify(stepId:string,context:ToolExecutionContext={}):Promise<VerificationEvidence> {
   this.assertAdmissionContext(context);
   const {binding,plan}=await this.verificationAdmission(stepId);const state=this.requireState();
   const runId=randomUUID();const evidenceId=randomUUID();
   const verificationDeadline=await this.admissions.run(async()=>{
     const grant=await this.grant();if(!grant.actions.includes("test") || !state.preview.snapshot.contract.actions.includes("test") || state.actions >= grant.limits.maxActions)throw new JournalInvariantError("Verification test authority or action limit unavailable");
     await this.options.grantResolver.reserveAttempt?.(state.binding,state.attemptId);await this.options.grantResolver.reserveAction?.(state.binding,state.attemptId);state.actions++;
     state.verificationRuns[runId]={stepId,evidenceId};this.persist("reconciled",{verificationRunId:runId,stepId,evidenceId});
     return Math.min(context.deadline ?? Infinity,this.now()+plan.steps.find(step=>step.id === stepId)!.timeoutMs,grant.expiresAt,state.startedAt+grant.limits.maxDurationMs);
   });
   const privateRegistry=this.options.registry.project({names:[]},{authorize:async()=>{
     try{const grant=await this.grant();await this.fresh(["running"]);if(this.stopping || !["running","verifying"].includes(state.state) || state.unknownExecutions.length || state.renewalFailed || !grant.actions.includes("test") || !state.lease || state.lease.expiresAt <= this.now())return {decision:"deny",reasonCodes:["verification_authority_unavailable"]};return {decision:"allow",authorityGrantRefs:[grant.id],expiresAt:grant.expiresAt};}catch{return {decision:"deny",reasonCodes:["verification_grant_unavailable"]};}
   }});
   const tool={name:`_of_verify_${stepId.replace(/[^a-zA-Z0-9_]/g,"_")}`,description:"Run the exact configured active verification binding",inputSchema:{type:"object" as const,properties:{},additionalProperties:false},contract:{version:"1",useWhen:[],doNotUseWhen:[],sideEffects:["Execute separately authorized verification command"],commitmentClass:"C1" as const,idempotency:"non_idempotent" as const,requiresAuthority:true,mutation:true,bounds:{specDigest:binding.specDigest,environment:binding.environment}},handler:async(_params:Record<string,unknown>,boundContext?:ToolExecutionContext)=>{
     const before=fingerprintSubject(this.options.workspaceRoot,state.binding.workspaceId,binding.inputs,state.mutationEpoch);const startedAt=this.now();
     const result=await binding.run({workspaceRoot:this.options.workspaceRoot,signal:boundContext?.signal ?? (context.signal ? AbortSignal.any([context.signal,this.lifetime.signal]) : this.lifetime.signal)});
     const readbackPassed=result.readbackPassed && await binding.readback(this.options.workspaceRoot);
     const after=fingerprintSubject(this.options.workspaceRoot,state.binding.workspaceId,binding.inputs,state.mutationEpoch);
     const evidence:VerificationEvidence={id:evidenceId,backendId:state.binding.backendId,workItemId:state.workItemId,attemptId:state.attemptId,planId:plan.id,planVersion:plan.version,stepId,specDigest:binding.specDigest,environment:binding.environment,...(result.environmentSnapshot ? {environmentSnapshot:result.environmentSnapshot}:{}),before,after,startedAt,finishedAt:this.now(),exitCode:result.exitCode,outcome:before.digest !== after.digest || before.mutationEpoch !== after.mutationEpoch || result.exitCode === null ? "inconclusive" : result.exitCode === 0 && readbackPassed ? "passed" : "failed",readbackPassed,acceptanceMethods:result.acceptanceMethods,artifact:this.artifacts.put(result.output,{mediaType:"text/plain"})};
     return {success:true,data:evidence};
   }};
   privateRegistry.register(tool);
   const call=privateRegistry.executeDetailed(tool.name,{}, {...context,expectedCapabilityDigest:capabilityDigest(tool),deadline:verificationDeadline,callId:runId,runId:state.attemptId,signal:context.signal ? AbortSignal.any([context.signal,this.lifetime.signal]) : this.lifetime.signal},this.executions);this.inflight.add(call);let execution:ToolExecution;
   try{execution=await call;}finally{this.inflight.delete(call);}
   if(execution.outcome === "unknown"){
     await this.admissions.run(async()=>{state.state="reconciliation_required";state.unknownExecutions.push(execution.receipt.executionId);this.persist("verification",{verificationRunId:runId,stepId,outcome:"unknown"},{executionId:execution.receipt.executionId,receiptRef:execution.receipt.executionId});});
     throw new JournalInvariantError("Verification execution is uncertain; reconcile before another run");
   }
   if(!execution.result.success){delete state.verificationRuns[runId];this.persist("verification",{verificationRunId:runId,stepId,outcome:"not_started"},{executionId:execution.receipt.executionId,receiptRef:execution.receipt.executionId});throw new JournalInvariantError(execution.result.error ?? "Verification was not admitted");}
   const evidence=execution.result.data as VerificationEvidence;
   await this.admissions.run(async()=>{
     state.evidence[stepId]=evidence;delete state.verificationRuns[runId];this.accountOutput(execution.receipt.executionId,evidence.artifact.sizeBytes);
     this.persist("verification",{verificationRunId:runId,evidenceId:evidence.id,stepId,artifactRef:evidence.artifact.id},{executionId:execution.receipt.executionId,receiptRef:execution.receipt.executionId});
     try{await this.recordOutput(execution.receipt.executionId);}catch(error){state.state="reconciliation_required";this.persist("reconciled",{disposition:"verification_output_limit",executionRef:execution.receipt.executionId});throw error;}
   });
   await this.submitEvidence(evidence,context);return snapshotJson(evidence) as VerificationEvidence;
 }
 private async submitEvidence(evidence:VerificationEvidence,context:ToolExecutionContext={}):Promise<void> {
   await this.lifecycle.run(async()=>{const state=this.requireState();await this.grant();await this.fresh();await this.backendOperation("evidence",evidence as unknown as Record<string,unknown>,ref=>this.options.backend.submitEvidence(state.lease!,evidence,ref,this.requestSignal(context)),evidence.id,undefined,context);this.persist("evidence_submitted",{evidenceId:evidence.id,stepId:evidence.stepId});});
 }
 private scheduleRenewal():void {
   this.stopTimer();const state=this.state;if(this.stopping || !state?.lease || !["running","verifying"].includes(state.state))return;
   const remaining=state.lease.expiresAt-this.now();const delay=Math.max(1,Math.floor(remaining/3));
   this.timer=setTimeout(()=>{void this.renew().catch(()=>{});},delay);this.timer.unref?.();
 }
 private stopTimer():void {if(this.timer)clearTimeout(this.timer);this.timer=undefined;}
 /** Trusted application/test seam; absent from model-callable tools. */
 async renew():Promise<void> {
   await this.lifecycle.run(async()=>{
     const state=this.requireState();if(this.stopping || !["running","verifying"].includes(state.state))return;
     try{
       const grant=await this.grant();await this.fresh();
       const payload={leaseId:state.lease!.id,action:"heartbeat",payload:{leaseSeconds:this.options.leaseSeconds ?? 120}};
       const operation=this.operation("heartbeat",payload);state.operations[operation.id]={ref:operation,payload,status:"started"};this.persist("operation_started",{operationId:operation.id,kind:"heartbeat"});
       const tool={name:"_of_attempt_renew",description:"Private adapter-bound lease renewal",inputSchema:{type:"object" as const,properties:{},additionalProperties:false},contract:{version:"1",useWhen:[],doNotUseWhen:[],sideEffects:["Renew selected work lease"],commitmentClass:"C1" as const,idempotency:"idempotent_with_key" as const,requiresAuthority:true,mutation:true},handler:async(_params:Record<string,unknown>,boundContext?:ToolExecutionContext)=>({success:true,data:await this.options.backend.transition(state.lease!,"heartbeat",payload.payload,operation.backendKey ?? operation.id,boundContext?.signal ?? this.lifetime.signal)})};
       const privateRegistry=this.options.registry.project({}, {authorize:async()=>{try{const current=await this.grant();return {decision:"allow",authorityGrantRefs:[current.id],expiresAt:current.expiresAt};}catch{return {decision:"deny",reasonCodes:["renewal_grant_unavailable"]};}}});
       const execution=await privateRegistry.createRenewalRunner(tool,this.executions)({}, {runId:state.attemptId,callId:operation.id,deadline:state.lease!.expiresAt,authorityGrantRefs:[grant.id]});
       if(!execution.result.success || execution.outcome !== "succeeded")throw new JournalInvariantError("Lease renewal failed or uncertain");
       const receipt=execution.result.data as BackendReceipt;this.validateBackendReceipt(receipt,operation);state.lease=receipt.lease;state.operations[operation.id]!.status="settled";state.operations[operation.id]!.backendReceipt=receipt;this.persist("operation_settled",{operationId:operation.id,backendReceiptRef:receipt.id});this.persist("renewed",{expiresAt:state.lease!.expiresAt});this.scheduleRenewal();
     }catch(error){state.renewalFailed=true;state.state="reconciliation_required";this.stopTimer();this.persist("reconciled",{disposition:"renewal_failed"});throw error;}
   });
 }
 private safeStatus():Record<string,unknown> {
   const state=this.requireState();
   const stepNames=new Set(Object.values(this.options.steps).map(step=>step.toolName));
   const last=this.executions?.recover().filter(execution=>execution.settled && stepNames.has((execution.settled.receipt as {toolName:string}).toolName)).at(-1);
   const lastStepExecution=last ? Buffer.byteLength(JSON.stringify(last.settled)) <= 16*1024 ? {executionId:last.executionId,...last.settled} : {executionId:last.executionId,receipt:last.settled!.receipt,artifactRef:state.outputArtifacts[last.executionId],resultAvailable:true} : undefined;
   return {lastStepExecution,effectResolutions:state.effectResolutions,outputArtifactRefs:Object.values(state.outputArtifacts),attemptId:state.attemptId,workItemId:state.workItemId,state:state.state,mutationEpoch:state.mutationEpoch,actions:state.actions,outputBytes:state.outputBytes,evidence:Object.values(state.evidence),unresolvedOperations:Object.values(state.operations).filter(op=>op.status === "started").map(op=>op.ref),unknownExecutions:[...state.unknownExecutions],inflightStepIds:Object.keys(state.inflightSteps),lease:state.lease ? {id:state.lease.id,expiresAt:state.lease.expiresAt}:undefined};
 }
 async status(context:ToolExecutionContext={}):Promise<Record<string,unknown>> {if(!this.state)return {state:"prepared",active:false};const snapshot=await this.options.backend.inspect(this.state.workItemId,context.signal);return snapshotJson({...this.safeStatus(),backendState:snapshot.state}) as Record<string,unknown>;}
 async reconcile(context:ToolExecutionContext={}):Promise<Record<string,unknown>> {
   return this.admissions.run(async()=>this.lifecycle.run(async()=>{
     const state=this.requireState();this.assertAdmissionContext(context);this.ensureOwner();if(this.inflight.size)throw new JournalInvariantError("Started calls still draining");await this.grant();
     const saved=this.executions!.recover();const recoveredOutputRefs:string[]=[];
     for(const execution of saved){
       if(!execution.settled || state.accountedOutputs[execution.executionId])continue;
       const receipt=execution.settled.receipt as {toolName:string};if(receipt.toolName === "_of_attempt_renew")continue;
       const evidence=(execution.settled.result as {data?:Partial<VerificationEvidence>}).data;
       const bytes=receipt.toolName.startsWith("_of_verify_") && evidence?.artifact ? evidence.artifact.sizeBytes:Buffer.byteLength(execution.settled.modelContent as string);
       this.accountOutput(execution.executionId,bytes);recoveredOutputRefs.push(execution.executionId);
     }
     if(recoveredOutputRefs.length)this.persist("reconciled",{recoveredOutputRefs});
     for(const [id,run] of Object.entries(state.oracleRuns)) {
       const known=saved.find(execution=>execution.events.some(event=>event.data.callId === id || (event.data.receipt as {callId?:string})?.callId === id));
       if(!known && !state.executionFileIdentity)continue;
       delete state.oracleRuns[id];this.persist("reconciled",{oracleRunId:id,originalExecutionId:run.originalExecutionId,readbackExecutionId:known?.executionId,disposition:known?.settled ? "readback_result_recovered" : known?.state === "unknown" ? "readback_result_unknown":"readback_not_started"});
     }
     for(const [id,step] of Object.entries(state.inflightSteps)) {
       const known=this.executions!.recover().find(execution=>execution.events.some(event=>event.data.callId === id || (event.data.receipt as {callId?:string})?.callId === id));
       if(!known && state.executionFileIdentity || known?.state === "not_started"){delete state.inflightSteps[id];this.persist("reconciled",{stepIntentId:id,executionRef:known?.executionId,disposition:"not_started"});continue;}
       if(known?.settled){delete state.inflightSteps[id];const receipt=known.settled!.receipt as {executionOutcome:string;executionId:string};this.accountOutput(receipt.executionId,Buffer.byteLength(known.settled!.modelContent as string));if(receipt.executionOutcome === "unknown"){if(!state.unknownExecutions.includes(receipt.executionId))state.unknownExecutions.push(receipt.executionId);state.unknownSteps[receipt.executionId]=step;}this.persist("step",{stepIntentId:id,stepKey:step.stepKey,recovered:true},{executionId:receipt.executionId,receiptRef:receipt.executionId});}
       else if(known?.state === "unknown"){if(!state.unknownExecutions.includes(known.executionId))state.unknownExecutions.push(known.executionId);state.unknownSteps[known.executionId]=step;}
     }
     for(const [id,run] of Object.entries(state.verificationRuns)) {
       const known=this.executions!.recover().find(execution=>execution.events.some(event=>event.data.callId === id || (event.data.receipt as {callId?:string})?.callId === id));
       if(!known && state.executionFileIdentity || known?.state === "not_started"){delete state.verificationRuns[id];this.persist("reconciled",{verificationRunId:id,executionRef:known?.executionId,disposition:"not_started"});continue;}
       if(!known?.settled)continue;
       const receipt=known.settled!.receipt as {executionOutcome:string;executionId:string;phase:string};
       if(receipt.executionOutcome === "unknown"){if(!state.unknownExecutions.includes(receipt.executionId))state.unknownExecutions.push(receipt.executionId);continue;}
       const result=known.settled!.result as {success:boolean;data?:VerificationEvidence};
       if(result.success && result.data?.id === run.evidenceId){this.accountOutput(receipt.executionId,result.data.artifact.sizeBytes);state.evidence[run.stepId]=result.data;delete state.verificationRuns[id];this.persist("verification",{verificationRunId:id,evidenceId:result.data.id,stepId:run.stepId,recovered:true},{executionId:receipt.executionId,receiptRef:receipt.executionId});}
       else if(receipt.phase === "not_started"){delete state.verificationRuns[id];this.persist("verification",{verificationRunId:id,stepId:run.stepId,disposition:"not_started"},{executionId:receipt.executionId,receiptRef:receipt.executionId});}
     }
     for(const id of Object.keys(state.accountedOutputs))await this.recordOutput(id);
     await this.grant();
     for(const operation of Object.values(state.operations).filter(op=>op.status === "started")) {
       const result=await this.options.backend.reconcileOperation(operation.ref,this.requestSignal(context));this.assertAdmissionContext(context);
       if(result.state === "settled"){this.validateBackendReceipt(result.receipt,operation.ref);operation.status="settled";operation.backendReceipt=result.receipt;if(result.receipt.lease)state.lease=result.receipt.lease;this.persist("operation_settled",{operationId:operation.ref.id,backendReceiptRef:result.receipt.id,reconciled:true});}
       else if(result.state === "authoritatively_not_started"){
         // Reconciliation establishes non-execution but does not implicitly retry effects.
         operation.status="settled";this.persist("operation_settled",{operationId:operation.ref.id,disposition:"authoritatively_not_started"});
       }
     }
     if(!Object.values(state.operations).some(operation=>operation.status === "started")) {
       for(const [executionId,intent] of Object.entries(state.unknownSteps))await this.reconcileEffect(executionId,intent,context);
     }
     let snapshot=await this.options.backend.inspect(state.workItemId);
     const unresolved=Object.keys(state.inflightSteps).length || Object.keys(state.verificationRuns).length || state.unknownExecutions.length || Object.values(state.operations).some(operation=>operation.status === "started");
     if(!unresolved && ["ready","released"].includes(snapshot.state) && !state.lease && !Object.values(state.operations).some(operation=>operation.ref.kind === "open" && operation.backendReceipt)) {
       const preview=await this.prepare(state.workItemId,context);await this.grant();
       if(digestJson(preview.binding) !== digestJson(state.binding) || !preview.snapshot.claimable || !preview.snapshot.dependenciesSatisfied)throw new JournalInvariantError("Prepared attempt scope changed or work is no longer claimable");
       await this.options.grantResolver.reserveAttempt?.(state.binding,state.attemptId);
       const id=randomUUID();const payload={workItemId:state.workItemId,claimOwner:this.options.claimOwner,leaseSeconds:this.options.leaseSeconds ?? 120,idempotencyKey:id};
       const receipt=await this.backendOperation("open",payload,async()=>{const lease=await this.options.backend.open(payload,this.requestSignal(context));this.validateLease(lease);return {id:lease.id,operationId:id,kind:"open",payloadDigest:digestJson(payload),workItemId:state.workItemId,state:"claimed",lease};},id,undefined,context);
       state.lease=receipt.lease;snapshot=await this.options.backend.inspect(state.workItemId,this.requestSignal(context));
     }
     if(!unresolved && snapshot.state === "claimed") {
       await this.fresh(["claimed"]);await this.grant();
       await this.backendOperation("start",{leaseId:state.lease!.id,action:"start",payload:{}},ref=>this.options.backend.transition(state.lease!,"start",{},ref.backendKey ?? ref.id,this.requestSignal(context)),undefined,undefined,context);
     }
     if(!unresolved && ["released","needs_review","blocked","failed"].includes(snapshot.state)) {
       const terminal=Object.values(state.operations).find(operation=>operation.backendReceipt?.state === snapshot.state && ["release","review","block","fail"].includes(operation.ref.kind));
       if(terminal){state.state=snapshot.state as WorkState;this.persist(snapshot.state === "failed" ? "failed" : snapshot.state === "needs_review" ? "review" : "blocked",{disposition:snapshot.state,backendReceiptRef:terminal.backendReceipt!.id,reconciled:true});this.releaseOwnership();return this.safeStatus();}
     }
     if(snapshot.state === "completed") {
       const completion=Object.values(state.operations).find(op=>op.ref.kind === "complete" && op.backendReceipt?.state === "completed");
       if(completion && !Object.keys(state.inflightSteps).length && !Object.keys(state.verificationRuns).length && !state.unknownExecutions.length){await this.checkProof();state.state="completed";this.persist("completed",{backendReceiptRef:completion.backendReceipt!.id,reconciled:true});}
     } else if(!Object.keys(state.inflightSteps).length && !Object.keys(state.verificationRuns).length && !state.unknownExecutions.length && !Object.values(state.operations).some(op=>op.status === "started")) {
       const {plan}=await this.fresh();
       for(const evidence of Object.values(state.evidence)) {
         if(plan.coverage[evidence.stepId]?.id === evidence.id)continue;
         const existing=state.operations[evidence.id];
         if(existing?.status === "started")continue;
         if(existing?.backendReceipt){state.state="blocked";this.persist("blocked",{disposition:"authoritative_evidence_coverage_changed",evidenceRef:evidence.id});return this.safeStatus();}
         await this.backendOperation("evidence",evidence as unknown as Record<string,unknown>,ref=>this.options.backend.submitEvidence(state.lease!,evidence,ref,this.requestSignal(context)),existing ? randomUUID():evidence.id,existing ? evidence.id : undefined,context);
       }
       state.renewalFailed=false;state.state=Object.keys(state.evidence).length ? "verifying" : "running";this.persist("reconciled",{disposition:"ownership_confirmed"});this.scheduleRenewal();
     }
     return this.safeStatus();
   }));
 }
 private async reconcileEffect(originalExecutionId:string,intent:StepIntent,context:ToolExecutionContext):Promise<void> {
   const state=this.requireState();const sourceStep=this.options.steps[intent.stepKey];const step=sourceStep ? Object.freeze({...sourceStep}):undefined;
   if(!step?.reconcileEffect || !step.prepareReconciliation || !step.reconciliationSpecDigest || !intent.reconciliationMetadata || !intent.oracleDigest)return;
   const metadata=snapshotJson(intent.reconciliationMetadata,"captured readback metadata");
   const readback=step.reconcileEffect;
   const validateCatalog=(grant:ResolvedWorkGrant):void=>{
     const current=this.options.steps[intent.stepKey];const tool=current ? this.options.registry.get(current.toolName):undefined;
     const digest=current?.prepareReconciliation && current.reconcileEffect && current.reconciliationSpecDigest ? digestJson({specDigest:current.reconciliationSpecDigest,prepare:Function.prototype.toString.call(current.prepareReconciliation),readback:Function.prototype.toString.call(current.reconcileEffect),capabilityDigest:current.capabilityDigest}):undefined;
     if(!current || current.reconcileEffect !== readback || digest !== intent.oracleDigest || current.capabilityDigest !== intent.capabilityDigest || current.toolName !== step.toolName || !tool || capabilityDigest(tool) !== intent.capabilityDigest || grant.stepBindings[intent.stepKey]?.toolName !== current.toolName || grant.stepBindings[intent.stepKey]?.capabilityDigest !== intent.capabilityDigest || !grant.actions.includes("read") || !state.preview.snapshot.contract.actions.includes("read"))throw new JournalInvariantError("Effect readback catalog or authority changed");
     this.validatePaths(intent.admittedPaths,grant);
   };
   const grant=await this.grant();await this.fresh(["running"]);validateCatalog(grant);
   if(state.actions >= grant.limits.maxActions)throw new JournalInvariantError("Effect readback action budget exhausted");
   await this.options.grantResolver.reserveAttempt?.(state.binding,state.attemptId);await this.options.grantResolver.reserveAction?.(state.binding,state.attemptId);this.assertAdmissionContext(context);state.actions++;const oracleRunId=randomUUID();state.oracleRuns[oracleRunId]={originalExecutionId,oracleDigest:intent.oracleDigest,inputDigest:intent.inputDigest};
   this.persist("reconciled",{originalExecutionId,oracleRunId,oracleIntent:true,oracleDigest:intent.oracleDigest,inputDigest:intent.inputDigest});
   const privateRegistry=this.options.registry.project({names:[]},{authorize:async()=>{try{const current=await this.grant();await this.fresh(["running"]);validateCatalog(current);return current.actions.includes("read") ? {decision:"allow",authorityGrantRefs:[current.id],expiresAt:current.expiresAt}:{decision:"deny",reasonCodes:["readback_read_permission_missing"]};}catch{return {decision:"deny",reasonCodes:["readback_authority_unavailable"]};}}});
   const definition={name:`_of_readback_${originalExecutionId.replaceAll("-","_")}`,description:"Read the independent trusted effect oracle; never dispatch the original effect",inputSchema:{type:"object" as const,properties:{},additionalProperties:false},replayPolicy:"read_only" as const,executionMode:"parallel-safe" as const,contract:{version:"1",useWhen:[],doNotUseWhen:[],sideEffects:[],mutation:false,commitmentClass:"C0" as const,idempotency:"idempotent" as const,requiresAuthority:true,bounds:{originalExecutionId,oracleDigest:intent.oracleDigest,inputDigest:intent.inputDigest,capabilityDigest:intent.capabilityDigest}},handler:async(_params:Record<string,unknown>,boundContext?:ToolExecutionContext)=>{const current=await this.grant();await this.fresh(["running"]);validateCatalog(current);return {success:true,data:await readback({workspaceRoot:this.options.workspaceRoot,metadata,inputDigest:intent.inputDigest,capabilityDigest:intent.capabilityDigest,signal:boundContext?.signal ?? this.requestSignal(context)})};}};
   privateRegistry.register(definition);
   const execution=await privateRegistry.executeDetailed(definition.name,{}, {...context,expectedCapabilityDigest:capabilityDigest(definition),callId:oracleRunId,runId:state.attemptId,signal:this.requestSignal(context),deadline:Math.min(context.deadline ?? Infinity,grant.expiresAt,state.startedAt+grant.limits.maxDurationMs)},this.executions);
   this.accountOutput(execution.receipt.executionId,Buffer.byteLength(execution.modelContent));delete state.oracleRuns[oracleRunId];this.persist("reconciled",{originalExecutionId,readbackExecutionId:execution.receipt.executionId,disposition:"readback_recorded"},{executionId:execution.receipt.executionId,receiptRef:execution.receipt.executionId});
   await this.recordOutput(execution.receipt.executionId);await this.grant();await this.fresh(["running"]);validateCatalog(await this.grant());
   const proof=execution.result.data as {effect?:unknown;sourceRefs?:unknown}|undefined;
   if(execution.receipt.cancellationObserved || execution.receipt.deadlineObserved || context.signal?.aborted || context.deadline !== undefined && context.deadline <= this.now() || execution.outcome !== "succeeded" || !execution.result.success || proof?.effect !== "verified" || !Array.isArray(proof.sourceRefs) || !proof.sourceRefs.length || proof.sourceRefs.some(ref=>typeof ref !== "string" || !ref))return;
   state.effectResolutions[originalExecutionId]={effect:"verified",readbackExecutionId:execution.receipt.executionId,sourceRefs:proof.sourceRefs as string[]};delete state.unknownSteps[originalExecutionId];state.unknownExecutions=state.unknownExecutions.filter(id=>id !== originalExecutionId);
   for(const [id,pending] of Object.entries(state.inflightSteps))if(pending === intent || pending.stepKey === intent.stepKey && pending.inputDigest === intent.inputDigest && pending.reconciliationMetadata === intent.reconciliationMetadata)delete state.inflightSteps[id];
   this.persist("reconciled",{originalExecutionId,readbackExecutionId:execution.receipt.executionId,disposition:"effect_independently_verified"},{executionId:execution.receipt.executionId,receiptRef:execution.receipt.executionId});
 }
 private assertProofSubjects(subjects:readonly {binding:WorkControllerOptions["verificationBindings"][number];evidence:VerificationEvidence}[]):void {
   const state=this.requireState();
   for(const {binding,evidence} of subjects) {
     const current=fingerprintSubject(this.options.workspaceRoot,state.binding.workspaceId,binding.inputs,state.mutationEpoch);
     if(current.digest !== evidence.after.digest || current.mutationEpoch !== evidence.after.mutationEpoch)throw new JournalInvariantError("Verification subject changed");
     if(digestJson(this.artifacts.metadata(evidence.artifact.id)) !== digestJson(evidence.artifact))throw new JournalInvariantError("Evidence artifact metadata changed");
   }
 }
 private async checkProof():Promise<()=>void> {
   const state=this.requireState();const grant=await this.grant("completion");const {snapshot,plan}=await this.fresh();
   if(snapshot.humanReviewRequired || !plan.steps.some(step=>step.required) || Object.keys(state.inflightSteps).length || Object.keys(state.verificationRuns).length || state.unknownExecutions.length || Object.values(state.operations).some(operation=>operation.status === "started" && operation.ref.kind !== "complete"))throw new JournalInvariantError("Review, missing proof or uncertain operations prevent completion");
   const covered=new Set<string>();
   const subjects:{binding:WorkControllerOptions["verificationBindings"][number];evidence:VerificationEvidence}[]=[];
   const criterionMethods=new Set(snapshot.contract.acceptanceCriteria.map(criterion=>criterion.method));
   for(const step of plan.steps.filter(step=>step.required || state.evidence[step.id]?.acceptanceMethods.some(method=>criterionMethods.has(method)))) {
     const binding=this.options.verificationBindings.find(binding=>binding.stepId === step.id && binding.specDigest === step.specDigest && binding.environment === step.environment);
     const evidence=state.evidence[step.id];const authoritative=plan.coverage[step.id];
     if(!binding || !evidence || authoritative?.id !== evidence.id || authoritative.outcome !== "passed" || digestJson(authoritative) !== digestJson(evidence) || evidence.outcome !== "passed" || evidence.before.mutationEpoch !== state.mutationEpoch || evidence.after.mutationEpoch !== state.mutationEpoch || evidence.before.digest !== evidence.after.digest || evidence.specDigest !== step.specDigest || evidence.environment !== step.environment || evidence.planId !== plan.id || evidence.planVersion !== plan.version || evidence.attemptId !== state.attemptId)throw new JournalInvariantError("Current active proof missing");
     this.assertProofSubjects([{binding,evidence}]);
     if(!await binding.readback(this.options.workspaceRoot))throw new JournalInvariantError("Independent readback failed");
     subjects.push({binding,evidence});
     for(const method of evidence.acceptanceMethods)covered.add(method);
   }
   if(!snapshot.contract.acceptanceCriteria.length || !snapshot.contract.acceptanceCriteria.every(criterion=>grant.acceptanceMethods.includes(criterion.method) && covered.has(criterion.method)))throw new JournalInvariantError("Acceptance method coverage missing");
   // Later readbacks can change inputs checked earlier in the same proof pass.
   // Return a synchronous fence so terminal dispatch can repeat this check after
   // every awaited authority lookup without collecting another stale snapshot.
   this.assertProofSubjects(subjects);
   return ()=>this.assertProofSubjects(subjects);
 }
 async finish(disposition:"complete"|"review"|"block"|"release"="complete",context:ToolExecutionContext={}):Promise<Record<string,unknown>> {
   return this.admissions.run(async()=>this.lifecycle.run(async()=>{
     const state=this.requireState();this.assertAdmissionContext(context);this.ensureOwner();if(this.stopping || !(disposition === "release" ? ["running","verifying","blocked","reconciliation_required"] : ["running","verifying"]).includes(state.state) || this.inflight.size || Object.keys(state.inflightSteps).length || Object.keys(state.verificationRuns).length || state.unknownExecutions.length || Object.values(state.operations).some(operation=>operation.status === "started"))throw new JournalInvariantError("Attempt cannot finalize while draining or uncertain");
     await this.grant("execution",disposition === "release");
     if(disposition === "release" && this.options.backend.capabilities.expiredLeaseRelease) {
       const preview=await this.prepare(state.workItemId);const lease=preview.snapshot.lease;
       if(digestJson(preview.binding) !== digestJson(state.binding) || !state.lease || !lease || lease.id !== state.lease.id || lease.owner !== state.lease.owner)throw new JournalInvariantError("Explicit release cannot adopt successor lease or changed scope");
       this.validateLease(lease,false);state.lease=lease;
     }else await this.fresh();
     this.stopTimer();state.state="finalizing";this.persist("reconciled",{finalizationIntent:true,disposition});
     if(disposition === "release") {
       const receipt=await this.backendOperation("release",{leaseId:state.lease!.id},ref=>this.options.backend.release(state.lease!,ref.backendKey ?? ref.id,this.requestSignal(context)),undefined,undefined,context);
       const snapshot=await this.options.backend.inspect(state.workItemId);if(snapshot.state !== "released" || receipt.state !== "released"){state.state="reconciliation_required";this.persist("reconciled",{disposition:"release_readback_mismatch"});return this.safeStatus();}
       state.state="released";this.persist("blocked",{disposition:"released",backendReceiptRef:receipt.id});this.releaseOwnership();return this.safeStatus();
     }
     let reason="Explicit terminal disposition";
     let proofSubjects:(()=>void)|undefined;
     if(disposition === "complete")try{proofSubjects=await this.checkProof();}catch(error){disposition="review";reason=error instanceof Error ? error.message : "Completion proof unavailable";}
     const action=disposition === "complete" ? "complete" : disposition === "review" ? "review" : "block";
     const terminalPayload=action === "complete" ? {evidenceIds:Object.values(state.evidence).map(evidence=>evidence.id),mutationEpoch:state.mutationEpoch} : {reason};
     const payload={leaseId:state.lease!.id,action,payload:terminalPayload};
     const receipt=await this.backendOperation(action,payload,async ref=>{
       // Proof collection contains awaited readbacks. Authority can change while
       // they run, so fence the actual terminal dispatch with current grants.
       await this.grant("execution");
       if(action === "complete")await this.grant("completion");
       this.assertAdmissionContext(context);
       if(action === "complete")proofSubjects!();
       return this.options.backend.transition(state.lease!,action,payload.payload,ref.backendKey ?? ref.id,this.requestSignal(context));
     },undefined,undefined,context);
     const snapshot=await this.options.backend.inspect(state.workItemId);const expected=action === "complete" ? "completed" : action === "review" ? "needs_review" : "blocked";
     if(receipt.state !== expected || snapshot.state !== expected){state.state="reconciliation_required";this.persist("reconciled",{disposition:"terminal_readback_mismatch",backendState:snapshot.state});return this.safeStatus();}
     if(action === "complete")try{await this.checkProof();}catch{state.state="reconciliation_required";this.persist("reconciled",{disposition:"completion_assurance_failed",backendState:snapshot.state});return this.safeStatus();}
     state.state=expected;this.persist(action === "complete" ? "completed" : action === "review" ? "review" : "blocked",{backendReceiptRef:receipt.id,reason:action === "complete" ? undefined : reason});this.releaseOwnership();return this.safeStatus();
   }));
 }
 async shutdown():Promise<void> {
   this.stopping=true;this.stopTimer();this.lifetime.abort();
   await Promise.allSettled([...this.inflight]);
   await this.admissions.run(async()=>{});await this.lifecycle.run(async()=>{});
   this.releaseOwnership();
 }
}
