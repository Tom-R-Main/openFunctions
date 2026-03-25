/**
 * OpenFunction — Memory System
 *
 * Two types of memory, both backed by the existing Store interface:
 *
 * 1. Conversation Memory — stores message threads by ID
 * 2. Fact Memory — stores extracted facts across sessions
 *
 * Both default to JSON file persistence. Pass createPgStore() for Postgres.
 *
 * @example
 * ```ts
 * const conversations = createConversationMemory();
 * const facts = createFactMemory();
 *
 * // Register AI-callable memory tools
 * registry.registerAll(createMemoryTools(conversations, facts));
 * ```
 */

import type { ChatMessage } from "./adapters/types.js";
import type { ToolDefinition } from "./types.js";
import type { Store } from "./store.js";
import { createStore } from "./store.js";
import { defineTool, ok, err } from "./tool.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Thread {
  id: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface Fact {
  id: string;
  content: string;
  source?: string;
  tags?: string[];
  createdAt: string;
}

export interface ConversationMemory {
  getThread(threadId: string): Thread;
  addMessage(threadId: string, message: ChatMessage): void;
  getRecent(threadId: string, count: number): ChatMessage[];
  listThreads(): string[];
  deleteThread(threadId: string): boolean;
  clear(): void;
}

export interface FactMemory {
  storeFact(content: string, source?: string, tags?: string[]): Fact;
  recallFacts(query: string, limit?: number): Fact[];
  getAllFacts(): Fact[];
  deleteFact(id: string): boolean;
  clear(): void;
}

// ─── Conversation Memory ────────────────────────────────────────────────────

/**
 * Create a conversation memory that persists message threads.
 *
 * @param store - Optional custom store. Defaults to JSON file store.
 */
export function createConversationMemory(
  store?: Store<Thread>,
): ConversationMemory {
  const threads = store ?? createStore<Thread>("threads");

  return {
    getThread(threadId: string): Thread {
      const existing = threads.get(threadId);
      if (existing) return existing;

      const thread: Thread = {
        id: threadId,
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      threads.set(threadId, thread);
      return thread;
    },

    addMessage(threadId: string, message: ChatMessage): void {
      const thread = this.getThread(threadId);
      const updated = {
        ...thread,
        messages: [...thread.messages, message],
        updatedAt: new Date().toISOString(),
      };
      threads.set(threadId, updated);
    },

    getRecent(threadId: string, count: number): ChatMessage[] {
      const thread = threads.get(threadId);
      if (!thread) return [];
      return thread.messages.slice(-count);
    },

    listThreads(): string[] {
      return threads.getAll().map((t) => t.id);
    },

    deleteThread(threadId: string): boolean {
      return threads.delete(threadId);
    },

    clear(): void {
      threads.clear();
    },
  };
}

// ─── Fact Memory ────────────────────────────────────────────────────────────

/**
 * Create a long-term fact memory that persists across sessions.
 * Facts are simple key-value entries with optional tags for filtering.
 * Search is substring-based — a future RAG module can swap in vector search
 * via the same FactMemory interface.
 *
 * @param store - Optional custom store. Defaults to JSON file store.
 */
export function createFactMemory(store?: Store<Fact>): FactMemory {
  const facts = store ?? createStore<Fact>("facts");
  let nextId = facts.size + 1;

  return {
    storeFact(content: string, source?: string, tags?: string[]): Fact {
      const id = String(nextId++);
      const fact: Fact = {
        id,
        content,
        source,
        tags,
        createdAt: new Date().toISOString(),
      };
      facts.set(id, fact);
      return fact;
    },

    recallFacts(query: string, limit = 10): Fact[] {
      const q = query.toLowerCase();
      return facts
        .getAll()
        .filter(
          (f) =>
            f.content.toLowerCase().includes(q) ||
            f.tags?.some((t) => t.toLowerCase().includes(q)),
        )
        .slice(0, limit);
    },

    getAllFacts(): Fact[] {
      return facts.getAll();
    },

    deleteFact(id: string): boolean {
      return facts.delete(id);
    },

    clear(): void {
      facts.clear();
      nextId = 1;
    },
  };
}

// ─── Memory Tools (AI-Callable) ─────────────────────────────────────────────

/**
 * Generate tool definitions that let the AI manage memory via tool calls.
 * Register these with the registry to give the AI memory capabilities.
 */
export function createMemoryTools(
  conversations: ConversationMemory,
  factMemory: FactMemory,
): ToolDefinition<any, any>[] {
  const storeFact = defineTool<{ content: string; source?: string; tags?: string[] }>({
    name: "store_fact",
    description:
      "Store a fact for long-term memory. Use this when the user shares " +
      "important information you should remember across conversations.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The fact to remember" },
        source: { type: "string", description: "Where this fact came from (optional)" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization (optional)",
        },
      },
      required: ["content"],
    },
    handler: async ({ content, source, tags }) => {
      const fact = factMemory.storeFact(content, source, tags);
      return ok(fact, `Stored fact: "${content}"`);
    },
  });

  const recallFacts = defineTool<{ query: string; limit?: number }>({
    name: "recall_facts",
    description:
      "Search long-term memory for stored facts. Use this when you need to " +
      "recall something the user told you previously.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term to match against stored facts" },
        limit: { type: "integer", description: "Max results to return (default 10)" },
      },
      required: ["query"],
    },
    handler: async ({ query, limit }) => {
      const results = factMemory.recallFacts(query, limit);
      return ok(
        { facts: results, total: results.length },
        `Found ${results.length} fact${results.length === 1 ? "" : "s"} matching "${query}"`,
      );
    },
  });

  const listThreads = defineTool<Record<string, never>>({
    name: "list_threads",
    description: "List all conversation thread IDs in memory.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const threads = conversations.listThreads();
      return ok({ threads, total: threads.length });
    },
  });

  const getThread = defineTool<{ thread_id: string; count?: number }>({
    name: "get_thread",
    description: "Get recent messages from a conversation thread.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "Thread ID" },
        count: { type: "integer", description: "Number of recent messages (default 20)" },
      },
      required: ["thread_id"],
    },
    handler: async ({ thread_id, count }) => {
      const messages = conversations.getRecent(thread_id, count ?? 20);
      return ok({ messages, total: messages.length });
    },
  });

  return [storeFact, recallFacts, listThreads, getThread];
}
