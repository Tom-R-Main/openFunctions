# RAG

openFunctions RAG is an advanced module for semantic document retrieval. It is built from the same runtime ideas as the rest of the framework:

1. ingest documents
2. chunk them semantically
3. embed the chunks
4. store vectors in pgvector
5. search by cosine similarity
6. optionally expose retrieval back to the AI as tools

RAG is not the core primitive of the framework. It is a tool-wrapped subsystem built on top of the core runtime.

## What It Provides

`createRAG()` returns an object with:

- `addDocument(content, metadata?)`
- `search(query, limit?)`
- `listDocuments()`
- `deleteDocument(id)`
- `createTools()`
- `close()`

The default storage shape is:

- `${tablePrefix}_documents` for source documents
- `${tablePrefix}_chunks` for chunk text plus vector embeddings

## Initialization

`createRAG()` bootstraps Postgres for vector search:

1. creates a connection pool
2. enables the `vector` extension
3. creates the documents table
4. creates the chunks table with `embedding vector(dimensions)`
5. creates an HNSW index using `vector_cosine_ops`

Why HNSW:

- it works immediately, even with very small datasets
- it supports fast approximate nearest-neighbor search
- it avoids the training requirement of IVFFlat

The current index uses cosine distance and these parameters:

- `m = 16`
- `ef_construction = 64`

## Semantic Chunking

Chunking is sentence-aware rather than fixed-width.

`chunkText(text, maxChars, overlapChars)`:

1. splits on sentence boundaries
2. accumulates sentences until the current chunk would exceed `maxChars`
3. emits the chunk
4. carries forward a sentence-level overlap up to `overlapChars`

This preserves meaning better than arbitrary character slicing and reduces boundary loss when related information spans adjacent chunks.

Default settings:

- `chunkSize = 1000`
- `chunkOverlap = 200`

## Embedding Providers

RAG supports two embedding backends behind one wrapper.

### Gemini

Gemini uses `gemini-embedding-2-preview` through the Gemini API.

Important behaviors:

- requires `GEMINI_API_KEY`
- supports `RETRIEVAL_DOCUMENT` and `RETRIEVAL_QUERY`
- supports configurable dimensionality via `outputDimensionality`
- practical options are `768`, `1536`, or `3072`

The task-type split matters for Gemini because document and query embeddings are optimized differently.

### OpenAI

OpenAI uses `text-embedding-3-small`.

Important behaviors:

- requires `OPENAI_API_KEY`
- uses configurable `dimensions`
- supports up to `1536`
- does not distinguish document vs query task types at the API layer

### Shared wrapper

The internal `embed()` helper routes to Gemini or OpenAI based on `embeddingProvider`, so chunking, storage, and search code stay provider-agnostic.

## Ingestion Flow

`addDocument()` is designed as an atomic ingest pipeline.

High-level flow:

1. assign a document id
2. chunk the content semantically
3. generate embeddings for every chunk before starting the write transaction
4. `BEGIN`
5. insert the source document
6. insert each chunk plus its vector embedding
7. `COMMIT`
8. on failure, `ROLLBACK`

Why embeddings are generated before the transaction:

- API failures do not leave partial database state behind
- the transaction is only used for database writes

Why the write is transactional:

- a failed chunk insert should not leave a half-indexed document
- documents and chunks stay consistent

## Search Flow

`search(query, limit)`:

1. embeds the query
2. compares it against stored chunk embeddings with `embedding <=> $1::vector`
3. orders by ascending cosine distance
4. returns ranked `RAGSearchResult[]`

Each result includes:

- `content`
- `distance`
- `documentId`
- `chunkIndex`

This is the retrieval surface you inject into prompts or hand back to calling code.

## Tool Integration

`rag.createTools()` returns two standard framework tools:

- `add_document`
- `search_documents`

That matters because RAG does not need a parallel execution model. It reuses the existing one.

Example:

```typescript
import { registry, createRAG } from "./framework/index.js";

const rag = await createRAG({ embeddingProvider: "gemini" });
registry.registerAll(rag.createTools());
```

Once registered, any adapter, workflow, or agent can use the RAG system through the normal tool path.

## How RAG Fits The Framework

RAG is a good example of the framework’s architecture:

- storage and retrieval logic live in a subsystem
- that subsystem exposes a small API
- then it wraps itself back into tools
- the rest of the framework consumes those tools without special cases

That same pattern also appears in memory tools, delegation tools, and structured-output extraction.

## When To Use RAG

Use RAG when:

- documents are too large to fit into prompts
- retrieval should be based on meaning rather than keywords
- multiple agents or tools need shared access to a document corpus

Do not use RAG when:

- you only need normal app persistence
- a small fact store or thread history is enough
- you can solve the problem with direct tool calls and known inputs

In those cases, use `createStore()`, `createPgStore()`, or the memory helpers instead.
