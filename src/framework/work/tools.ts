import type { ToolDefinition } from "../types.js";
import type { ToolExecutionContext } from "../execution-types.js";
import type { ToolRegistry } from "../registry.js";
import type { WorkAttemptController } from "./controller.js";
/** Opt-in finite work facade. Inputs carry selections, never grant/lease custody. */
export function createWorkTools(controller:Pick<WorkAttemptController,"prepare"|"start"|"step"|"verify"|"status"|"reconcile"|"finish">, registry?:ToolRegistry):ToolDefinition[] {
 const definition=(name:string,description:string,properties:ToolDefinition["inputSchema"]["properties"],required:string[],handler:(params:Record<string,unknown>,context?:ToolExecutionContext)=>Promise<unknown>,readOnly=false):ToolDefinition=>({
   name,description,inputSchema:{type:"object",properties,required,additionalProperties:false},annotations:{readOnlyHint:readOnly,destructiveHint:false,openWorldHint:false},executionMode:readOnly ? "parallel-safe" : "exclusive",replayPolicy:readOnly ? "read_only" : "never",handler:async (params,context)=>{
     const invoke=async()=>{const canonical=await handler(params,context);const data=canonical && typeof canonical === "object" && "artifactProjection" in canonical && "receipt" in canonical && "outcome" in canonical ? {receipt:(canonical as {receipt:unknown}).receipt,outcome:(canonical as {outcome:unknown}).outcome,artifactProjection:(canonical as {artifactProjection:unknown}).artifactProjection} : canonical;if(data && typeof data === "object" && "receipt" in data && "outcome" in data && (data as {outcome:string}).outcome === "unknown")return {success:false,error:"Work execution is uncertain; reconcile before retry",executionOutcome:"unknown" as const,data};if(data && typeof data === "object" && "receipt" in data && "outcome" in data && (data as {outcome:string}).outcome === "failed")return {success:false,error:"Work step failed; inspect its bound execution receipt",executionOutcome:"failed" as const,data};return {success:true,data};};
     return registry ? registry.withChildExecution(invoke) : invoke();
   }
 });
 return [
   definition("of_work_prepare","Inspect one selected work item and its bound authorization preview",{workItemId:{type:"string",minLength:1}},["workItemId"],(p,context)=>controller.prepare(p.workItemId as string,context),true),
   definition("of_work_start","Start the explicitly selected bounded work item using current persisted grants",{workItemId:{type:"string",minLength:1}},["workItemId"],(p,context)=>controller.start(p.workItemId as string,context)),
   definition("of_work_step","Run a finite granted work step",{stepKey:{type:"string",minLength:1},params:{type:"object",additionalProperties:true}},["stepKey","params"],(p,context)=>controller.step(p.stepKey as string,p.params as Record<string,unknown>,context)),
   definition("of_work_verify","Run one exact registered active-plan verification method",{stepId:{type:"string",minLength:1}},["stepId"],(p,context)=>controller.verify(p.stepId as string,context)),
   definition("of_work_status","Read current local evidence and fresh backend status",{},[],(_p,context)=>controller.status(context),true),
   definition("of_work_reconcile","Explicitly reconcile durable receipts and backend operation identities; never rerun work effects",{},[],(_p,context)=>controller.reconcile(context)),
   definition("of_work_finish","Finalize only with current authority, subject proof and independent readback",{disposition:{type:"string",enum:["complete","review","block","release"]}},[],(p,context)=>controller.finish((p.disposition ?? "complete") as "complete"|"review"|"block"|"release",context)),
 ];
}
