import assert from "node:assert/strict";
import test from "node:test";
import { createPgStore, closePgPool, type PgStoreDatabase } from "../src/framework/pg-store.js";

function fixture() {
  const persisted = new Map<string, unknown>();
  const calls: string[] = [];
  let release: (() => void) | undefined;
  let fail = false;
  let gate: Promise<void> = Promise.resolve();
  const database: PgStoreDatabase = {
    async query(sql, values) {
      calls.push(sql);
      if (sql.startsWith("SELECT")) return { rows: [] };
      if (sql.startsWith("CREATE")) return { rows: [] };
      await gate;
      if (fail) throw new Error("injected write failure");
      if (sql.startsWith("INSERT")) persisted.set(String(values?.[0]), JSON.parse(String(values?.[1])));
      else if (values) persisted.delete(String(values[0]));
      else persisted.clear();
      return { rows: [] };
    },
  };
  return { database, persisted, calls,
    hold() { gate = new Promise<void>((resolve) => { release = resolve; }); },
    release() { release?.(); gate = Promise.resolve(); },
    fail() { fail = true; },
  };
}

test("PgStore flush waits for persistence and preserves sync Store API", async () => {
  const db = fixture();
  const store = await createPgStore<{ count: number }>("flush_fixture", { database: db.database });
  db.hold();
  store.set("one", { count: 1 });
  assert.deepEqual(store.get("one"), { count: 1 });
  assert.equal(db.persisted.size, 0);
  let flushed = false;
  const barrier = store.flush().then(() => { flushed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(flushed, false);
  db.release();
  await barrier;
  assert.deepEqual(db.persisted.get("one"), { count: 1 });
  await closePgPool();
});

test("PgStore persists ordered set/delete/clear operations", async () => {
  const db = fixture();
  const store = await createPgStore("ordered", { database: db.database });
  store.set("one", 1); store.delete("one"); store.set("two", 2); store.clear(); store.set("last", 3);
  await store.flush();
  assert.deepEqual([...db.persisted], [["last", 3]]);
  assert.deepEqual(db.calls.slice(2).map((sql) => sql.split(" ")[0]), ["INSERT", "DELETE", "INSERT", "DELETE", "INSERT"]);
  await closePgPool();
  assert.throws(() => store.set("closed", 4), /closed/);
});

test("PgStore flush and shutdown surface persistence errors", async () => {
  const db = fixture();
  const store = await createPgStore("failed", { database: db.database });
  db.fail(); store.set("one", 1);
  await assert.rejects(store.flush(), (error: unknown) =>
    error instanceof AggregateError && error.errors[0].message === "injected write failure");
  await assert.rejects(closePgPool(), /Postgres shutdown failed/);
  await closePgPool();
});

test("PgStore validates identifiers and JSON before acknowledging cache changes", async () => {
  const db = fixture();
  await assert.rejects(createPgStore('', { database: db.database }), /store name/);
  const store = await createPgStore<unknown>("valid", { database: db.database });
  assert.throws(() => store.set("bad", undefined), /JSON serializable/);
  assert.equal(store.has("bad"), false);
  await closePgPool();
});


test("PgStore initialization cannot register after concurrent shutdown", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const database: PgStoreDatabase = { async query() { await barrier; return { rows: [] }; } };
  const opening = createPgStore("initializing", { database });
  await closePgPool();
  release();
  await assert.rejects(opening, /shut down during store initialization/);
  await closePgPool();
});
