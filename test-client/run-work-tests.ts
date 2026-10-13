import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileArtifactStore } from "../src/framework/artifacts.js";
import { ExecutionJournal } from "../src/framework/execution-journal.js";
import { createWorkTools } from "../src/framework/work/tools.js";
import { ToolRegistry } from "../src/framework/registry.js";
import { digestJson } from "../src/framework/session.js";
import { WorkAttemptController } from "../src/framework/work/controller.js";
import { LocalGrantStore } from "../src/framework/work/grants.js";
import { LocalWorkBackend } from "../src/framework/work/local-backend.js";
import { createLocalFixtureBindings } from "../src/framework/work/local-fixture.js";
import { JournalConcurrencyError, JournalInvariantError } from "../src/framework/journal-file.js";
import type { ExecutionJournalSink } from "../src/framework/execution-types.js";
import type { ResolvedWorkGrant, WorkBackend, VerificationEvidence, WorkControllerOptions } from "../src/framework/work/types.js";

async function setup(t:{after(fn:()=>void|Promise<void>):void},options:{journal?:ExecutionJournalSink;completion?:boolean;human?:boolean;maxActions?:number;maxOutputBytes?:number;verificationTimeoutMs?:number;afterEffect?:()=>Promise<void>;verifier?:string;leaseSeconds?:number;backendWrap?:(backend:WorkBackend)=>WorkBackend}={}) {
 const root=mkdtempSync(join(tmpdir(),"openfunction-work-"));chmodSync(root,0o700);
 let now=Date.now();const clock=()=>now;
 const fixture=join(root,"fixture.json");const verifier=join(root,"verify.mjs");
 writeFileSync(fixture,'{"status":"needs_correction","value":0}\n',{mode:0o600});
 writeFileSync(verifier,options.verifier ?? 'import fs from "node:fs";const value=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));if(value.status!=="corrected"||value.value!==1)process.exit(1);console.log("verified");\n',{mode:0o600});
 const bindings=createLocalFixtureBindings({workspaceRoot:root,fixturePath:"fixture.json",verifierPath:"verify.mjs",afterEffect:options.afterEffect});
 if(options.verificationTimeoutMs)bindings.verificationStep.timeoutMs=options.verificationTimeoutMs;
 const registry=new ToolRegistry({clock,...(options.journal ? {journal:options.journal}: {})});registry.registerAll(bindings.tools);
 const local=new LocalWorkBackend({rootDir:join(root,"backend"),backendId:"local-test",workspaceId:"test-workspace",workItems:[{workItemId:"job",contract:bindings.contract,plan:{id:"plan",version:1,state:"active",steps:[bindings.verificationStep]},humanReviewRequired:options.human}],clock});
 const backend=options.backendWrap?.(local) ?? local;const grants=new LocalGrantStore({rootDir:join(root,"grants"),clock});
 const config:WorkControllerOptions={backend,registry,grantResolver:grants,journalRoot:join(root,"journals"),artifactRoot:join(root,"artifacts"),workspaceRoot:root,claimOwner:"test-owner",steps:bindings.steps,verificationBindings:bindings.verificationBindings,clock,leaseSeconds:options.leaseSeconds ?? 120,renewalSafetyMs:25};
 const controller=new WorkAttemptController(config);
 const preview=await controller.prepare("job");
 const limits:ResolvedWorkGrant["limits"]={maxAttempts:1,maxDurationMs:60000,maxActions:options.maxActions ?? 10,maxOutputBytes:options.maxOutputBytes ?? 65536};
 const common={expiresAt:now+60000,actions:bindings.contract.actions,roots:[root],include:["fixture.json"],exclude:[],stepBindings:Object.fromEntries(Object.entries(bindings.steps).map(([key,step])=>[key,{toolName:step.toolName,capabilityDigest:step.capabilityDigest}])),acceptanceMethods:["fixture-readback"],limits};
 const executionGrant=grants.issue(preview.binding,{...common,purpose:"execution"});
 if(options.completion !== false)grants.issue(preview.binding,{...common,purpose:"completion",executionGrantId:executionGrant.id});
 t.after(async()=>{await controller.shutdown();rmSync(root,{recursive:true,force:true});});
 return {root,fixture,verifier,controller,config,backend,local,grants,bindings,executionGrant,preview,advance:(ms:number)=>now+=ms};
}
async function correct(controller:WorkAttemptController):Promise<void>{const inspected=await controller.step("inspect",{});assert.equal(inspected.result.success,true);const expectedDigest=(inspected.result.data as {expectedDigest:string}).expectedDigest;const changed=await controller.step("correct",{expectedDigest});assert.equal(changed.result.success,true);}

 test("local fixture uses persisted execution/completion grants and fresh independent proof",async t=>{
   const {controller,fixture,backend}=await setup(t);await controller.start("job");await correct(controller);const evidence=await controller.verify("fixture-check");assert.equal(evidence.outcome,"passed");assert.equal(evidence.readbackPassed,true);assert.equal((await controller.finish()).state,"completed");assert.equal((await backend.inspect("job")).state,"completed");assert.equal(JSON.parse(readFileSync(fixture,"utf8")).value,1);
 });
 test("execution succeeds without completion authority and routes to review",async t=>{
   const {controller}=await setup(t,{completion:false});await controller.start("job");await correct(controller);await controller.verify("fixture-check");assert.equal((await controller.finish()).state,"needs_review");
 });
 test("passing a no-op verifier cannot replace independent postcondition readback",async t=>{
   const {controller}=await setup(t,{verifier:'console.log("pretend passed");\n'});await controller.start("job");const evidence=await controller.verify("fixture-check");assert.equal(evidence.exitCode,0);assert.equal(evidence.outcome,"failed");assert.equal((await controller.finish()).state,"needs_review");
 });
 test("verify then externally mutate target prevents completion",async t=>{
   const {controller,fixture,backend}=await setup(t);await controller.start("job");await correct(controller);await controller.verify("fixture-check");writeFileSync(fixture,'{"status":"corrected","value":1,"unverified":true}\n');assert.equal((await controller.finish()).state,"needs_review");assert.equal((await backend.inspect("job")).state,"needs_review");
 });
 test("changed verifier source invalidates prior passing evidence",async t=>{
   const {controller,verifier}=await setup(t);await controller.start("job");await correct(controller);await controller.verify("fixture-check");writeFileSync(verifier,'console.log("changed source");\n');assert.equal((await controller.finish()).state,"needs_review");
 });
 test("explicit correction after verification invalidates all prior epoch evidence",async t=>{
   const {controller}=await setup(t);await controller.start("job");await correct(controller);await controller.verify("fixture-check");await correct(controller);const status=await controller.status();assert.deepEqual(status.evidence,[]);assert.equal(status.state,"running");assert.equal((await controller.finish()).state,"needs_review");
 });
 test("revocation stops next admission and terminal authorization",async t=>{
   const {controller,grants,executionGrant}=await setup(t);await controller.start("job");grants.revoke(executionGrant.id);await assert.rejects(()=>controller.step("inspect",{}),/grant missing/);await assert.rejects(()=>controller.finish(),/grant missing/);
 });
 test("concurrent requests cannot double-spend action limits",async t=>{
   const {controller}=await setup(t,{maxActions:1});await controller.start("job");const results=await Promise.allSettled([controller.step("inspect",{}),controller.step("inspect",{})]);assert.equal(results.filter(result=>result.status === "fulfilled").length,1);assert.equal((await controller.status()).actions,1);
 });
 test("competing controllers cannot adopt a live attempt",async t=>{
   const {controller,config}=await setup(t);await controller.start("job");const other=new WorkAttemptController(config);await assert.rejects(()=>other.reconcile(),JournalConcurrencyError);await other.shutdown();
 });
 test("status is read-only and lease expiration stops admission",async t=>{
   const {controller,advance,backend}=await setup(t,{leaseSeconds:1});await controller.start("job");const before=(await backend.inspect("job")).lease!.expiresAt;await controller.status();assert.equal((await backend.inspect("job")).lease!.expiresAt,before);advance(1100);await assert.rejects(()=>controller.step("inspect",{}),/lease/i);
 });
 test("long work effect overlaps authorized renewal without deadlock",async t=>{
   let release!:()=>void;let entered!:()=>void;const entry=new Promise<void>(resolve=>entered=resolve);const barrier=new Promise<void>(resolve=>release=resolve);
   const {controller,advance,backend}=await setup(t,{leaseSeconds:1,afterEffect:async()=>{entered();await barrier;}});await controller.start("job");const inspect=await controller.step("inspect",{});const original=(await backend.inspect("job")).lease!.expiresAt;
   const effect=controller.step("correct",{expectedDigest:(inspect.result.data as {expectedDigest:string}).expectedDigest});await entry;advance(600);await controller.renew();assert.ok((await backend.inspect("job")).lease!.expiresAt>original);advance(600);release();assert.equal((await effect).result.success,true);await controller.verify("fixture-check");assert.equal((await controller.finish()).state,"completed");
 });
 test("failed renewal stops admissions while retaining a started effect receipt",async t=>{
   let release!:()=>void;let entered!:()=>void;const entry=new Promise<void>(resolve=>entered=resolve);const barrier=new Promise<void>(resolve=>release=resolve);
   const {controller}=await setup(t,{afterEffect:async()=>{entered();await barrier;},backendWrap:backend=>new Proxy(backend,{get(target,key){if(key === "transition")return async (...args:Parameters<WorkBackend["transition"]>)=>{if(args[1] === "heartbeat")throw new Error("renewal lost");return target.transition(...args);};const value=Reflect.get(target,key);return typeof value === "function" ? value.bind(target) : value;}})});
   await controller.start("job");const inspect=await controller.step("inspect",{});const effect=controller.step("correct",{expectedDigest:(inspect.result.data as {expectedDigest:string}).expectedDigest});await entry;await assert.rejects(()=>controller.renew(),/renewal/);await assert.rejects(()=>controller.step("inspect",{}),/not accepting/);release();assert.equal((await effect).result.success,true);assert.equal((await controller.status()).state,"reconciliation_required");
 });
 test("backend identical keys return receipts and conflicting payloads fail",async t=>{
   const {local}=await setup(t);const input={workItemId:"job",claimOwner:"owner",leaseSeconds:120,idempotencyKey:"fixed-open"};const lease=await local.open(input);assert.deepEqual(await local.open(input),lease);await assert.rejects(()=>local.open({...input,claimOwner:"other"}),/Conflicting/);const payload={leaseId:lease.id,action:"start",payload:{}};const receipt=await local.transition(lease,"start",{},"fixed-start");assert.deepEqual(await local.reconcileOperation({id:"fixed-start",backendKey:"fixed-start",kind:"start",payloadDigest:digestJson(payload),capabilityVersion:local.capabilities.version}),{state:"settled",receipt,sourceRefs:["local:local-test:job"]});await assert.rejects(()=>local.transition(lease,"start",{different:true},"fixed-start"),/Conflicting/);
 });
 test("lost evidence response reconciles persisted output without rerunning verifier",async t=>{
   let lost=true;let verifications=0;
   const {controller,config}=await setup(t,{backendWrap:backend=>new Proxy(backend,{get(target,key){if(key === "submitEvidence")return async (...args:Parameters<WorkBackend["submitEvidence"]>)=>{const receipt=await target.submitEvidence(...args);if(lost){lost=false;throw new Error("lost evidence response");}return receipt;};const value=Reflect.get(target,key);return typeof value === "function" ? value.bind(target) : value;}})});
   const binding=config.verificationBindings[0]!;const run=binding.run;binding.run=async context=>{verifications++;return run(context);};await controller.start("job");await correct(controller);await assert.rejects(()=>controller.verify("fixture-check"),/lost evidence/);assert.equal((await controller.status()).state,"reconciliation_required");await controller.reconcile();assert.equal(verifications,1);assert.equal((await controller.finish()).state,"completed");
 });
 test("lost terminal response reads keyed receipt and confirms completion",async t=>{
   let lost=true;const {controller}=await setup(t,{backendWrap:backend=>new Proxy(backend,{get(target,key){if(key === "transition")return async (...args:Parameters<WorkBackend["transition"]>)=>{const receipt=await target.transition(...args);if(args[1] === "complete" && lost){lost=false;throw new Error("lost complete response");}return receipt;};const value=Reflect.get(target,key);return typeof value === "function" ? value.bind(target) : value;}})});
   await controller.start("job");await correct(controller);await controller.verify("fixture-check");await assert.rejects(()=>controller.finish(),/lost complete/);assert.equal((await controller.reconcile()).state,"completed");
 });

 test("authoritative evidence changing under the same ID cannot complete",async t=>{
   let corrupt=false;const {controller}=await setup(t,{backendWrap:backend=>new Proxy(backend,{get(target,key){if(key === "getVerificationPlan")return async (...args:Parameters<WorkBackend["getVerificationPlan"]>)=>{const plan=await target.getVerificationPlan(...args);if(!corrupt)return plan;return {...plan,coverage:Object.fromEntries(Object.entries(plan.coverage).map(([id,evidence])=>[id,{...evidence,outcome:"failed" as const}]))};};const value=Reflect.get(target,key);return typeof value === "function" ? value.bind(target) : value;}})});
   await controller.start("job");await correct(controller);const evidence=await controller.verify("fixture-check");corrupt=true;assert.equal((await controller.finish()).state,"needs_review");assert.equal(evidence.outcome,"passed");
 });
 test("explicit expired local release frees only the unchanged known lease",async t=>{
   const {controller,advance,backend}=await setup(t,{leaseSeconds:1});await controller.start("job");await controller.step("inspect",{});const original=(await backend.inspect("job")).lease!;advance(1100);
   assert.equal((await controller.finish("release")).state,"released");assert.equal((await backend.inspect("job")).claimable,true);
   const successor=await backend.open({workItemId:"job",claimOwner:"successor",leaseSeconds:10,idempotencyKey:"successor-key"});assert.notEqual(successor.id,original.id);
   await assert.rejects(()=>backend.release(original,"old-owner-release"),/does not match/);
 });
 test("human acceptance gate cannot be satisfied by passing commands",async t=>{
   const {controller,backend}=await setup(t,{human:true});await controller.start("job");await correct(controller);await controller.verify("fixture-check");assert.equal((await controller.finish()).state,"needs_review");assert.equal((await backend.inspect("job")).state,"needs_review");
 });
 test("changed inputs during verification persist an inconclusive run",async t=>{
   const {controller,config,fixture}=await setup(t);const binding=config.verificationBindings[0]!;const run=binding.run;binding.run=async context=>{const result=await run(context);const current=JSON.parse(readFileSync(fixture,"utf8"));writeFileSync(fixture,JSON.stringify({...current,changedDuringVerification:true}));return result;};
   await controller.start("job");await correct(controller);assert.equal((await controller.verify("fixture-check")).outcome,"inconclusive");assert.equal((await controller.finish()).state,"needs_review");
 });
 test("verification freezes mutation admissions until the command drains",async t=>{
   let entered!:()=>void;let release!:()=>void;const entry=new Promise<void>(resolve=>entered=resolve);const barrier=new Promise<void>(resolve=>release=resolve);
   const {controller,config}=await setup(t);const binding=config.verificationBindings[0]!;const run=binding.run;binding.run=async context=>{entered();await barrier;return run(context);};await controller.start("job");await correct(controller);const verification=controller.verify("fixture-check");await entry;await assert.rejects(()=>controller.step("correct",{expectedDigest:"fake"}),/freezes/);release();assert.equal((await verification).outcome,"passed");
 });
 test("registered work steps cannot exceed canonical contract scope",async t=>{
   const {controller,config,grants,preview}=await setup(t);const correctStep=config.steps.correct!;
   correctStep.paths=()=>["verify.mjs"];
   await controller.start("job");await assert.rejects(()=>controller.step("correct",{expectedDigest:"fake"}),/outside granted scope/);
 });
 test("known result survives restart and is replayed through status",async t=>{
   const {controller,config}=await setup(t);await controller.start("job");await correct(controller);const prior=(await controller.status()).lastStepExecution;await controller.shutdown();const restarted=new WorkAttemptController(config);t.after(()=>restarted.shutdown());assert.deepEqual((await restarted.status()).lastStepExecution,prior);assert.equal((await restarted.reconcile()).state,"running");
 });
 test("model-supplied verification fields are absent from the finite tool surface",async t=>{
   const {controller}=await setup(t);await controller.start("job");await assert.rejects(()=>controller.verify("fake-passed-step"),/unsupported/);await assert.rejects(()=>controller.step("arbitrary_shell",{command:"echo passed"}),/Unregistered/);
 });

 for(const boundary of ["verification_before_requested","step_before_requested","verification_after_start","verification_after_effect","verification_after_result","step_after_result","step_after_effect"]){
   test(`SIGKILL ${boundary} retains receipt/evidence without unsafe replay`,async t=>{
     const verifier='import fs from "node:fs";const count="run-count";fs.writeFileSync(count,String(fs.existsSync(count)?Number(fs.readFileSync(count,"utf8"))+1:1));const value=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));if(value.status!=="corrected"||value.value!==1)process.exit(1);console.log("verified");\n';
     const {controller,config,root}=await setup(t,{verifier});await controller.start("job");if(boundary.startsWith("verification_"))await correct(controller);await controller.shutdown();
     const child=await crashChild(root,boundary);await new Promise<void>(resolve=>{child.once("exit",()=>resolve());child.kill("SIGKILL");});
     const restarted=new WorkAttemptController(config);t.after(()=>restarted.shutdown());const status=await restarted.reconcile();
     if(boundary === "verification_before_requested" || boundary === "step_before_requested") {assert.equal(status.state,"running");if(boundary === "verification_before_requested"){await restarted.verify("fixture-check");assert.equal(readFileSync(join(root,"run-count"),"utf8"),"1");assert.equal((await restarted.finish()).state,"completed");}else assert.equal(JSON.parse(readFileSync(join(root,"fixture.json"),"utf8")).value,0);}
     else if(boundary === "verification_after_result") {assert.equal(status.state,"verifying");assert.equal((await restarted.finish()).state,"completed");assert.equal(readFileSync(join(root,"run-count"),"utf8"),"1");}
     else if(boundary === "step_after_effect") {assert.equal(status.state,"running");const resolutions=status.effectResolutions as Record<string,{effect:string;readbackExecutionId:string}>;assert.equal(Object.values(resolutions)[0]!.effect,"verified");const unknownBefore=Object.keys(resolutions)[0]!;const events=readdirSync(join(root,"journals","executions")).filter(name=>name.endsWith(".jsonl")).flatMap(name=>readFileSync(join(root,"journals","executions",name),"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)));assert.ok(!events.some(event=>event.executionId === unknownBefore && event.type === "settled"));await restarted.verify("fixture-check");assert.equal((await restarted.finish()).state,"completed");}
     else if(boundary === "step_after_result") {assert.equal(status.state,"running");assert.equal((status.lastStepExecution as {result:{data:{corrected:boolean}}}).result.data.corrected,true);assert.equal(JSON.parse(readFileSync(join(root,"fixture.json"),"utf8")).value,1);}
     else {assert.equal(status.state,"reconciliation_required");const again=await restarted.reconcile();assert.equal(again.state,"reconciliation_required");await assert.rejects(()=>restarted.verify("fixture-check"),/drain/);if(boundary === "verification_after_effect")assert.equal(readFileSync(join(root,"run-count"),"utf8"),"1");}
   });
 }
 function crashChild(root:string,boundary:string):Promise<ReturnType<typeof spawn>> {
   return new Promise((resolve,reject)=>{
     const child=spawn(process.execPath,["--import","tsx",fileURLToPath(new URL("./fixtures/work-crash-fixture.ts",import.meta.url))],{env:{...process.env,OF_WORK_CRASH_ROOT:root,OF_WORK_CRASH_MODE:boundary},stdio:["ignore","ignore","pipe","ipc"]});
     let error="";child.stderr?.on("data",chunk=>error+=chunk);const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error(`Work child timed out: ${error}`));},10000);child.once("message",()=>{clearTimeout(timer);resolve(child);});child.once("error",error=>{clearTimeout(timer);reject(error);});child.once("exit",code=>{clearTimeout(timer);reject(new Error(`Work child failed ${code}: ${error}`));});
   });
 }

 test("mutable caller parameters cannot bypass a registered admission rule",async t=>{
   const {controller,grants,bindings,fixture}=await setup(t);await controller.start("job");const inspected=await controller.step("inspect",{});const actual=(inspected.result.data as {expectedDigest:string}).expectedDigest;
   bindings.steps.correct!.validateParams=params=>{if(params.expectedDigest !== "SAFE_ONLY")throw new JournalInvariantError("Forbidden custom parameters");};
   let entered!:()=>void;let release!:()=>void;const entry=new Promise<void>(resolve=>entered=resolve);const barrier=new Promise<void>(resolve=>release=resolve);const reserve=grants.reserveAction.bind(grants);
   grants.reserveAction=async (...args)=>{entered();await barrier;return reserve(...args);};
   const params={expectedDigest:"SAFE_ONLY"};const operation=controller.step("correct",params);await entry;params.expectedDigest=actual;release();assert.equal((await operation).result.success,false);assert.equal(JSON.parse(readFileSync(fixture,"utf8")).value,0);
 });
 test("foreign lease descriptors never authorize another work transition",async t=>{
   let starts=0;const {controller,backend}=await setup(t,{backendWrap:backend=>new Proxy(backend,{get(target,key){if(key === "open")return async (...args:Parameters<WorkBackend["open"]>)=>({...await target.open(...args),workItemId:"foreign-work"});if(key === "transition")return async (...args:Parameters<WorkBackend["transition"]>)=>{starts++;return target.transition(...args);};const value=Reflect.get(target,key);return typeof value === "function" ? value.bind(target) : value;}})});
   await assert.rejects(()=>controller.start("job"),/descriptor identity/);assert.equal(starts,0);assert.equal((await controller.status()).state,"reconciliation_required");
 });
 test("receipt with a foreign operation identity is not adopted",async t=>{
   const {controller}=await setup(t,{backendWrap:backend=>new Proxy(backend,{get(target,key){if(key === "transition")return async (...args:Parameters<WorkBackend["transition"]>)=>({...await target.transition(...args),operationId:"foreign-operation"});const value=Reflect.get(target,key);return typeof value === "function" ? value.bind(target) : value;}})});
   await assert.rejects(()=>controller.start("job"),/receipt operation\/work binding/);assert.equal((await controller.status()).state,"reconciliation_required");
 });
 test("cancelled slow preflight never dispatches a claim",async t=>{
   let pause=false;let opens=0;let entered!:()=>void;let release!:()=>void;const entry=new Promise<void>(resolve=>entered=resolve);const barrier=new Promise<void>(resolve=>release=resolve);
   const {controller}=await setup(t,{backendWrap:backend=>new Proxy(backend,{get(target,key){if(key === "inspect")return async (...args:Parameters<WorkBackend["inspect"]>)=>{if(pause){entered();await barrier;}return target.inspect(...args);};if(key === "open")return async (...args:Parameters<WorkBackend["open"]>)=>{opens++;return target.open(...args);};const value=Reflect.get(target,key);return typeof value === "function" ? value.bind(target) : value;}})});
   pause=true;const cancellation=new AbortController();const start=controller.start("job",{signal:cancellation.signal});await entry;cancellation.abort();release();await assert.rejects(()=>start,/cancelled/);assert.equal(opens,0);pause=false;assert.equal((await controller.start("job") as {state:string}).state,"running");
 });
 test("cancellation during terminal proof stops the later complete dispatch",async t=>{
   const {controller,config,backend}=await setup(t);await controller.start("job");await correct(controller);await controller.verify("fixture-check");
   let entered!:()=>void;let release!:()=>void;const entry=new Promise<void>(resolve=>entered=resolve);const barrier=new Promise<void>(resolve=>release=resolve);const binding=config.verificationBindings[0]!;const readback=binding.readback;binding.readback=async root=>{entered();await barrier;return readback(root);};
   const cancellation=new AbortController();const finishing=controller.finish("complete",{signal:cancellation.signal});await entry;cancellation.abort();release();await assert.rejects(()=>finishing,/cancelled/);assert.equal((await backend.inspect("job")).state,"running");binding.readback=readback;assert.equal((await controller.reconcile()).state,"verifying");
 });
 test("verification subprocess environment does not inherit unrelated credentials",async t=>{
   process.env.OF_VERIFICATION_TEST_SECRET="private-test-sentinel";
   try{const {controller}=await setup(t,{verifier:'if(process.env.OF_VERIFICATION_TEST_SECRET)process.exit(2);console.log("environment bounded");\n'});await controller.start("job");await correct(controller);assert.equal((await controller.verify("fixture-check")).exitCode,0);}finally{delete process.env.OF_VERIFICATION_TEST_SECRET;}
 });

 test("missing mandatory execution journal cannot prove non-dispatch",async t=>{
   const {controller,config,root}=await setup(t);await controller.start("job");await controller.shutdown();const directory=join(root,"journals","executions");const path=join(directory,readdirSync(directory).find(name=>name.endsWith(".jsonl"))!);unlinkSync(path);assert.throws(()=>new WorkAttemptController(config),JournalInvariantError);
 });
 test("replaced execution stream identity fails before recovery",async t=>{
   const {controller,config,root}=await setup(t);await controller.start("job");await controller.shutdown();const directory=join(root,"journals","executions");const path=join(directory,readdirSync(directory).find(name=>name.endsWith(".jsonl"))!);const bytes=readFileSync(path);renameSync(path,`${path}.preserved`);writeFileSync(path,bytes,{mode:0o600});assert.throws(()=>new WorkAttemptController(config),/identity changed/);
 });

 test("active plan timeout reaches the shell-free verification subprocess",async t=>{
   const {controller}=await setup(t,{verificationTimeoutMs:40,verifier:'setTimeout(()=>console.log("late success"),1000);\n'});await controller.start("job");await correct(controller);const evidence=await controller.verify("fixture-check");assert.equal(evidence.exitCode,null);assert.equal(evidence.outcome,"inconclusive");assert.equal((await controller.finish()).state,"needs_review");
 });
 test("large output keeps its canonical receipt and exposes a bounded artifact projection",async t=>{
   const {controller,root,fixture}=await setup(t,{maxOutputBytes:262144});writeFileSync(fixture,JSON.stringify({status:"needs_correction",value:0,payload:"x".repeat(40000)}));await controller.start("job");
   const execution=await controller.step("inspect",{});assert.equal(execution.receipt.resultDigest,digestJson(execution.result));assert.ok(execution.artifactProjection);
   const status=await controller.status();const store=new FileArtifactStore({rootDir:join(root,"artifacts",status.attemptId as string)});const metadata=store.metadata(execution.artifactProjection!.artifact.id);const chunks:Buffer[]=[];for(let offset=0;offset<metadata.sizeBytes;offset+=16384)chunks.push(store.read(metadata.id,{offset,length:Math.min(16384,metadata.sizeBytes-offset)}));assert.equal(Buffer.concat(chunks).toString("utf8"),execution.modelContent);
   const facade=new ToolRegistry();facade.registerAll(createWorkTools(controller));const response=await facade.executeDetailed("of_work_step",{stepKey:"inspect",params:{}});assert.ok(Buffer.byteLength(response.modelContent)<32768);assert.ok((response.result.data as {artifactProjection:unknown}).artifactProjection);assert.equal((response.result.data as {result?:unknown}).result,undefined);
 });

 test("lost claim response reconciles the selected keyed claim without another open",async t=>{
   let opens=0;const {controller}=await setup(t,{backendWrap:backend=>new Proxy(backend,{get(target,key){if(key === "open")return async (...args:Parameters<WorkBackend["open"]>)=>{opens++;const lease=await target.open(...args);throw new Error("claim response lost");};const value=Reflect.get(target,key);return typeof value === "function" ? value.bind(target) : value;}})});
   await assert.rejects(()=>controller.start("job"),/claim response lost/);assert.equal((await controller.reconcile()).state,"running");assert.equal(opens,1);
 });
 test("authoritative not-started claim permits a new authorized operation",async t=>{
   let opens=0;const {controller}=await setup(t,{backendWrap:backend=>new Proxy(backend,{get(target,key){if(key === "open")return async (...args:Parameters<WorkBackend["open"]>)=>{opens++;if(opens === 1)throw new Error("claim not dispatched");return target.open(...args);};const value=Reflect.get(target,key);return typeof value === "function" ? value.bind(target) : value;}})});
   await assert.rejects(()=>controller.start("job"),/claim not dispatched/);assert.equal((await controller.reconcile()).state,"running");assert.equal(opens,2);
 });
 test("known non-dispatch at start resumes the same selected claim",async t=>{
   let starts=0;const {controller}=await setup(t,{backendWrap:backend=>new Proxy(backend,{get(target,key){if(key === "transition")return async (...args:Parameters<WorkBackend["transition"]>)=>{if(args[1] === "start" && ++starts === 1)throw new Error("start not dispatched");return target.transition(...args);};const value=Reflect.get(target,key);return typeof value === "function" ? value.bind(target) : value;}})});
   await assert.rejects(()=>controller.start("job"),/start not dispatched/);assert.equal((await controller.reconcile()).state,"running");assert.equal(starts,2);
 });
 test("lost review response reconciles its terminal receipt without work replay",async t=>{
   let reviews=0;const {controller}=await setup(t,{completion:false,backendWrap:backend=>new Proxy(backend,{get(target,key){if(key === "transition")return async (...args:Parameters<WorkBackend["transition"]>)=>{const receipt=await target.transition(...args);if(args[1] === "review"){reviews++;throw new Error("review response lost");}return receipt;};const value=Reflect.get(target,key);return typeof value === "function" ? value.bind(target) : value;}})});
   await controller.start("job");await assert.rejects(()=>controller.finish(),/review response lost/);assert.equal((await controller.reconcile()).state,"needs_review");assert.equal(reviews,1);
 });
 test("backend uncertainty without authoritative reconciliation remains blocked",async t=>{
   let opens=0;const {controller}=await setup(t,{backendWrap:backend=>new Proxy(backend,{get(target,key){if(key === "capabilities")return {...target.capabilities,keyedOperations:[],receiptLookup:[],missingReceiptProvesNotStarted:false};if(key === "open")return async (...args:Parameters<WorkBackend["open"]>)=>{opens++;await target.open(...args);throw new Error("unresolved open");};if(key === "reconcileOperation")return async()=>({state:"unknown",sourceRefs:["unsupported lookup"]});const value=Reflect.get(target,key);return typeof value === "function" ? value.bind(target) : value;}})});
   await assert.rejects(()=>controller.start("job"),/unresolved open/);assert.equal((await controller.reconcile()).state,"reconciliation_required");assert.equal(opens,1);await assert.rejects(()=>controller.finish(),/uncertain/);
 });

 test("exhausted output remains a durable admission block through reconciliation",async t=>{
   const {controller,fixture}=await setup(t,{maxOutputBytes:100});await controller.start("job");await assert.rejects(()=>controller.step("inspect",{}),/output/);assert.equal((await controller.status()).state,"reconciliation_required");const before=readFileSync(fixture,"utf8");
   await assert.rejects(()=>controller.reconcile(),/output budget/);await assert.rejects(()=>controller.step("correct",{expectedDigest:digestJson(before)}),/not accepting|output budget/);assert.equal(readFileSync(fixture,"utf8"),before);assert.equal((await controller.finish("release")).state,"released");
 });

 test("exact expected fixture digest reconciles an uncertain effect with separate readback",async t=>{
   const {controller,root,fixture}=await setup(t,{afterEffect:async()=>{throw new Error("effect response lost");}});await controller.start("job");const inspected=await controller.step("inspect",{});const execution=await controller.step("correct",{expectedDigest:(inspected.result.data as {expectedDigest:string}).expectedDigest});assert.equal(execution.outcome,"unknown");
   const directory=join(root,"journals","executions");const path=join(directory,readdirSync(directory).find(name=>name.endsWith(".jsonl"))!);const original=readFileSync(path,"utf8").split("\n").filter(line=>line.includes(execution.receipt.executionId));const status=await controller.reconcile();const proof=(status.effectResolutions as Record<string,{readbackExecutionId:string}>)[execution.receipt.executionId]!;assert.ok(proof.readbackExecutionId);assert.notEqual(proof.readbackExecutionId,execution.receipt.executionId);assert.deepEqual(readFileSync(path,"utf8").split("\n").filter(line=>line.includes(execution.receipt.executionId)&&JSON.parse(line).executionId === execution.receipt.executionId),original);assert.equal((await controller.status()).unknownExecutions instanceof Array,true);assert.equal(JSON.parse(readFileSync(fixture,"utf8")).value,1);await controller.verify("fixture-check");assert.equal((await controller.finish()).state,"completed");
 });
 test("mismatching effect subject remains unknown and is never rewritten",async t=>{
   const {controller,fixture}=await setup(t,{afterEffect:async()=>{throw new Error("effect response lost");}});await controller.start("job");const inspected=await controller.step("inspect",{});const execution=await controller.step("correct",{expectedDigest:(inspected.result.data as {expectedDigest:string}).expectedDigest});writeFileSync(fixture,'{"status":"corrected","value":1,"otherChange":true}');const bytes=readFileSync(fixture,"utf8");const status=await controller.reconcile();assert.equal(status.state,"reconciliation_required");assert.deepEqual(status.unknownExecutions,[execution.receipt.executionId]);assert.equal(readFileSync(fixture,"utf8"),bytes);
 });
 test("oracle failure and changed catalog cannot clear original effect uncertainty",async t=>{
   let fail=false;const {controller,bindings}=await setup(t,{afterEffect:async()=>{throw new Error("effect response lost");}});const binding=bindings.steps.correct!;const readback=binding.reconcileEffect!;binding.reconcileEffect=async context=>{if(fail)throw new Error("oracle unavailable");return readback(context);};await controller.start("job");const inspected=await controller.step("inspect",{});await controller.step("correct",{expectedDigest:(inspected.result.data as {expectedDigest:string}).expectedDigest});fail=true;assert.equal((await controller.reconcile()).state,"reconciliation_required");fail=false;binding.reconciliationSpecDigest="changed-spec";await assert.rejects(()=>controller.reconcile(),/catalog or authority changed/);
 });
 test("readback cannot consume revoked authority or a lost lease",async t=>{
   const {controller,grants,executionGrant,advance}=await setup(t,{leaseSeconds:1,afterEffect:async()=>{throw new Error("effect response lost");}});await controller.start("job");const inspected=await controller.step("inspect",{});await controller.step("correct",{expectedDigest:(inspected.result.data as {expectedDigest:string}).expectedDigest});advance(1100);await assert.rejects(()=>controller.reconcile(),/expiry mismatch/);grants.revoke(executionGrant.id);await assert.rejects(()=>controller.reconcile(),/grant missing/);
 });

 test("SIGKILL after effect receipt charges recovered output before another admission",async t=>{
   const {controller,config,root,fixture}=await setup(t,{maxOutputBytes:200});await controller.start("job");await controller.shutdown();const child=await crashChild(root,"step_after_result");await new Promise<void>(resolve=>{child.once("exit",()=>resolve());child.kill("SIGKILL");});
   const restarted=new WorkAttemptController(config);t.after(()=>restarted.shutdown());await assert.rejects(()=>restarted.reconcile(),/output/);const status=await restarted.status();assert.ok((status.outputBytes as number)>200);const before=readFileSync(fixture,"utf8");await assert.rejects(()=>restarted.step("correct",{expectedDigest:digestJson(before)}),/not accepting|output/);assert.equal(readFileSync(fixture,"utf8"),before);
 });
 test("SIGKILL after verification receipt charges its artifact before submission or work",async t=>{
   const verifier='import fs from "node:fs";const value=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));if(value.value!==1)process.exit(1);process.stdout.write("x".repeat(201));';
   const {controller,config,root,fixture}=await setup(t,{maxOutputBytes:350,verifier});await controller.start("job");await correct(controller);await controller.shutdown();const child=await crashChild(root,"verification_after_result");await new Promise<void>(resolve=>{child.once("exit",()=>resolve());child.kill("SIGKILL");});
   const restarted=new WorkAttemptController(config);t.after(()=>restarted.shutdown());await assert.rejects(()=>restarted.reconcile(),/output/);assert.ok(((await restarted.status()).outputBytes as number)>350);const before=readFileSync(fixture,"utf8");await assert.rejects(()=>restarted.step("correct",{expectedDigest:digestJson(before)}),/not accepting|output/);assert.equal(readFileSync(fixture,"utf8"),before);
 });
 test("SIGKILL after readback receipt charges the old proof before any fresh observation",async t=>{
   const {controller,config,root,fixture}=await setup(t,{maxOutputBytes:450,afterEffect:async()=>{throw new Error("lost");}});await controller.start("job");const inspected=await controller.step("inspect",{});await controller.step("correct",{expectedDigest:(inspected.result.data as {expectedDigest:string}).expectedDigest});await controller.shutdown();const child=await crashChild(root,"readback_after_result");await new Promise<void>(resolve=>{child.once("exit",()=>resolve());child.kill("SIGKILL");});
   const restarted=new WorkAttemptController(config);t.after(()=>restarted.shutdown());await assert.rejects(()=>restarted.reconcile(),/output/);assert.ok(((await restarted.status()).outputBytes as number)>450);const before=readFileSync(fixture,"utf8");await assert.rejects(()=>restarted.step("correct",{expectedDigest:digestJson(before)}),/not accepting|output/);assert.equal(readFileSync(fixture,"utf8"),before);
 });
 test("SIGKILL after durable grant output does not charge the same execution twice",async t=>{
   const {controller,config,root}=await setup(t,{maxOutputBytes:200});await controller.start("job");await controller.shutdown();const child=await crashChild(root,"output_after_ledger");await new Promise<void>(resolve=>{child.once("exit",()=>resolve());child.kill("SIGKILL");});
   const restarted=new WorkAttemptController(config);t.after(()=>restarted.shutdown());const status=await restarted.reconcile();assert.equal(status.state,"running");assert.ok((status.outputBytes as number)<200);
   const events=readdirSync(join(root,"grants")).filter(name=>name.endsWith(".jsonl")).flatMap(name=>readFileSync(join(root,"grants",name),"utf8").trim().split("\n").map(line=>JSON.parse(line))).filter(event=>event.type === "output");assert.equal(events.length,1);assert.ok(events[0].outputExecutionId);
 });

function reviewBarrier() {
 let entered!:()=>void;let release!:()=>void;
 const entry=new Promise<void>(resolve=>entered=resolve);
 const waiting=new Promise<void>(resolve=>release=resolve);
 return {entry,entered,waiting,release};
}
async function waitForQueuedSteps(controller:WorkAttemptController,count:number) {
 const deadline=Date.now()+3000;
 while(((await controller.status()).inflightStepIds as string[]).length !== count) {
   assert.ok(Date.now()<deadline,"Expected controller steps to reach the shared queue");
   await new Promise<void>(resolve=>setImmediate(resolve));
 }
}

test("queued writes stop after the prior effect becomes uncertain",async t=>{
 const barrier=reviewBarrier();t.after(()=>barrier.release());let effects=0;
 const {controller,fixture}=await setup(t,{afterEffect:async()=>{effects++;if(effects === 1){barrier.entered();await barrier.waiting;throw new Error("Result lost after effect");}}});
 await controller.start("job");const inspected=await controller.step("inspect",{});
 const first=controller.step("correct",{expectedDigest:(inspected.result.data as {expectedDigest:string}).expectedDigest});
 await barrier.entry;
 const second=controller.step("correct",{expectedDigest:digestJson(readFileSync(fixture,"utf8"))});
 await waitForQueuedSteps(controller,2);barrier.release();
 const [unknown,denied]=await Promise.all([first,second]);
 assert.equal(unknown.outcome,"unknown");assert.equal(denied.receipt.phase,"not_started");assert.equal(effects,1);
 const status=await controller.status();assert.equal(status.state,"reconciliation_required");assert.deepEqual(status.unknownExecutions,[unknown.receipt.executionId]);
});

test("queued writes refuse a lease replaced by a successor",async t=>{
 const barrier=reviewBarrier();t.after(()=>barrier.release());let effects=0;
 const {controller,config,local}=await setup(t,{afterEffect:async()=>{effects++;}});
 await controller.start("job");const inspected=await controller.step("inspect",{});
 config.registry.register({name:"hold_for_custody_review",description:"Hold the shared executor reservation",inputSchema:{type:"object",properties:{}},handler:async()=>{barrier.entered();await barrier.waiting;return {success:true};}});
 const hold=config.registry.executeDetailed("hold_for_custody_review",{});await barrier.entry;
 const pending=controller.step("correct",{expectedDigest:(inspected.result.data as {expectedDigest:string}).expectedDigest});
 await waitForQueuedSteps(controller,1);
 await local.release((await local.inspect("job")).lease!,"review-release");
 const successor=await local.open({workItemId:"job",claimOwner:"successor",leaseSeconds:120,idempotencyKey:"review-successor"});
 await local.transition(successor,"start",{},"review-successor-start");
 barrier.release();await hold;const result=await pending;
 assert.equal(result.receipt.phase,"not_started");assert.equal(effects,0);assert.equal((await local.inspect("job")).lease!.owner,"successor");
});

for(const change of ["completion","execution","expiry"] as const)test(`terminal dispatch refuses ${change} authority loss during proof readback`,async t=>{
 const barrier=reviewBarrier();t.after(()=>barrier.release());
 const {controller,bindings,grants,local,advance}=await setup(t);await controller.start("job");await correct(controller);await controller.verify("fixture-check");
 const binding=bindings.verificationBindings[0]!;const original=binding.readback;
 binding.readback=async root=>{barrier.entered();await barrier.waiting;return original(root);};
 const pending=controller.finish("complete");const rejection=assert.rejects(pending,/grant missing|expired|duration/);await barrier.entry;
 if(change === "expiry")advance(60001);else grants.revoke(grants.list().find(grant=>grant.purpose === change)!.id);
 barrier.release();await rejection;
 assert.equal((await local.inspect("job")).state,"running");assert.equal((await controller.status()).state,"reconciliation_required");
});

test("queued writes stop when the prior result cannot be journaled",async t=>{
 const barrier=reviewBarrier();t.after(()=>barrier.release());let effects=0;
 const {controller,fixture}=await setup(t,{afterEffect:async()=>{effects++;if(effects === 1){barrier.entered();await barrier.waiting;}}});
 const original=ExecutionJournal.prototype.record;let failed=false;
 ExecutionJournal.prototype.record=function(event){
   const receipt=event.data.receipt as {toolName?:string}|undefined;
   if(event.type === "settled" && receipt?.toolName === "fixture_correct" && !failed){failed=true;throw new Error("Result journal unavailable");}
   return original.call(this,event);
 };
 t.after(()=>{ExecutionJournal.prototype.record=original;});
 await controller.start("job");const inspected=await controller.step("inspect",{});
 const first=controller.step("correct",{expectedDigest:(inspected.result.data as {expectedDigest:string}).expectedDigest});await barrier.entry;
 const second=controller.step("correct",{expectedDigest:digestJson(readFileSync(fixture,"utf8"))});await waitForQueuedSteps(controller,2);barrier.release();
 const [unknown,denied]=await Promise.all([first,second]);
 assert.equal(failed,true);assert.equal(unknown.outcome,"unknown");assert.equal(denied.receipt.phase,"not_started");assert.equal(effects,1);
 assert.equal((await controller.status()).state,"reconciliation_required");
});

test("an earlier registry journal failure still fences queued controller effects",async t=>{
 const barrier=reviewBarrier();t.after(()=>barrier.release());let effects=0;let failed=false;
 const journal:ExecutionJournalSink={record:event=>{
   if(event.type === "settled" && (event.data.receipt as {toolName:string}).toolName === "fixture_correct" && !failed){failed=true;throw new Error("Primary registry journal failed before controller sink");}
 }};
 const {controller,fixture}=await setup(t,{journal,afterEffect:async()=>{effects++;if(effects === 1){barrier.entered();await barrier.waiting;}}});
 await controller.start("job");const inspected=await controller.step("inspect",{});
 const first=controller.step("correct",{expectedDigest:(inspected.result.data as {expectedDigest:string}).expectedDigest});await barrier.entry;
 const second=controller.step("correct",{expectedDigest:digestJson(readFileSync(fixture,"utf8"))});await waitForQueuedSteps(controller,2);barrier.release();
 const [unknown,denied]=await Promise.all([first,second]);
 assert.equal(failed,true);assert.equal(unknown.outcome,"unknown");assert.equal(denied.receipt.phase,"not_started");assert.equal(effects,1);
 assert.equal((await controller.status()).state,"reconciliation_required");
});
