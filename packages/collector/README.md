<!-- generated-by: gsd-doc-writer -->

# @simmetric-chat/collector

Document ingestion microservice for Simmetric Chat. Receives documents via HTTP, parses them into plain text, splits them into semantic chunks, generates vector embeddings, and stores them for hybrid RAG retrieval.

Part of the [Simmetric Chat](..) monorepo.

## Overview

The collector is an independent Express microservice that runs on port **3210**. It handles the entire document processing pipeline:

```text
Upload → Parse → Chunk → Embed → Store → Status callback
```

It is designed to run as a standalone service — it does not import the server package and has no Prisma/ORM access. All communication with the main server happens over HTTP, authenticated via the shared `COLLECTOR_SECRET` (sent on the `X-Collector-Secret` header on every mutating route). The one direct-database path is the optional pgvector vector-store provider, which creates a raw `pg.Pool` and queries Postgres directly using a URL received at runtime from the server (see [Vector store providers](#vector-store-providers)).

## Installation

This package is **private** (`"private": true` in `package.json`) and not published to npm. It is installed as part of the monorepo:

```bash
git clone https://github.com/simmetric-chat/simmetric-chat simmetric-chat
cd simmetric-chat
pnpm install
```

The collector reads the repo-root `.env` (the single runtime config for all packages — see [Environment variables](#environment-variables) below and the root `.env.example`).

## Entry points

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `tsx watch src/index.ts` | Development server with hot reload |
| `start` | `node dist/index.js` | Production server (run after `build`) |
| `build` | `tsc` | Compile TypeScript to `dist/` |
| `typecheck` | `tsc --noEmit` | Type-check without emitting |
| `lint` | `eslint src/` | Lint source files |
| `test` | `jest` | Run the Jest unit test suite (included in root `pnpm test` via turbo) |
| `test:integration` | `jest --config jest.config.integration.cjs` | Integration suite against real pgvector on port 5433 and Chroma (skips when unavailable) |
| `smoke:ollama` | `tsx src/smoke/ollamaJs.smoke.ts && node dist/smoke/ollamaJs.smoke.js` | Dual-runtime (tsx ESM / node CJS) resolution gate for the `ollama` package |
| `seed:reranker` | `tsx scripts/seed-reranker.ts` | Pre-populate the on-disk HF cache for the CrossEncoder reranker model (run on a networked host) |

## Key directories

```
src/
├── index.ts              # Express app setup and bootstrapping
├── config/
│   └── env.ts            # Zod-validated environment variable loader and defaults
├── routes/
│   └── ingest.ts         # HTTP routes: upload, query, rerank, youtube, wiki-pages, chunks, reembed, archive-page, delete, health
├── services/
│   ├── parser.ts         # Document parsing (PDF, DOCX, PPTX, XLSX, TXT, MD, CSV, YouTube; ocrMode routing)
│   ├── chunker.ts        # RecursiveCharacterTextSplitter wrapper
│   ├── embeddings.ts     # Embedding strategy: Local (Xenova), HF v4 (hf-local), OpenAI, Ollama
│   ├── reranker.ts       # CrossEncoder reranker (Xenova/bge-reranker-base) + availability pre-flight
│   ├── ollamaClient.ts   # Map-keyed lazy singleton factory for the official ollama-js client
│   ├── vectorStore.ts    # Vector store strategy: LanceDB (default), Qdrant, Chroma; pgvector in pgVectorProvider.ts
│   └── pgVectorProvider.ts # pgvector provider (raw pg Pool, URL via runtime config)
├── smoke/
│   └── ollamaJs.smoke.ts # Dual-runtime ollama resolution smoke checks
├── __tests__/            # Jest suites: parser, parserOcrRouting, embeddings, hfLocalEmbedding airgap, ingest, ingest.rerank, reranker airgap, ollamaClient, ollamaKeepAliveEnv, vectorStore, chromaProvider, pgvectorHelper, pgVectorProvider (+ integration suites)
├── utils/
│   ├── logger.ts         # Winston logger
│   ├── fileUtils.ts      # Filename sanitization and unique path resolution
│   ├── retry.ts          # withRetry exponential-backoff helper
│   └── pgvectorHelper.ts # Vendor pgvector serializer (toSql, dim-mismatch guard) for the pgvector provider
└── types/
    └── modules.d.ts      # Type declarations for third-party modules
```

## Supported document formats

| Format | Libraries | Notes |
|--------|-----------|-------|
| PDF | `pdf-parse` | Text extraction. Vision OCR is **server-side**; the collector receives an `ocrMode` signal (`auto` \| `vision` \| `skip`) and routes accordingly. Image-only PDFs return empty text + `ocrSkipped` metadata (graceful degradation) |
| DOCX | `officeparser`, `mammoth` | officeparser first, mammoth as fallback |
| PPTX | `officeparser` | Slide content concatenated in presentation order |
| XLSX | `xlsx` (`node-xlsx`) | Sheet names preserved as `=== Sheet: <name> ===` headers |
| TXT / MD / CSV | Native `Buffer` | Read as UTF-8 plain text |
| YouTube URL | `youtube-transcript-plus` | Extracts transcript from the 11-char video ID |

**Max file size:** 100 MB per upload (multer `limits: { fileSize: 100 * 1024 * 1024 }` in `src/routes/ingest.ts`).

**Allowed extensions** (multer `fileFilter`): `.pdf`, `.md`, `.txt`, `.csv`, `.docx`, `.xlsx`, `.pptx`. Unsupported types are rejected with 415.

## Processing pipeline

1. **Parse** — Extract plain text from the uploaded file or URL.
2. **Chunk** — Split text into 1000-char chunks with 200-char overlap using `RecursiveCharacterTextSplitter` (wiki pages use 800/100).
3. **Embed** — Generate vector embeddings via the configured provider, keyed by the request's `embeddingModel`.
4. **Store** — Save vectors and citation metadata to the configured vector database.
5. **Cleanup** — Delete the uploaded file from `storage/uploads/`.
6. **Callback** — Notify the main server of completion or failure via `PUT /api/documents/:id/status` (best-effort, 5000ms timeout).

## Reranking

The collector also hosts a CrossEncoder reranker (`src/services/reranker.ts`) that the server calls **post-RRF** to re-score the fused top-K candidate list. It is a sibling of the HF local embedding provider: lazy `pipeline()` load, an `initializing` promise mutex against concurrent load storms, and a fail-closed air-gap stance (remote downloads gated by `HF_ALLOW_REMOTE_MODELS`, default `true`; set `false` for air-gapped deployments with a pre-seeded cache).

- Model: `Xenova/bge-reranker-base` (default `RERANKER_MODEL`), loaded via `@xenova/transformers` with `quantized: true`. The `seed:reranker` script pre-populates the on-disk cache for `onnx-community/bge-reranker-v2-m3-ONNX` (~544MB int8 ONNX) — set `RERANKER_MODEL` to match whichever model you seed.
- Scores are sigmoid-mapped logits → 0..1 probabilities; the route sorts candidates DESC by score.
- `checkRerankerAvailability()` is an O(1) 4-file on-disk cache pre-flight (`config.json`, `tokenizer_config.json`, `tokenizer.json`, `onnx/model_quantized.onnx`) that surfaces a missing model as a structured `available: false` instead of a silent 500.
- Cache dir resolution: `RERANKER_CACHE_DIR` → `HF_CACHE_DIR` → HF default. For air-gapped deployments, seed the cache on a networked host with `pnpm --filter collector seed:reranker` (optionally pinning `--revision <sha>` for supply-chain safety) and point `RERANKER_CACHE_DIR` outside `node_modules`.

## API summary

The collector exposes the following HTTP endpoints (all mounted under `/api`):

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Service health check (`{ status, service, timestamp }`) |
| `POST` | `/api/ingest` | Upload and process a document (multipart). Requires `documentId` and `embeddingModel` in the body. Gated by `requireCollectorSecret` |
| `POST` | `/api/ingest/query` | Vector search within a workspace. Body: `{ query, workspaceId, embeddingModel?, limit? }` (limit defaults to 5, capped at 100). Not secret-gated |
| `POST` | `/api/ingest/rerank` | CrossEncoder reranking of RRF-fused candidates. Body: `{ query, candidates: [{ chunkId, documentId, chunkText, score, source?, chunkIndex?, metadata? }] }` (Zod-validated via `RerankRequestSchema`, max 100 candidates). Returns `{ results: [{ ...candidate, score }] }` sorted DESC by score (sigmoid 0..1). Read-only pure function — not secret-gated (the server's `rerankCandidates` does not send `X-Collector-Secret`) |
| `GET` | `/api/ingest/chunks/:documentId` | Retrieve all chunks for a document from the vector store (query: `workspaceId`, `workspaceName?`). Validates IDs before they reach a LanceDB SQL `where` clause (injection guard). Not secret-gated |
| `POST` | `/api/ingest/reembed` | Re-embed an existing document's chunks with a (possibly different) `embeddingModel`. Idempotent: deletes existing vectors before writing new ones; an empty `chunks` array is a no-op. Gated by `requireCollectorSecret` |
| `POST` | `/api/ingest/youtube` | Extract and ingest a YouTube transcript. Requires `url`, `documentId`, `embeddingModel`. Gated by `requireCollectorSecret` |
| `POST` | `/api/ingest/wiki-pages` | Chunk, embed, and store wiki page vectors (Zod-validated body: `archiveId`, `pageId`, `slug`, `title`, `bodyText`, `contentHash`). Pre-flights embedding-model availability and returns 503 with `{ error, embeddingModel, available: false }` if the local model is unavailable. Gated by `requireCollectorSecret` |
| `POST` | `/api/ingest/archive-page` | Parse-only endpoint for the archive import pipeline (multipart file + `{ jobId, archiveId, documentId? }`). Does **not** chunk/embed/store — it parses the file and callbacks the server at `PUT /api/archives/import/:jobId/callback` with `{ status, extractedText, title }`, returning `{ jobId, status: "completed" }`. Gated by `requireCollectorSecret` |
| `DELETE` | `/api/ingest/:documentId` | Remove document vectors (query: `workspaceId`, `workspaceName?`). Gated by `requireCollectorSecret` |
| `DELETE` | `/api/ingest/wiki-pages/:pageId` | Remove wiki page vectors. Gated by `requireCollectorSecret` |

**Response shape (upload/youtube):** `{ documentId, chunkCount, chunks: [{ chunkIndex, chunkText, paragraph, charStart, charEnd }], embeddingModel, table, status }`. The `chunks[].chunkText` field is passed through so the server can populate PostgreSQL `document_chunks.searchVector` for hybrid RAG (the collector never writes to PostgreSQL through Prisma).

**Key exports (programmatic):**

| Export | File | Description |
|--------|------|-------------|
| `parseFile()` | `src/services/parser.ts` | Parse a file by extension, returns `ParsedDocument` |
| `parseYoutubeUrl()` | `src/services/parser.ts` | Extract transcript from a YouTube URL |
| `chunkText()` | `src/services/chunker.ts` | Split text into `ChunkResult[]` with configurable size/overlap |
| `getEmbeddingProvider()` | `src/services/embeddings.ts` | Async; resolves an `EmbeddingProvider` by model name (server config first, falls back to env) |
| `checkEmbeddingModelAvailability()` | `src/services/embeddings.ts` | Async; O(1) file-presence pre-flight for local Xenova/HF v4 caches (returns 503-ready `EmbeddingModelAvailability`) |
| `getReranker()` | `src/services/reranker.ts` | Async lazy singleton `CrossEncoderReranker` for the configured `RERANKER_MODEL` (cached per model name) |
| `checkRerankerAvailability()` | `src/services/reranker.ts` | Sync O(1) 4-file cache pre-flight; returns `{ available, model, error? }` |
| `getOllamaClient()` | `src/services/ollamaClient.ts` | Map-keyed lazy singleton factory for the official `ollama` client (cache key: `host\|timeoutMs\|auth`) |
| `getVectorStore()` | `src/services/vectorStore.ts` | Async singleton `VectorStoreProvider` instance |
| `getEnv()` / `clearEnvCache()` | `src/config/env.ts` | Get validated, cached environment config; `process.exit(1)` on invalid env |
| `toPgVector()` | `src/utils/pgvectorHelper.ts` | Serialize a `number[]` to a pgvector literal `[v1,...]` for the pgvector provider |

## Dependencies

- **Express** ^5.2.1 — HTTP server framework
- **@lancedb/lancedb** ^0.31.0 — Default vector database (local, air-gap compatible)
- **@xenova/transformers** ^2.17.2 — Local embedding models (default: `Xenova/all-MiniLM-L6-v2`, 384-dim) and the CrossEncoder reranker
- **@huggingface/transformers** ^4.2.0 — HF v4 local embedding runtime (`EMBEDDING_PROVIDER=hf-local`); same model IDs and dims as Xenova, no re-index
- **@langchain/textsplitters** ^1.0.1 + **@langchain/core** ^1.2.9 — Recursive character-based text splitting
- **Parsing libraries** — `pdf-parse` ^1.1.1, `mammoth` ^1.12.1, `officeparser` ^7.8.0, `xlsx` ^0.18.5, `youtube-transcript-plus` ^2.0.1
- **multer** ^2.2.0 — Multipart upload handling
- **ollama** ^0.6.3 — Official ollama-js client (embeddings + smoke gate)
- **chromadb** ^3.5.0 — Official Chroma SDK (vector store provider)
- **pg** ^8.23.0 + **pgvector** ^0.3.0 — pgvector provider (raw Pool, no Prisma)
- **cors** ^2.8.6, **dotenv** ^17.4.2 — CORS and `.env` loading
- **axios** ^1.19.0 — Server config fetch + status callbacks
- **winston** ^3.19.0 — Structured logging
- **zod** ^4.4.3 — Request validation (shared schemas)
- **commander** ^15.0.0 — `seed:reranker` CLI argument parsing
- **@simmetric-chat/shared** `workspace:*` — Shared Zod schemas and types (only cross-package import)

## Embedding providers

Strategy pattern with the `EmbeddingProvider` interface (`embed`, `getDimension`, `getModelName`). Selected via `EMBEDDING_PROVIDER` env var or fetched from the server's `/api/system/settings/embedding-config` endpoint (server config takes priority; env vars are the fallback).

| Provider | Class | Config | Notes |
|----------|-------|--------|-------|
| Local (default) | `LocalEmbeddingProvider` | `EMBEDDING_PROVIDER=local`, `EMBEDDING_MODEL`, `XENOVA_CACHE_DIR` | `@xenova/transformers` pipeline, `quantized: true`. Remote downloads gated by `HF_ALLOW_REMOTE_MODELS` (default `true`; set `false` for air-gap). Cache dir overridable via `XENOVA_CACHE_DIR` |
| HF v4 | `HuggingFaceLocalEmbeddingProvider` | `EMBEDDING_PROVIDER=hf-local`, `EMBEDDING_MODEL`, `HF_CACHE_DIR` | `@huggingface/transformers` v4 (Xenova's maintained successor). `dtype: "q8"` (NOT `quantized` — silently ignored in v4). `allowRemoteModels=false`, `allowLocalModels=true`; cache miss = hard error. Same model IDs/dims as Xenova → no re-index |
| OpenAI | `OpenAIEmbeddingProvider` | `EMBEDDING_PROVIDER=openai`, `EMBEDDING_API_KEY` | Native `fetch` to `https://api.openai.com/v1/embeddings`. Default model `text-embedding-3-small` (1536-dim) |
| Ollama | `OllamaEmbeddingProvider` | `EMBEDDING_PROVIDER=ollama`, `OLLAMA_BASE_URL`, `OLLAMA_KEEP_ALIVE` | Official `ollama` (ollama-js) client via `getOllamaClient()`; `keep_alive` flows from `OLLAMA_KEEP_ALIVE` (default `10m`) so the model stays resident between batches. 404 returns an actionable error with `ollama pull` hint |

Providers are cached in a `Map<string, EmbeddingProvider>` keyed by `providerType:modelName` via `getEmbeddingProvider()`. Ollama model names (containing `:` or prefixed `ollama/`) are auto-detected even in `local`/`hf-local` mode. `checkEmbeddingModelAvailability()` verifies the 4-file on-disk cache layout (`config.json`, `tokenizer_config.json`, `tokenizer.json`, `onnx/model_quantized.onnx`) for the local and HF v4 providers so a missing model surfaces as a structured 503 instead of a silent 500.

**Air-gap landmine:** HF v4's default `cacheDir` is `./.cache/` relative to the process cwd — a fresh clone or clean install wipes it. For air-gapped deployments, set `HF_CACHE_DIR` (and/or `XENOVA_CACHE_DIR`, `RERANKER_CACHE_DIR`) to a path outside `node_modules` and seed the 4-file cache there.

## Vector store providers

Strategy pattern with the `VectorStoreProvider` interface (`addDocuments`, `search`, `deleteByDocumentId`, `deleteByWorkspaceId`, `getByDocumentId`).

| Provider | Class | Config | Notes |
|----------|-------|--------|-------|
| LanceDB (default) | `LanceDBProvider` | `VECTOR_DB_PROVIDER=lancedb` | Local disk at `${STORAGE_PATH}/vectors/lancedb`. Workspace tables named `ws_${sanitized}_${shortId}`; global docs use `global`; wiki pages use `wiki_pages` |
| Qdrant | `QdrantProvider` | `VECTOR_DB_PROVIDER=qdrant`, `VECTOR_DB_URL`, `VECTOR_DB_API_KEY?` | Fully wired enterprise provider (REST/axios). Point IDs are deterministic **UUIDv5** (SHA-1 over `SIMMETRIC_CHAT_CHUNK_NAMESPACE` + chunk id); the logical `chunkId` rides in the payload. `ensureCollection` treats 409 as idempotent success (create-race); delete treats 404 as idempotent success. Requires `VECTOR_DB_URL` at construction |
| pgvector | `PgVectorProvider` | `VECTOR_DB_PROVIDER=pgvector`, runtime config URL | Wired in `getVectorStore()`: `case "pgvector"` constructs `new PgVectorProvider(url)` and lazy-provisions (`initialize()` CREATE EXTENSION/TABLE/INDEX IF NOT EXISTS). URL arrives via runtime config from server `/api/system/settings/vector-db-config`, never from collector `DATABASE_URL`. Dim-mismatch policy: BLOCK + re-embed. Reuses `toPgVector`/`parseVectorDim` from `src/utils/pgvectorHelper.ts` |
| Chroma | `ChromaProvider` | `VECTOR_DB_PROVIDER=chroma`, `VECTOR_DB_URL` | Uses the official `chromadb` npm SDK. Intended for mid-scale deployments. Requires `VECTOR_DB_URL` at construction (same as Qdrant) |

`getVectorStore()` returns a module-level singleton; switching providers requires a process restart. Mutable REST/Arrow calls are wrapped in `withRetry` (exponential backoff, 3 attempts); non-retryable errors (e.g. Qdrant 404 on a missing collection) are caught inside the retry fn so it does not loop forever.

## Environment variables

Validated by Zod in `src/config/env.ts`; invalid env causes `process.exit(1)` with an actionable diagnostic naming the resolved `.env` path and missing keys. The `.env` file is resolved by walking up from `__dirname` to the repo-root marker (`pnpm-workspace.yaml`), independent of the operator's `cwd` — **not** `process.cwd()` — with a cwd-adjacent fallback for packaged layouts (e.g. Tauri sidecar) that skip the root merge.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `COLLECTOR_SECRET` | **Yes** | — | Shared secret for server-collector auth (sent on `X-Collector-Secret` header). Min 1 char |
| `COLLECTOR_PORT` | No | `3210` | HTTP port for the microservice |
| `COLLECTOR_URL` | No | `http://localhost:3210` | Self-referencing URL |
| `SERVER_URL` | No | `http://localhost:3000` | Main server endpoint for status callbacks and embedding-config fetch |
| `STORAGE_PATH` | No | `./storage` | Directory for uploads and vector data |
| `EMBEDDING_PROVIDER` | No | `local` | `local` (Xenova), `hf-local` (HF v4), `openai`, or `ollama` |
| `EMBEDDING_MODEL` | No | — | Model name for the embedding provider (typically passed per-request via `embeddingModel` body field) |
| `EMBEDDING_API_KEY` | Conditional | — | API key when `EMBEDDING_PROVIDER=openai` |
| `OLLAMA_BASE_URL` | No | `http://ollama:11434` | Ollama server URL when using Ollama embeddings |
| `OLLAMA_KEEP_ALIVE` | No | `10m` | ollama-js `keep_alive` for warm KV cache between requests (guidance 5–30min; never `-1`/infinite) |
| `XENOVA_CACHE_DIR` | No | `@xenova/transformers` default | On-disk cache directory for the local Xenova provider (air-gap: point outside `node_modules`) |
| `HF_CACHE_DIR` | No | `@huggingface/transformers` default | On-disk cache directory for the HF v4 provider (air-gap: point outside `node_modules`) |
| `HF_ALLOW_REMOTE_MODELS` | No | `true` | Allow first-use model downloads from the HF hub for the local Xenova provider and the reranker; set `false` for air-gapped deployments with a pre-seeded cache |
| `RERANKER_MODEL` | No | `Xenova/bge-reranker-base` | CrossEncoder model for `POST /api/ingest/rerank` (loaded via `@xenova/transformers` with `quantized: true`) |
| `RERANKER_CACHE_DIR` | No | `HF_CACHE_DIR` → HF default | On-disk cache directory for the reranker model (wins over `HF_CACHE_DIR`; air-gap: point outside `node_modules`) |
| `VECTOR_DB_PROVIDER` | No | `lancedb` | `lancedb`, `qdrant`, `pgvector`, or `chroma` (all four wired — see [Vector store providers](#vector-store-providers)) |
| `VECTOR_DB_URL` | Conditional | — | Qdrant/Chroma endpoint (required when `VECTOR_DB_PROVIDER=qdrant` or `chroma`) |
| `VECTOR_DB_API_KEY` | Conditional | — | Qdrant API key (optional when using Qdrant) |

There is **no** `DATABASE_URL` env var on the collector — the collector never reads one from its own environment. The pgvector provider receives the Postgres URL at runtime from the server's `/api/system/settings/vector-db-config` endpoint. Do not add a `DATABASE_URL` env var.

Chunk size (1000 chars) and overlap (200 chars) are hardcoded in `src/routes/ingest.ts` and can be overridden per-call via `chunkText()` options. They are **not** environment variables. Wiki page ingestion uses 800/100.

## Testing

The collector has a dedicated Jest test suite under `src/__tests__/`:

| File | Coverage |
|------|----------|
| `embeddings.test.ts` | `OllamaEmbeddingProvider` — actionable 404 error messages, generic non-404 errors, successful embedding response; `LocalEmbeddingProvider` cold-start `progress_callback` |
| `hfLocalEmbedding.airgap.test.ts` | HF v4 provider air-gap stance (`allowRemoteModels=false`, cache miss = hard error, dtype `q8`) |
| `parser.test.ts` | Document parser per-format (PDF/DOCX/PPTX/XLSX/TXT/CSV/YouTube) |
| `parserOcrRouting.test.ts` | `ocrMode` (`auto`/`vision`/`skip`) routing and `ocrSkipped` graceful degradation |
| `ingest.test.ts` | Route-level behavior (auth boundary, query `dimension` exposure, reembed idempotency + shared chunk-id, status callback) |
| `ingest.rerank.test.ts` | `POST /api/ingest/rerank` — no-secret 200 (NOT 401), Zod 400, DESC sort with sigmoid scores, 500 on reranker failure |
| `reranker.airgap.test.ts` | `CrossEncoderReranker` air-gap stance — no network on score, cache miss = hard error, sigmoid arithmetic, 4-file pre-flight |
| `ollamaClient.test.ts` | `getOllamaClient()` Map-keyed lazy singleton (host\|timeoutMs\|auth cache key) |
| `ollamaKeepAliveEnv.test.ts` | `OLLAMA_KEEP_ALIVE` Zod default (`10m`) and operator override passthrough |
| `vectorStore.test.ts` | LanceDB/Qdrant/Chroma provider behavior (UUIDv5 point-id, 409/404 idempotency) |
| `chromaProvider.test.ts` | `ChromaProvider` unit tests with mocked chromadb SDK |
| `pgvectorHelper.test.ts` | `toPgVector` serializer + `parseVectorDim` dim-mismatch guard |
| `pgVectorProvider.test.ts` | `PgVectorProvider` unit tests — mocked `pg.Pool`: table-name derivation, dim-mismatch BLOCK, upsert/search/delete SQL shape, batch cap, `close()`, optional `registerTypes` |

```bash
pnpm --filter collector test                          # Run the collector unit test suite (part of root `pnpm test`)
pnpm --filter collector test -- -t "Ollama"           # Run a single test by name
pnpm --filter collector test -- path/to/file.test.ts  # Run a single test file
```

**Integration tests** (`*.integration.test.ts`, excluded from the unit suite) hit real services and are run via `test:integration`:

```bash
# pgvector integration (pgVectorProvider.integration.test.ts, chromaProvider.integration.test.ts):
# requires a real pgvector on port 5433 — skips when unavailable:
docker run -d -p 5433:5432 -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=pgvector_test pgvector/pgvector:pg16
pnpm --filter collector test:integration

# Chroma integration (gated behind CHROMA_AVAILABLE):
docker compose -f docker/docker-compose.yml up -d chroma
CHROMA_AVAILABLE=true VECTOR_DB_URL=http://localhost:8000 \
  pnpm --filter collector test -- --config jest.config.integration.cjs --testPathPattern="chromaProvider"
```

End-to-end document ingestion coverage is provided by the server's integration tests (`packages/server/src/__tests__/`), which exercise the full upload → parse → chunk → embed → store → callback flow against a running PostgreSQL instance:

```bash
pnpm --filter server test:integration
```

## How it fits into the monorepo

```text
shared ← collector
shared ← server
```

- The collector **only imports from `@simmetric-chat/shared`** (Zod schemas and types). It never imports server services, Prisma clients, or route handlers.
- The main server forwards uploaded documents to the collector over HTTP and receives status callbacks in return (authenticated with `COLLECTOR_SECRET`).
- This isolation allows the collector to run on a separate node or container with no Prisma/ORM access. The only direct database path is the optional pgvector vector-store provider, which receives its Postgres URL at runtime from the server — critical for air-gapped deployments.
- The server performs hybrid search by combining collector vector results with PostgreSQL `tsvector` full-text results using Reciprocal Rank Fusion (RRF). The collector provides only the vector search half; it does not run `to_tsvector` or write to `document_chunks`.
- The server calls `POST /api/ingest/rerank` post-RRF to re-score the fused candidate list with the collector's CrossEncoder (read-only, not secret-gated).
- The collector is **not** involved in MCP Marketplace operations — all marketplace state lives in PostgreSQL, managed exclusively by the server package.
