/** Drive the real compiled CLI and then use its persisted resolver. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createLocalFixtureBindings } from "../src/framework/work/local-fixture.js";
import type { WorkProfileConfig } from "../src/runtime/work-profile.js";
import { pathToFileURL } from "node:url";
const createWorkProfile: typeof import("../src/runtime/work-profile.js")["createWorkProfile"] = (await import(pathToFileURL(resolve("dist/src/runtime/work-profile.js")).href)).createWorkProfile;
const cli=resolve("dist/src/cli.js");
function fixture(){
  const root=mkdtempSync(join(tmpdir(),"of-work-cli-"));const workspace=join(root,"workspace");mkdirSync(workspace,{mode:0o700});
  writeFileSync(join(workspace,"fixture.json"),JSON.stringify({status:"needs_correction",value:0,retained:"yes"}),{mode:0o600});
  writeFileSync(join(workspace,"verify.mjs"),`import {readFileSync} from 'node:fs'; const fixture=JSON.parse(readFileSync(process.argv[2], 'utf8')); const pass=fixture.status === 'corrected' && fixture.value === 1; console.log(pass ? 'fixture verified' : 'fixture failed'); process.exitCode=pass ? 0 : 1;`,{mode:0o600});
  const catalog=createLocalFixtureBindings({workspaceRoot:workspace,fixturePath:"fixture.json",verifierPath:"verify.mjs"});
  const config:WorkProfileConfig={schemaVersion:1,workspaceRoot:workspace,dataDir:join(root,"state"),grantDir:join(root,"authority"),backend:{kind:"local",backendId:"fixture-backend",workspaceId:"fixture-workspace",workItems:[{workItemId:"correction",contract:catalog.contract,plan:{id:"fixture-plan",version:1,state:"active",steps:[catalog.verificationStep]}}]},stepCatalog:{kind:"fixture",fixturePath:"fixture.json",verifierPath:"verify.mjs"},limits:{maxAttempts:1,maxDurationMs:60000,maxActions:10,maxOutputBytes:65536},grantTtlMs:60000};
  const configPath=join(root,"config.json");writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
  const preview=join(root,"preview.json");
  function run(args:string[],input?:string){const result=spawnSync(process.execPath,[cli,...args],{input,encoding:"utf8",timeout:15000});assert.equal(result.error,undefined);return result;}
  return {root,workspace,config,configPath,preview,run,dispose:()=>rmSync(root,{recursive:true,force:true})};
}
function authorization(output:string){const result=output.match(/\{\n  "authorized": [\s\S]*\}\s*$/);assert.ok(result,output);return JSON.parse(result[0]) as {authorized:boolean;executionGrantId?:string;completionGrantId?:string;automaticCompletion?:boolean};}

test("CLI trusted reviewer grants execution, defaults completion off, and can revoke after target loss",async()=>{
  const box=fixture();try{
    const denied=await createWorkProfile(box.configPath);await assert.rejects(denied.controller.start("correction"),/grant|authority/i);
    const prepared=box.run(["work","prepare","--config",box.configPath,"--work-item","correction","--out",box.preview]);assert.equal(prepared.status,0,prepared.stderr);
    const refused=box.run(["work","authorize","--config",box.configPath,"--preview",box.preview],"NO\n");assert.equal(refused.status,0,refused.stderr);assert.equal(authorization(refused.stdout).authorized,false);
    const result=box.run(["work","authorize","--config",box.configPath,"--preview",box.preview],"AUTHORIZE\n\n");assert.equal(result.status,0,result.stderr);const decision=authorization(result.stdout);assert.equal(decision.automaticCompletion,false);
    const runtime=denied;const preview=await runtime.controller.prepare("correction");assert.ok(await runtime.grants.resolve(preview.binding,"execution"));assert.equal(await runtime.grants.resolve(preview.binding,"completion"),undefined);
    await runtime.controller.start("correction");
    await runtime.controller.shutdown();
    const list=box.run(["work","grants","list","--config",box.configPath]);assert.equal(JSON.parse(list.stdout).length,1);
    rmSync(join(box.workspace,"fixture.json"));
    const revoke=box.run(["work","grants","revoke","--config",box.configPath,"--grant",decision.executionGrantId!]);assert.equal(revoke.status,0,revoke.stderr);
    assert.equal(await runtime.grants.resolve(preview.binding,"execution"),undefined);
  }finally{box.dispose();}
});

test("CLI separate completion decision permits a scoped correction with fresh evidence",async()=>{
  const box=fixture();try{
    assert.equal(box.run(["work","prepare","--config",box.configPath,"--work-item","correction","--out",box.preview]).status,0);
    const granted=box.run(["work","authorize","--config",box.configPath,"--preview",box.preview],"AUTHORIZE\nCOMPLETE\n");assert.equal(granted.status,0,granted.stderr);const decision=authorization(granted.stdout);assert.equal(decision.automaticCompletion,true);assert.notEqual(decision.executionGrantId,decision.completionGrantId);
    const runtime=await createWorkProfile(box.configPath);
    try{
      await runtime.controller.start("correction");
      const inspected=await runtime.controller.step("inspect",{});
      const expectedDigest=(inspected.result.data as {expectedDigest:string}).expectedDigest;
      await runtime.controller.step("correct",{expectedDigest});
      await runtime.controller.verify("fixture-check");
      const finished=await runtime.controller.finish();assert.equal(finished.state,"completed");
      assert.deepEqual(JSON.parse(readFileSync(join(box.workspace,"fixture.json"),"utf8")),{status:"corrected",value:1,retained:"yes"});
    }finally{await runtime.controller.shutdown();}
  }finally{box.dispose();}
});

test("CLI refuses stale previews and emits Hermes configuration with explicit work allowlist",()=>{
  const box=fixture();try{
    assert.equal(box.run(["work","prepare","--config",box.configPath,"--work-item","correction","--out",box.preview]).status,0);
    writeFileSync(box.configPath,JSON.stringify({...box.config,grantTtlMs:120000}));chmodSync(box.configPath,0o600);
    const stale=box.run(["work","authorize","--config",box.configPath,"--preview",box.preview],"AUTHORIZE\nCOMPLETE\n");assert.equal(stale.status,1);assert.match(stale.stderr,/Configuration changed/);
    const config=box.run(["hermes-config","--config",box.configPath]);assert.equal(config.status,0,config.stderr);
    const server=JSON.parse(config.stdout).mcp_servers.openfunctions;assert.equal(server.protocol,"legacy");assert.equal(server.trust,"untrusted");assert.ok(server.tools.include.includes("of_work_step"));assert.equal(server.tools.include.includes("fixture_correct"),false);assert.equal(server.tools.resources,false);
  }finally{box.dispose();}
});
