# AGENTS.md — @simmetric-chat/collector

Document ingestion microservice (port 3210): parse → chunk → embed → store → status callback. CJS, TS strict. **No DB access** — no `DATABASE_URL` env var, never add one. Communicates with the server over HTTP only.

## Commands

```bash
pnpm --filter collector dev              # tsx watch src/index.ts
pnpm --filter collector test             # included in root `pnpm test`
pnpm --filter collector test -- -t "Ollama"          # single test by name
pnpm --filter collector test -- src/__tests__/parser.test.ts   # single file
pnpm --filter collector test:integration   # .integration.test.ts — real PG on port 5433 (pgvector_test DB), separate jest config
pnpm --filter collector build            # tsc → dist/
```

## Architecture

- `src/routes/ingest.ts` — all endpoints: `POST /api/ingest` (upload), `/api/ingest/query` (vector search), `/api/ingest/rerank`, `/api/ingest/reembed`, `/api/ingest/youtube`, `/api/ingest/wiki-pages`, `/api/ingest/archive-page`, `DELETE /api/ingest/:documentId`, `DELETE /api/ingest/wiki-pages/:pageId`, `GET /api/health`. Mutating routes are gated by `requireCollectorSecret` (`X-Collector-Secret` header); query/chunks routes are not. **No per-IP rate limit** — the secret check is the authz boundary (bulk archive imports share one server IP).
- `src/services/parser.ts` — PDF (`pdf-parse`), DOCX (officeparser → mammoth fallback), PPTX, XLSX, TXT/MD/CSV, YouTube transcripts. Vision OCR is **server-side**; the collector only routes on the `ocrMode` signal (`auto`/`vision`/`skip`) — image-only PDFs return empty text + `ocrSkipped` (graceful degradation, don't re-add a local OCR worker).
- `src/services/embeddings.ts` — strategy pattern: `local` (Xenova), `hf-local` (HF v3), `openai`, `ollama`. Server config takes priority over env. `checkEmbeddingModelAvailability()` pre-flights the 4-file on-disk cache → structured 503 instead of silent 500.
- `src/services/vectorStore.ts` — LanceDB (default, local disk), Qdrant, pgvector, Chroma. Module-level singleton — switching providers requires a process restart. Mutable calls wrapped in `withRetry` (3 attempts, exponential backoff); non-retryable errors caught inside the retry fn.
- Chunk size 1000/200 (wiki pages 800/100) is hardcoded in `ingest.ts` — not env-configurable.

## Gotchas

- **Air-gap landmine**: HF v3's default cache dir lives inside `node_modules/@huggingface/transformers/` and is wiped by `pnpm install`. Set `HF_CACHE_DIR`/`XENOVA_CACHE_DIR` outside `node_modules` for air-gapped deployments.
- The collector reads the repo-root `.env` (marker-walk via `loadRootEnv()`; cwd-adjacent fallback in packaged layouts — OPS-05 lineage). Zod-validated in `src/config/env.ts`; invalid env → `process.exit(1)` with an actionable diagnostic.
- Upload limits: 100 MB max, extensions `.pdf .md .txt .csv .docx .xlsx .pptx` only (415 otherwise).
- The `chunks[].chunkText` pass-through populates PostgreSQL `document_chunks.searchVector` server-side — the collector never writes to Postgres.
- Qdrant point IDs are deterministic UUIDv5 (SHA-1 over `SIMMETRIC_CHAT_CHUNK_NAMESPACE` + chunk id); the logical `chunkId` rides in the payload. Don't change the namespace — it breaks existing indexes.
- `@simmetric-chat/shared` maps to `shared/dist/index.js` in jest — rebuild shared after editing it.
