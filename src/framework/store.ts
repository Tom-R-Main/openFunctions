/**
 * OpenFunction — Persistent Store
 *
 * A dead-simple JSON file store that works like a Map but persists to disk.
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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve project root (two levels up from src/framework/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, "..", "..", ".data");

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
}

/**
 * Create a persistent store that saves to .data/<name>.json
 *
 * Works just like a Map, but data survives server restarts.
 *
 * @param name - Store name (used as the filename, e.g. "tasks" → .data/tasks.json)
 */
export function createStore<T>(name: string): Store<T> {
  const filePath = join(DATA_DIR, `${name}.json`);

  // Ensure .data directory exists
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  // Load existing data or start empty
  let data: Map<string, T>;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, T>;
    data = new Map(Object.entries(parsed));
  } catch {
    data = new Map();
  }

  function save() {
    const obj = Object.fromEntries(data);
    writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n");
  }

  return {
    get(id: string): T | undefined {
      return data.get(id);
    },

    set(id: string, value: T): void {
      data.set(id, value);
      save();
    },

    delete(id: string): boolean {
      const existed = data.delete(id);
      if (existed) save();
      return existed;
    },

    getAll(): T[] {
      return Array.from(data.values());
    },

    entries(): [string, T][] {
      return Array.from(data.entries());
    },

    get size(): number {
      return data.size;
    },

    has(id: string): boolean {
      return data.has(id);
    },

    clear(): void {
      data.clear();
      save();
    },
  };
}
