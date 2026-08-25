/**
 * OpenFunction — Memory System
 *
 * Two types of memory, both backed by the existing Store interface:
 *
 * 1. Conversation Memory — stores message threads by ID
 * 2. Fact Memory — stores extracted facts across sessions
 *
 * Both default to JSON file persistence. Legacy stores without atomic mutate()
 * remain usable in one writer, but cannot back a durable session projection.
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

import { randomUUID } from "node:crypto";
import type { ChatMessage } from "./adapters/types.js";
import type { ToolDefinition } from "./types.js";
import type { Store, StoreMutation } from "./store.js";
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
  /** Optional batch extension implemented by journal-aware memory stores. */
  addMessages?(threadId: string, messages: ChatMessage[]): void;
  /** Optional projection extension implemented by journal-aware memory stores. */
  replaceMessages?(threadId: string, messages: ChatMessage[]): void;
  getRecent(threadId: string, count: number): ChatMessage[];
  listThreads(): string[];
  deleteThread(threadId: string): boolean;
  clear(): void;
}

export interface JournalConversationMemory extends ConversationMemory {
  /** Whether read-check-write projection updates are atomic across writers. */
  readonly atomicMutations: boolean;
  /** Persist one completed turn with a single backing-store write. */
  addMessages(threadId: string, messages: ChatMessage[]): void;
  /** Replace a thread projection from authoritative journal history in one write. */
  replaceMessages(threadId: string, messages: ChatMessage[]): void;
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
): JournalConversationMemory {
  const threads = store ?? createStore<Thread>("threads");
  const knownSnapshots = new Map<string, string>();

  const remember = (threadId: string, messages: ChatMessage[]): void => {
    knownSnapshots.set(threadId, JSON.stringify(messages));
  };

  const mutateThread = <R>(
    threadId: string,
    mutation: (current: Thread | undefined) => StoreMutation<Thread, R>,
  ): R => {
    if (threads.mutate) return threads.mutate(threadId, mutation);

    // Backward compatibility for custom Store implementations created before
    // atomic mutation existed. Synchronous in-process stores cannot interleave
    // between these calls, while createStore() takes the atomic path above.
    const outcome = mutation(threads.get(threadId));
    switch (outcome.action) {
      case "set":
        threads.set(threadId, outcome.value);
        break;
      case "delete":
        threads.delete(threadId);
        break;
      case "unchanged":
        break;
    }
    return outcome.result;
  };

  return {
    atomicMutations: threads.mutate !== undefined,

    getThread(threadId: string): Thread {
      const thread = mutateThread(threadId, (existing) => {
        if (existing) return { action: "unchanged", result: existing };
        const now = new Date().toISOString();
        const created: Thread = {
          id: threadId,
          messages: [],
          createdAt: now,
          updatedAt: now,
        };
        return { action: "set", value: created, result: created };
      });
      remember(threadId, thread.messages);
      return thread;
    },

    addMessage(threadId: string, message: ChatMessage): void {
      this.addMessages(threadId, [message]);
    },

    addMessages(threadId: string, messages: ChatMessage[]): void {
      const now = new Date().toISOString();
      const updated = mutateThread(threadId, (thread) => {
        const current = thread ?? {
          id: threadId,
          messages: [],
          createdAt: now,
          updatedAt: now,
        };
        const next = {
          ...current,
          messages: [...current.messages, ...messages],
          updatedAt: now,
        };
        return { action: "set", value: next, result: next };
      });
      remember(threadId, updated.messages);
    },

    replaceMessages(threadId: string, messages: ChatMessage[]): void {
      const now = new Date().toISOString();
      const desiredSnapshot = JSON.stringify(messages);
      const knownSnapshot = knownSnapshots.get(threadId);
      mutateThread(threadId, (thread) => {
        const currentMessages = thread?.messages ?? [];
        const currentSnapshot = JSON.stringify(currentMessages);
        if (currentSnapshot !== knownSnapshot && currentSnapshot !== desiredSnapshot) {
          // An empty journal projection is an explicit clear, not merely a
          // prefix of whatever compatibility history happens to be persisted.
          // A fresh ConversationMemory has no optimistic-concurrency baseline,
          // so its authoritative clear must replace stale storage. Once this
          // instance has observed a snapshot, however, reject a concurrent
          // change rather than erasing another writer's messages.
          if (knownSnapshot === undefined) {
            if (messages.length > 0 && isMessagePrefix(messages, currentMessages)) {
              return { action: "unchanged", result: undefined };
            }
            if (messages.length > 0 && !isMessagePrefix(currentMessages, messages)) {
              throw new Error(`Conversation thread "${threadId}" changed concurrently`);
            }
          } else {
            const knownMessages = JSON.parse(knownSnapshot) as ChatMessage[];
            if (
              messages.length === 0
              || !isMessagePrefix(knownMessages, currentMessages)
            ) {
              throw new Error(`Conversation thread "${threadId}" changed concurrently`);
            }
            if (isMessagePrefix(messages, currentMessages)) {
              return { action: "unchanged", result: undefined };
            }
            if (!isMessagePrefix(currentMessages, messages)) {
              throw new Error(`Conversation thread "${threadId}" changed concurrently`);
            }
          }
        }
        const updated = {
          ...thread,
          id: threadId,
          messages: [...messages],
          createdAt: thread?.createdAt ?? now,
          updatedAt: now,
        };
        return { action: "set", value: updated, result: undefined };
      });
      // Keep the optimistic baseline aligned with the journal projection this
      // caller supplied. When a longer concurrent extension is preserved,
      // treating that extension as this writer's baseline would let a repeated
      // stale projection erase it on the next call.
      remember(threadId, messages);
    },

    getRecent(threadId: string, count: number): ChatMessage[] {
      const thread = threads.get(threadId);
      if (!thread) return [];
      remember(threadId, thread.messages);
      return thread.messages.slice(-count);
    },

    listThreads(): string[] {
      return threads.getAll().map((t) => t.id);
    },

    deleteThread(threadId: string): boolean {
      const deleted = threads.delete(threadId);
      if (deleted) knownSnapshots.delete(threadId);
      return deleted;
    },

    clear(): void {
      threads.clear();
      knownSnapshots.clear();
    },
  };
}

function isMessagePrefix(prefix: ChatMessage[], whole: ChatMessage[]): boolean {
  if (prefix.length > whole.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (JSON.stringify(prefix[index]) !== JSON.stringify(whole[index])) return false;
  }
  return true;
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

  return {
    storeFact(content: string, source?: string, tags?: string[]): Fact {
      // UUIDs avoid the size+1 collision: after deletes (or after a
      // process restart with a partially-pruned store) the old counter
      // would silently overwrite an existing fact.
      const id = randomUUID();
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
    },
  };
}

// ─── Memory Tools (AI-Callable) ─────────────────────────────────────────────

/**
 * Generate tool definitions that let the AI manage memory via tool calls.
 * Register these with the registry to give the AI memory capabilities.
 */
export function createMemoryTools(
  conversations?: ConversationMemory,
  factMemory?: FactMemory,
): ToolDefinition<any, any>[] {
  const storeFact = factMemory === undefined ? undefined : defineTool<{ content: string; source?: string; tags?: string[] }>({
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

  const recallFacts = factMemory === undefined ? undefined : defineTool<{ query: string; limit?: number }>({
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

  const listThreads = conversations === undefined ? undefined : defineTool<Record<string, never>>({
    name: "list_threads",
    description: "List all conversation thread IDs in memory.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const threads = conversations.listThreads();
      return ok({ threads, total: threads.length });
    },
  });

  const getThread = conversations === undefined ? undefined : defineTool<{ thread_id: string; count?: number }>({
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

  return [storeFact, recallFacts, listThreads, getThread].filter(
    (tool): tool is ToolDefinition<any, any> => tool !== undefined,
  );
}
