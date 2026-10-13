/** Optional Postgres cache with ordered asynchronous persistence.
 * Sync mutations update the local cache; await flush() to acknowledge queued
 * database writes. This is not a distributed atomic store or event journal.
 */
import type pg from "pg";
import type { Store } from "./store.js";

/** Small injectable database boundary for deterministic persistence checks. */
export interface PgStoreDatabase {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface PgStoreOptions {
  /** Caller-owned database connection; the shared pool is not initialized. */
  database?: PgStoreDatabase;
}

export interface PgStore<T> extends Store<T> {
  /** Wait for writes queued before this call; rejects on any persistence failure. */
  flush(): Promise<void>;
}

let poolPromise: Promise<pg.Pool> | undefined;
let closing: Promise<void> | undefined;
let poolEpoch = 0;
const stores = new Set<{ flush(): Promise<void>; close(): void }>();

async function getPool(): Promise<pg.Pool> {
  if (closing) throw new Error("Postgres pool is shutting down");
  if (!poolPromise) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required for Postgres stores. Set it to your Postgres connection string, or use createStore() for JSON files.");
    }
    const initialization = import("pg").then(({ default: driver }) =>
      new driver.Pool({ connectionString }),
    ).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error
          && error.code === "ERR_MODULE_NOT_FOUND"
          && error instanceof Error && error.message.includes("'pg'")) {
        throw new Error("Postgres stores require the optional pg package. Install pg before using createPgStore().", { cause: error });
      }
      throw error;
    });
    poolPromise = initialization;
    initialization.catch(() => {
      if (poolPromise === initialization) poolPromise = undefined;
    });
  }
  return poolPromise;
}

/** Flush queued writes and close the shared pool. Does not import pg if unused.
 * Persistence errors remain visible here even when a previous flush observed them.
 */
export function closePgPool(): Promise<void> {
  if (closing) return closing;
  poolEpoch += 1;
  const active = [...stores];
  for (const store of active) store.close();
  const currentPool = poolPromise;
  const shutdown = (async () => {
    const errors: unknown[] = [];
    const flushed = await Promise.allSettled(active.map((store) => store.flush()));
    for (const result of flushed) if (result.status === "rejected") errors.push(result.reason);
    if (currentPool) {
      try { await (await currentPool).end(); } catch (error) { errors.push(error); }
    }
    for (const store of active) stores.delete(store);
    if (poolPromise === currentPool) poolPromise = undefined;
    if (errors.length) throw new AggregateError(errors, "Postgres shutdown failed");
  })();
  closing = shutdown;
  // Handle cleanup without creating a second unhandled rejected promise.
  shutdown.then(() => { closing = undefined; }, () => { closing = undefined; });
  return shutdown;
}

/** Create a cache backed by Postgres. Sync API stays compatible with Store.
 * All changes are serialized in call order. await flush() before reporting a
 * durable success, and do not use this cache for work or conversation journals.
 */
export async function createPgStore<T>(
  name: string,
  options: PgStoreOptions = {},
): Promise<PgStore<T>> {
  if (closing) throw new Error("Postgres pool is shutting down");
  if (typeof name !== "string" || !name) {
    throw new Error("Postgres store name must be non-empty");
  }
  const startupEpoch = poolEpoch;
  const db = options.database ?? await getPool();
  // Preserve legacy punctuation normalization and PostgreSQL case folding.
  // Quote the sanitized identifier so it cannot alter the SQL statement.
  const table = `"of_${name.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}"`;
  await db.query(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data JSONB NOT NULL)`);
  const { rows } = await db.query<{ id: string; data: T }>(`SELECT id, data FROM ${table}`);
  if (closing || startupEpoch !== poolEpoch) throw new Error("Postgres pool shut down during store initialization");
  const cache = new Map<string, T>(rows.map((row) => [row.id, row.data]));
  const errors: unknown[] = [];
  let tail: Promise<void> = Promise.resolve();
  let closed = false;
  function assertOpen(): void {
    if (closed) throw new Error(`PgStore(${name}) has been closed`);
  }
  function enqueue(sql: string, values?: unknown[]): void {
    tail = tail.then(async () => {
      try { await db.query(sql, values); } catch (error) { errors.push(error); }
    });
  }
  async function flush(): Promise<void> {
    const boundary = tail;
    await boundary;
    if (errors.length) throw new AggregateError([...errors], `PgStore(${name}) persistence failed`);
  }
  stores.add({ flush, close: () => { closed = true; } });
  return {
    get: (id) => cache.get(id),
    set(id, value) {
      assertOpen();
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new Error("Postgres store values must be JSON serializable");
      cache.set(id, value);
      enqueue(`INSERT INTO ${table} (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = $2::jsonb`, [id, serialized]);
    },
    delete(id) {
      assertOpen();
      const existed = cache.delete(id);
      if (existed) enqueue(`DELETE FROM ${table} WHERE id = $1`, [id]);
      return existed;
    },
    getAll: () => [...cache.values()],
    entries: () => [...cache.entries()],
    get size() { return cache.size; },
    has: (id) => cache.has(id),
    clear() {
      assertOpen();
      cache.clear();
      enqueue(`DELETE FROM ${table}`);
    },
    flush,
  };
}
