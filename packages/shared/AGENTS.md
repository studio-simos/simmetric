# AGENTS.md — @simmetric-chat/shared

Shared kernel: Zod schemas, types, constants. Zero runtime deps except `zod`. CJS. Leaf node of the monorepo — never import from server/collector/frontend/widget.

## Commands

```bash
pnpm --filter @simmetric-chat/shared build   # tsc → dist/ (required before server/collector/widget build, lint, typecheck, test)
pnpm --filter @simmetric-chat/shared test    # 14 test files in src/__tests__/
```

- **Must be built** for server/collector/widget: their tsconfigs and jest configs map `@simmetric-chat/shared` → `shared/dist/index.js`. The frontend aliases shared **source** (`../shared/src/index.ts` in vite + jest) and does not need the build.
- Turbo caches downstream tasks on `^build` — after editing `src/`, rebuild shared or run via turbo, or server tests hit a stale `dist/`.

## Conventions

- **No business logic** — types, schemas, constants only. Never add a runtime dependency beyond `zod`.
- **Schema files**: `camelCase.schema.ts` (e.g. `auth.schema.ts`); export the schema AND the inferred type (`loginSchema` → `LoginInput`). Re-export from `src/schemas/index.ts` and the top-level `src/index.ts` barrel.
- Handlers validate with `safeParse` (not `parse`) so bad input returns 400, never a 500. Never re-declare a schema in a consuming package.
- Key constants: `PERMISSION_NAMES` (31 RBAC permissions), `MENU_SECTIONS` (13), `FEATURE_FLAGS` (11 — commodity flags were removed in Phase 140, only enterprise flags + numeric limits remain; `COMMUNITY_FEATURE_DEFAULTS` pins Community values).
- `SourceCitation.source` is a 6-value union (`"rag" | "archive" | "tool" | "web" | "memory" | "workspace"`); `"workspace"` is a legacy alias normalized to `"rag"` by `normalizeSource()` — don't remove it (persisted data depends on it).

## Gotchas

- `src/__tests__/ingestSchemas.test.ts` guards the collector↔server ingest contract (`chunkText` Bug B regression) — changing `ingest.schema.ts` shapes breaks the collector; update both sides in the same change.
- Changing a schema that the server persists (e.g. `widget.schema.ts` `allowedOrigins` is a JSON-encoded string, not an array) can break E2E seeding — check `e2e/globalSetup.ts` expectations.
