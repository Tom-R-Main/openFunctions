/** Caller-owned immutable output artifacts; opaque IDs never select filesystem paths. */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { acquireJournalOwnership, initializePrivateRoot, JournalInvariantError, readPrivateFile, writePrivateFileAtomic } from "./journal-file.js";
import { snapshotJson } from "./session.js";
export const DEFAULT_ARTIFACT_QUOTA_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MODEL_OUTPUT_BYTES = 32 * 1024;
export interface ArtifactReference { id:string; sha256:string; mediaType:string; sizeBytes:number; }
export interface FileArtifactStoreOptions { rootDir:string; quotaBytes?:number; maxReadBytes?:number; }
export interface ArtifactReadOptions { offset?:number; length?:number; maxBytes?:number; }
interface ArtifactRecord { schemaVersion:1; reference:ArtifactReference; base64:string; }
export class ArtifactQuotaError extends Error {constructor(){super("Artifact quota exhausted");this.name="ArtifactQuotaError";}}
export class FileArtifactStore {
  readonly rootDir:string;
  readonly quotaBytes:number;
  readonly maxReadBytes:number;
  private readonly identity:{dev:number;ino:number};
  constructor(options:FileArtifactStoreOptions) {
    this.rootDir=initializePrivateRoot(options.rootDir);
    this.quotaBytes=options.quotaBytes ?? DEFAULT_ARTIFACT_QUOTA_BYTES;
    this.maxReadBytes=options.maxReadBytes ?? DEFAULT_MODEL_OUTPUT_BYTES;
    if(!Number.isSafeInteger(this.quotaBytes) || this.quotaBytes < 0 || !Number.isSafeInteger(this.maxReadBytes) || this.maxReadBytes < 0)throw new JournalInvariantError("Artifact limits must be nonnegative safe integers");
    this.identity=lstatSync(this.rootDir);
  }
  put(content:Uint8Array|string, options:{mediaType?:string} = {}):Readonly<ArtifactReference> {
    this.checkRoot();
    const bytes=typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
    if(bytes.length > this.quotaBytes)throw new ArtifactQuotaError();
    const mediaType=options.mediaType ?? "application/octet-stream";
    if(typeof mediaType !== "string" || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:;[\x20-\x7e]*)?$/.test(mediaType) || mediaType.length > 255)throw new JournalInvariantError("Invalid artifact media type");
    const lock=acquireJournalOwnership(this.rootDir,"artifact-quota");
    try {
      let total=0;
      for(const name of readdirSync(this.rootDir)) {
        if(!name.endsWith(".artifact"))continue;
        const id=name.slice(0,-9); this.assertId(id);
        total+=this.load(id).reference.sizeBytes;
      }
      if(total+bytes.length > this.quotaBytes)throw new ArtifactQuotaError();
      const reference:ArtifactReference={id:randomUUID(),sha256:createHash("sha256").update(bytes).digest("hex"),mediaType,sizeBytes:bytes.length};
      const record:ArtifactRecord={schemaVersion:1,reference,base64:bytes.toString("base64")};
      writePrivateFileAtomic(this.path(reference.id),Buffer.from(JSON.stringify(record)));
      return snapshotJson(reference);
    } finally {lock.release();}
  }
  metadata(id:string):Readonly<ArtifactReference> {return snapshotJson(this.load(id).reference);}
  read(id:string, options:ArtifactReadOptions = {}):Buffer {
    const limit=options.maxBytes ?? this.maxReadBytes;
    const offset=options.offset ?? 0;
    if(!Number.isSafeInteger(limit) || limit < 0 || limit > this.maxReadBytes || !Number.isSafeInteger(offset) || offset < 0)throw new JournalInvariantError("Invalid artifact read bounds");
    const record=this.load(id);
    const length=options.length ?? record.reference.sizeBytes-offset;
    if(!Number.isSafeInteger(length) || length < 0 || length > limit || offset+length > record.reference.sizeBytes)throw new JournalInvariantError("Artifact read exceeds bounds");
    // Return a fresh copy; changing the consumer buffer cannot change the saved output.
    return Buffer.from(Buffer.from(record.base64,"base64").subarray(offset,offset+length));
  }
  private assertId(id:string):void {if(typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))throw new JournalInvariantError("Invalid opaque artifact id");}
  private checkRoot():void {initializePrivateRoot(this.rootDir);const current=lstatSync(this.rootDir);if(current.dev !== this.identity.dev || current.ino !== this.identity.ino)throw new JournalInvariantError("Artifact root identity changed");}
  private path(id:string):string {this.checkRoot();this.assertId(id);return join(this.rootDir,`${id}.artifact`);}
  private load(id:string):ArtifactRecord {
    let record:ArtifactRecord;
    try {record=JSON.parse(readPrivateFile(this.path(id),Math.ceil(this.quotaBytes/3)*4+4096).toString("utf8")) as ArtifactRecord;} catch(error) {if(error instanceof SyntaxError)throw new JournalInvariantError("Corrupt artifact record");throw error;}
    const ref=record?.reference;
    if (!record || typeof record !== "object" || Object.keys(record).sort().join(",") !== "base64,reference,schemaVersion" || !ref || Object.keys(ref).sort().join(",") !== "id,mediaType,sha256,sizeBytes") throw new JournalInvariantError("Unexpected artifact metadata fields");
    if(record?.schemaVersion !== 1 || !ref || ref.id !== id || typeof ref.mediaType !== "string" || !Number.isSafeInteger(ref.sizeBytes) || ref.sizeBytes < 0 || ref.sizeBytes > this.quotaBytes || typeof record.base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.base64))throw new JournalInvariantError("Invalid artifact metadata");
    const bytes=Buffer.from(record.base64,"base64");
    if(bytes.length !== ref.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== ref.sha256)throw new JournalInvariantError("Artifact size or digest mismatch");
    return record;
  }
}

/** Optional saved-output reader. It never resolves arbitrary paths or reruns a tool. */
export function createArtifactReadTool(store:FileArtifactStore):import("./types.js").ToolDefinition {
  return {name:"of_artifact_read",description:"Read a bounded byte range from an approved immutable output artifact",inputSchema:{type:"object",properties:{artifactId:{type:"string"},offset:{type:"integer",minimum:0},length:{type:"integer",minimum:0,maximum:16384}},required:["artifactId"],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},executionMode:"parallel-safe",replayPolicy:"read_only",contract:{version:"1",useWhen:["Inspect approved saved output"],doNotUseWhen:["Request an arbitrary filesystem path"],sideEffects:[],mutation:false,commitmentClass:"C0",idempotency:"idempotent",reversibility:"read_only"},handler:async params=>{
    const artifact=store.metadata(params.artifactId as string);const offset=(params.offset as number|undefined) ?? 0;const length=(params.length as number|undefined) ?? Math.min(16384,store.maxReadBytes,Math.max(0,artifact.sizeBytes-offset));
    const bytes=store.read(artifact.id,{offset,length});return {success:true,data:{artifact,offset,length,encoding:"base64",data:bytes.toString("base64"),hasMore:offset+length<artifact.sizeBytes}};
  }};
}
