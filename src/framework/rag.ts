/**
 * OpenFunction — RAG (Retrieval-Augmented Generation)
 *
 * Add document memory to your AI tools. Documents are chunked, embedded,
 * stored in pgvector, and retrieved via cosine similarity search.
 *
 * Requires:
 *   - DATABASE_URL (Postgres with pgvector extension)
 *   - GEMINI_API_KEY or OPENAI_API_KEY (for embeddings)
 *
 * @example
 * ```ts
 * const rag = await createRAG({ embeddingProvider: "gemini" });
 *
 * // Add documents
 * await rag.addDocument("Biology Chapter 5: Mitosis is the process of...");
 * await rag.addDocument("Chemistry Notes: Covalent bonds share electrons...");
 *
 * // Search
 * const results = await rag.search("How does cell division work?");
 * // → [{ content: "Mitosis is the process of...", distance: 0.12 }]
 *
 * // Generate AI-callable tools
 * registry.registerAll(rag.createTools());
 * ```
 */

import pg from "pg";
const { Pool } = pg;
import type { ToolDefinition } from "./types.js";
import { defineTool, ok, err } from "./tool.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RAGOptions {
  /** Which API to use for embeddings: "gemini" or "openai" */
  embeddingProvider: "gemini" | "openai";
  /** Postgres connection string (defaults to DATABASE_URL env var) */
  databaseUrl?: string;
  /** Embedding dimensions (default: 768 for Gemini, 1536 for OpenAI) */
  dimensions?: number;
  /** Max characters per chunk (default: 1000) */
  chunkSize?: number;
  /** Overlap characters between chunks (default: 200) */
  chunkOverlap?: number;
  /** Table name prefix (default: "of_rag") */
  tablePrefix?: string;
}

export interface RAGDocument {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface RAGChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  createdAt: string;
}

export interface RAGSearchResult {
  content: string;
  distance: number;
  documentId: string;
  chunkIndex: number;
}

export interface RAG {
  /** Add a document — automatically chunks and embeds it */
  addDocument(content: string, metadata?: Record<string, unknown>): Promise<RAGDocument>;
  /** Search for relevant chunks by semantic similarity */
  search(query: string, limit?: number): Promise<RAGSearchResult[]>;
  /** Get all documents (without embeddings) */
  listDocuments(): Promise<RAGDocument[]>;
  /** Delete a document and its chunks */
  deleteDocument(id: string): Promise<boolean>;
  /** Generate AI-callable tools for add_document, search_documents */
  createTools(): ToolDefinition<any, any>[];
  /** Shut down the connection pool */
  close(): Promise<void>;
}

// ─── Embedding Providers ────────────────────────────────────────────────────

async function embedGemini(text: string, taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY", dims: number): Promise<number[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY required for Gemini embeddings");

  const model = "gemini-embedding-2-preview";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${model}`,
      content: { parts: [{ text: text.slice(0, 15000) }] },
      taskType,
      outputDimensionality: dims,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini embedding error (${response.status}): ${error}`);
  }

  const data = await response.json();
  return data.embedding?.values as number[];
}

async function embedOpenAI(text: string, dims: number): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY required for OpenAI embeddings");

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text.slice(0, 15000),
      dimensions: dims,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI embedding error (${response.status}): ${error}`);
  }

  const data = await response.json();
  return data.data[0].embedding as number[];
}

// ─── Text Chunking ──────────────────────────────────────────────────────────

/**
 * Split text into overlapping chunks using sentence boundaries.
 * Derived from ExecuFunction's semantic chunking strategy.
 */
function chunkText(text: string, maxChars: number, overlapChars: number): string[] {
  // Split into sentences
  const sentences = text.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) ?? [text];
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    if (currentLen + trimmed.length > maxChars && current.length > 0) {
      // Emit current chunk
      chunks.push(current.join(" ").trim());

      // Overlap: carry forward last sentences that fit within overlapChars
      const overlap: string[] = [];
      let overlapLen = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        overlapLen += current[i].length;
        if (overlapLen > overlapChars) break;
        overlap.unshift(current[i]);
      }
      current = [...overlap];
      currentLen = overlap.reduce((sum, s) => sum + s.length, 0);
    }

    current.push(trimmed);
    currentLen += trimmed.length;
  }

  if (current.length > 0) {
    chunks.push(current.join(" ").trim());
  }

  return chunks.length > 0 ? chunks : [text];
}

// ─── Vector Helpers ─────────────────────────────────────────────────────────

function toPgVector(values: number[]): string {
  return `[${values.join(",")}]`;
}

// ─── RAG Factory ────────────────────────────────────────────────────────────

/**
 * Create a RAG instance backed by pgvector.
 *
 * Automatically creates tables and indexes if they don't exist.
 * Supports Gemini (768-dim) or OpenAI (1536-dim) embeddings.
 */
export async function createRAG(options: RAGOptions): Promise<RAG> {
  const {
    embeddingProvider,
    databaseUrl = process.env.DATABASE_URL,
    chunkSize = 1000,
    chunkOverlap = 200,
    tablePrefix = "of_rag",
  } = options;

  // Gemini Embedding 2 supports 3072 (default), 1536, 768 via Matryoshka
  // OpenAI text-embedding-3-small supports up to 1536
  const dimensions = options.dimensions ?? (embeddingProvider === "gemini" ? 768 : 1536);

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL required for RAG.\n" +
        "Set it to your Postgres connection string with pgvector enabled.\n" +
        "Quick setup: docker run -e POSTGRES_PASSWORD=pass -p 5432:5432 pgvector/pgvector:pg16"
    );
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const docsTable = `${tablePrefix}_documents`;
  const chunksTable = `${tablePrefix}_chunks`;

  // Embed function based on provider — passes user-configured dimensions through
  async function embed(text: string, taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"): Promise<number[]> {
    if (embeddingProvider === "gemini") {
      return embedGemini(text, taskType, dimensions);
    }
    return embedOpenAI(text, dimensions);
  }

  // ── Initialize schema ─────────────────────────────────────────────────
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${docsTable} (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${chunksTable} (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES ${docsTable}(id) ON DELETE CASCADE,
      chunk_index INT NOT NULL,
      content TEXT NOT NULL,
      embedding vector(${dimensions}),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(document_id, chunk_index)
    )
  `);

  // Create HNSW index for vector similarity search
  // HNSW works with any number of rows (unlike IVFFlat which needs data to build clusters)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${chunksTable}_embedding_idx
      ON ${chunksTable} USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)
  `);

  let nextDocId = 1;
  const countResult = await pool.query(`SELECT COUNT(*) FROM ${docsTable}`);
  nextDocId = parseInt(countResult.rows[0].count) + 1;

  // ── RAG Implementation ────────────────────────────────────────────────

  async function addDocumentFn(content: string, metadata?: Record<string, unknown>): Promise<RAGDocument> {
    const id = String(nextDocId++);
    const doc: RAGDocument = {
      id,
      content,
      metadata,
      createdAt: new Date().toISOString(),
    };

    await pool.query(
      `INSERT INTO ${docsTable} (id, content, metadata) VALUES ($1, $2, $3::jsonb)`,
      [id, content, metadata ? JSON.stringify(metadata) : null],
    );

    const chunks = chunkText(content, chunkSize, chunkOverlap);
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = `${id}-${i}`;
      const embedding = await embed(chunks[i], "RETRIEVAL_DOCUMENT");

      await pool.query(
        `INSERT INTO ${chunksTable} (id, document_id, chunk_index, content, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)`,
        [chunkId, id, i, chunks[i], toPgVector(embedding)],
      );
    }

    console.log(`📄 Added document "${id}" (${chunks.length} chunk${chunks.length === 1 ? "" : "s"})`);
    return doc;
  }

  async function searchFn(query: string, limit = 5): Promise<RAGSearchResult[]> {
    const queryEmbedding = await embed(query, "RETRIEVAL_QUERY");

    const client = await pool.connect();
    try {
      const { rows } = await client.query<{
        content: string;
        distance: number;
        document_id: string;
        chunk_index: number;
      }>(
        `SELECT
          content,
          embedding <=> $1::vector AS distance,
          document_id,
          chunk_index
        FROM ${chunksTable}
        WHERE embedding IS NOT NULL
        ORDER BY distance ASC
        LIMIT $2`,
        [toPgVector(queryEmbedding), limit],
      );

      return rows.map((r) => ({
        content: r.content,
        distance: parseFloat(String(r.distance)),
        documentId: r.document_id,
        chunkIndex: r.chunk_index,
      }));
    } finally {
      client.release();
    }
  }

  async function listDocumentsFn(): Promise<RAGDocument[]> {
    const { rows } = await pool.query(
      `SELECT id, content, metadata, created_at FROM ${docsTable} ORDER BY created_at DESC`,
    );
    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      metadata: r.metadata,
      createdAt: r.created_at,
    }));
  }

  async function deleteDocumentFn(id: string): Promise<boolean> {
    const { rowCount } = await pool.query(`DELETE FROM ${docsTable} WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  function createToolsFn(): ToolDefinition<any, any>[] {
    const addDoc = defineTool<{ content: string; title?: string }>({
      name: "add_document",
      description:
        "Add a document to the knowledge base for later retrieval. " +
        "The document is automatically chunked, embedded, and indexed for semantic search.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "The document text to store" },
          title: { type: "string", description: "Optional title for the document" },
        },
        required: ["content"],
      },
      handler: async ({ content, title }) => {
        const doc = await addDocumentFn(content, title ? { title } : undefined);
        return ok(doc, `Added document with ${chunkText(content, chunkSize, chunkOverlap).length} chunks`);
      },
    });

    const searchDocs = defineTool<{ query: string; limit?: number }>({
      name: "search_documents",
      description:
        "Search the knowledge base for relevant information using semantic similarity. " +
        "Returns the most relevant document chunks matching the query.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for" },
          limit: { type: "integer", description: "Max results to return (default 5)" },
        },
        required: ["query"],
      },
      handler: async ({ query, limit }) => {
        const results = await searchFn(query, limit);
        return ok(
          { results, total: results.length },
          `Found ${results.length} relevant chunk${results.length === 1 ? "" : "s"}`,
        );
      },
    });

    return [addDoc, searchDocs];
  }

  return {
    addDocument: addDocumentFn,
    search: searchFn,
    listDocuments: listDocumentsFn,
    deleteDocument: deleteDocumentFn,
    createTools: createToolsFn,
    close: async () => { await pool.end(); },
  };
}
