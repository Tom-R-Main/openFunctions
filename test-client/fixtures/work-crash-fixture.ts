/** Process-kill fixture only: real controller/backend/grants, paused at durable boundaries. */
import { join } from "node:path";
import { ExecutionJournal } from "../../src/framework/execution-journal.js";
import { FileArtifactStore } from "../../src/framework/artifacts.js";
import { ToolRegistry } from "../../src/framework/registry.js";
import { LocalGrantStore } from "../../src/framework/work/grants.js";
import { LocalWorkBackend } from "../../src/framework/work/local-backend.js";
import { WorkAttemptController } from "../../src/framework/work/controller.js";
import { createLocalFixtureBindings } from "../../src/framework/work/local-fixture.js";
const root=process.env.OF_WORK_CRASH_ROOT!;const mode=process.env.OF_WORK_CRASH_MODE!;
const bindings=createLocalFixtureBindings({workspaceRoot:root,fixturePath:"fixture.json",verifierPath:"verify.mjs",...(mode === "step_after_effect" ? {afterEffect:async()=>stop()}: {})});
const registry=new ToolRegistry();registry.registerAll(bindings.tools);
const backend=new LocalWorkBackend({rootDir:join(root,"backend"),backendId:"local-test",workspaceId:"test-workspace",workItems:[{workItemId:"job",contract:bindings.contract,plan:{id:"plan",version:1,state:"active",steps:[bindings.verificationStep]}}]});
const controller=new WorkAttemptController({backend,registry,grantResolver:new LocalGrantStore({rootDir:join(root,"grants")}),journalRoot:join(root,"journals"),artifactRoot:join(root,"artifacts"),workspaceRoot:root,claimOwner:"test-owner",steps:bindings.steps,verificationBindings:bindings.verificationBindings,renewalSafetyMs:25});
const stop=()=>{process.send?.("ready");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
const record=ExecutionJournal.prototype.record;
ExecutionJournal.prototype.record=function(event){if(event.type === "requested" && (mode === "verification_before_requested" && String(event.data.toolName).startsWith("_of_verify_") || mode === "step_before_requested" && event.data.toolName === "fixture_correct"))stop();record.call(this,event);const name=(event.data.receipt as {toolName?:string})?.toolName;if(mode === "verification_after_result" && event.type === "settled" && name?.startsWith("_of_verify_"))stop();if(mode === "verification_after_start" && event.type === "started" && name?.startsWith("_of_verify_"))stop();if(mode === "step_after_result" && event.type === "settled" && name === "fixture_correct")stop();if(mode === "readback_after_result" && event.type === "settled" && name?.startsWith("_of_readback_"))stop();};
const put=FileArtifactStore.prototype.put;
FileArtifactStore.prototype.put=function(content,options){const artifact=put.call(this,content,options);if(mode === "verification_after_effect")stop();return artifact;};
if(mode === "output_after_ledger") {
  const recordOutput=LocalGrantStore.prototype.recordOutput;
  LocalGrantStore.prototype.recordOutput=async function(...args){await recordOutput.apply(this,args);stop();};
}
await controller.reconcile();
if(mode === "output_after_ledger")await controller.step("inspect",{});
else if(mode.startsWith("verification_"))await controller.verify("fixture-check");
else {const inspected=await controller.step("inspect",{});await controller.step("correct",{expectedDigest:(inspected.result.data as {expectedDigest:string}).expectedDigest});}
throw new Error("Crash fixture failed to reach selected durable boundary");
