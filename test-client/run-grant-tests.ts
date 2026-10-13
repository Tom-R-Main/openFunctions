import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalGrantStore, type IssueGrantOptions } from "../src/framework/work/grants.js";
import type { WorkAuthorizationBinding } from "../src/framework/work/types.js";

const binding: WorkAuthorizationBinding = {backendId:"local",workItemId:"job",workspaceId:"workspace",contractDigest:"contract",revision:"1",planId:"plan",planVersion:1,planDigest:"plan-digest",scopeDigest:"scope"};
function options(root:string, now:number, purpose: "execution"|"completion"="execution"):IssueGrantOptions {
  return {purpose,expiresAt:now+1000,actions:["read","write","test"],roots:[root],include:["job.json"],exclude:[".git/**"],stepBindings:{correct:{toolName:"fixture_correct",capabilityDigest:"spec"}},acceptanceMethods:["fixture-readback"],limits:{maxAttempts:1,maxDurationMs:100,maxActions:1,maxOutputBytes:100}};
}
function sandbox(){const root=mkdtempSync(join(tmpdir(),"of-grants-"));return {root,dispose:()=>rmSync(root,{recursive:true,force:true})};}

test("persisted grants bind execution and completion to separate trusted decisions",async()=>{
  const box=sandbox();try{
    const store=new LocalGrantStore({rootDir:box.root,clock:()=>10});
    const execution=store.issue(binding,options(box.root,10));
    assert.equal(await store.resolve(binding,"completion"),undefined);
    const completion=store.issue(binding,{...options(box.root,10,"completion"),executionGrantId:execution.id});
    assert.notEqual(completion.decisionRef,execution.decisionRef);
    assert.equal((await new LocalGrantStore({rootDir:box.root,clock:()=>20}).resolve(binding,"execution"))?.id,execution.id);
    assert.equal((await store.resolve(binding,"completion"))?.id,completion.id);
    store.revoke(execution.id);
    assert.equal(await store.resolve(binding,"execution"),undefined);
    assert.equal(await store.resolve(binding,"completion"),undefined);
    assert.equal(store.list()[0]?.revokedAt,10);
  }finally{box.dispose();}
});

test("changed work identity, scope, plan or expiry refuses copied grants",async()=>{
  const box=sandbox();let now=10;try{
    const store=new LocalGrantStore({rootDir:box.root,clock:()=>now});store.issue(binding,options(box.root,now));
    for(const replacement of [{workItemId:"other"},{scopeDigest:"changed"},{planDigest:"changed"},{revision:"2"},{contractDigest:"changed"}]) assert.equal(await store.resolve({...binding,...replacement},"execution"),undefined);
    now=1010;assert.equal(await store.resolve(binding,"execution"),undefined);
  }finally{box.dispose();}
});

test("grant usage survives restart and enforces attempts, actions, output and duration",async()=>{
  const box=sandbox();let now=10;try{
    const store=new LocalGrantStore({rootDir:box.root,clock:()=>now});store.issue(binding,options(box.root,now));
    await store.reserveAttempt(binding,"a");await store.reserveAttempt(binding,"a");
    await assert.rejects(store.reserveAttempt(binding,"b"),/attempt limit/);
    await store.reserveAction(binding,"a");await assert.rejects(store.reserveAction(binding,"a"),/action limit/);
    await store.recordOutput(binding,"a",90);await assert.rejects(store.recordOutput(binding,"a",11),/output limit/);
    const reopened=new LocalGrantStore({rootDir:box.root,clock:()=>now});await assert.rejects(reopened.reserveAction(binding,"a"),/action limit/);
    now=110;await assert.rejects(reopened.recordOutput(binding,"a",1),/duration limit/);
  }finally{box.dispose();}
});

test("grant state is private and refuses symlink/mode changes",()=>{
  const box=sandbox();try{
    const store=new LocalGrantStore({rootDir:box.root,clock:()=>10});store.issue(binding,options(box.root,10));
    assert.equal(lstatSync(box.root).mode & 0o777,0o700);
    const log=join(box.root,readdirSync(box.root).find(value=>value.endsWith('.jsonl'))!);
    assert.equal(lstatSync(log).mode & 0o777,0o600);
    chmodSync(log,0o644);assert.throws(()=>store.list(),/0600/);
    chmodSync(log,0o600);
    const link=join(box.root,"link");symlinkSync(box.root,link);assert.throws(()=>new LocalGrantStore({rootDir:link}),/symlink/);
  }finally{box.dispose();}
});


test("stable execution output accounting is idempotent across restart and rejects conflicts",async()=>{
  const box=sandbox();try{
    const store=new LocalGrantStore({rootDir:box.root,clock:()=>10});store.issue(binding,options(box.root,10));
    await store.reserveAttempt(binding,"a");await store.recordOutput(binding,"a",90,"execution-1");
    const log=join(box.root,readdirSync(box.root).find(value=>value.endsWith('.jsonl'))!);
    const size=lstatSync(log).size;
    const reopened=new LocalGrantStore({rootDir:box.root,clock:()=>20});
    await reopened.recordOutput(binding,"a",90,"execution-1");assert.equal(lstatSync(log).size,size,"repeat must not append or double charge the acknowledged output");
    await assert.rejects(reopened.recordOutput(binding,"a",89,"execution-1"),/Conflicting output/);
    await assert.rejects(reopened.recordOutput(binding,"a",1,""),/execution identity/);
    await reopened.recordOutput(binding,"a",10,"execution-2");
    await assert.rejects(reopened.recordOutput(binding,"a",1,"execution-3"),/output limit/);
  }finally{box.dispose();}
});
