/** Private, synchronous JSONL durability shared by execution and work journals.
 * Newline is the commit marker: only a final uncommitted fragment is discarded.
 * fsync protects acknowledged file contents and directory entries on supported
 * POSIX filesystems. Kill tests establish process-crash recovery, not guarantees
 * about storage hardware or filesystem behavior after power loss. Windows does
 * not expose directory fsync through this implementation.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join, resolve, parse } from "node:path";
import { TextDecoder } from "node:util";
import { snapshotJson } from "./session.js";

export class JournalInvariantError extends Error { constructor(message: string) { super(message); this.name = "JournalInvariantError"; } }
export class JournalConcurrencyError extends Error { constructor(id: string) { super(`Journal ${id} is owned or was concurrently modified`); this.name = "JournalConcurrencyError"; } }
export interface JournalEnvelope { schemaVersion: number; streamId: string; scopeDigest: string; seq: number; }
export interface SecureJournalOptions<T extends JournalEnvelope> {
  rootDir: string; streamId: string; scopeDigest: string; schemaVersion: number; requireExisting?:boolean; expectedFileIdentity?:{dev:string;ino:string};
  validate?: (event: Readonly<T>, previous: readonly Readonly<T>[]) => void;
}
const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;

export class SecureJsonlJournal<T extends JournalEnvelope> {
  readonly rootDir: string;
  private readonly options: SecureJournalOptions<T>;
  private readonly rootIdentity: {dev: number; ino: number};
  private requiredFile:boolean;
  constructor(options: SecureJournalOptions<T>) {
    if (!options.streamId || !options.scopeDigest || !Number.isSafeInteger(options.schemaVersion) || options.schemaVersion < 1) throw new JournalInvariantError("Invalid journal identity/version");
    this.options = {...options};this.requiredFile=options.requireExisting ?? false;
    // resolve removes a trailing slash before lstat; otherwise POSIX can follow a final link.
    this.rootDir = initializePrivateRoot(options.rootDir);
    this.rootIdentity = lstatSync(this.rootDir);
  }
  private checkRoot(): void {
    assertNoSymlinkComponents(this.rootDir);
    const current = lstatSync(this.rootDir);
    assertPrivateDirectory(current, this.rootDir);
    if (current.dev !== this.rootIdentity.dev || current.ino !== this.rootIdentity.ino) throw new JournalInvariantError("Journal root identity changed");
  }
  private path(suffix: string): string {
    this.checkRoot();
    const digest = createHash("sha256").update(this.options.streamId).digest("hex");
    return join(this.rootDir, `${digest}.${suffix}`);
  }
  /** Persist an empty stream before another journal can refer to execution intent. */
  initialize():void {
    const lock=acquireExclusiveLock(this.path("lock"),this.options.streamId);
    try{const path=this.path("jsonl");if(!lstatIfExists(path)){
      if(this.requiredFile)throw new JournalInvariantError("Required journal disappeared");
      writePrivateFileAtomic(path,Buffer.alloc(0));
    }
    this.readLog();this.requiredFile=true;
    if(!this.options.expectedFileIdentity){const stats=lstatSync(path,{bigint:true});this.options.expectedFileIdentity={dev:String(stats.dev),ino:String(stats.ino)};}
    }finally{lock.release();}
  }
  fileIdentity():{dev:string;ino:string} {
    this.readLog();const stats=lstatSync(this.path("jsonl"),{bigint:true});return {dev:String(stats.dev),ino:String(stats.ino)};
  }
  acquireOwnership(): JournalFileLock { return acquireExclusiveLock(this.path("owner"), this.options.streamId); }
  read(): readonly Readonly<T>[] { return this.readLog().events; }
  append(candidate: T, expectedSeq: number): Readonly<T> {
    const event = snapshotJson(candidate, "journal event");
    const lock = acquireExclusiveLock(this.path("lock"), this.options.streamId);
    try {
      const log = this.readLog();
      if (expectedSeq !== log.events.length) throw new JournalConcurrencyError(this.options.streamId);
      this.validate(event, log.events);
      const path = this.path("jsonl");
      const existing = lstatIfExists(path);
      const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | noFollow | (existing ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
      try {
        if (!existing) fchmodSync(fd, 0o600);
        assertPrivateFile(fstatSync(fd), path);
        if (existing && (fstatSync(fd).ino !== existing.ino || fstatSync(fd).dev !== existing.dev)) throw new JournalConcurrencyError(this.options.streamId);
        if (log.torn) ftruncateSync(fd, log.committed);
        writeAll(fd, Buffer.from(`${JSON.stringify(event)}\n`));
        fsyncSync(fd);
      } finally { closeSync(fd); }
      if (!existing) fsyncDirectory(this.rootDir);
      return event;
    } finally { lock.release(); }
  }
  private validate(event: Readonly<T>, previous: readonly Readonly<T>[]): void {
    if (event === null || typeof event !== "object" || event.schemaVersion !== this.options.schemaVersion || event.streamId !== this.options.streamId || event.scopeDigest !== this.options.scopeDigest || event.seq !== previous.length + 1) throw new JournalInvariantError("Journal version, identity, scope or sequence mismatch");
    this.options.validate?.(event, previous);
  }
  private readLog(): {events: readonly Readonly<T>[]; committed: number; torn: boolean} {
    const path = this.path("jsonl");
    let bytes: Buffer;
    try {
      if(this.options.expectedFileIdentity){const stat=lstatSync(path,{bigint:true});if(String(stat.dev) !== this.options.expectedFileIdentity.dev || String(stat.ino) !== this.options.expectedFileIdentity.ino)throw new JournalInvariantError("Required journal file identity changed");}
      bytes = readPrivateFile(path);
    } catch(error) { if (isNodeError(error) && error.code === "ENOENT") {if(!this.requiredFile)bytes = Buffer.alloc(0);else throw new JournalInvariantError("Required journal disappeared");} else throw error; }
    const committed = bytes.lastIndexOf(10) + 1;
    let decoded: string;
    try { decoded = new TextDecoder("utf-8", {fatal:true}).decode(bytes.subarray(0, committed)); } catch { throw new JournalInvariantError("Committed journal bytes are not UTF-8"); }
    const events: Readonly<T>[] = [];
    for (const line of committed ? decoded.slice(0,-1).split("\n") : []) {
      let event: Readonly<T>;
      try { event = snapshotJson(JSON.parse(line) as T); } catch { throw new JournalInvariantError(`Corrupt committed journal line ${events.length + 1}`); }
      this.validate(event, events); events.push(event);
    }
    return {events: Object.freeze(events), committed, torn: committed < bytes.length};
  }
}

/** Existing caller-owned permissions are never silently widened or repaired. */
export function initializePrivateRoot(value: string): string {
  if (typeof value !== "string" || !value.trim()) throw new JournalInvariantError("Private root must be nonempty");
  const root = resolve(value);
  assertNoSymlinkComponents(root);
  const existing = lstatIfExists(root);
  if (existing) { assertPrivateDirectory(existing, root); return root; }
  const firstCreated = mkdirSync(root, {recursive:true, mode:0o700});
  assertNoSymlinkComponents(root);
  assertPrivateDirectory(lstatSync(root), root);
  fsyncDirectory(root);
  if (firstCreated) {
    let current = root;
    for (;;) { const parent = dirname(current); fsyncDirectory(parent); if(current === resolve(firstCreated)) break; if(parent === current) throw new JournalInvariantError("Invalid directory creation chain"); current = parent; }
  }
  return root;
}
function assertNoSymlinkComponents(path: string): void {
  const absolute = resolve(path); let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, component); const stats = lstatIfExists(current);
    if (!stats) break;
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new JournalInvariantError(`Private path has non-directory or symlink component: ${current}`);
  }
}
function assertPrivateDirectory(stats: Stats, path: string): void {
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o7777) !== 0o700 || (typeof process.getuid === "function" && stats.uid !== process.getuid())) throw new JournalInvariantError(`Private root must be owned real mode 0700 directory: ${path}`);
}
function assertPrivateFile(stats: Stats, path: string): void {
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o7777) !== 0o600 || (typeof process.getuid === "function" && stats.uid !== process.getuid())) throw new JournalInvariantError(`Private file must be owned regular mode 0600 file: ${path}`);
}
export function readPrivateFile(path: string, maximumBytes = Number.MAX_SAFE_INTEGER): Buffer {
  const before = lstatSync(path); assertPrivateFile(before, path);
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd); assertPrivateFile(opened, path);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new JournalInvariantError("Private file identity changed");
    if (opened.size > maximumBytes) throw new JournalInvariantError("Private file exceeds read limit");
    const result = Buffer.alloc(opened.size);
    let offset = 0;
    while(offset < result.length) {
      const count = readSync(fd, result, offset, result.length-offset, offset);
      if(count === 0) throw new JournalConcurrencyError(path);
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new JournalConcurrencyError(path);
    if (result.length > maximumBytes) throw new JournalInvariantError("Private file exceeds read limit");
    return result;
  } finally { closeSync(fd); }
}
/** Atomic create never replaces an existing immutable file. */
export function writePrivateFileAtomic(path: string, bytes: Buffer, replace = false): void {
  const parent = initializePrivateRoot(dirname(path));
  const temporary = join(parent, `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
  try { fchmodSync(fd,0o600); writeAll(fd, bytes); fsyncSync(fd); } finally {closeSync(fd);}
  try {
    if(replace) { const old = lstatIfExists(path); if(old) assertPrivateFile(old,path); renameSync(temporary,path); }
    else { linkSync(temporary,path); unlinkSync(temporary); }
    fsyncDirectory(parent);
  } finally { if(unlinkIfExists(temporary)) fsyncDirectory(parent); }
}
export function acquireJournalOwnership(rootDir: string, identity: string): JournalFileLock {
  const root = initializePrivateRoot(rootDir);
  return acquireExclusiveLock(join(root, `${createHash("sha256").update(identity).digest("hex")}.owner`),identity);
}
function lstatIfExists(path: string): Stats | undefined { try {return lstatSync(path);} catch(error) {if(isNodeError(error) && error.code === "ENOENT") return undefined; throw error;} }
function writeAll(fd:number,bytes:Buffer):void {let offset=0; while(offset<bytes.length){const count=writeSync(fd,bytes,offset,bytes.length-offset);if(count<=0)throw new JournalInvariantError("Private write made no progress");offset+=count;} }
function fsyncDirectory(path:string):void {if(process.platform === "win32")return; const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);} }
function isNodeError(error:unknown):error is NodeJS.ErrnoException {return error instanceof Error && "code" in error;}

export interface JournalFileLock {
  release(): void;
}

interface JournalLockOwner {
  pid: number;
  token: string;
}

/**
 * Acquire a crash-recoverable cross-process lock.
 *
 * A fully written and fsynced claim is hard-linked into the well-known lock
 * path, so contenders never observe a partially initialized owner record.
 * Dead owners can be reclaimed; malformed or live claims fail closed.
 */
function acquireExclusiveLock(path: string, sessionId: string): JournalFileLock {
  const token = randomUUID();
  const claimPath = `${path}.${process.pid}.${token}.claim`;
  const lockDirectory = dirname(path);
  const owner: JournalLockOwner = { pid: process.pid, token };
  let claimFd: number | undefined;

  try {
    claimFd = openSync(claimPath, "wx", 0o600);
    fchmodSync(claimFd, 0o600);
    writeAll(claimFd, Buffer.from(`${JSON.stringify(owner)}\n`, "utf8"));
    fsyncSync(claimFd);
  } catch (error) {
    if (claimFd !== undefined) {
      try {
        closeSync(claimFd);
      } finally {
        if (unlinkIfExists(claimPath)) fsyncDirectory(lockDirectory);
      }
    }
    throw error;
  }
  try {
    closeSync(claimFd);
    claimFd = undefined;
  } catch (error) {
    if (unlinkIfExists(claimPath)) fsyncDirectory(lockDirectory);
    throw error;
  }

  let lockLinked = false;
  try {
    for (;;) {
      try {
        linkSync(claimPath, path);
        lockLinked = true;
        break;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        const existing = readLockOwner(path);
        if (existing === undefined || isProcessAlive(existing.pid)) {
          throw new JournalConcurrencyError(sessionId);
        }

        // Serialize stale-owner recovery. Without a separate gate, two
        // contenders can both observe the dead owner and one can unlink the
        // other's newly acquired lock after the lock path is reused.
        const reclaimGate = tryAcquireJournalReclaimGate(
          path,
          claimPath,
          sessionId,
          existing,
        );
        if (reclaimGate === undefined) {
          throw new JournalConcurrencyError(sessionId);
        }

        try {
          const current = readLockOwner(path);
          if (
            current === undefined
            || current.pid !== existing.pid
            || current.token !== existing.token
            || isProcessAlive(current.pid)
          ) {
            continue;
          }

          const staleClaimPath = `${path}.${current.pid}.${current.token}.claim`;
          if (!sameFile(path, staleClaimPath)) {
            if (lstatIfExists(path) === undefined) continue;
            throw new JournalInvariantError(
              `session ${sessionId} has an inconsistent stale append lock`,
            );
          }

          unlinkSync(path);
          unlinkIfExists(staleClaimPath);
          fsyncDirectory(lockDirectory);
        } finally {
          reclaimGate.release();
        }
      }
    }
    fsyncDirectory(lockDirectory);

    let released = false;
    return {
      release(): void {
        if (released) return;
        released = true;
        let directoryChanged = false;
        try {
          if (sameFile(path, claimPath)) {
            unlinkSync(path);
            directoryChanged = true;
          }
        } finally {
          directoryChanged = unlinkIfExists(claimPath) || directoryChanged;
          if (directoryChanged) fsyncDirectory(lockDirectory);
        }
      },
    };
  } catch (error) {
    let directoryChanged = false;
    if (lockLinked && sameFile(path, claimPath)) {
      unlinkSync(path);
      directoryChanged = true;
    }
    directoryChanged = unlinkIfExists(claimPath) || directoryChanged;
    if (directoryChanged) fsyncDirectory(lockDirectory);
    throw error;
  }
}

function tryAcquireJournalReclaimGate(
  lockPath: string,
  claimPath: string,
  sessionId: string,
  staleOwner: JournalLockOwner,
): JournalFileLock | undefined {
  const lockDirectory = dirname(lockPath);
  const reclaimRoot = `${lockPath}.reclaim.${staleOwner.token}`;
  const observedGateTokens = new Set<string>();
  let reclaimPath = reclaimRoot;

  for (;;) {
    try {
      linkSync(claimPath, reclaimPath);
      fsyncDirectory(lockDirectory);
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        try {
          if (sameFile(reclaimPath, claimPath)) unlinkIfExists(reclaimPath);
        } catch {
          // Preserve the acquisition failure below.
        }
        throw error;
      }

      const owner = readLockOwner(reclaimPath);
      if (owner === undefined || isProcessAlive(owner.pid)) return undefined;
      if (observedGateTokens.has(owner.token)) {
        throw new JournalInvariantError(
          `session ${sessionId} has an inconsistent stale-lock recovery chain`,
        );
      }
      observedGateTokens.add(owner.token);

      // Never unlink a crashed reclaimer's gate. Its unique token names the
      // next generation, so exactly one contender can advance the chain and
      // old generations can never be confused with a replacement main lock.
      reclaimPath = `${reclaimRoot}.${owner.token}`;
    }
  }

  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      if (sameFile(reclaimPath, claimPath)) unlinkIfExists(reclaimPath);
      fsyncDirectory(lockDirectory);
    },
  };
}

function readLockOwner(path: string): JournalLockOwner | undefined {
  try {
    const parsed = JSON.parse(readPrivateFile(path,512).toString("utf8")) as Partial<JournalLockOwner>;
    if (!Number.isSafeInteger(parsed.pid) || (parsed.pid ?? 0) <= 0) return undefined;
    if (typeof parsed.token !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(parsed.token)) return undefined;
    return { pid: parsed.pid!, token: parsed.token };
  } catch { return undefined; }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return false;
    if (isNodeError(error) && error.code === "EPERM") return true;
    throw error;
  }
}

function sameFile(left: string, right: string): boolean {
  try {
    const leftStat = lstatSync(left);
    const rightStat = lstatSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function unlinkIfExists(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}
