/**
 * OpenFunction — Postgres Store
 *
 * Same API as createStore() but backed by Postgres instead of JSON files.
 * Data loads into memory on startup, writes through to Postgres on every change.
 * Switching from JSON to Postgres is a one-line change:
 *
 *   // Before (JSON files):
 *   const tasks = createStore<Task>("tasks");
 *
 *   // After (Postgres):
 *   const tasks = await createPgStore<Task>("tasks");
 *
 * All your tool code stays exactly the same — get(), set(), getAll(), etc.
 *
 * Setup:
 *   1. Have Postgres running (local Docker, Cloud SQL, Supabase, Neon, etc.)
 *   2. Set DATABASE_URL:  export DATABASE_URL=postgres://user:pass@localhost:5432/mydb
 *   3. That's it — tables are created automatically
 *
 * Each store gets its own table (of_<name>) with two columns:
 *   - id    (text, primary key)
 *   - data  (jsonb, your tool's data)
 *
 * For a more production-grade approach with proper schemas, migrations,
 * and row-level security, see how ExecuFunction structures its database layer.
 */

import pg from "pg";
const { Pool } = pg;
import type { Store } from "./store.js";

// ─── Connection Pool (shared across all stores) ────────────────────────────

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL environment variable is required for Postgres stores.\n\n" +
          "Set it to your Postgres connection string:\n" +
          "  export DATABASE_URL=postgres://user:pass@localhost:5432/mydb\n\n" +
          "Quick options:\n" +
          "  - Local Docker:  docker run -e POSTGRES_PASSWORD=pass -p 5432:5432 postgres\n" +
          "  - Supabase:      https://supabase.com (free tier)\n" +
          "  - Neon:          https://neon.tech (free tier)\n" +
          "  - Google Cloud SQL, AWS RDS, etc.\n\n" +
          "Don't want a database? Use createStore() instead — it saves to JSON files."
      );
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

/**
 * Shut down the connection pool gracefully.
 * Call this when your server is shutting down (optional).
 */
export async function closePgPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ─── Store Factory ─────────────────────────────────────────────────────────

/**
 * Create a persistent store backed by Postgres.
 *
 * Same interface as createStore() — your tool code doesn't change.
 * The table is created automatically if it doesn't exist.
 * Data is loaded into memory on startup for fast reads, and written
 * through to Postgres on every set/delete for durability.
 *
 * @param name - Store name (becomes table "of_<name>", e.g. "tasks" → of_tasks)
 */
export async function createPgStore<T>(name: string): Promise<Store<T>> {
  const db = getPool();
  // Prefix with of_ to avoid collisions with existing tables
  const table = `of_${name.replace(/[^a-z0-9_]/gi, "_")}`;

  // Create table if it doesn't exist
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id    TEXT PRIMARY KEY,
      data  JSONB NOT NULL
    )
  `);

  // Load all existing data into memory
  const { rows } = await db.query<{ id: string; data: T }>(
    `SELECT id, data FROM ${table}`
  );
  const cache = new Map<string, T>(rows.map((r) => [r.id, r.data]));

  return {
    get(id: string): T | undefined {
      return cache.get(id);
    },

    set(id: string, value: T): void {
      cache.set(id, value);
      // Write through to Postgres (fire-and-forget for sync interface)
      db.query(
        `INSERT INTO ${table} (id, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = $2::jsonb`,
        [id, JSON.stringify(value)]
      ).catch((err) => {
        console.error(`PgStore(${name}): write failed for "${id}":`, err.message);
      });
    },

    delete(id: string): boolean {
      const existed = cache.delete(id);
      if (existed) {
        db.query(`DELETE FROM ${table} WHERE id = $1`, [id]).catch((err) => {
          console.error(`PgStore(${name}): delete failed for "${id}":`, err.message);
        });
      }
      return existed;
    },

    getAll(): T[] {
      return Array.from(cache.values());
    },

    entries(): [string, T][] {
      return Array.from(cache.entries());
    },

    get size(): number {
      return cache.size;
    },

    has(id: string): boolean {
      return cache.has(id);
    },

    clear(): void {
      cache.clear();
      db.query(`DELETE FROM ${table}`).catch((err) => {
        console.error(`PgStore(${name}): clear failed:`, err.message);
      });
    },
  };
}
