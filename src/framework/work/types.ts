import type { ToolExecution, ToolExecutionContext } from "../execution-types.js";
import type { ToolRegistry } from "../registry.js";
import type { FileArtifactStore, ArtifactReference } from "../artifacts.js";
export type WorkAction = "read"|"write"|"test"|"network"|"vault"|"deploy"|"migrate";
export type WorkState = "prepared"|"claiming"|"running"|"verifying"|"finalizing"|"completed"|"needs_review"|"blocked"|"failed"|"released"|"reconciliation_required";
export interface WorkContract { version:1; profile:"coding"|"read_only"; actions:WorkAction[]; roots:string[]; include:string[]; exclude:string[]; acceptanceCriteria:{id:string;method:string}[]; }
export interface WorkSnapshot { backendId:string; workItemId:string; workspaceId:string; projectId?:string; revision:string; contract:WorkContract; contractDigest:string; state:string; claimable:boolean; dependenciesSatisfied:boolean; humanReviewRequired:boolean; sourceRefs:string[]; lease?:LeaseRef; }
export interface VerificationPlanStep { id:string; kind:"command"|"readback"|"external"|"human"; specDigest:string; environment:string; required:boolean; timeoutMs:number; }
export interface VerificationPlanSnapshot { id:string; version:number; digest:string; state:"active"|"inactive"; steps:VerificationPlanStep[]; coverage:Record<string,VerificationEvidence>; }
/** Safe local lease reference. Hosted opaque custody belongs in adapter-private state. */
export interface LeaseRef { id:string; backendId:string; workItemId:string; owner:string; expiresAt:number; }
export type OperationKind = "open"|"start"|"heartbeat"|"evidence"|"complete"|"review"|"block"|"fail"|"release";
export interface OperationRef { id:string; kind:OperationKind; payloadDigest:string; backendKey?:string; deduplicationDeadline?:number; capabilityVersion:string; }
export interface BackendCapabilities { version:string; keyedOperations:OperationKind[]; receiptLookup:OperationKind[]; deduplicationWindowMs?:number; missingReceiptProvesNotStarted:boolean;expiredLeaseRelease?:boolean; }
export interface BackendReceipt { id:string; operationId:string; kind:OperationKind; payloadDigest:string; workItemId:string; state:string; lease?:LeaseRef; evidenceId?:string; }
export type ReconciliationResult = {state:"settled";receipt:BackendReceipt;sourceRefs:string[]}|{state:"authoritatively_not_started";sourceRefs:string[]}|{state:"unknown";sourceRefs:string[]};
export interface WorkBackend {
 readonly capabilities:BackendCapabilities;
 inspect(workItemId:string,signal?:AbortSignal):Promise<WorkSnapshot>;
 getVerificationPlan(workItemId:string,signal?:AbortSignal):Promise<VerificationPlanSnapshot>;
 open(input:{workItemId:string;claimOwner:string;leaseSeconds:number;idempotencyKey:string},signal?:AbortSignal):Promise<LeaseRef>;
 transition(lease:LeaseRef,action:Exclude<OperationKind,"open"|"evidence"|"release">,payload:Record<string,unknown>,idempotencyKey:string,signal?:AbortSignal):Promise<BackendReceipt>;
 submitEvidence(lease:LeaseRef,evidence:VerificationEvidence,operation:OperationRef,signal?:AbortSignal):Promise<BackendReceipt>;
 reconcileOperation(operation:OperationRef,signal?:AbortSignal):Promise<ReconciliationResult>;
 release(lease:LeaseRef,idempotencyKey:string,signal?:AbortSignal):Promise<BackendReceipt>;
}
export interface WorkAuthorizationBinding {backendId:string;workItemId:string;workspaceId:string;projectId?:string;contractDigest:string;revision:string;planId:string;planVersion:number;planDigest:string;scopeDigest:string;}
export interface ResolvedWorkGrant {id:string;expiresAt:number;actions:WorkAction[];roots:string[];include:string[];exclude:string[];stepBindings:Record<string,{toolName:string;capabilityDigest:string}>;acceptanceMethods:string[];limits:{maxAttempts:number;maxDurationMs:number;maxActions:number;maxOutputBytes:number};completion:boolean;}
export interface WorkGrantResolver {
 resolve(binding:WorkAuthorizationBinding,purpose:"execution"|"completion"):Promise<ResolvedWorkGrant|undefined>;
 reserveAttempt?(binding:WorkAuthorizationBinding,attemptId:string):Promise<void>;
 reserveAction?(binding:WorkAuthorizationBinding,attemptId:string):Promise<void>;
 recordOutput?(binding:WorkAuthorizationBinding,attemptId:string,bytes:number,executionId?:string):Promise<void>;
}
export interface WorkStepExecution extends ToolExecution {artifactProjection?:{artifact:ArtifactReference;executionId:string;receiptRef:string};}
export interface EffectReadback {effect:"verified"|"unknown";sourceRefs:string[];}
export interface WorkStepBinding {toolName:string;action:WorkAction;capabilityDigest:string;validateParams?:(params:Readonly<Record<string,unknown>>)=>void;paths?:(params:Readonly<Record<string,unknown>>)=>string[];reconciliationSpecDigest?:string;prepareReconciliation?:(params:Readonly<Record<string,unknown>>,workspaceRoot:string)=>Record<string,unknown>;reconcileEffect?:(context:{workspaceRoot:string;metadata:Readonly<Record<string,unknown>>;inputDigest:string;capabilityDigest:string;signal:AbortSignal})=>Promise<EffectReadback>;}
export interface VerificationSubject {workspaceId:string;inputManifest:readonly string[];digest:string;mutationEpoch:number;}
export interface VerificationEnvironmentSnapshot {platform:string;arch:string;hostNodeVersion:string;executable:string;cwd:string;environmentDigest:string;}
export interface VerificationEvidence {id:string;backendId:string;workItemId:string;attemptId:string;planId:string;planVersion:number;stepId:string;specDigest:string;environment:string;environmentSnapshot?:VerificationEnvironmentSnapshot;before:VerificationSubject;after:VerificationSubject;startedAt:number;finishedAt:number;exitCode:number|null;outcome:"passed"|"failed"|"inconclusive";readbackPassed:boolean;acceptanceMethods:string[];artifact:ArtifactReference;}
export interface VerificationRun {environmentSnapshot?:VerificationEnvironmentSnapshot;exitCode:number|null;output:string;readbackPassed:boolean;acceptanceMethods:string[];}
export interface VerificationBinding {stepId:string;specDigest:string;environment:string;inputs:readonly string[];run:(context:{workspaceRoot:string;signal:AbortSignal})=>Promise<VerificationRun>;readback:(workspaceRoot:string)=>Promise<boolean>;}
export interface WorkPreview {binding:WorkAuthorizationBinding;snapshot:WorkSnapshot;plan:VerificationPlanSnapshot;steps:Record<string,{toolName:string;action:WorkAction;capabilityDigest:string}>;createdAt:number;digest:string;}
export interface WorkControllerOptions {backend:WorkBackend;registry:ToolRegistry;grantResolver:WorkGrantResolver;journalRoot:string;artifactRoot:string;workspaceRoot:string;claimOwner:string;steps:Record<string,WorkStepBinding>;verificationBindings:readonly VerificationBinding[];clock?:()=>number;leaseSeconds?:number;attemptId?:string;renewalSafetyMs?:number;renewalRunner?:(call:()=>Promise<BackendReceipt>,context:ToolExecutionContext)=>Promise<ToolExecution>;artifactStore?:FileArtifactStore;}
