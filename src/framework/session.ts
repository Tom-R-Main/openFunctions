/**
 * Event-sourced session kernel for the OpenFunction agent harness.
 *
 * The kernel is deliberately provider- and UI-neutral. Its event log is the
 * durable authority; model history is a deterministic projection of that log.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

import type {
  AdapterContinuationRecovery,
  AdapterReplayPayload,
  AdapterSessionState,
  ChatMessage,
  ToolCall,
} from "./adapters/types.js";

export const SESSION_EVENT_SCHEMA_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type ToolResultOutcome = "succeeded" | "failed" | "unknown";
export type StepOutcome = "completed" | "failed" | "interrupted";

export interface ModelHistoryReference {
  /** Sequence immediately before model/request-prepared is appended. */
  throughSeq: number;
  messageCount: number;
  sha256: string;
}

export interface ModelToolSnapshotReference {
  /** Canonical, sorted tool names available for this request. */
  names: string[];
  /** Digest of the complete tool snapshot supplied to the adapter. */
  sha256: string;
}

export interface ModelRequestSnapshot {
  history: ModelHistoryReference;
  systemPromptSha256: string;
  tools: ModelToolSnapshotReference;
  options?: unknown;
  adapter?: {
    name: string;
    model: string;
  };
}

export interface ModelResponseSnapshot {
  text?: string;
  toolCall?: ToolCall;
  toolCalls?: ToolCall[];
  thinking?: unknown[];
  providerReplay?: AdapterReplayPayload;
  continuationRecovery?: AdapterContinuationRecovery;
}

export interface SessionEventDataMap {
  "session/started": {
    metadata?: Record<string, unknown>;
  };
  "history/replaced": {
    history: ChatMessage[];
    reason?: string;
    /** Atomically move the history projection to another logical thread. */
    threadId?: string;
    /** Clear every provider continuation alongside the replacement. */
    clearAdapterStates?: boolean;
    /** True only for crash recovery's pre-terminal turn rollback. */
    recovered?: boolean;
  };
  "message/appended": {
    message: ChatMessage;
  };
  "turn/started": {
    input?: ChatMessage;
  };
  "step/started": {
    index?: number;
  };
  "model/request-prepared": ModelRequestSnapshot;
  "model/response-received": ModelResponseSnapshot;
  "adapter/state-updated": {
    state: AdapterSessionState;
  };
  "adapter/state-cleared": {
    key: string;
    reason?: string;
  };
  "tool/call": {
    call: ToolCall;
  };
  "tool/execution-started": {
    call: ToolCall;
  };
  "tool/result": {
    toolCallId: string;
    toolName: string;
    outcome: ToolResultOutcome;
    result?: unknown;
    error?: string;
    /** Exact content appended to model history for this result. */
    modelContent?: string;
    /** True when crash recovery synthesized this result without retrying. */
    recovered?: boolean;
  };
  "step/completed": {
    outcome: StepOutcome;
    reason?: string;
    /** True when recovery synthesized this terminal event after a crash. */
    recovered?: boolean;
    /** Persist the turn rollback decision across a crash during recovery. */
    rollbackTurn?: boolean;
  };
  "turn/completed": {
    reason?: string;
    rounds?: number;
    finalText?: string;
    assistantTurnComplete?: boolean;
    runStatus?: string;
  };
  "turn/failed": {
    error: string;
    rounds?: number;
  };
  "turn/interrupted": {
    reason: string;
    recovered?: boolean;
  };
  "session/reset": {
    reason?: string;
    /** New logical thread identity established by the reset. */
    threadId?: string;
  };
  "session/destroyed": {
    reason?: string;
  };
}

export type SessionEventType = keyof SessionEventDataMap;

export interface SessionEventContext {
  turnId?: string;
  stepId?: string;
  runId?: string;
  correlationId?: string;
}

interface SessionEventEnvelope<K extends SessionEventType> extends SessionEventContext {
  readonly schemaVersion: typeof SESSION_EVENT_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly seq: number;
  readonly eventId: string;
  readonly timestamp: string;
  readonly type: K;
  readonly data: Readonly<SessionEventDataMap[K]>;
}

export type SessionEventOf<K extends SessionEventType> = SessionEventEnvelope<K>;
export type SessionEvent = {
  [K in SessionEventType]: SessionEventOf<K>;
}[SessionEventType];

export type SessionEventInput<K extends SessionEventType = SessionEventType> =
  SessionEventContext & {
    type: K;
    data: SessionEventDataMap[K];
  };

export interface SessionEventStore {
  read(sessionId: string): readonly SessionEvent[];
  append(event: SessionEvent): void;
}

export interface SessionKernelOptions {
  sessionId: string;
  store?: SessionEventStore;
  clock?: () => Date;
  eventIdFactory?: () => string;
  metadata?: Record<string, unknown>;
}

export class SessionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionInvariantError";
  }
}

/** Raised when another writer owns the session's exclusive append lock. */
export class SessionConcurrencyError extends SessionInvariantError {
  constructor(sessionId: string) {
    super(`session ${sessionId} is locked by another writer`);
    this.name = "SessionConcurrencyError";
  }
}

/**
 * Clone a value into a canonical JSON representation and deeply freeze it.
 * Object keys are sorted, object-valued `undefined` properties are omitted,
 * and every other non-JSON value is rejected.
 */
export function snapshotJson<T>(value: T, label = "value"): Readonly<T> {
  const snapshot = cloneJson(value, label, new Set<object>());
  return deepFreeze(snapshot) as Readonly<T>;
}

/** Return a canonical SHA-256 digest for any JSON-compatible value. */
export function digestJson(value: unknown): string {
  const snapshot = snapshotJson(value, "digest value");
  const serialized = JSON.stringify(snapshot);
  if (serialized === undefined) {
    throw new SessionInvariantError("digest value is not JSON-compatible");
  }
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

/** In-memory reference store. It applies the same replay validation as a durable store. */
export class InMemorySessionEventStore implements SessionEventStore {
  private readonly eventsBySession = new Map<string, SessionEvent[]>();
  private readonly validationBySession = new Map<string, SessionValidationState>();

  constructor(events: readonly SessionEvent[] = []) {
    for (const candidate of events) {
      const event = snapshotJson(candidate, "session event") as SessionEvent;
      const existing = this.eventsBySession.get(event.sessionId) ?? [];
      const validation = this.validationBySession.get(event.sessionId) ?? createSessionValidationState();
      validateEventEnvelope(event, event.sessionId, existing.length + 1, validation);
      existing.push(event);
      this.eventsBySession.set(event.sessionId, existing);
      advanceSessionValidationState(validation, event);
      this.validationBySession.set(event.sessionId, validation);
    }
  }

  read(sessionId: string): readonly SessionEvent[] {
    const events = this.eventsBySession.get(sessionId) ?? [];
    return Object.freeze([...events]);
  }

  append(candidate: SessionEvent): void {
    const event = snapshotJson(candidate, "session event") as SessionEvent;
    const existing = this.eventsBySession.get(event.sessionId) ?? [];
    const validation = this.validationBySession.get(event.sessionId) ?? createSessionValidationState();
    validateEventEnvelope(event, event.sessionId, existing.length + 1, validation);
    existing.push(event);
    this.eventsBySession.set(event.sessionId, existing);
    advanceSessionValidationState(validation, event);
    this.validationBySession.set(event.sessionId, validation);
  }
}

export interface JsonlSessionEventStoreOptions {
  rootDir: string;
}

/**
 * Synchronous, fsync-backed JSONL session store.
 *
 * A SHA-256 digest, rather than the session id, determines every file name.
 * The newline after each JSON value is its commit marker. Readers may ignore
 * one non-newline final fragment left by a crashed append, but never skip a
 * malformed committed line.
 */
export class JsonlSessionEventStore implements SessionEventStore {
  private readonly rootDir: string;
  private readonly cacheBySession = new Map<string, JsonlCacheEntry>();

  constructor(options: JsonlSessionEventStoreOptions) {
    if (typeof options.rootDir !== "string" || options.rootDir.trim() === "") {
      throw new SessionInvariantError("JSONL session store rootDir must be a non-empty string");
    }
    // resolve() removes a trailing separator before lstat. Without this,
    // POSIX lstat follows a final symlink when the caller supplies `link/`.
    this.rootDir = resolve(options.rootDir);
    initializeSecureRoot(this.rootDir);
  }

  read(sessionId: string): readonly SessionEvent[] {
    assertNonEmptyString(sessionId, "sessionId");
    return Object.freeze([...this.currentLog(sessionId).events]);
  }

  append(candidate: SessionEvent): void {
    const event = snapshotJson(candidate, "session event") as SessionEvent;
    const paths = this.pathsFor(event.sessionId);
    const lock = acquireExclusiveLock(paths.lock, event.sessionId);

    try {
      const current = this.currentLog(event.sessionId);
      validateEventEnvelope(
        event,
        event.sessionId,
        current.events.length + 1,
        current.validation,
      );

      const createdEventFile = current.identity === undefined;
      const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
      const openFlags = constants.O_APPEND | constants.O_RDWR | noFollow
        | (createdEventFile ? constants.O_CREAT | constants.O_EXCL : 0);
      let eventFd: number;
      try {
        eventFd = openSync(paths.events, openFlags, 0o600);
      } catch (error) {
        if (isNodeError(error) && (error.code === "EEXIST" || error.code === "ENOENT")) {
          throw new SessionConcurrencyError(event.sessionId);
        }
        throw error;
      }
      let appendedIdentity: JsonlFileIdentity | undefined;
      try {
        if (createdEventFile) fchmodSync(eventFd, 0o600);
        const openedIdentity = eventFileIdentityFromStats(
          fstatSync(eventFd, { bigint: true }),
          paths.events,
        );
        if (!createdEventFile && !sameEventFileIdentity(current.identity, openedIdentity)) {
          throw new SessionConcurrencyError(event.sessionId);
        }
        if (current.hasTornTail) {
          ftruncateSync(eventFd, current.committedByteLength);
        }
        writeAll(eventFd, Buffer.from(`${JSON.stringify(event)}\n`, "utf8"));
        fsyncSync(eventFd);
        appendedIdentity = eventFileIdentityFromStats(
          fstatSync(eventFd, { bigint: true }),
          paths.events,
        );
      } finally {
        closeSync(eventFd);
      }
      if (createdEventFile) fsyncDirectory(this.rootDir);

      const identity = eventFileIdentity(paths.events);
      if (identity === undefined) {
        throw new SessionInvariantError(
          `session event file disappeared after append: ${paths.events}`,
        );
      }
      if (appendedIdentity === undefined || !sameEventFileIdentity(appendedIdentity, identity)) {
        throw new SessionConcurrencyError(event.sessionId);
      }
      advanceSessionValidationState(current.validation, event);
      current.events.push(event);
      current.committedByteLength = Number(identity.size);
      current.hasTornTail = false;
      current.identity = identity;
      this.cacheBySession.set(event.sessionId, current);
    } finally {
      lock.release();
    }
  }

  private currentLog(sessionId: string): JsonlCacheEntry {
    const path = this.pathsFor(sessionId).events;
    const identity = eventFileIdentity(path);
    const cached = this.cacheBySession.get(sessionId);
    if (cached !== undefined && sameEventFileIdentity(cached.identity, identity)) {
      return cached;
    }
    const rebuilt = this.readLog(sessionId);
    this.cacheBySession.set(sessionId, rebuilt);
    return rebuilt;
  }

  private readLog(sessionId: string): JsonlCacheEntry {
    const path = this.pathsFor(sessionId).events;
    let bytes: Buffer | undefined;
    let identity: JsonlFileIdentity | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = eventFileIdentity(path);
      let candidateBytes: Buffer;
      try {
        candidateBytes = before === undefined ? Buffer.alloc(0) : readFileSync(path);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") continue;
        throw error;
      }
      const after = eventFileIdentity(path);
      if (sameEventFileIdentity(before, after)) {
        bytes = candidateBytes;
        identity = after;
        break;
      }
    }
    if (bytes === undefined) {
      throw new SessionConcurrencyError(sessionId);
    }

    const lastNewline = bytes.lastIndexOf(0x0a);
    const committedByteLength = lastNewline + 1;
    const hasTornTail = committedByteLength < bytes.length;
    let committed: string;
    try {
      committed = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, committedByteLength));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SessionInvariantError(`committed session event log is not valid UTF-8: ${detail}`);
    }
    const lines = committedByteLength === 0 ? [] : committed.slice(0, -1).split("\n");
    const events: SessionEvent[] = [];
    const validation = createSessionValidationState();

    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      const line = lines[index]!;
      if (line.length === 0) {
        throw new SessionInvariantError(`malformed committed session event at line ${lineNumber}: empty line`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new SessionInvariantError(`malformed committed session event at line ${lineNumber}: ${detail}`);
      }

      try {
        const event = snapshotJson(parsed, `session event at line ${lineNumber}`) as SessionEvent;
        validateEventEnvelope(event, sessionId, lineNumber, validation);
        events.push(event);
        advanceSessionValidationState(validation, event);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new SessionInvariantError(`invalid committed session event at line ${lineNumber}: ${detail}`);
      }
    }

    return {
      events,
      committedByteLength,
      hasTornTail,
      validation,
      identity,
    };
  }

  private pathsFor(sessionId: string): { events: string; lock: string } {
    const digest = createHash("sha256").update(sessionId, "utf8").digest("hex");
    return {
      events: join(this.rootDir, `${digest}.jsonl`),
      lock: join(this.rootDir, `${digest}.lock`),
    };
  }
}

interface JsonlReadResult {
  events: readonly SessionEvent[];
  committedByteLength: number;
  hasTornTail: boolean;
}

interface JsonlFileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface JsonlCacheEntry extends JsonlReadResult {
  events: SessionEvent[];
  validation: SessionValidationState;
  identity?: JsonlFileIdentity;
}

function eventFileIdentity(path: string): JsonlFileIdentity | undefined {
  try {
    return eventFileIdentityFromStats(lstatSync(path, { bigint: true }), path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

interface BigIntFileStats {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mode: bigint;
  uid: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

function eventFileIdentityFromStats(
  stats: BigIntFileStats,
  path: string,
): JsonlFileIdentity {
  if (stats.isSymbolicLink()) {
    throw new SessionInvariantError(`session event file must not be a symbolic link: ${path}`);
  }
  if (!stats.isFile()) {
    throw new SessionInvariantError(`session event path must be a regular file: ${path}`);
  }
  if ((stats.mode & 0o7777n) !== 0o600n) {
    throw new SessionInvariantError(`session event file must have mode 0600: ${path}`);
  }
  if (typeof process.getuid === "function" && stats.uid !== BigInt(process.getuid())) {
    throw new SessionInvariantError(`session event file must be owned by the current user: ${path}`);
  }
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameEventFileIdentity(
  left: JsonlFileIdentity | undefined,
  right: JsonlFileIdentity | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function initializeSecureRoot(rootDir: string): void {
  const existing = lstatIfExists(rootDir);
  if (existing !== undefined) {
    assertSecureSessionRoot(rootDir, existing);
    return;
  }

  const firstCreated = mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  if (firstCreated === undefined) {
    const raced = lstatIfExists(rootDir);
    if (raced === undefined) {
      throw new SessionInvariantError(`session store root disappeared while being created: ${rootDir}`);
    }
    assertSecureSessionRoot(rootDir, raced);
    return;
  }

  const created = lstatSync(rootDir);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new SessionInvariantError(`new session store root is not a real directory: ${rootDir}`);
  }
  // This path was created by this constructor, so normalizing its mode cannot
  // change permissions on a caller-owned directory.
  chmodSync(rootDir, 0o700);
  assertSecureSessionRoot(rootDir, lstatSync(rootDir));
  // recursive mkdir may have created several path components. Persist every
  // new child entry up to the first directory it created, as well as the root
  // directory inode/mode itself, before an event file can depend on them.
  fsyncDirectory(rootDir);
  fsyncCreatedDirectoryChain(resolve(firstCreated), rootDir);
}

function fsyncCreatedDirectoryChain(firstCreated: string, rootDir: string): void {
  let current = rootDir;
  while (true) {
    const parent = dirname(current);
    if (parent === current) {
      throw new SessionInvariantError(
        `created session root is not beneath its first created directory: ${rootDir}`,
      );
    }
    fsyncDirectory(parent);
    if (current === firstCreated) return;
    current = parent;
  }
}

function lstatIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertSecureSessionRoot(
  rootDir: string,
  stats: Stats,
): void {
  if (stats.isSymbolicLink()) {
    throw new SessionInvariantError(`session store root must not be a symbolic link: ${rootDir}`);
  }
  if (!stats.isDirectory()) {
    throw new SessionInvariantError(`session store root must be a directory: ${rootDir}`);
  }
  if ((stats.mode & 0o7777) !== 0o700) {
    throw new SessionInvariantError(`existing session store root must have mode 0700: ${rootDir}`);
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new SessionInvariantError(`existing session store root must be owned by the current user: ${rootDir}`);
  }
}

/**
 * Owns one session's event stream and deterministic model-history projection.
 */
export class SessionKernel {
  readonly sessionId: string;

  private readonly store: SessionEventStore;
  private readonly clock: () => Date;
  private readonly eventIdFactory: () => string;
  private events: SessionEvent[] = [];
  private history: readonly ChatMessage[] = Object.freeze([]);
  private adapterSessionStates: ReadonlyMap<string, Readonly<AdapterSessionState>> = new Map();
  private activeThreadId: string | undefined;
  private validation = createSessionValidationState();
  private destroyed = false;
  private appending = false;

  constructor(options: SessionKernelOptions) {
    if (typeof options.sessionId !== "string" || options.sessionId.trim() === "") {
      throw new SessionInvariantError("sessionId must be a non-empty string");
    }

    this.sessionId = options.sessionId;
    this.store = options.store ?? new InMemorySessionEventStore();
    this.clock = options.clock ?? (() => new Date());
    this.eventIdFactory = options.eventIdFactory ?? randomUUID;

    const stored = this.store.read(this.sessionId);
    if (stored.length === 0) {
      this.append({
        type: "session/started",
        data: options.metadata === undefined ? {} : { metadata: options.metadata },
      });
      return;
    }

    this.replay(stored);
  }

  getEvents(): readonly SessionEvent[] {
    return Object.freeze([...this.events]);
  }

  /** Number of durable events without allocating a copy of the journal. */
  getEventCount(): number {
    return this.events.length;
  }

  getHistory(): readonly ChatMessage[] {
    return this.history;
  }

  getAdapterSessionState(key: string): Readonly<AdapterSessionState> | undefined {
    assertNonEmptyString(key, "adapter session state key");
    return this.adapterSessionStates.get(key);
  }

  getThreadId(): string | undefined {
    return this.activeThreadId;
  }

  append<K extends SessionEventType>(input: SessionEventInput<K>): SessionEventOf<K> {
    if (this.appending) {
      throw new SessionInvariantError("session event append is not reentrant");
    }
    if (this.destroyed) {
      throw new SessionInvariantError("cannot append to a destroyed session");
    }
    if (this.events.length > 0 && input.type === "session/started") {
      throw new SessionInvariantError("session/started must be the first and only start event");
    }

    this.appending = true;
    try {
      const timestamp = this.clock();
      if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
        throw new SessionInvariantError("session clock must return a valid Date");
      }
      const eventId = this.eventIdFactory();
      if (typeof eventId !== "string" || eventId.trim() === "") {
        throw new SessionInvariantError("eventIdFactory must return a non-empty string");
      }

      const candidate = snapshotJson(
        {
          schemaVersion: SESSION_EVENT_SCHEMA_VERSION,
          sessionId: this.sessionId,
          seq: this.events.length + 1,
          eventId,
          timestamp: timestamp.toISOString(),
          type: input.type,
          data: input.data,
          ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
          ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
        },
        "session event",
      ) as unknown as SessionEventOf<K>;

      validateEventEnvelope(
        candidate as SessionEvent,
        this.sessionId,
        this.events.length + 1,
        this.validation,
      );
      const nextHistory = projectEvent(this.history, candidate as SessionEvent);
      const nextAdapterSessionStates = projectAdapterSessionStates(
        this.adapterSessionStates,
        candidate as SessionEvent,
      );
      const nextThreadId = projectThreadId(this.activeThreadId, candidate as SessionEvent);

      this.store.append(candidate as SessionEvent);
      this.events.push(candidate as SessionEvent);
      advanceSessionValidationState(this.validation, candidate as SessionEvent);
      this.history = nextHistory;
      this.adapterSessionStates = nextAdapterSessionStates;
      this.activeThreadId = nextThreadId;
      if (candidate.type === "session/destroyed") this.destroyed = true;
      return candidate;
    } finally {
      this.appending = false;
    }
  }

  appendMessage(message: ChatMessage, context: SessionEventContext = {}): SessionEventOf<"message/appended"> {
    return this.append({
      type: "message/appended",
      data: { message },
      ...context,
    });
  }

  replaceHistory(
    history: ChatMessage[],
    reason?: string,
    context: SessionEventContext = {},
  ): SessionEventOf<"history/replaced"> {
    return this.append({
      type: "history/replaced",
      data: reason === undefined ? { history } : { history, reason },
      ...context,
    });
  }

  switchThread(
    threadId: string,
    history: ChatMessage[],
    reason = "thread_switched",
    context: SessionEventContext = {},
  ): SessionEventOf<"history/replaced"> {
    return this.append({
      type: "history/replaced",
      data: { history, reason, threadId, clearAdapterStates: true },
      ...context,
    });
  }

  replaceHistoryAndClearAdapterStates(
    history: ChatMessage[],
    reason: string,
    context: SessionEventContext = {},
  ): SessionEventOf<"history/replaced"> {
    return this.append({
      type: "history/replaced",
      data: { history, reason, clearAdapterStates: true },
      ...context,
    });
  }

  setAdapterSessionState(
    state: AdapterSessionState,
    context: SessionEventContext = {},
  ): SessionEventOf<"adapter/state-updated"> {
    return this.append({
      type: "adapter/state-updated",
      data: { state },
      ...context,
    });
  }

  clearAdapterSessionState(
    key: string,
    reason?: string,
    context: SessionEventContext = {},
  ): SessionEventOf<"adapter/state-cleared"> {
    return this.append({
      type: "adapter/state-cleared",
      data: reason === undefined ? { key } : { key, reason },
      ...context,
    });
  }

  private restoreAdapterSessionStates(
    expected: ReadonlyMap<string, Readonly<AdapterSessionState>>,
    reason: string,
    context: SessionEventContext,
  ): SessionEvent[] {
    const appended: SessionEvent[] = [];
    for (const key of [...this.adapterSessionStates.keys()].sort()) {
      if (!expected.has(key)) {
        appended.push(this.clearAdapterSessionState(key, reason, context));
      }
    }
    for (const [key, state] of [...expected.entries()].sort(([left], [right]) => (
      left < right ? -1 : left > right ? 1 : 0
    ))) {
      const current = this.adapterSessionStates.get(key);
      if (current === undefined || digestJson(current) !== digestJson(state)) {
        appended.push(this.setAdapterSessionState({ ...state }, context));
      }
    }
    return appended;
  }

  /**
   * Balance a stream left open by a process crash. An execution-started tool
   * without a result is never retried; it receives an explicit unknown outcome
   * and a model-facing tool message before open steps/turns are closed.
   */
  recoverInterrupted(reason = "session recovered after an interrupted process"): readonly SessionEvent[] {
    if (this.destroyed) return Object.freeze([]);

    const state = inspectOpenWork(this.events);
    const appended: SessionEvent[] = [];

    for (const tool of state.openTools) {
      if (tool.result !== undefined) {
        const { result } = tool;
        const modelContent = result.data.modelContent ?? serializeRecoveredToolResult(result);
        appended.push(
          this.appendMessage(
            {
              role: "tool",
              toolCallId: result.data.toolCallId,
              toolName: result.data.toolName,
              content: modelContent,
            },
            eventContext(result),
          ),
        );
        continue;
      }

      const executionStarted = tool.execution !== undefined;
      const outcome = executionStarted ? "unknown" : "failed";
      const error = executionStarted
        ? "Tool execution outcome is unknown after recovery; the tool was not retried."
        : "Tool execution did not start before recovery; the tool was not executed.";
      const result = { outcome, error };
      const modelContent = JSON.stringify(result);
      const context = eventContext(tool.execution ?? tool.contextEvent);

      appended.push(
        this.append({
          type: "tool/result",
          data: {
            toolCallId: tool.call.id,
            toolName: tool.call.name,
            outcome,
            result,
            error,
            modelContent,
            recovered: true,
          },
          ...context,
        }),
      );
      appended.push(
        this.appendMessage(
          {
            role: "tool",
            toolCallId: tool.call.id,
            toolName: tool.call.name,
            content: modelContent,
          },
          context,
        ),
      );
    }

    for (const step of state.openSteps) {
      if (step.hasUnprojectedModelWork) {
        appended.push(...this.restoreAdapterSessionStates(
          step.adapterSessionStatesBefore,
          "interrupted step response rollback",
          eventContext(step.event),
        ));
      }
      const containingTurn = step.event.turnId === undefined
        ? state.openTurns.find((turn) => turn.event.seq <= step.event.seq)
        : state.openTurns.find((turn) => turn.event.turnId === step.event.turnId);
      appended.push(
        this.append({
          type: "step/completed",
          data: {
            outcome: "interrupted",
            reason,
            recovered: true,
            rollbackTurn: containingTurn !== undefined
              && (!containingTurn.hasNonUserMessage || containingTurn.requiresRollback),
          },
          ...eventContext(step.event),
        }),
      );
    }

    for (const turn of state.openTurns) {
      if (!turn.hasNonUserMessage || turn.requiresRollback) {
        const context = eventContext(turn.event);
        appended.push(
          this.append({
            type: "history/replaced",
            data: {
              history: [...turn.historyBefore],
              reason: "interrupted_turn_rolled_back",
              recovered: true,
            },
            ...context,
          }),
        );
        appended.push(...this.restoreAdapterSessionStates(
          turn.adapterSessionStatesBefore,
          "interrupted turn rollback",
          context,
        ));
      }
      appended.push(
        this.append({
          type: "turn/interrupted",
          data: { reason, recovered: true },
          ...eventContext(turn.event),
        }),
      );
    }

    return Object.freeze(appended);
  }

  private replay(stored: readonly SessionEvent[]): void {
    let history: readonly ChatMessage[] = Object.freeze([]);
    let adapterSessionStates: ReadonlyMap<string, Readonly<AdapterSessionState>> = new Map();
    let activeThreadId: string | undefined;
    let destroyed = false;
    const replayed: SessionEvent[] = [];
    const validation = createSessionValidationState();

    for (let index = 0; index < stored.length; index += 1) {
      const event = snapshotJson(stored[index], `session event at index ${index}`) as SessionEvent;
      validateEventEnvelope(event, this.sessionId, index + 1, validation);
      if (index === 0 && event.type !== "session/started") {
        throw new SessionInvariantError("session event stream must begin with session/started");
      }
      if (index > 0 && event.type === "session/started") {
        throw new SessionInvariantError("session/started may only appear at sequence 1");
      }
      if (destroyed) {
        throw new SessionInvariantError("session event stream contains an event after session/destroyed");
      }
      history = projectEvent(history, event);
      adapterSessionStates = projectAdapterSessionStates(adapterSessionStates, event);
      activeThreadId = projectThreadId(activeThreadId, event);
      replayed.push(event);
      advanceSessionValidationState(validation, event);
      if (event.type === "session/destroyed") destroyed = true;
    }

    this.events = replayed;
    this.history = history;
    this.adapterSessionStates = adapterSessionStates;
    this.activeThreadId = activeThreadId;
    this.validation = validation;
    this.destroyed = destroyed;
  }
}

interface OpenEvent<T extends SessionEvent = SessionEvent> {
  key: string;
  event: T;
}

interface OpenTurn extends OpenEvent<SessionEventOf<"turn/started">> {
  historyBefore: readonly ChatMessage[];
  adapterSessionStatesBefore: ReadonlyMap<string, Readonly<AdapterSessionState>>;
  hasNonUserMessage: boolean;
  requiresRollback: boolean;
}

interface OpenStep extends OpenEvent<SessionEventOf<"step/started">> {
  adapterSessionStatesBefore: ReadonlyMap<string, Readonly<AdapterSessionState>>;
  /** The active step has not durably projected an assistant response. */
  hasUnprojectedModelWork: boolean;
}

interface OpenToolWork {
  key: string;
  call: Pick<ToolCall, "id" | "name">;
  orderSeq: number;
  orderIndex: number;
  contextEvent: SessionEvent;
  turnId?: string;
  stepId?: string;
  execution?: SessionEventOf<"tool/execution-started">;
  result?: SessionEventOf<"tool/result">;
}

function inspectOpenWork(events: readonly SessionEvent[]): {
  openTools: OpenToolWork[];
  openSteps: OpenStep[];
  openTurns: OpenTurn[];
} {
  const turns = new Map<string, OpenTurn>();
  const steps = new Map<string, OpenStep>();
  const tools = new Map<string, OpenToolWork>();
  let history: readonly ChatMessage[] = Object.freeze([]);
  let adapterSessionStates: ReadonlyMap<string, Readonly<AdapterSessionState>> = new Map();

  for (const event of events) {
    switch (event.type) {
      case "session/reset":
      case "session/destroyed":
        turns.clear();
        steps.clear();
        tools.clear();
        break;
      case "turn/started":
        turns.set(event.turnId ?? `anonymous-turn:${event.seq}`, {
          key: event.turnId ?? `anonymous-turn:${event.seq}`,
          event,
          historyBefore: history,
          adapterSessionStatesBefore: new Map(adapterSessionStates),
          hasNonUserMessage: false,
          requiresRollback: false,
        });
        break;
      case "turn/completed":
      case "turn/failed":
      case "turn/interrupted": {
        const closed = takeOpen(turns, event.turnId);
        closeDescendantsForTurn(steps, tools, event.turnId, closed);
        break;
      }
      case "step/started":
        steps.set(event.stepId ?? `anonymous-step:${event.seq}`, {
          key: event.stepId ?? `anonymous-step:${event.seq}`,
          event,
          adapterSessionStatesBefore: new Map(adapterSessionStates),
          hasUnprojectedModelWork: true,
        });
        break;
      case "step/completed": {
        takeOpen(steps, event.stepId);
        const requiresRollback = event.data.outcome !== "completed"
          && (event.data.recovered !== true || event.data.rollbackTurn === true);
        if (requiresRollback) {
          const turn = event.turnId === undefined
            ? [...turns.values()].at(-1)
            : turns.get(event.turnId);
          if (turn !== undefined) turn.requiresRollback = true;
        }
        break;
      }
      case "model/request-prepared": {
        const step = event.stepId === undefined
          ? [...steps.values()].at(-1)
          : steps.get(event.stepId);
        if (step !== undefined) {
          step.adapterSessionStatesBefore = new Map(adapterSessionStates);
          step.hasUnprojectedModelWork = true;
        }
        break;
      }
      case "tool/call":
        upsertOpenTool(tools, event.data.call, event);
        break;
      case "tool/execution-started": {
        const work = upsertOpenTool(tools, event.data.call, event);
        work.execution = event;
        break;
      }
      case "tool/result": {
        const work = upsertOpenTool(
          tools,
          { id: event.data.toolCallId, name: event.data.toolName },
          event,
        );
        work.result = event;
        break;
      }
      case "message/appended": {
        if (event.data.message.role !== "user") {
          const turn = event.turnId === undefined
            ? [...turns.values()].at(-1)
            : turns.get(event.turnId);
          if (turn !== undefined) turn.hasNonUserMessage = true;
        }
        if (event.data.message.role === "assistant") {
          const step = event.stepId === undefined
            ? [...steps.values()].at(-1)
            : steps.get(event.stepId);
          if (step !== undefined) step.hasUnprojectedModelWork = false;
          const calls = assistantMessageToolCalls(event.data.message);
          for (let index = 0; index < calls.length; index += 1) {
            upsertOpenTool(tools, calls[index]!, event, index);
          }
        } else if (event.data.message.role === "tool" && event.data.message.toolCallId !== undefined) {
          tools.delete(event.data.message.toolCallId);
        }
        break;
      }
      default:
        break;
    }
    history = projectEvent(history, event);
    if (event.type === "history/replaced") {
      for (const turn of turns.values()) {
        turn.hasNonUserMessage = historyHasRetainedNonUserMessage(history, turn.historyBefore);
      }
    }
    adapterSessionStates = projectAdapterSessionStates(adapterSessionStates, event);
  }

  return {
    openTools: [...tools.values()].sort(
      (left, right) => left.orderSeq - right.orderSeq || left.orderIndex - right.orderIndex,
    ),
    openSteps: [...steps.values()].reverse(),
    openTurns: [...turns.values()].reverse(),
  };
}

function assistantMessageToolCalls(
  message: ChatMessage,
): Array<Pick<ToolCall, "id" | "name"> & { args?: Record<string, unknown> }> {
  if (message.toolCalls !== undefined) {
    return message.toolCalls.map(({ id, name, args }) => ({ id, name, args }));
  }
  if (message.toolCallId !== undefined && message.toolName !== undefined) {
    let args: Record<string, unknown> | undefined;
    if (typeof message.content === "string") {
      try {
        const parsed = JSON.parse(message.content) as unknown;
        if (isPlainObject(parsed)) args = parsed;
      } catch {
        // Legacy assistant tool messages may contain non-JSON display text.
      }
    }
    return [{
      id: message.toolCallId,
      name: message.toolName,
      ...(args === undefined ? {} : { args }),
    }];
  }
  return [];
}

function historyHasRetainedNonUserMessage(
  current: readonly ChatMessage[],
  before: readonly ChatMessage[],
): boolean {
  if (digestJson(current) === digestJson(before)) return false;
  if (
    current.length >= before.length
    && digestJson(current.slice(0, before.length)) === digestJson(before)
  ) {
    return current.slice(before.length).some((message) => message.role !== "user");
  }
  // A replacement that is not a prefix extension is unusual during a turn.
  // Preserve state only if its active projection still contains non-user work.
  return current.some((message) => message.role !== "user");
}

function upsertOpenTool(
  tools: Map<string, OpenToolWork>,
  call: Pick<ToolCall, "id" | "name">,
  event: SessionEvent,
  orderIndex = 0,
): OpenToolWork {
  const existing = tools.get(call.id);
  if (existing !== undefined) {
    existing.call = call;
    existing.turnId ??= event.turnId;
    existing.stepId ??= event.stepId;
    return existing;
  }
  const work: OpenToolWork = {
    key: call.id,
    call,
    orderSeq: event.seq,
    orderIndex,
    contextEvent: event,
    ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
  };
  tools.set(call.id, work);
  return work;
}

function takeOpen<T extends SessionEvent, U extends OpenEvent<T>>(
  open: Map<string, U>,
  explicitId?: string,
): U | undefined {
  if (explicitId !== undefined) {
    const item = open.get(explicitId);
    open.delete(explicitId);
    return item;
  }
  const latest = [...open.keys()].at(-1);
  if (latest === undefined) return undefined;
  const item = open.get(latest);
  open.delete(latest);
  return item;
}

function closeDescendantsForTurn(
  steps: Map<string, OpenEvent<SessionEventOf<"step/started">>>,
  tools: Map<string, OpenToolWork>,
  explicitTurnId: string | undefined,
  closed: OpenEvent<SessionEventOf<"turn/started">> | undefined,
): void {
  const turnId = explicitTurnId ?? closed?.event.turnId;
  const beginsAt = closed?.event.seq;
  for (const [key, step] of steps) {
    if (turnId !== undefined ? step.event.turnId === turnId : beginsAt !== undefined && step.event.seq >= beginsAt) {
      steps.delete(key);
    }
  }
  for (const [key, tool] of tools) {
    if (turnId !== undefined ? tool.turnId === turnId : beginsAt !== undefined && tool.orderSeq >= beginsAt) {
      tools.delete(key);
    }
  }
}

function eventContext(event: SessionEvent): SessionEventContext {
  return {
    ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
    ...(event.runId === undefined ? {} : { runId: event.runId }),
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
  };
}

function serializeRecoveredToolResult(result: SessionEventOf<"tool/result">): string {
  const value = result.data.result ?? {
    outcome: result.data.outcome,
    ...(result.data.error === undefined ? {} : { error: result.data.error }),
  };
  const serialized = JSON.stringify(snapshotJson(value, "recovered tool result"));
  if (serialized === undefined) {
    throw new SessionInvariantError(
      `tool result ${result.data.toolCallId} cannot be reconstructed for model history`,
    );
  }
  return serialized;
}

function expectedModelResponseMessage(
  response: SessionEventOf<"model/response-received">,
): ChatMessage | undefined {
  const calls = response.data.toolCalls
    ?? (response.data.toolCall === undefined ? [] : [response.data.toolCall]);
  if (calls.length === 1) {
    return {
      role: "assistant",
      content: JSON.stringify(calls[0]!.args),
      toolCallId: calls[0]!.id,
      toolName: calls[0]!.name,
      ...(response.data.thinking === undefined
        ? {}
        : { thinkingBlocks: response.data.thinking }),
      ...(response.data.providerReplay === undefined
        ? {}
        : { providerReplay: response.data.providerReplay }),
    };
  }
  if (calls.length > 1) {
    return {
      role: "assistant",
      content: "",
      toolCalls: calls,
      ...(response.data.thinking === undefined
        ? {}
        : { thinkingBlocks: response.data.thinking }),
      ...(response.data.providerReplay === undefined
        ? {}
        : { providerReplay: response.data.providerReplay }),
    };
  }
  if (!response.data.text) return undefined;
  return {
    role: "assistant",
    content: response.data.text,
    ...(response.data.providerReplay === undefined
      ? {}
      : { providerReplay: response.data.providerReplay }),
  };
}

function modelResponseMessageMatches(
  expected: ChatMessage,
  actual: ChatMessage,
): boolean {
  if (expected.toolCallId === undefined) {
    return digestJson(actual) === digestJson(expected);
  }
  if (typeof expected.content !== "string" || typeof actual.content !== "string") {
    return false;
  }

  let expectedArgs: unknown;
  let actualArgs: unknown;
  try {
    expectedArgs = JSON.parse(expected.content) as unknown;
    actualArgs = JSON.parse(actual.content) as unknown;
  } catch {
    return false;
  }
  if (!isPlainObject(expectedArgs) || !isPlainObject(actualArgs)) return false;

  // JSON object key order has no call semantic. The response event is a
  // canonical snapshot while the adapter-provided assistant display string
  // retains insertion order, so compare parsed arguments canonically and keep
  // every other assistant/replay field exact.
  return digestJson({ ...actual, content: "" }) === digestJson({ ...expected, content: "" })
    && digestJson(actualArgs) === digestJson(expectedArgs);
}

function projectEvent(
  current: readonly ChatMessage[],
  event: SessionEvent,
): readonly ChatMessage[] {
  switch (event.type) {
    case "session/started":
    case "session/reset":
      return Object.freeze([]);
    case "session/destroyed":
      return current;
    case "history/replaced":
      return snapshotJson(event.data.history, "replacement history") as readonly ChatMessage[];
    case "message/appended":
      return snapshotJson([...current, event.data.message], "projected history") as readonly ChatMessage[];
    case "model/request-prepared": {
      if (event.data.history.throughSeq !== event.seq - 1) {
        throw new SessionInvariantError(
          `model/request-prepared at sequence ${event.seq} must reference history through sequence ${event.seq - 1}`,
        );
      }
      if (event.data.history.messageCount !== current.length) {
        throw new SessionInvariantError(
          `model/request-prepared at sequence ${event.seq} history message count does not match projected history`,
        );
      }
      if (event.data.history.sha256 !== digestJson(current)) {
        throw new SessionInvariantError(
          `model/request-prepared at sequence ${event.seq} history digest does not match projected history`,
        );
      }
      return current;
    }
    default:
      return current;
  }
}

function projectAdapterSessionStates(
  current: ReadonlyMap<string, Readonly<AdapterSessionState>>,
  event: SessionEvent,
): ReadonlyMap<string, Readonly<AdapterSessionState>> {
  switch (event.type) {
    case "session/started":
    case "session/reset":
      return new Map();
    case "history/replaced":
      return event.data.clearAdapterStates === true ? new Map() : current;
    case "adapter/state-updated": {
      const next = new Map(current);
      next.set(event.data.state.key, event.data.state);
      return next;
    }
    case "adapter/state-cleared": {
      if (!current.has(event.data.key)) return current;
      const next = new Map(current);
      next.delete(event.data.key);
      return next;
    }
    default:
      return current;
  }
}

function projectThreadId(
  current: string | undefined,
  event: SessionEvent,
): string | undefined {
  switch (event.type) {
    case "session/started": {
      const threadId = event.data.metadata?.threadId;
      return typeof threadId === "string" && threadId.trim() !== "" ? threadId : current;
    }
    case "history/replaced":
    case "session/reset":
      return event.data.threadId ?? current;
    default:
      return current;
  }
}

interface ValidationOpenTool {
  orderSeq: number;
  name: string;
  argsSha256?: string;
  callRecorded: boolean;
  executionStarted: boolean;
  resultModelContent?: string;
  turnId: string;
  stepId: string;
  runId?: string;
  correlationId?: string;
}

interface ValidationPendingModelRequest {
  seq: number;
  turnId: string;
  stepId: string;
  runId?: string;
  correlationId?: string;
}

interface ValidationPendingModelResponse {
  seq: number;
  expectedMessage?: ChatMessage;
  turnId: string;
  stepId: string;
  runId?: string;
  correlationId?: string;
}

interface SessionValidationState {
  processedEvents: number;
  eventIds: Set<string>;
  openTurns: Map<string, SessionEventOf<"turn/started">>;
  turnOrder: string[];
  openSteps: Map<string, SessionEventOf<"step/started">>;
  stepOrder: string[];
  openTools: Map<string, ValidationOpenTool>;
  pendingModelRequest: ValidationPendingModelRequest | undefined;
  pendingModelResponse: ValidationPendingModelResponse | undefined;
  modelRequestStepIds: Set<string>;
  historyRollbackAllowedTurnIds: Set<string>;
  historyRollbackAppliedTurnIds: Set<string>;
  turnIdsWithStartedStep: Set<string>;
  openStepCountByTurn: Map<string, number>;
  openToolCountByTurn: Map<string, number>;
  openToolCountByStep: Map<string, number>;
}

function createSessionValidationState(): SessionValidationState {
  return {
    processedEvents: 0,
    eventIds: new Set(),
    openTurns: new Map(),
    turnOrder: [],
    openSteps: new Map(),
    stepOrder: [],
    openTools: new Map(),
    pendingModelRequest: undefined,
    pendingModelResponse: undefined,
    modelRequestStepIds: new Set(),
    historyRollbackAllowedTurnIds: new Set(),
    historyRollbackAppliedTurnIds: new Set(),
    turnIdsWithStartedStep: new Set(),
    openStepCountByTurn: new Map(),
    openToolCountByTurn: new Map(),
    openToolCountByStep: new Map(),
  };
}

function validateEventEnvelope(
  event: SessionEvent,
  expectedSessionId: string,
  expectedSeq: number,
  validation: SessionValidationState,
): void {
  if (validation.processedEvents !== expectedSeq - 1) {
    throw new SessionInvariantError(
      `session validation state is out of sync: expected ${expectedSeq - 1} prior events, got ${validation.processedEvents}`,
    );
  }
  if (!isPlainObject(event)) throw new SessionInvariantError("session event must be a JSON object");
  if (event.schemaVersion !== SESSION_EVENT_SCHEMA_VERSION) {
    throw new SessionInvariantError(`unsupported session event schema version: ${String(event.schemaVersion)}`);
  }
  if (event.sessionId !== expectedSessionId) {
    throw new SessionInvariantError(`session event belongs to ${event.sessionId}, expected ${expectedSessionId}`);
  }
  if (!Number.isSafeInteger(event.seq) || event.seq !== expectedSeq) {
    throw new SessionInvariantError(`session event sequence must be contiguous: expected ${expectedSeq}, got ${String(event.seq)}`);
  }
  assertNonEmptyString(event.eventId, "eventId");
  if (validation.eventIds.has(event.eventId)) {
    throw new SessionInvariantError(`duplicate session event id: ${event.eventId}`);
  }
  assertIsoTimestamp(event.timestamp);
  if (!EVENT_TYPES.has(event.type)) {
    throw new SessionInvariantError(`unknown session event type: ${String(event.type)}`);
  }
  for (const [name, value] of [
    ["turnId", event.turnId],
    ["stepId", event.stepId],
    ["runId", event.runId],
    ["correlationId", event.correlationId],
  ] as const) {
    if (value !== undefined) assertNonEmptyString(value, name);
  }
  validateEventData(event);
  validateCorrelationTransition(event, validation);
  validateLifecycleTransition(event, validation);
}

function validateCorrelationTransition(
  event: SessionEvent,
  state: SessionValidationState,
): void {
  const pendingRequest = state.pendingModelRequest;
  if (pendingRequest !== undefined) {
    if (event.type === "model/response-received") {
      assertValidationContext(pendingRequest, event, "model request and response");
    } else if (event.type === "step/completed") {
      assertValidationContext(pendingRequest, event, "model request and step completion");
      if (event.data.outcome === "completed") {
        throw new SessionInvariantError(
          "cannot complete a step before recording a response for its model request",
        );
      }
    } else if (
      event.type !== "adapter/state-updated"
      && event.type !== "adapter/state-cleared"
    ) {
      throw new SessionInvariantError(
        `model request at sequence ${pendingRequest.seq} has not received a response or been closed`,
      );
    }
  }

  const pendingResponse = state.pendingModelResponse;
  if (pendingResponse !== undefined) {
    if (event.type === "message/appended" && event.data.message.role === "assistant") {
      assertValidationContext(pendingResponse, event, "model response and assistant message");
      if (pendingResponse.expectedMessage === undefined) {
        throw new SessionInvariantError("an empty model response cannot append an assistant message");
      }
      if (!modelResponseMessageMatches(pendingResponse.expectedMessage, event.data.message)) {
        throw new SessionInvariantError(
          "assistant message does not exactly match the recorded model response",
        );
      }
    } else if (event.type === "step/completed") {
      assertValidationContext(pendingResponse, event, "model response and step completion");
      if (event.data.outcome === "completed" && pendingResponse.expectedMessage !== undefined) {
        throw new SessionInvariantError(
          "cannot complete a step before projecting its recorded model response",
        );
      }
    } else if (
      event.type !== "adapter/state-updated"
      && event.type !== "adapter/state-cleared"
    ) {
      throw new SessionInvariantError(
        `model response at sequence ${pendingResponse.seq} has not been projected or closed`,
      );
    }
  }

  switch (event.type) {
    case "model/request-prepared": {
      const context = requiredValidationContext(event, "model request");
      if (state.pendingModelRequest !== undefined) {
        throw new SessionInvariantError(
          `model request at sequence ${state.pendingModelRequest.seq} has not received a response or been closed`,
        );
      }
      if (state.pendingModelResponse !== undefined) {
        throw new SessionInvariantError(
          `model response at sequence ${state.pendingModelResponse.seq} has not been projected or closed`,
        );
      }
      if (state.modelRequestStepIds.has(context.stepId)) {
        throw new SessionInvariantError(
          `step ${context.stepId} already recorded a model request`,
        );
      }
      if ((state.openToolCountByStep.get(context.stepId) ?? 0) > 0) {
        throw new SessionInvariantError(
          `step ${context.stepId} cannot request another model response while tool calls remain open`,
        );
      }
      break;
    }
    case "model/response-received": {
      requiredValidationContext(event, "model response");
      if (state.pendingModelResponse !== undefined) {
        throw new SessionInvariantError(
          `model response at sequence ${state.pendingModelResponse.seq} has not been projected or closed`,
        );
      }
      if (state.pendingModelRequest === undefined) {
        throw new SessionInvariantError(
          "model response has no preceding unmatched model request",
        );
      }
      break;
    }
    case "tool/call": {
      const tool = state.openTools.get(event.data.call.id);
      if (tool === undefined) {
        throw new SessionInvariantError(
          `tool call ${event.data.call.id} was not declared by an assistant response`,
        );
      }
      assertValidationOpenToolCompatible(
        tool,
        event.data.call.id,
        event.data.call.name,
        event,
        event.data.call.args,
      );
      if (tool.resultModelContent !== undefined) {
        throw new SessionInvariantError(
          `tool call ${event.data.call.id} already recorded a result`,
        );
      }
      if (tool.callRecorded) {
        throw new SessionInvariantError(
          `tool call ${event.data.call.id} was already recorded`,
        );
      }
      break;
    }
    case "tool/execution-started": {
      const tool = state.openTools.get(event.data.call.id);
      if (tool === undefined) {
        throw new SessionInvariantError(
          `tool execution ${event.data.call.id} was not declared by an assistant response`,
        );
      }
      assertValidationOpenToolCompatible(
        tool,
        event.data.call.id,
        event.data.call.name,
        event,
        event.data.call.args,
      );
      if (tool.resultModelContent !== undefined) {
        throw new SessionInvariantError(
          `tool call ${event.data.call.id} already recorded a result`,
        );
      }
      if (!tool.callRecorded) {
        throw new SessionInvariantError(
          `tool execution ${event.data.call.id} has no preceding tool/call event`,
        );
      }
      if (tool.executionStarted) {
        throw new SessionInvariantError(
          `tool execution ${event.data.call.id} was already started`,
        );
      }
      break;
    }
    case "tool/result": {
      const tool = state.openTools.get(event.data.toolCallId);
      if (tool === undefined) {
        throw new SessionInvariantError(
          `tool result ${event.data.toolCallId} was not declared by an assistant response`,
        );
      }
      assertValidationOpenToolCompatible(
        tool,
        event.data.toolCallId,
        event.data.toolName,
        event,
      );
      if (tool.resultModelContent !== undefined) {
        throw new SessionInvariantError(
          `tool call ${event.data.toolCallId} already recorded a result`,
        );
      }
      if (event.data.recovered === true) {
        const expectedOutcome = tool.executionStarted ? "unknown" : "failed";
        if (event.data.outcome !== expectedOutcome) {
          throw new SessionInvariantError(
            `recovered tool result ${event.data.toolCallId} must be ${expectedOutcome}`,
          );
        }
      } else if (!tool.executionStarted) {
        throw new SessionInvariantError(
          `tool result ${event.data.toolCallId} has no preceding execution-started event`,
        );
      }
      break;
    }
    case "message/appended":
      if (event.data.message.role === "assistant") {
        if (state.pendingModelResponse === undefined) {
          throw new SessionInvariantError(
            "assistant message has no recorded model response to project",
          );
        }
        for (const call of assistantMessageToolCalls(event.data.message)) {
          const existing = state.openTools.get(call.id);
          if (existing !== undefined) {
            assertValidationOpenToolCompatible(
              existing,
              call.id,
              call.name,
              event,
              call.args,
            );
            throw new SessionInvariantError(
              `tool call ${call.id} was already declared by an assistant response`,
            );
          }
        }
      } else if (event.data.message.role === "tool") {
        const callId = event.data.message.toolCallId!;
        const tool = state.openTools.get(callId);
        if (tool === undefined) {
          throw new SessionInvariantError(
            `tool message ${callId} has no matching open tool call`,
          );
        }
        assertValidationOpenToolCompatible(
          tool,
          callId,
          event.data.message.toolName!,
          event,
        );
        if (tool.resultModelContent === undefined) {
          throw new SessionInvariantError(
            `tool call ${callId} has no durable result to project`,
          );
        }
        if (
          event.data.message.content !== tool.resultModelContent
        ) {
          throw new SessionInvariantError(
            `tool call ${callId} model-facing receipt does not match its durable result`,
          );
        }
      }
      break;
    default:
      break;
  }
}

function assertValidationContext(
  expected: {
    turnId?: string;
    stepId?: string;
    runId?: string;
    correlationId?: string;
  },
  event: SessionEvent,
  label: string,
): void {
  if (
    expected.turnId !== event.turnId
    || expected.stepId !== event.stepId
    || expected.runId !== event.runId
    || expected.correlationId !== event.correlationId
  ) {
    throw new SessionInvariantError(
      `${label} crossed turn, step, run, or correlation boundaries`,
    );
  }
}

function assertValidationTurnContext(
  expected: SessionEventOf<"turn/started">,
  event: SessionEvent,
  label: string,
): void {
  if (
    expected.turnId !== event.turnId
    || expected.runId !== event.runId
    || expected.correlationId !== event.correlationId
  ) {
    throw new SessionInvariantError(
      `${label} crossed turn, run, or correlation boundaries`,
    );
  }
}

function requiredValidationContext(
  event: SessionEvent,
  label: string,
): {
  turnId: string;
  stepId: string;
  runId?: string;
  correlationId?: string;
} {
  if (event.turnId === undefined || event.stepId === undefined) {
    throw new SessionInvariantError(`${label} requires explicit turnId and stepId`);
  }
  return {
    turnId: event.turnId,
    stepId: event.stepId,
    ...(event.runId === undefined ? {} : { runId: event.runId }),
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
  };
}

function validateLifecycleTransition(
  event: SessionEvent,
  state: SessionValidationState,
): void {
  const requiresOpenStep = event.type === "model/request-prepared"
    || event.type === "model/response-received"
    || event.type === "tool/call"
    || event.type === "tool/execution-started"
    || event.type === "tool/result"
    || (
      event.type === "message/appended"
      && (event.data.message.role === "assistant" || event.data.message.role === "tool")
    );

  if (requiresOpenStep) {
    const { turnId, stepId } = requiredValidationContext(event, event.type);
    if (!state.openTurns.has(turnId)) {
      throw new SessionInvariantError(
        `${event.type} has no matching open turn ${turnId}`,
      );
    }
    const step = state.openSteps.get(stepId);
    if (step === undefined) {
      throw new SessionInvariantError(
        `${event.type} has no matching open step ${stepId}`,
      );
    }
    if (step.turnId !== turnId) {
      throw new SessionInvariantError(
        `${event.type} step ${stepId} is not open in turn ${turnId}`,
      );
    }
    assertValidationContext(step, event, `${event.type} and its open step`);
  }

  if (event.type === "message/appended" && event.data.message.role === "user") {
    if (state.openSteps.size > 0 || state.openTools.size > 0) {
      throw new SessionInvariantError(
        "cannot append a user message while step or tool work remains open",
      );
    }
    const turn = event.turnId === undefined
      ? latestValidationOpen(state.openTurns, state.turnOrder)
      : state.openTurns.get(event.turnId);
    if (turn !== undefined) {
      assertValidationContext(turn, event, "user message and its open turn");
    } else if (event.turnId !== undefined || event.stepId !== undefined) {
      throw new SessionInvariantError("user message has no matching open lifecycle");
    }
  }

  if (event.type === "history/replaced") {
    if (state.openSteps.size > 0 || state.openTools.size > 0) {
      throw new SessionInvariantError(
        "cannot replace history while step or tool work remains open",
      );
    }
    const turnKey = event.turnId ?? latestValidationOpenKey(state.openTurns, state.turnOrder);
    const turn = turnKey === undefined ? undefined : state.openTurns.get(turnKey);
    if (turn !== undefined) {
      if (turnKey === undefined) {
        throw new SessionInvariantError("open turn validation key is missing");
      }
      assertValidationContext(turn, event, "history replacement and its open turn");
      if (event.data.threadId !== undefined || event.data.clearAdapterStates === true) {
        throw new SessionInvariantError(
          "cannot switch or compact history while a turn remains open",
        );
      }
      const rollbackAllowed = state.historyRollbackAllowedTurnIds.has(turnKey)
        || isInternalTurnRollbackReason(event.data.reason)
        || (
          event.data.recovered === true
          && (
            !state.turnIdsWithStartedStep.has(turnKey)
            || state.historyRollbackAppliedTurnIds.has(turnKey)
          )
        );
      if (!rollbackAllowed) {
        throw new SessionInvariantError(
          "cannot replace history while a turn remains open without a terminal rollback step",
        );
      }
    } else {
      if (event.data.recovered === true) {
        throw new SessionInvariantError(
          "a recovered history replacement requires a matching open turn",
        );
      }
      if (event.turnId !== undefined || event.stepId !== undefined) {
        throw new SessionInvariantError(
          "history replacement has no matching open lifecycle",
        );
      }
    }
  }

  if (event.type === "adapter/state-updated" || event.type === "adapter/state-cleared") {
    const step = event.stepId === undefined
      ? latestValidationOpen(state.openSteps, state.stepOrder)
      : state.openSteps.get(event.stepId);
    if (step !== undefined) {
      assertValidationContext(step, event, `${event.type} and its open step`);
    } else {
      const turn = event.turnId === undefined
        ? latestValidationOpen(state.openTurns, state.turnOrder)
        : state.openTurns.get(event.turnId);
      if (turn !== undefined) {
        assertValidationContext(turn, event, `${event.type} and its open turn`);
      } else if (event.turnId !== undefined || event.stepId !== undefined) {
        throw new SessionInvariantError(`${event.type} has no matching open lifecycle`);
      }
    }
  }

  if (
    event.type !== "turn/started" &&
    event.type !== "step/started" &&
    event.type !== "step/completed" &&
    event.type !== "turn/completed" &&
    event.type !== "turn/failed" &&
    event.type !== "turn/interrupted" &&
    event.type !== "session/reset" &&
    event.type !== "session/destroyed"
  ) return;

  if (event.type === "turn/started" && state.openTurns.size > 0) {
    throw new SessionInvariantError(
      "cannot start a turn while a prior turn remains open; recover the session first",
    );
  }

  if (event.type === "step/started") {
    const { turnId, stepId } = requiredValidationContext(event, "step/started");
    const turn = state.openTurns.get(turnId);
    if (turn === undefined) {
      throw new SessionInvariantError(
        `cannot start step ${stepId}: turn ${turnId} is not open`,
      );
    }
    assertValidationTurnContext(turn, event, "step and its open turn");
    if (state.openSteps.has(stepId)) {
      throw new SessionInvariantError(`step ${stepId} is already open`);
    }
    if (state.openSteps.size > 0) {
      throw new SessionInvariantError(
        "cannot start a step while a prior step remains open; recover the session first",
      );
    }
  }

  if (event.type === "step/completed") {
    const step = event.stepId === undefined
      ? latestValidationOpen(state.openSteps, state.stepOrder)
      : state.openSteps.get(event.stepId);
    if (step === undefined) {
      throw new SessionInvariantError(
        `cannot complete step ${event.stepId ?? "<latest>"}: no matching step is open`,
      );
    }
    if (step.turnId !== event.turnId) {
      throw new SessionInvariantError(
        `cannot complete step ${event.stepId ?? "<latest>"}: it is not open in turn ${event.turnId}`,
      );
    }
    assertValidationContext(step, event, "step start and completion");
    const stepId = event.stepId ?? step.stepId;
    const hasOpenTools = stepId !== undefined
      ? (state.openToolCountByStep.get(stepId) ?? 0) > 0
      : [...state.openTools.values()].some((tool) => tool.orderSeq >= step.seq);
    if (hasOpenTools) {
      throw new SessionInvariantError(
        "cannot complete a step while tool calls still lack model-facing result receipts",
      );
    }
  }

  if (
    event.type === "turn/completed" ||
    event.type === "turn/failed" ||
    event.type === "turn/interrupted"
  ) {
    const turn = event.turnId === undefined
      ? latestValidationOpen(state.openTurns, state.turnOrder)
      : state.openTurns.get(event.turnId);
    if (turn === undefined) {
      throw new SessionInvariantError(
        `cannot close turn ${event.turnId ?? "<latest>"}: no matching turn is open`,
      );
    }
    assertValidationContext(turn, event, "turn start and terminal event");
    const turnId = event.turnId ?? turn.turnId;
    const hasOpenTools = turnId !== undefined
      ? (state.openToolCountByTurn.get(turnId) ?? 0) > 0
      : [...state.openTools.values()].some((tool) => tool.orderSeq >= turn.seq);
    const hasOpenSteps = turnId !== undefined
      ? (state.openStepCountByTurn.get(turnId) ?? 0) > 0
      : [...state.openSteps.values()].some((step) => step.seq >= turn.seq);
    if (hasOpenTools || hasOpenSteps) {
      throw new SessionInvariantError(
        "cannot close a turn while steps or tool calls remain open; recover the session first",
      );
    }
  }

  if (event.type === "session/reset" || event.type === "session/destroyed") {
    if (
      state.openTurns.size > 0 ||
      state.openSteps.size > 0 ||
      state.openTools.size > 0
    ) {
      throw new SessionInvariantError(
        `cannot ${event.type === "session/reset" ? "reset" : "destroy"} a session with open work; recover it first`,
      );
    }
  }
}

function isInternalTurnRollbackReason(reason: string | undefined): boolean {
  return reason === "turn_failed"
    || reason === "turn_interrupted"
    || reason === "turn_failed_partial_effects"
    || reason === "turn_interrupted_partial_effects"
    || reason === "turn_without_assistant_rolled_back";
}

function advanceSessionValidationState(
  state: SessionValidationState,
  event: SessionEvent,
): void {
  state.processedEvents += 1;
  state.eventIds.add(event.eventId);

  switch (event.type) {
    case "session/reset":
    case "session/destroyed":
      clearValidationOpenWork(state);
      break;
    case "turn/started": {
      const key = event.turnId ?? `anonymous-turn:${event.seq}`;
      state.openTurns.set(key, event);
      state.turnOrder.push(key);
      break;
    }
    case "turn/completed":
    case "turn/failed":
    case "turn/interrupted": {
      const key = event.turnId ?? latestValidationOpenKey(state.openTurns, state.turnOrder);
      if (key !== undefined) {
        state.openTurns.delete(key);
        state.historyRollbackAllowedTurnIds.delete(key);
        state.historyRollbackAppliedTurnIds.delete(key);
        state.turnIdsWithStartedStep.delete(key);
      }
      state.pendingModelRequest = undefined;
      state.pendingModelResponse = undefined;
      break;
    }
    case "step/started": {
      const key = event.stepId ?? `anonymous-step:${event.seq}`;
      const replaced = state.openSteps.get(key);
      if (replaced?.turnId !== undefined) {
        adjustValidationCount(state.openStepCountByTurn, replaced.turnId, -1);
      }
      state.openSteps.set(key, event);
      state.stepOrder.push(key);
      if (event.turnId !== undefined) {
        adjustValidationCount(state.openStepCountByTurn, event.turnId, 1);
        state.turnIdsWithStartedStep.add(event.turnId);
        state.historyRollbackAllowedTurnIds.delete(event.turnId);
        state.historyRollbackAppliedTurnIds.delete(event.turnId);
      }
      break;
    }
    case "step/completed": {
      const key = event.stepId ?? latestValidationOpenKey(state.openSteps, state.stepOrder);
      if (key !== undefined) {
        const step = state.openSteps.get(key);
        if (step?.turnId !== undefined) {
          adjustValidationCount(state.openStepCountByTurn, step.turnId, -1);
          const completedWithoutProjection = event.data.outcome === "completed"
            && state.pendingModelResponse !== undefined
            && state.pendingModelResponse.expectedMessage === undefined;
          const requiresRollback = completedWithoutProjection || (
            event.data.outcome !== "completed"
            && (event.data.recovered !== true || event.data.rollbackTurn === true)
          );
          if (requiresRollback) {
            state.historyRollbackAllowedTurnIds.add(step.turnId);
          } else {
            state.historyRollbackAllowedTurnIds.delete(step.turnId);
          }
        }
        state.openSteps.delete(key);
      }
      state.pendingModelRequest = undefined;
      state.pendingModelResponse = undefined;
      break;
    }
    case "history/replaced": {
      const key = event.turnId ?? latestValidationOpenKey(state.openTurns, state.turnOrder);
      if (key !== undefined) {
        state.historyRollbackAllowedTurnIds.delete(key);
        state.historyRollbackAppliedTurnIds.add(key);
      }
      break;
    }
    case "model/request-prepared": {
      const context = requiredValidationContext(event, "model request");
      state.pendingModelRequest = { seq: event.seq, ...context };
      const { stepId } = context;
      state.modelRequestStepIds.add(stepId);
      break;
    }
    case "model/response-received": {
      const context = requiredValidationContext(event, "model response");
      const expectedMessage = expectedModelResponseMessage(event);
      state.pendingModelRequest = undefined;
      state.pendingModelResponse = {
        seq: event.seq,
        ...(expectedMessage === undefined ? {} : { expectedMessage }),
        ...context,
      };
      break;
    }
    case "tool/call": {
      const tool = state.openTools.get(event.data.call.id)!;
      tool.callRecorded = true;
      break;
    }
    case "tool/execution-started": {
      const tool = state.openTools.get(event.data.call.id)!;
      tool.executionStarted = true;
      break;
    }
    case "tool/result": {
      const tool = state.openTools.get(event.data.toolCallId)!;
      tool.resultModelContent = event.data.modelContent ?? serializeRecoveredToolResult(event);
      break;
    }
    case "message/appended":
      if (event.data.message.role === "assistant") {
        if (state.pendingModelResponse !== undefined) {
          state.pendingModelResponse = undefined;
        }
        for (const call of assistantMessageToolCalls(event.data.message)) {
          declareValidationOpenTool(state, call.id, call.name, event, call.args);
        }
      } else if (
        event.data.message.role === "tool"
        && event.data.message.toolCallId !== undefined
      ) {
        removeValidationOpenTool(
          state,
          event.data.message.toolCallId,
          event.data.message.toolName,
          event.data.message.content,
          event,
        );
      }
      break;
    default:
      break;
  }
}

function latestValidationOpenKey<T>(
  open: Map<string, T>,
  order: string[],
): string | undefined {
  while (order.length > 0) {
    const key = order.at(-1)!;
    if (open.has(key)) return key;
    order.pop();
  }
  return undefined;
}

function latestValidationOpen<T>(
  open: Map<string, T>,
  order: string[],
): T | undefined {
  const key = latestValidationOpenKey(open, order);
  return key === undefined ? undefined : open.get(key);
}

function adjustValidationCount(
  counts: Map<string, number>,
  key: string,
  delta: 1 | -1,
): void {
  const next = (counts.get(key) ?? 0) + delta;
  if (next <= 0) counts.delete(key);
  else counts.set(key, next);
}

function declareValidationOpenTool(
  state: SessionValidationState,
  callId: string,
  toolName: string,
  event: SessionEvent,
  args?: Record<string, unknown>,
): ValidationOpenTool {
  const context = requiredValidationContext(event, "assistant tool declaration");
  const tool: ValidationOpenTool = {
    orderSeq: event.seq,
    name: toolName,
    callRecorded: false,
    executionStarted: false,
    ...(args === undefined ? {} : { argsSha256: digestJson(args) }),
    ...context,
  };
  state.openTools.set(callId, tool);
  adjustValidationCount(state.openToolCountByTurn, tool.turnId, 1);
  adjustValidationCount(state.openToolCountByStep, tool.stepId, 1);
  return tool;
}

function assertValidationOpenToolCompatible(
  existing: ValidationOpenTool | undefined,
  callId: string,
  toolName: string,
  event: SessionEvent,
  args?: Record<string, unknown>,
): void {
  if (existing === undefined) return;
  if (existing.name !== toolName) {
    throw new SessionInvariantError(
      `tool call ${callId} changed name from ${existing.name} to ${toolName}`,
    );
  }
  if (existing.turnId !== event.turnId) {
    throw new SessionInvariantError(`tool call ${callId} crossed turn boundaries`);
  }
  if (existing.stepId !== event.stepId) {
    throw new SessionInvariantError(`tool call ${callId} crossed step boundaries`);
  }
  if (existing.runId !== event.runId) {
    throw new SessionInvariantError(`tool call ${callId} crossed run boundaries`);
  }
  if (existing.correlationId !== event.correlationId) {
    throw new SessionInvariantError(`tool call ${callId} crossed correlation boundaries`);
  }
  if (
    existing.argsSha256 !== undefined
    && args !== undefined
    && existing.argsSha256 !== digestJson(args)
  ) {
    throw new SessionInvariantError(`tool call ${callId} changed arguments`);
  }
}

function removeValidationOpenTool(
  state: SessionValidationState,
  callId: string,
  toolName?: string,
  modelContent?: ChatMessage["content"],
  event?: SessionEvent,
): void {
  const tool = state.openTools.get(callId);
  if (tool === undefined) return;
  if (toolName !== undefined && event !== undefined) {
    assertValidationOpenToolCompatible(tool, callId, toolName, event);
  }
  if (
    tool.resultModelContent !== undefined
    && modelContent !== tool.resultModelContent
  ) {
    throw new SessionInvariantError(
      `tool call ${callId} model-facing receipt does not match its durable result`,
    );
  }
  state.openTools.delete(callId);
  adjustValidationCount(state.openToolCountByTurn, tool.turnId, -1);
  adjustValidationCount(state.openToolCountByStep, tool.stepId, -1);
}

function clearValidationOpenWork(state: SessionValidationState): void {
  state.openTurns.clear();
  state.turnOrder.length = 0;
  state.openSteps.clear();
  state.stepOrder.length = 0;
  state.openTools.clear();
  state.pendingModelRequest = undefined;
  state.pendingModelResponse = undefined;
  state.modelRequestStepIds.clear();
  state.historyRollbackAllowedTurnIds.clear();
  state.historyRollbackAppliedTurnIds.clear();
  state.turnIdsWithStartedStep.clear();
  state.openStepCountByTurn.clear();
  state.openToolCountByTurn.clear();
  state.openToolCountByStep.clear();
}

const EVENT_TYPES: ReadonlySet<string> = new Set<SessionEventType>([
  "session/started",
  "history/replaced",
  "message/appended",
  "turn/started",
  "step/started",
  "model/request-prepared",
  "model/response-received",
  "adapter/state-updated",
  "adapter/state-cleared",
  "tool/call",
  "tool/execution-started",
  "tool/result",
  "step/completed",
  "turn/completed",
  "turn/failed",
  "turn/interrupted",
  "session/reset",
  "session/destroyed",
]);

function validateEventData(event: SessionEvent): void {
  if (!isPlainObject(event.data)) {
    throw new SessionInvariantError(`${event.type} data must be a JSON object`);
  }
  switch (event.type) {
    case "session/started":
      if (event.data.metadata !== undefined && !isPlainObject(event.data.metadata)) {
        throw new SessionInvariantError("session/started metadata must be an object");
      }
      if (event.data.metadata?.threadId !== undefined) {
        assertNonEmptyString(event.data.metadata.threadId, "session/started metadata.threadId");
      }
      break;
    case "history/replaced":
      assertMessages(event.data.history, "history/replaced history");
      assertOptionalString(event.data.reason, "history/replaced reason");
      if (event.data.threadId !== undefined) {
        assertNonEmptyString(event.data.threadId, "history/replaced threadId");
      }
      if (
        event.data.clearAdapterStates !== undefined
        && typeof event.data.clearAdapterStates !== "boolean"
      ) {
        throw new SessionInvariantError("history/replaced clearAdapterStates must be boolean");
      }
      if (event.data.recovered !== undefined && typeof event.data.recovered !== "boolean") {
        throw new SessionInvariantError("history/replaced recovered must be boolean");
      }
      if (event.data.recovered === true && event.data.reason !== "interrupted_turn_rolled_back") {
        throw new SessionInvariantError(
          "a recovered history replacement must be an interrupted turn rollback",
        );
      }
      break;
    case "message/appended":
      assertChatMessage(event.data.message, "message/appended message");
      break;
    case "turn/started":
      if (event.data.input !== undefined) assertChatMessage(event.data.input, "turn/started input");
      break;
    case "step/started":
      if (event.data.index !== undefined && (!Number.isSafeInteger(event.data.index) || event.data.index < 0)) {
        throw new SessionInvariantError("step/started index must be a non-negative safe integer");
      }
      break;
    case "model/request-prepared":
      assertModelHistoryReference(event.data.history);
      assertSha256(event.data.systemPromptSha256, "model/request-prepared systemPromptSha256");
      assertModelToolSnapshotReference(event.data.tools);
      if (event.data.adapter !== undefined) {
        if (!isPlainObject(event.data.adapter)) throw new SessionInvariantError("model request adapter must be an object");
        assertNonEmptyString(event.data.adapter.name, "model request adapter name");
        assertNonEmptyString(event.data.adapter.model, "model request adapter model");
      }
      break;
    case "adapter/state-updated":
      assertAdapterSessionState(event.data.state, "adapter/state-updated state");
      break;
    case "adapter/state-cleared":
      assertNonEmptyString(event.data.key, "adapter/state-cleared key");
      assertOptionalString(event.data.reason, "adapter/state-cleared reason");
      break;
    case "model/response-received":
      assertOptionalString(event.data.text, "model response text");
      if (event.data.toolCall !== undefined && event.data.toolCalls !== undefined) {
        throw new SessionInvariantError(
          "model response cannot contain both toolCall and toolCalls",
        );
      }
      if (event.data.toolCall !== undefined) assertToolCall(event.data.toolCall, "model response toolCall");
      if (event.data.toolCalls !== undefined) {
        if (!Array.isArray(event.data.toolCalls) || event.data.toolCalls.length === 0) {
          throw new SessionInvariantError("model response toolCalls must be a non-empty array");
        }
        const ids = new Set<string>();
        event.data.toolCalls.forEach((call, index) => {
          assertToolCall(call, `model response toolCalls[${index}]`);
          if (ids.has(call.id)) {
            throw new SessionInvariantError(`model response toolCalls contains duplicate id ${call.id}`);
          }
          ids.add(call.id);
        });
      }
      if (event.data.thinking !== undefined && !Array.isArray(event.data.thinking)) {
        throw new SessionInvariantError("model response thinking must be an array");
      }
      if (event.data.providerReplay !== undefined) {
        assertAdapterReplayPayload(event.data.providerReplay, "model response providerReplay");
      }
      if (event.data.continuationRecovery !== undefined) {
        assertAdapterContinuationRecovery(
          event.data.continuationRecovery,
          "model response continuationRecovery",
        );
      }
      break;
    case "tool/call":
    case "tool/execution-started":
      assertToolCall(event.data.call, `${event.type} call`);
      break;
    case "tool/result":
      assertNonEmptyString(event.data.toolCallId, "tool result call id");
      assertNonEmptyString(event.data.toolName, "tool result name");
      if (!(["succeeded", "failed", "unknown"] as string[]).includes(event.data.outcome)) {
        throw new SessionInvariantError(`invalid tool result outcome: ${String(event.data.outcome)}`);
      }
      assertOptionalString(event.data.error, "tool result error");
      assertOptionalString(event.data.modelContent, "tool result modelContent");
      if (event.data.recovered !== undefined && typeof event.data.recovered !== "boolean") {
        throw new SessionInvariantError("tool result recovered must be boolean");
      }
      break;
    case "step/completed":
      if (!(["completed", "failed", "interrupted"] as string[]).includes(event.data.outcome)) {
        throw new SessionInvariantError(`invalid step outcome: ${String(event.data.outcome)}`);
      }
      assertOptionalString(event.data.reason, "step completion reason");
      if (event.data.recovered !== undefined && typeof event.data.recovered !== "boolean") {
        throw new SessionInvariantError("step completion recovered must be boolean");
      }
      if (event.data.rollbackTurn !== undefined && typeof event.data.rollbackTurn !== "boolean") {
        throw new SessionInvariantError("step completion rollbackTurn must be boolean");
      }
      if (event.data.recovered === true) {
        if (event.data.outcome !== "interrupted") {
          throw new SessionInvariantError("a recovered step completion must be interrupted");
        }
        if (typeof event.data.rollbackTurn !== "boolean") {
          throw new SessionInvariantError("a recovered step completion must record rollbackTurn");
        }
      } else if (event.data.rollbackTurn !== undefined) {
        throw new SessionInvariantError("step completion rollbackTurn requires recovered=true");
      }
      break;
    case "turn/completed":
      assertOptionalString(event.data.reason, "turn completion reason");
      assertOptionalNonNegativeInteger(event.data.rounds, "turn completion rounds");
      assertOptionalString(event.data.finalText, "turn completion finalText");
      if (event.data.assistantTurnComplete !== undefined && typeof event.data.assistantTurnComplete !== "boolean") {
        throw new SessionInvariantError("turn completion assistantTurnComplete must be boolean");
      }
      assertOptionalString(event.data.runStatus, "turn completion runStatus");
      break;
    case "turn/failed":
      assertNonEmptyString(event.data.error, "turn failure error");
      assertOptionalNonNegativeInteger(event.data.rounds, "turn failure rounds");
      break;
    case "turn/interrupted":
      assertNonEmptyString(event.data.reason, "turn interruption reason");
      if (event.data.recovered !== undefined && typeof event.data.recovered !== "boolean") {
        throw new SessionInvariantError("turn interruption recovered must be boolean");
      }
      break;
    case "session/reset":
      assertOptionalString(event.data.reason, "session reset reason");
      if (event.data.threadId !== undefined) {
        assertNonEmptyString(event.data.threadId, "session reset threadId");
      }
      break;
    case "session/destroyed":
      assertOptionalString(event.data.reason, "session destroyed reason");
      break;
  }
}

function assertMessages(value: unknown, label: string): asserts value is ChatMessage[] {
  if (!Array.isArray(value)) throw new SessionInvariantError(`${label} must be an array`);
  value.forEach((message, index) => assertChatMessage(message, `${label}[${index}]`));
}

function assertChatMessage(value: unknown, label: string): asserts value is ChatMessage {
  if (!isPlainObject(value)) throw new SessionInvariantError(`${label} must be an object`);
  if (value.role !== "user" && value.role !== "assistant" && value.role !== "tool") {
    throw new SessionInvariantError(`${label}.role is invalid`);
  }
  if (typeof value.content !== "string") {
    if (!Array.isArray(value.content)) throw new SessionInvariantError(`${label}.content must be string or parts`);
    for (let index = 0; index < value.content.length; index += 1) {
      const part = value.content[index];
      if (!isPlainObject(part) || (part.type !== "text" && part.type !== "image")) {
        throw new SessionInvariantError(`${label}.content[${index}] is invalid`);
      }
      if (part.type === "text" && typeof part.text !== "string") {
        throw new SessionInvariantError(`${label}.content[${index}].text must be a string`);
      }
      if (part.type === "image") {
        assertNonEmptyString(part.mime, `${label}.content[${index}].mime`);
        assertOptionalString(part.dataUrl, `${label}.content[${index}].dataUrl`);
        assertOptionalString(part.path, `${label}.content[${index}].path`);
        if (part.detail !== undefined && !(["auto", "low", "high"] as string[]).includes(part.detail as string)) {
          throw new SessionInvariantError(`${label}.content[${index}].detail is invalid`);
        }
      }
    }
  }
  const hasToolCallId = value.toolCallId !== undefined;
  const hasToolName = value.toolName !== undefined;
  if (value.role === "user") {
    if (hasToolCallId || hasToolName || value.toolCalls !== undefined) {
      throw new SessionInvariantError(`${label} user message cannot contain tool-call fields`);
    }
    if (value.thinkingBlocks !== undefined || value.providerReplay !== undefined) {
      throw new SessionInvariantError(`${label} user message cannot contain provider replay fields`);
    }
  } else if (value.role === "tool") {
    assertNonEmptyString(value.toolCallId, `${label}.toolCallId`);
    assertNonEmptyString(value.toolName, `${label}.toolName`);
    if (value.toolCalls !== undefined) {
      throw new SessionInvariantError(`${label} tool message cannot contain assistant toolCalls`);
    }
    if (value.thinkingBlocks !== undefined || value.providerReplay !== undefined) {
      throw new SessionInvariantError(`${label} tool message cannot contain provider replay fields`);
    }
  } else {
    if (hasToolCallId !== hasToolName) {
      throw new SessionInvariantError(
        `${label} assistant single tool call requires both toolCallId and toolName`,
      );
    }
    if (hasToolCallId) {
      assertNonEmptyString(value.toolCallId, `${label}.toolCallId`);
      assertNonEmptyString(value.toolName, `${label}.toolName`);
    }
    if (value.toolCalls !== undefined) {
      if (hasToolCallId || hasToolName) {
        throw new SessionInvariantError(
          `${label} assistant message cannot contain both single and parallel tool calls`,
        );
      }
      if (!Array.isArray(value.toolCalls) || value.toolCalls.length === 0) {
        throw new SessionInvariantError(`${label}.toolCalls must be a non-empty array`);
      }
      const ids = new Set<string>();
      value.toolCalls.forEach((call, index) => {
        assertToolCall(call, `${label}.toolCalls[${index}]`);
        if (ids.has(call.id)) {
          throw new SessionInvariantError(`${label}.toolCalls contains duplicate id ${call.id}`);
        }
        ids.add(call.id);
      });
    }
    if (value.providerReplay !== undefined) {
      assertAdapterReplayPayload(value.providerReplay, `${label}.providerReplay`);
    }
  }
  if (value.thinkingBlocks !== undefined && !Array.isArray(value.thinkingBlocks)) {
    throw new SessionInvariantError(`${label}.thinkingBlocks must be an array`);
  }
}

function assertToolCall(value: unknown, label: string): asserts value is ToolCall {
  if (!isPlainObject(value)) throw new SessionInvariantError(`${label} must be an object`);
  assertNonEmptyString(value.id, `${label}.id`);
  assertNonEmptyString(value.name, `${label}.name`);
  if (!isPlainObject(value.args)) throw new SessionInvariantError(`${label}.args must be an object`);
}

function assertAdapterSessionState(value: unknown, label: string): asserts value is AdapterSessionState {
  if (!isPlainObject(value)) throw new SessionInvariantError(`${label} must be an object`);
  assertNonEmptyString(value.key, `${label}.key`);
  assertNonEmptyString(value.continuationId, `${label}.continuationId`);
  assertNonEmptyString(value.fingerprint, `${label}.fingerprint`);
  if (value.instructionsSha256 !== undefined) {
    assertSha256(value.instructionsSha256, `${label}.instructionsSha256`);
  }
}

function assertAdapterReplayPayload(value: unknown, label: string): asserts value is AdapterReplayPayload {
  if (!isPlainObject(value)) throw new SessionInvariantError(`${label} must be an object`);
  assertNonEmptyString(value.key, `${label}.key`);
  if (!Array.isArray(value.outputItems)) {
    throw new SessionInvariantError(`${label}.outputItems must be an array`);
  }
}

function assertAdapterContinuationRecovery(
  value: unknown,
  label: string,
): asserts value is AdapterContinuationRecovery {
  if (!isPlainObject(value)) throw new SessionInvariantError(`${label} must be an object`);
  if (value.reason !== "missing_or_expired") {
    throw new SessionInvariantError(`${label}.reason must be missing_or_expired`);
  }
  assertNonEmptyString(value.failedContinuationId, `${label}.failedContinuationId`);
}

function assertModelHistoryReference(value: unknown): asserts value is ModelHistoryReference {
  if (!isPlainObject(value)) {
    throw new SessionInvariantError("model/request-prepared history must be an object");
  }
  if (!Number.isSafeInteger(value.throughSeq) || (value.throughSeq as number) < 0) {
    throw new SessionInvariantError("model request history throughSeq must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(value.messageCount) || (value.messageCount as number) < 0) {
    throw new SessionInvariantError("model request history messageCount must be a non-negative safe integer");
  }
  assertSha256(value.sha256, "model request history sha256");
}

function assertModelToolSnapshotReference(value: unknown): asserts value is ModelToolSnapshotReference {
  if (!isPlainObject(value)) {
    throw new SessionInvariantError("model/request-prepared tools must be an object");
  }
  if (!Array.isArray(value.names)) {
    throw new SessionInvariantError("model request tool names must be an array");
  }
  let previous: string | undefined;
  for (let index = 0; index < value.names.length; index += 1) {
    const name = value.names[index];
    assertNonEmptyString(name, `model request tool names[${index}]`);
    if (previous !== undefined && previous >= name) {
      throw new SessionInvariantError("model request tool names must be sorted and unique");
    }
    previous = name;
  }
  assertSha256(value.sha256, "model request tools sha256");
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new SessionInvariantError(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertOptionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new SessionInvariantError(`${label} must be a string when present`);
  }
}

function assertOptionalNonNegativeInteger(value: unknown, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
    throw new SessionInvariantError(`${label} must be a non-negative safe integer when present`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SessionInvariantError(`${label} must be a non-empty string`);
  }
}

function assertIsoTimestamp(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new SessionInvariantError("event timestamp must be an ISO string");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new SessionInvariantError(`event timestamp is not canonical ISO-8601: ${value}`);
  }
}

function cloneJson(value: unknown, path: string, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SessionInvariantError(`${path} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new SessionInvariantError(`${path} contains non-JSON value ${typeof value}`);
  }
  if (typeof value !== "object") throw new SessionInvariantError(`${path} is not JSON-compatible`);
  if (ancestors.has(value)) throw new SessionInvariantError(`${path} contains a cycle`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new SessionInvariantError(`${path}[${index}] is a sparse array entry`);
        }
        result.push(cloneJson(value[index], `${path}[${index}]`, ancestors));
      }
      return result;
    }

    if (!isPlainObject(value)) {
      const name = Object.getPrototypeOf(value)?.constructor?.name ?? "unknown";
      throw new SessionInvariantError(`${path} contains non-JSON object ${name}`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new SessionInvariantError(`${path} contains symbol-keyed properties`);
    }

    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
        throw new SessionInvariantError(`${path}.${key} is an accessor property`);
      }
      const child = value[key];
      if (child === undefined) continue;
      Object.defineProperty(result, key, {
        value: cloneJson(child, `${path}.${key}`, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new SessionInvariantError("session event append made no progress");
    offset += written;
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

interface SessionFileLock {
  release(): void;
}

interface SessionLockOwner {
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
function acquireExclusiveLock(path: string, sessionId: string): SessionFileLock {
  const token = randomUUID();
  const claimPath = `${path}.${process.pid}.${token}.claim`;
  const lockDirectory = dirname(path);
  const owner: SessionLockOwner = { pid: process.pid, token };
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
          throw new SessionConcurrencyError(sessionId);
        }

        // Serialize stale-owner recovery. Without a separate gate, two
        // contenders can both observe the dead owner and one can unlink the
        // other's newly acquired lock after the lock path is reused.
        const reclaimGate = tryAcquireSessionReclaimGate(
          path,
          claimPath,
          sessionId,
          existing,
        );
        if (reclaimGate === undefined) {
          throw new SessionConcurrencyError(sessionId);
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
            throw new SessionInvariantError(
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

function tryAcquireSessionReclaimGate(
  lockPath: string,
  claimPath: string,
  sessionId: string,
  staleOwner: SessionLockOwner,
): SessionFileLock | undefined {
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
        throw new SessionInvariantError(
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

function readLockOwner(path: string): SessionLockOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionLockOwner>;
    if (!Number.isSafeInteger(parsed.pid) || (parsed.pid ?? 0) <= 0) return undefined;
    if (typeof parsed.token !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(parsed.token)) {
      return undefined;
    }
    return { pid: parsed.pid!, token: parsed.token };
  } catch {
    return undefined;
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
    const leftStat = statSync(left);
    const rightStat = statSync(right);
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
