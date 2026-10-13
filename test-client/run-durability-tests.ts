import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ExecutionJournal } from "../src/framework/execution-journal.js";
import { JournalConcurrencyError, JournalInvariantError, SecureJsonlJournal, type JournalEnvelope } from "../src/framework/journal-file.js";
import { ArtifactQuotaError, FileArtifactStore } from "../src/framework/artifacts.js";
import { digestJson } from "../src/framework/session.js";
import { WorkAttemptJournal } from "../src/framework/work/journal.js";

function temporary(t:{after(fn:()=>void):void}):string {const root=mkdtempSync(join(tmpdir(),"openfunction-durability-"));chmodSync(root,0o700);t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
function execution(root:string):ExecutionJournal {return new ExecutionJournal({rootDir:root,streamId:"run",scopeDigest:"sha256:scope"});}
const started=(journal:ExecutionJournal) => {
  journal.record({type:"requested",executionId:"call",data:{inputDigest:"digest",capabilityDigest:"capability"}});
  journal.record({type:"admitted",executionId:"call",data:{policyRef:"policy"}});
  journal.record({type:"started",executionId:"call",data:{}});
};
function done(journal:ExecutionJournal):void {journal.record({type:"settled",executionId:"call",data:{receipt:{schemaVersion:1,executionId:"call",phase:"settled",admission:"allowed",inputDigest:"digest",capabilityDigest:"capability",executionOutcome:"succeeded",resultDigest:digestJson({success:true,data:{changed:true}})},result:{success:true,data:{changed:true}},modelContent:JSON.stringify({success:true,data:{changed:true}})}});}

if(process.env.OF_DURABILITY_CHILD){
  const root=process.env.OF_DURABILITY_ROOT!;const boundary=process.env.OF_DURABILITY_CHILD;
  const journal=execution(root);
  if(boundary === "writer") {
    const file=new SecureJsonlJournal<JournalEnvelope>({rootDir:root,streamId:"cas",scopeDigest:"scope",schemaVersion:1});
    process.on("message",()=>{try {file.append({schemaVersion:1,streamId:"cas",scopeDigest:"scope",seq:1},0);process.send?.("appended");}catch(error){process.send?.(error instanceof JournalConcurrencyError ? "conflict" : "unexpected");}});
  }
  else if(boundary === "owner")journal.acquireOwnership();
  else if(boundary === "recovery")journal.recover();
  else {
    journal.record({type:"requested",executionId:"call",data:{inputDigest:"digest",capabilityDigest:"capability"}});
    if(boundary !== "before_admission") {
      journal.record({type:"admitted",executionId:"call",data:{policyRef:"policy"}});
      journal.record({type:"started",executionId:"call",data:{}});
      if(boundary !== "after_start")writeFileSync(join(root,"effect"),"1",{mode:0o600});
      if(boundary === "after_result")done(journal);
    }
  }
  process.send?.("ready");setInterval(()=>{},1000);
} else {
  test("immutable snapshots, sequence CAS and scope/version binding",t=>{
    const root=temporary(t);const file=new SecureJsonlJournal<JournalEnvelope&{data:{value:number}}>({rootDir:root,streamId:"one",scopeDigest:"scope",schemaVersion:1});
    const event={schemaVersion:1,streamId:"one",scopeDigest:"scope",seq:1,data:{value:1}};file.append(event,0);event.data.value=2;
    assert.equal(file.read()[0]!.data.value,1);assert.ok(Object.isFrozen(file.read()[0]!.data));
    assert.throws(()=>file.append({...event,seq:2},0),JournalConcurrencyError);
    assert.throws(()=>new SecureJsonlJournal({rootDir:root,streamId:"one",scopeDigest:"changed",schemaVersion:1}).read(),JournalInvariantError);
    assert.throws(()=>new SecureJsonlJournal({rootDir:root,streamId:"one",scopeDigest:"scope",schemaVersion:2}).read(),JournalInvariantError);
  });
  test("torn final fragment recovers; malformed committed lines fail closed",t=>{
    const root=temporary(t);const journal=execution(root);started(journal);
    const path=join(root,readdirSync(root).find(name=>name.endsWith(".jsonl"))!);
    appendFileSync(path,'{"incomplete":');assert.equal(execution(root).recover()[0]!.state,"unknown");done(journal);
    assert.equal(execution(root).recover()[0]!.state,"settled");assert.equal(readFileSync(path,"utf8").includes("incomplete"),false);
    appendFileSync(path,"not json\n");assert.throws(()=>execution(root),JournalInvariantError);
  });
  test("unsafe roots, ancestor links, file links and weak permissions fail closed",t=>{
    const root=temporary(t);const privateDir=join(root,"private");mkdirSync(privateDir,{mode:0o700});
    const link=join(root,"link");symlinkSync(privateDir,link);assert.throws(()=>execution(`${link}/`),JournalInvariantError);assert.throws(()=>execution(join(link,"child")),JournalInvariantError);
    chmodSync(privateDir,0o755);assert.throws(()=>execution(privateDir),JournalInvariantError);chmodSync(privateDir,0o700);
    const digest=createHash("sha256").update("run").digest("hex");symlinkSync(join(root,"other"),join(privateDir,`${digest}.jsonl`));assert.throws(()=>execution(privateDir),JournalInvariantError);
  });
  test("authority custody and illegal transitions are rejected before append",t=>{
    const journal=execution(temporary(t));
    assert.throws(()=>journal.record({type:"started",executionId:"x",data:{}}),JournalInvariantError);
    assert.throws(()=>journal.record({type:"requested",executionId:"x",data:{claimToken:"secret"}}),JournalInvariantError);
    journal.record({type:"requested",executionId:"x",data:{}});
    assert.throws(()=>journal.record({type:"rejected",executionId:"x",data:{receipt:{phase:"settled"}}}),JournalInvariantError);
    journal.record({type:"rejected",executionId:"x",data:{receipt:{schemaVersion:1,executionId:"x",phase:"not_started",admission:"rejected",executionOutcome:"failed",resultDigest:digestJson({success:false,error:"denied"})},result:{success:false,error:"denied"},modelContent:JSON.stringify({success:false,error:"denied"})}});
    assert.equal(journal.recover()[0]!.state,"settled");
  });
  test("work operations remain unresolved until receipt references settle them",t=>{
    const root=temporary(t);const journal=new WorkAttemptJournal({rootDir:root,attemptId:"attempt",scopeDigest:"scope"});
    journal.record({type:"prepared",data:{contractDigest:"contract"}});
    journal.record({type:"operation_started",data:{operationId:"op",kind:"step"}});
    assert.deepEqual(journal.recover().unresolvedOperationIds,["op"]);
    assert.throws(()=>journal.record({type:"step",data:{result:"duplicated"}}),JournalInvariantError);
    journal.record({type:"operation_settled",data:{operationId:"op"},executionId:"call",receiptRef:"receipt"});
    assert.deepEqual(journal.recover().unresolvedOperationIds,[]);
    const reopened=new WorkAttemptJournal({rootDir:root,attemptId:"attempt",scopeDigest:"scope"});assert.deepEqual(reopened.recover(),journal.recover());
  });
  test("artifact quota, bounded reads, immutable output and digest checks",t=>{
    const root=temporary(t);const store=new FileArtifactStore({rootDir:root,quotaBytes:8,maxReadBytes:4});const ref=store.put("abcdef",{mediaType:"text/plain"});
    assert.equal(lstatSync(join(root,`${ref.id}.artifact`)).mode&0o777,0o600);
    assert.throws(()=>store.read(ref.id),JournalInvariantError);const bytes=store.read(ref.id,{offset:1,length:3});assert.equal(bytes.toString(),"bcd");bytes.fill(0);assert.equal(store.read(ref.id,{offset:1,length:3}).toString(),"bcd");
    assert.throws(()=>store.read("../secret"),JournalInvariantError);assert.throws(()=>store.put("xyz"),ArtifactQuotaError);
    const path=join(root,`${ref.id}.artifact`);const record=JSON.parse(readFileSync(path,"utf8"));record.reference.sha256="0".repeat(64);writeFileSync(path,JSON.stringify(record));assert.throws(()=>store.metadata(ref.id),JournalInvariantError);
  });
  for(const boundary of ["before_admission","after_start","after_effect","after_result"]){
    test(`SIGKILL ${boundary} recovers without repeating an effect`,async t=>{
      const root=temporary(t);const child=await readyChild(root,boundary);await killChild(child);
      const journal=execution(root);const recovered=journal.recover();
      assert.equal(recovered[0]!.state,boundary === "before_admission" ? "not_started" : boundary === "after_result" ? "settled" : "unknown");
      if(boundary === "after_result")assert.equal(recovered[0]!.settled!.modelContent,JSON.stringify({success:true,data:{changed:true}}));
      const effect=existsSync(join(root,"effect")) ? readFileSync(join(root,"effect"),"utf8") : undefined;
      const recoveryChild=await readyChild(root,"recovery");await killChild(recoveryChild);
      assert.deepEqual(execution(root).recover(),recovered);assert.equal(existsSync(join(root,"effect")) ? readFileSync(join(root,"effect"),"utf8") : undefined,effect);
    });
  }
  test("cross-process compare-and-append admits only one concurrent writer",async t=>{
    const root=temporary(t);const one=await readyChild(root,"writer");const two=await readyChild(root,"writer");
    const status=(child:ReturnType<typeof spawn>)=>new Promise<string>(resolve=>{child.once("message",value=>resolve(String(value)));child.send?.("go");});
    const statuses=await Promise.all([status(one),status(two)]);await Promise.all([killChild(one),killChild(two)]);
    assert.deepEqual(statuses.sort(),["appended","conflict"]);
    const file=new SecureJsonlJournal<JournalEnvelope>({rootDir:root,streamId:"cas",scopeDigest:"scope",schemaVersion:1});assert.equal(file.read().length,1);
  });
  test("a live process owner cannot be stolen; dead owner is safely recovered",async t=>{
    const root=temporary(t);const child=await readyChild(root,"owner");assert.throws(()=>execution(root).acquireOwnership(),JournalConcurrencyError);
    await killChild(child);const journal=execution(root);const owner=journal.acquireOwnership();assert.throws(()=>journal.acquireOwnership(),JournalConcurrencyError);owner.release();journal.acquireOwnership().release();
  });
}
function readyChild(root:string,boundary:string):Promise<ReturnType<typeof spawn>> {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,["--import","tsx",fileURLToPath(import.meta.url)],{env:{...process.env,OF_DURABILITY_CHILD:boundary,OF_DURABILITY_ROOT:root},stdio:["ignore","ignore","pipe","ipc"]});
    let error="";child.stderr?.on("data",chunk=>error+=chunk);const timeout=setTimeout(()=>{child.kill("SIGKILL");reject(new Error(`Child ${boundary} timed out: ${error}`));},10000);
    child.once("message",()=>{clearTimeout(timeout);resolve(child);});child.once("error",error=>{clearTimeout(timeout);reject(error);});child.once("exit",code=>{clearTimeout(timeout);reject(new Error(`Child exited before ready ${code}: ${error}`));});
  });
}
function killChild(child:ReturnType<typeof spawn>):Promise<void>{return new Promise(resolve=>{child.once("exit",()=>resolve());child.kill("SIGKILL");});}
