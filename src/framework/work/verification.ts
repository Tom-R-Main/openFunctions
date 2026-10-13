/** Domain-bound verification, shell-free commands and explicit subject fingerprints. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { digestJson, snapshotJson } from "../session.js";
import { JournalInvariantError } from "../journal-file.js";
import type { VerificationBinding, VerificationSubject } from "./types.js";

/** Reject every symlink component, including a symlink supplied as the root. */
export function scopedPath(workspaceRoot:string,path:string,allowMissingFinal=false):string {
  const root=resolve(workspaceRoot);const target=isAbsolute(path) ? resolve(path) : resolve(root,path);
  const rel=relative(root,target);if(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))throw new JournalInvariantError("Path escapes authorized workspace");
  let current=root;const rootParts=root.split(sep).filter(Boolean);current=sep;
  for(const part of rootParts){current=join(current,part);const stats=lstatSync(current);if(stats.isSymbolicLink() || !stats.isDirectory())throw new JournalInvariantError("Workspace root has unsafe path component");}
  const parts=rel.split(sep).filter(Boolean);
  for(let index=0;index<parts.length;index++) {
    current=join(current,parts[index]!);
    let stats:ReturnType<typeof lstatSync>;
    try{stats=lstatSync(current);}catch(error){if(allowMissingFinal && index === parts.length-1 && (error as NodeJS.ErrnoException).code === "ENOENT")return target;throw error;}
    if(stats.isSymbolicLink() || index<parts.length-1 && !stats.isDirectory())throw new JournalInvariantError("Authorized path contains a symlink or non-directory");
  }
  return target;
}
export function fingerprintSubject(workspaceRoot:string,workspaceId:string,inputs:readonly string[],mutationEpoch:number):VerificationSubject {
  if(!inputs.length)throw new JournalInvariantError("Verification input manifest cannot be empty");
  const files:{path:string;sha256:string;mode:number;size:number}[]=[];
  const visit=(input:string):void=>{
    const path=scopedPath(workspaceRoot,input);const stats=lstatSync(path);
    if(stats.isDirectory()){for(const name of readdirSync(path).sort())visit(join(path,name));return;}
    if(!stats.isFile())throw new JournalInvariantError("Verification inputs must be ordinary files");
    const bytes=readFileSync(path);const after=lstatSync(path);
    if(stats.ino !== after.ino || stats.size !== after.size || stats.mtimeMs !== after.mtimeMs || stats.ctimeMs !== after.ctimeMs)throw new JournalInvariantError("Verification input changed during fingerprinting");
    files.push({path:relative(resolve(workspaceRoot),path),sha256:createHash("sha256").update(bytes).digest("hex"),mode:stats.mode,size:bytes.length});
  };
  for(const input of [...inputs].sort())visit(input);
  return {workspaceId,inputManifest:files.map(file=>file.path),digest:digestJson(files),mutationEpoch};
}
export interface CommandBinding {
 stepId:string;specDigest:string;environment:string;inputs:readonly string[];
 executable:string;argv:readonly string[];cwd?:string;timeoutMs:number;
 environmentVariables?:Readonly<Record<string,string>>;
 outputLimitBytes?:number;acceptanceMethods:readonly string[];
 readback:(workspaceRoot:string)=>Promise<boolean>;
}
export function createCommandVerificationBinding(original:CommandBinding):VerificationBinding {
  const {readback,...configuration}=original;const binding={...snapshotJson(configuration),readback};
  if(!binding.executable || !binding.specDigest || !Number.isFinite(binding.timeoutMs) || binding.timeoutMs <= 0)throw new JournalInvariantError("Invalid trusted command binding");
  return {stepId:binding.stepId,specDigest:binding.specDigest,environment:binding.environment,inputs:[...binding.inputs],readback:binding.readback,run:async ({workspaceRoot,signal})=>{
    const cwd=scopedPath(workspaceRoot,binding.cwd ?? ".");
    // The bound executable/argv are trusted integration configuration, never model parameters.
    const environment={...(process.env.PATH ? {PATH:process.env.PATH}:{}),...(process.env.SystemRoot ? {SystemRoot:process.env.SystemRoot}:{}),LANG:"C.UTF-8",...binding.environmentVariables};
    const environmentSnapshot={platform:process.platform,arch:process.arch,hostNodeVersion:process.version,executable:binding.executable,cwd,environmentDigest:digestJson(environment)};
    const result=await new Promise<{exitCode:number|null;output:string}>((resolveResult)=>{
      const child=spawn(binding.executable,[...binding.argv],{cwd,shell:false,env:environment,stdio:["ignore","pipe","pipe"]});
      const chunks:Buffer[]=[];let total=0;let exceeded=false;let timedOut=false;
      const collect=(value:Buffer)=>{total+=value.length;if(total > (binding.outputLimitBytes ?? 16*1024*1024)){exceeded=true;child.kill("SIGKILL");return;}chunks.push(Buffer.from(value));};
      child.stdout.on("data",collect);child.stderr.on("data",collect);
      const timer=setTimeout(()=>{timedOut=true;child.kill("SIGKILL");},binding.timeoutMs);
      const cancel=()=>child.kill("SIGKILL");signal.addEventListener("abort",cancel,{once:true});if(signal.aborted)cancel();
      child.once("error",error=>{clearTimeout(timer);signal.removeEventListener("abort",cancel);resolveResult({exitCode:null,output:error.message});});
      child.once("close",code=>{clearTimeout(timer);signal.removeEventListener("abort",cancel);resolveResult({exitCode:exceeded || timedOut || signal.aborted ? null : code,output:Buffer.concat(chunks).toString("utf8")+(exceeded ? "\nOutput quota exceeded" : timedOut ? "\nVerification timed out" : signal.aborted ? "\nVerification interrupted" : "")});});
    });
    const readbackPassed=await binding.readback(workspaceRoot);
    return {...result,environmentSnapshot,readbackPassed,acceptanceMethods:readbackPassed ? [...binding.acceptanceMethods] : []};
  }};
}
export function pathMatches(path:string,patterns:readonly string[]):boolean {
 return patterns.some(pattern=>new RegExp(`^${pattern.split("**").map(part=>part.split("*").map(piece=>piece.replace(/[|\\{}()[\]^$+?.]/g,"\\$&")).join("[^/]*")).join(".*")}$`).test(path.replaceAll(sep,"/")));
}
