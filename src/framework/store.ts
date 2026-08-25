/**
 * OpenFunction — Persistent Store
 *
 * A small JSON file store that works like a Map but persists to disk.
 * No database, no setup, no dependencies. Data survives server restarts.
 *
 * Usage:
 *   const tasks = createStore<Task>("tasks");
 *   tasks.set("1", { title: "Read chapter 5", ... });
 *   tasks.get("1");    // → { title: "Read chapter 5", ... }
 *   tasks.getAll();    // → [{ title: "Read chapter 5", ... }]
 *   tasks.delete("1");
 *
 * Data is saved to .data/<name>.json in the project root.
 * You can open these files to see exactly what's stored.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve project root (two levels up from src/framework/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, "..", "..", ".data");
const LOCK_WAIT_TIMEOUT_MS = 30_000;
const LOCK_POLL_INTERVAL_MS = 10;
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export interface Store<T> {
  /** Get an item by ID */
  get(id: string): T | undefined;

  /** Set an item by ID (creates or updates) */
  set(id: string, value: T): void;

  /** Delete an item by ID. Returns true if it existed. */
  delete(id: string): boolean;

  /** Get all items as an array */
  getAll(): T[];

  /** Get all items as [id, value] pairs */
  entries(): [string, T][];

  /** Number of items in the store */
  get size(): number;

  /** Check if an item exists */
  has(id: string): boolean;

  /** Remove all items */
  clear(): void;

  /**
   * Atomically inspect and update one item when the backing store supports it.
   *
   * The callback runs while createStore() holds its cross-process file lock,
   * so read-check-write operations cannot overwrite a concurrent writer. This
   * remains optional so existing custom Store implementations keep working;
   * callers can retain their legacy synchronous fallback when it is absent.
   */
  mutate?<R>(
    id: string,
    mutation: (current: T | undefined) => StoreMutation<T, R>,
  ): R;
}

export type StoreMutation<T, R> =
  | { action: "set"; value: T; result: R }
  | { action: "delete"; result: R }
  | { action: "unchanged"; result: R };

interface StoreLock {
  release(): void;
}

interface StoreLockOwner {
  pid: number;
  token: string;
}

class StorePersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorePersistenceError";
  }
}

/**
 * Create a persistent store that saves to .data/<name>.json
 *
 * Works just like a Map, but data survives server restarts. Every operation
 * reads the latest committed snapshot so independent instances and processes
 * observe one another's writes.
 *
 * @param name - Store name (used as the filename, e.g. "tasks" → .data/tasks.json)
 */
export function createStore<T>(name: string): Store<T> {
  validateStoreName(name);
  ensurePrivateDataDirectory();

  const filePath = join(DATA_DIR, `${name}.json`);
  const lockPath = `${filePath}.lock`;

  reclaimStaleTempFiles(filePath);

  // Surface unsafe or corrupt existing state immediately. Missing is the only
  // condition that means "start empty".
  const cache = loadData<T>(filePath);
  let baseline = snapshotComparableValues(cache);

  function read(): Map<string, T> {
    const latest = loadData<T>(filePath);
    reconcileStoreCache(cache, baseline, latest);
    baseline = snapshotComparableValues(latest);
    return cache;
  }

  function update<R>(mutate: (data: Map<string, T>) => { result: R; changed: boolean }): R {
    const lock = acquireExclusiveLock(lockPath, name);
    let operationFailed = false;

    try {
      reclaimStaleTempFiles(filePath);
      const data = loadData<T>(filePath);
      const mergedLocalMutation = mergeLocallyMutatedValues(cache, baseline, data);
      const { result, changed } = mutate(data);
      if (changed || mergedLocalMutation) persistData(filePath, data);
      synchronizeStoreCache(cache, data);
      baseline = snapshotComparableValues(data);
      return result;
    } catch (error) {
      operationFailed = true;
      throw error;
    } finally {
      try {
        lock.release();
      } catch (releaseError) {
        if (!operationFailed) throw releaseError;
      }
    }
  }

  return {
    get(id: string): T | undefined {
      return read().get(id);
    },

    set(id: string, value: T): void {
      update((data) => {
        data.set(id, value);
        return { result: undefined, changed: true };
      });
    },

    delete(id: string): boolean {
      return update((data) => {
        const existed = data.delete(id);
        return { result: existed, changed: existed };
      });
    },

    getAll(): T[] {
      return Array.from(read().values());
    },

    entries(): [string, T][] {
      return Array.from(read().entries());
    },

    get size(): number {
      return read().size;
    },

    has(id: string): boolean {
      return read().has(id);
    },

    clear(): void {
      update((data) => {
        data.clear();
        return { result: undefined, changed: true };
      });
    },

    mutate<R>(
      id: string,
      mutation: (current: T | undefined) => StoreMutation<T, R>,
    ): R {
      return update((data) => {
        const outcome = mutation(data.get(id));
        switch (outcome.action) {
          case "set":
            data.set(id, outcome.value);
            return { result: outcome.result, changed: true };
          case "delete": {
            const changed = data.delete(id);
            return { result: outcome.result, changed };
          }
          case "unchanged":
            return { result: outcome.result, changed: false };
        }
      });
    },
  };
}

function snapshotComparableValues<T>(data: Map<string, T>): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const [id, value] of data) {
    const serialized = comparableValue(value);
    if (serialized === undefined) {
      throw new StorePersistenceError(`store value "${id}" is not JSON-serializable`);
    }
    snapshot.set(id, serialized);
  }
  return snapshot;
}

function comparableValue(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function isLocallyMutated<T>(
  id: string,
  cache: Map<string, T>,
  baseline: Map<string, string>,
): boolean {
  if (cache.has(id) !== baseline.has(id)) return true;
  if (!cache.has(id)) return false;
  const current = comparableValue(cache.get(id));
  return current === undefined || current !== baseline.get(id);
}

function reconcileStoreCache<T>(
  cache: Map<string, T>,
  baseline: Map<string, string>,
  latest: Map<string, T>,
): void {
  const ids = new Set([...cache.keys(), ...baseline.keys(), ...latest.keys()]);
  for (const id of ids) {
    // Preserve the original Map-like contract: an object obtained from get()
    // may be mutated by reference and is written by the next store mutation.
    if (isLocallyMutated(id, cache, baseline)) continue;
    if (!latest.has(id)) {
      cache.delete(id);
      continue;
    }
    const current = cache.get(id);
    const incoming = latest.get(id)!;
    if (!cache.has(id) || comparableValue(current) !== comparableValue(incoming)) {
      cache.set(id, incoming);
    }
  }
}

function mergeLocallyMutatedValues<T>(
  cache: Map<string, T>,
  baseline: Map<string, string>,
  latest: Map<string, T>,
): boolean {
  let changed = false;
  const ids = new Set([...cache.keys(), ...baseline.keys()]);
  for (const id of ids) {
    if (!isLocallyMutated(id, cache, baseline)) continue;
    changed = true;
    if (cache.has(id)) latest.set(id, cache.get(id)!);
    else latest.delete(id);
  }
  return changed;
}

function synchronizeStoreCache<T>(cache: Map<string, T>, committed: Map<string, T>): void {
  const ids = new Set([...cache.keys(), ...committed.keys()]);
  for (const id of ids) {
    if (!committed.has(id)) {
      cache.delete(id);
      continue;
    }
    const current = cache.get(id);
    const next = committed.get(id)!;
    if (!cache.has(id) || comparableValue(current) !== comparableValue(next)) {
      cache.set(id, next);
    }
  }
}

function validateStoreName(name: string): void {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new StorePersistenceError("store name must be a non-empty filename without path separators");
  }
}

function ensurePrivateDataDirectory(): void {
  let created = false;

  try {
    mkdirSync(DATA_DIR, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw new StorePersistenceError(`could not create store directory ${DATA_DIR}`, { cause: error });
    }
  }

  let info;
  try {
    info = lstatSync(DATA_DIR);
  } catch (error) {
    throw new StorePersistenceError(`could not inspect store directory ${DATA_DIR}`, { cause: error });
  }

  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new StorePersistenceError(`store directory ${DATA_DIR} must be a real directory, not a symlink`);
  }
  assertCurrentOwner(info.uid, `store directory ${DATA_DIR}`);

  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o700) {
    try {
      chmodSync(DATA_DIR, 0o700);
      fsyncDirectory(DATA_DIR);
    } catch (error) {
      throw new StorePersistenceError(`could not make store directory ${DATA_DIR} private`, { cause: error });
    }
  }

  if (created) {
    // Persist both the new directory's metadata and its parent entry.
    fsyncDirectory(DATA_DIR);
    fsyncDirectory(dirname(DATA_DIR));
  }
}

function loadData<T>(filePath: string): Map<string, T> {
  try {
    normalizeStoreFile(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return new Map();
    throw error;
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new StorePersistenceError(`could not read store file ${filePath}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StorePersistenceError(
      `store file ${filePath} contains invalid JSON; it was not replaced or treated as empty`,
      { cause: error },
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StorePersistenceError(`store file ${filePath} must contain a JSON object`);
  }

  return new Map(Object.entries(parsed as Record<string, T>));
}

function normalizeStoreFile(filePath: string): void {
  let info;
  try {
    info = lstatSync(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") throw error;
    throw new StorePersistenceError(`could not inspect store file ${filePath}`, { cause: error });
  }

  if (info.isSymbolicLink() || !info.isFile()) {
    throw new StorePersistenceError(`store path ${filePath} must be a regular file, not a symlink`);
  }
  assertCurrentOwner(info.uid, `store file ${filePath}`);
  if (info.nlink !== 1) {
    throw new StorePersistenceError(`store file ${filePath} must not have hard links`);
  }

  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
    try {
      chmodSync(filePath, 0o600);
      fsyncFile(filePath);
    } catch (error) {
      throw new StorePersistenceError(`could not make store file ${filePath} private`, { cause: error });
    }
  }
}

function persistData<T>(filePath: string, data: Map<string, T>): void {
  const serialized = serializeData(data, filePath);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let renamed = false;

  try {
    fd = openSync(tempPath, "wx", 0o600);
    fchmodSync(fd, 0o600);
    writeAll(fd, Buffer.from(serialized, "utf8"));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    renameSync(tempPath, filePath);
    renamed = true;
    fsyncDirectory(DATA_DIR);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the persistence failure below.
      }
    }
    if (!renamed) unlinkIfExists(tempPath);
    throw new StorePersistenceError(`could not atomically persist store file ${filePath}`, { cause: error });
  }
}

/**
 * Remove snapshots left behind by a writer that died before its atomic rename.
 * A matching file is deleted only when its encoded process is currently dead,
 * the path is still the same private regular file we inspected, and a second
 * liveness check still proves the owner dead immediately before unlinking.
 */
function reclaimStaleTempFiles(filePath: string): void {
  const fileName = basename(filePath);
  const pattern = new RegExp(
    `^${escapeRegExp(fileName)}\\.([1-9][0-9]*)\\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\\.tmp$`,
    "i",
  );
  let entries: string[];
  try {
    entries = readdirSync(DATA_DIR);
  } catch (error) {
    throw new StorePersistenceError(`could not inspect temporary snapshots for ${filePath}`, {
      cause: error,
    });
  }

  let removed = false;
  for (const entry of entries) {
    const match = pattern.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || isProcessAlive(pid)) continue;

    const tempPath = join(DATA_DIR, entry);
    let inspected;
    try {
      inspected = lstatSync(tempPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw new StorePersistenceError(`could not inspect temporary store snapshot ${tempPath}`, {
        cause: error,
      });
    }

    if (
      inspected.isSymbolicLink()
      || !inspected.isFile()
      || inspected.nlink !== 1
      || (typeof process.getuid === "function" && inspected.uid !== process.getuid())
      || (process.platform !== "win32" && (inspected.mode & 0o777) !== 0o600)
    ) {
      continue;
    }

    // A live process must never lose its in-progress snapshot. PID reuse is
    // conservative here: if the encoded PID has become live, leave the file.
    if (isProcessAlive(pid)) continue;

    let current;
    try {
      current = lstatSync(tempPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw new StorePersistenceError(`could not re-inspect temporary store snapshot ${tempPath}`, {
        cause: error,
      });
    }
    if (current.dev !== inspected.dev || current.ino !== inspected.ino) continue;

    try {
      unlinkSync(tempPath);
      removed = true;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw new StorePersistenceError(`could not reclaim temporary store snapshot ${tempPath}`, {
          cause: error,
        });
      }
    }
  }

  if (removed) fsyncDirectory(DATA_DIR);
}

function serializeData<T>(data: Map<string, T>, filePath: string): string {
  const object = Object.create(null) as Record<string, T>;
  for (const [id, value] of data) {
    Object.defineProperty(object, id, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  try {
    const serialized = JSON.stringify(object, null, 2);
    if (serialized === undefined) {
      throw new TypeError("store data is not JSON-serializable");
    }
    const roundTripped = JSON.parse(serialized) as Record<string, unknown>;
    if (Object.keys(roundTripped).length !== data.size) {
      throw new TypeError("one or more top-level values are not JSON-serializable");
    }
    return `${serialized}\n`;
  } catch (error) {
    throw new StorePersistenceError(`could not serialize store data for ${filePath}`, { cause: error });
  }
}

/**
 * Acquire a crash-recoverable cross-process lock.
 *
 * A complete, fsynced claim is hard-linked into the well-known lock path, so
 * contenders never read a partially initialized owner record. Live owners are
 * waited out; claims owned by dead processes are reclaimed.
 */
function acquireExclusiveLock(lockPath: string, storeName: string): StoreLock {
  const token = randomUUID();
  const claimPath = `${lockPath}.${process.pid}.${token}.claim`;
  const owner: StoreLockOwner = { pid: process.pid, token };
  let claimFd: number | undefined;

  try {
    claimFd = openSync(claimPath, "wx", 0o600);
    fchmodSync(claimFd, 0o600);
    writeAll(claimFd, Buffer.from(`${JSON.stringify(owner)}\n`, "utf8"));
    fsyncSync(claimFd);
    closeSync(claimFd);
    claimFd = undefined;
  } catch (error) {
    if (claimFd !== undefined) {
      try {
        closeSync(claimFd);
      } catch {
        // Preserve the acquisition failure below.
      }
    }
    unlinkIfExists(claimPath);
    throw new StorePersistenceError(`could not create lock claim for store ${storeName}`, { cause: error });
  }

  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  try {
    for (;;) {
      try {
        linkSync(claimPath, lockPath);
        fsyncDirectory(DATA_DIR);
        break;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      }

      const existing = readLockOwner(lockPath);
      if (existing === undefined) continue;

      if (isProcessAlive(existing.pid)) {
        if (Date.now() >= deadline) {
          throw new StorePersistenceError(
            `timed out waiting for another process to update store ${storeName}`,
          );
        }
        Atomics.wait(LOCK_SLEEP, 0, 0, LOCK_POLL_INTERVAL_MS);
        continue;
      }

      // Serialize stale-owner recovery separately. Without this gate, two
      // contenders could both validate the dead lock and one could unlink the
      // other's newly acquired lock.
      const reclaimGate = tryAcquireReclaimGate(lockPath, claimPath, storeName);
      if (reclaimGate === undefined) {
        if (Date.now() >= deadline) {
          throw new StorePersistenceError(`timed out recovering the stale lock for store ${storeName}`);
        }
        Atomics.wait(LOCK_SLEEP, 0, 0, LOCK_POLL_INTERVAL_MS);
        continue;
      }

      try {
        const current = readLockOwner(lockPath);
        if (
          current === undefined ||
          current.pid !== existing.pid ||
          current.token !== existing.token ||
          isProcessAlive(current.pid)
        ) {
          continue;
        }

        const staleClaimPath = `${lockPath}.${current.pid}.${current.token}.claim`;
        if (!sameFile(lockPath, staleClaimPath)) {
          if (!pathExists(lockPath)) continue;
          throw new StorePersistenceError(`store ${storeName} has an inconsistent stale lock`);
        }

        unlinkIfExists(lockPath);
        unlinkIfExists(staleClaimPath);
        fsyncDirectory(DATA_DIR);
      } finally {
        reclaimGate.release();
      }
    }

    let released = false;
    return {
      release(): void {
        if (released) return;
        released = true;
        try {
          if (sameFile(lockPath, claimPath)) unlinkSync(lockPath);
        } finally {
          unlinkIfExists(claimPath);
          fsyncDirectory(DATA_DIR);
        }
      },
    };
  } catch (error) {
    try {
      if (sameFile(lockPath, claimPath)) unlinkIfExists(lockPath);
    } finally {
      unlinkIfExists(claimPath);
    }
    if (error instanceof StorePersistenceError) throw error;
    throw new StorePersistenceError(`could not acquire lock for store ${storeName}`, { cause: error });
  }
}

function tryAcquireReclaimGate(
  lockPath: string,
  claimPath: string,
  storeName: string,
): StoreLock | undefined {
  // Recovery gates form an append-only generation chain. A crashed gate owner
  // is never unlinked or replaced: contenders advance to a child generation
  // keyed by that owner's unique token. This avoids recreating the same ABA
  // race the gate exists to prevent, while still allowing recovery after any
  // number of reclaiming processes crash.
  let generationToken: string | undefined;
  const visited = new Set<string>();

  for (;;) {
    const generationKey = generationToken ?? "initial";
    if (visited.has(generationKey)) {
      throw new StorePersistenceError(`store ${storeName} has a cyclic stale-lock recovery chain`);
    }
    visited.add(generationKey);
    // Keep the first generation at the legacy path so mixed versions still
    // serialize recovery. Only a dead gate advances to a token-keyed child.
    const reclaimPath = generationToken === undefined
      ? `${lockPath}.reclaim`
      : `${lockPath}.reclaim.${generationToken}`;

    try {
      linkSync(claimPath, reclaimPath);
      fsyncDirectory(DATA_DIR);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        const owner = readLockOwner(reclaimPath);
        if (owner === undefined) continue;
        if (isProcessAlive(owner.pid)) return undefined;
        generationToken = owner.token;
        continue;
      }
      try {
        if (sameFile(reclaimPath, claimPath)) unlinkIfExists(reclaimPath);
      } catch {
        // Preserve the acquisition failure below.
      }
      throw new StorePersistenceError(`could not acquire stale-lock recovery gate for store ${storeName}`, {
        cause: error,
      });
    }

    let released = false;
    return {
      release(): void {
        if (released) return;
        released = true;
        if (sameFile(reclaimPath, claimPath)) unlinkIfExists(reclaimPath);
        fsyncDirectory(DATA_DIR);
      },
    };
  }
}

function readLockOwner(lockPath: string): StoreLockOwner | undefined {
  let info;
  try {
    info = lstatSync(lockPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new StorePersistenceError(`could not inspect store lock ${lockPath}`, { cause: error });
  }

  if (info.isSymbolicLink() || !info.isFile()) {
    throw new StorePersistenceError(`store lock ${lockPath} must be a regular file`);
  }
  assertCurrentOwner(info.uid, `store lock ${lockPath}`);
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
    throw new StorePersistenceError(`store lock ${lockPath} has unsafe permissions`);
  }
  if (info.nlink !== 2) {
    throw new StorePersistenceError(`store lock ${lockPath} has an inconsistent link count`);
  }

  let parsed: Partial<StoreLockOwner>;
  try {
    parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<StoreLockOwner>;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new StorePersistenceError(`store lock ${lockPath} is malformed`, { cause: error });
  }

  if (!Number.isSafeInteger(parsed.pid) || (parsed.pid ?? 0) <= 0) {
    throw new StorePersistenceError(`store lock ${lockPath} has an invalid process owner`);
  }
  if (typeof parsed.token !== "string" || !isUuid(parsed.token)) {
    throw new StorePersistenceError(`store lock ${lockPath} has an invalid owner token`);
  }
  return { pid: parsed.pid!, token: parsed.token };
}

function assertCurrentOwner(uid: number, description: string): void {
  if (typeof process.getuid === "function" && uid !== process.getuid()) {
    throw new StorePersistenceError(`${description} is not owned by the current user`);
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new StorePersistenceError("store write made no progress");
    offset += written;
  }
}

function fsyncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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
    const leftInfo = statSync(left);
    const rightInfo = statSync(right);
    return leftInfo.dev === rightInfo.dev && leftInfo.ino === rightInfo.ino;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
