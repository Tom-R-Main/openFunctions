/** Bounded maintenance sample: one JSON correction and independent Node verification. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { capabilityDigest } from "../executor.js";
import { digestJson } from "../session.js";
import { JournalInvariantError } from "../journal-file.js";
import type { ToolDefinition } from "../types.js";
import { createCommandVerificationBinding, scopedPath } from "./verification.js";
import type { VerificationPlanStep, WorkContract, WorkStepBinding } from "./types.js";
export interface LocalFixtureBindingOptions {workspaceRoot:string;fixturePath:string;verifierPath:string;afterEffect?:()=>Promise<void>;}
export function createLocalFixtureBindings(originalOptions:LocalFixtureBindingOptions) {
 const options=Object.freeze({...originalOptions});
 const path=()=>scopedPath(options.workspaceRoot,options.fixturePath);
 const inspect:ToolDefinition={name:"fixture_inspect",description:"Read the configured fixture and its revision digest",inputSchema:{type:"object",properties:{},additionalProperties:false},executionMode:"parallel-safe",replayPolicy:"read_only",annotations:{readOnlyHint:true},contract:{version:"1",useWhen:["Inspect authorized fixture"],doNotUseWhen:[],sideEffects:[],mutation:false,commitmentClass:"C0",idempotency:"idempotent",requiresAuthority:true},handler:async()=>{const bytes=readFileSync(path());return {success:true,data:{expectedDigest:digestJson(bytes.toString("utf8")),fixture:JSON.parse(bytes.toString("utf8"))}};}};
 const correct:ToolDefinition={name:"fixture_correct",description:"Correct only the configured JSON fixture, requiring the inspected revision",inputSchema:{type:"object",properties:{expectedDigest:{type:"string",minLength:1}},required:["expectedDigest"],additionalProperties:false},replayPolicy:"never",annotations:{readOnlyHint:false,destructiveHint:false},contract:{version:"1",useWhen:["Apply granted deterministic correction"],doNotUseWhen:["Revision changed"],sideEffects:["Replace configured fixture contents"],mutation:true,commitmentClass:"C1",idempotency:"non_idempotent",requiresAuthority:true,requiredVerification:["fixture-readback"],concurrency:{revisionField:"expectedDigest",leaseRequired:true}},handler:async params=>{
   const target=path();const previous=readFileSync(target,"utf8");if(digestJson(previous) !== params.expectedDigest)return {success:false,error:"Fixture revision changed"};
   const fixture=JSON.parse(previous) as Record<string,unknown>;if(!fixture || typeof fixture !== "object" || Array.isArray(fixture))return {success:false,error:"Fixture must be a JSON object"};
   const next={...fixture,status:"corrected",value:1};
   // Only this fixed trusted path is selected; no shell, model-provided filenames or commands.
   writeFileSync(target,`${JSON.stringify(next,null,2)}\n`);await options.afterEffect?.();
   return {success:true,data:{expectedDigest:digestJson(readFileSync(target,"utf8")),corrected:true}};
 }};
 const tools:ToolDefinition[]=[inspect,correct];
 const steps:Record<string,WorkStepBinding>={inspect:{toolName:inspect.name,action:"read",capabilityDigest:capabilityDigest(inspect),paths:()=>[options.fixturePath]},correct:{toolName:correct.name,action:"write",capabilityDigest:capabilityDigest(correct),paths:()=>[options.fixturePath],reconciliationSpecDigest:digestJson({version:1,method:"fixture-exact-file-digest",workspaceRoot:resolve(options.workspaceRoot),fixturePath:options.fixturePath}),prepareReconciliation:params=>{
   const previous=readFileSync(path(),"utf8");const fixture=JSON.parse(previous) as Record<string,unknown>;
   const next=`${JSON.stringify({...fixture,status:"corrected",value:1},null,2)}\n`;
   return {expectedInputDigest:params.expectedDigest,observedInputDigest:digestJson(previous),expectedFinalDigest:digestJson(next)};
 },reconcileEffect:async context=>{
   const metadata=context.metadata;
   if(metadata.expectedInputDigest !== metadata.observedInputDigest || digestJson({expectedDigest:metadata.expectedInputDigest}) !== context.inputDigest)return {effect:"unknown",sourceRefs:["fixture:input-binding-mismatch"]};
   const current=digestJson(readFileSync(scopedPath(context.workspaceRoot,options.fixturePath),"utf8"));
   return {effect:current === metadata.expectedFinalDigest ? "verified":"unknown",sourceRefs:[`fixture:${options.fixturePath}#${current}`]};
 }}};
 const fixturePath=scopedPath(options.workspaceRoot,options.fixturePath);const verifierPath=scopedPath(options.workspaceRoot,options.verifierPath);
 const inputs=[relative(options.workspaceRoot,fixturePath),relative(options.workspaceRoot,verifierPath)];
 const specDigest=digestJson({executable:process.execPath,argv:[verifierPath,fixturePath],environment:"local-node",inputs});
 const readback=async (workspaceRoot:string)=>{try{const fixture=JSON.parse(readFileSync(scopedPath(workspaceRoot,options.fixturePath),"utf8"));return fixture.status === "corrected" && fixture.value === 1;}catch{return false;}};
 const verificationBindings=[createCommandVerificationBinding({stepId:"fixture-check",specDigest,environment:"local-node",inputs,executable:process.execPath,argv:[verifierPath,fixturePath],timeoutMs:30000,acceptanceMethods:["fixture-readback"],readback})];
 const verificationStep:VerificationPlanStep={id:"fixture-check",kind:"command",specDigest,environment:"local-node",required:true,timeoutMs:30000};
 const contract:WorkContract={version:1,profile:"coding",actions:["read","write","test"],roots:[options.workspaceRoot],include:[inputs[0]!],exclude:[],acceptanceCriteria:[{id:"fixture-corrected",method:"fixture-readback"}]};
 return {tools,steps,verificationBindings,verificationStep,contract};
}
