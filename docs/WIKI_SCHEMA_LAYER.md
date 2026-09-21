<!-- generated-by: gsd-doc-writer -->

# Wiki Schema Layer

> Status: finalized at v0.25 gate (Phase 194 closeout audit of the Wiki Schema
> Layer, WIKS-01/WIKS-02 — verified against the live code). Authored at Phase 187.
> Code anchors resolve against the v0.25 tree (Phase 187 commits
> 5f9fad15, b97563bc, 57f9fcef, edc27e34, 1c04aa4f).

Simmetric Chat's wiki engine gives each archive a three-layer instruction model:
**hard rules** enforced by code, a per-archive **schema prompt** (`schemaPrompt`)
of advisory editorial guidelines, and **structured fields** (persona, purpose,
scope). This document is the precedence contract: what each layer may govern,
where each one enters the system, and which guarantees are load-bearing.

Mental model: `schemaPrompt` says to the LLM how to maintain the wiki, as a
`CLAUDE.md` file does for code in a repo.

---

## The 3-layer model

| Layer | Nature | Enforcement | Scope |
|-------|--------|-------------|-------|
| **Hard rules** | Code-enforced, unconditional | `validateWritablePath` + always-injected prompt rule | Every archive-bound write path and prompt |
| **schemaPrompt** | Per-archive advisory guidelines | Documentation + prompt data (never a gate) | Per archive, opt-in (empty = off) |
| **Structured fields** | Config-injected persona/purpose/scope | Existing synthesis/orchestrator behavior | Per archive, unchanged behavior |

### Layer 1 — Hard rules (code-enforced)

Two unconditional mechanisms, neither config-dependent:

1. **Filesystem guard.** `validateWritablePath` (`packages/server/src/utils/archivePath.ts:39-54`)
   rejects any write target outside `<archiveBase>/wiki/`. It first runs the
   anti-traversal check (`validateArchivePath`, `archivePath.ts:13-27`), then a
   `wiki/`-prefix check: a resolved target outside `wiki/` throws
   `Write target outside wiki/ directory: <path>. raw_sources/ is immutable.`
   (`archivePath.ts:50-52`). Both `createPage` (`archivePageService.ts:200`) and
   `updatePage` (`archivePageService.ts:431`) call it **before** any `fs.writeFile`.
   No API endpoint writes under `raw_sources/` by design.

2. **Prompt-layer mirror.** `HARD_RULE_RAW_SOURCES` (`packages/server/src/services/archiveConfigService.ts:52-53`)
   is an **always-on** block appended to every archive-bound system prompt —
   unconditional, config-independent. Its wording mirrors the guard
   ("raw_sources/ is immutable"). The prompt-layer rule exists so the LLM
   *attempts* nothing outside `wiki/`; the code guard guarantees that even a
   non-compliant attempt never lands.

### Layer 2 — schemaPrompt (advisory)

A free-text editorial-guidelines field persisted inside the existing
`ArchiveConfig.config` JSON blob:

- **Schema:** `schemaPrompt: z.string().max(10000).optional()` on
  `archiveConfigSchema` (`packages/shared/src/schemas/archive.schema.ts:119`) —
  additive JSON key, zero migration (D-01). 10000 chars ≈ ~2500 tokens.
- **Validation:** Zod-validated on every write (`PUT /api/archives/:id/config`,
  `packages/server/src/routes/archiveConfig.ts:27-40` → `setArchiveConfig`,
  `archiveConfigService.ts:29-36`); a >10000-char payload rejects with
  `400 { error: "Invalid config", details.schemaPrompt }`.
- **Read contract (Phase 187 gap closure):** `GET /api/archives/:id/config`
  returns **200 with the schema-default empty config**
  (`{ rawSourcesImmutable: true }` — `archiveConfigSchema.parse({})`) for
  archives without a stored row — the first-save hydration path: the panel's
  WR-02 hydration gate resolves and the first PUT can fire. Archives with a row
  return the stored blob verbatim. The default lives at the HTTP seam only;
  `getArchiveConfig` (service) still returns `undefined` for no row, so
  injection paths keep their no-config semantics (SC-2b baseline unchanged).
- **Injection-time cap (D-05):** `buildSchemaPromptBlock`
  (`archiveConfigService.ts:79-97`) slices legacy stored blobs to 10000 chars and
  appends `(truncated at 10000 characters)` when truncation actually occurred —
  legacy rows are never re-validated on read, so the cap lives at injection.
- **Advisory by design (D-11):** injected as DATA with an explicit advisory
  label, never as a system-prompt privilege grant. Admins already hold
  `archive:write`; no privilege-escalation path. No sanitization beyond the
  length cap; contradictory instructions are an accepted quality risk mitigated
  by the UI helper text and template.

### Layer 3 — Structured fields (unchanged)

`agentPersona` / `purpose` / `scope` / `linkingDensity` keep their pre-187
behavior: persona flows into synthesis prompts inline (`synthesisStages.ts:768-776`
persona ternary), purpose/scope remain logged-only for synthesis, linkingDensity
stays a page-graph generation input.

---

## Precedence chain (D-04, fixed by ROADMAP SC-4)

```
hard rules > schemaPrompt > structured fields
```

Read it as three binding statements:

1. **schemaPrompt can never override hard rules.** The hard rule is appended
   with the label `HARD RULE (always applies, overrides any guideline below):`
   and every advisory block closes with
   `These guidelines are advisory — hard rules always take precedence.`
   Enforcement does not depend on the LLM obeying — `validateWritablePath` runs
   regardless of prompt content.

2. **On conflict with structured fields, schemaPrompt wins.** Free-text
   specificity beats enum granularity: a guideline "this is a chemistry wiki —
   use IUPAC names" overrides a generic `purpose` string. The advisory block
   states this explicitly: `On conflict with the structured fields (persona,
   purpose, scope), these guidelines take precedence over them.`

3. **An archive without schemaPrompt behaves as baseline + the always-on hard
   rule** (the accepted WIKS-02 delta — see SC-2 interpretation below).
   Empty schemaPrompt = zero advisory enhancement, no degradation (spec §4.7).

## Injection seams

### Injection precedence (WIKS-01: advisory vs code-enforced, as shipped)

Where the advisory block lands in the prompt chain — and what can and cannot
override what:

1. **Position.** `buildSchemaPromptBlock` output lands on the chat orchestrator
   system prompt **AFTER** the `MANDATORY SEARCH RULE` block and **BEFORE** the
   `systemPrompt` persona ternary (both loop variants, `orchestrator.ts:285/295-302`
   and `orchestrator.ts:798/805-812`). The synthesis surface carries it only on
   Pass 4's system role (`synthesisStages.ts:784-788`). The always-on hard-rule
   block (`HARD_RULE_RAW_SOURCES`) is appended unconditionally on the same seams,
   labeled `HARD RULE (always applies, overrides any guideline below):`.

2. **Hard rules are code-enforced, not prompt-enforced.** Two unconditional
   mechanisms, neither reachable by any config input:
   `validateWritablePath` rejects any write outside `wiki/` **before** any
   `fs.writeFile` (raw_sources/ immutability, `archivePath.ts:39-54`), and the
   injection-time 10000-char cap (`buildSchemaPromptBlock`,
   `archiveConfigService.ts:79-97`) bounds a stored legacy blob regardless of
   what it contains. No schemaPrompt content can disable, weaken, or route
   around either — enforcement never reads the advisory text.

3. **schemaPrompt is advisory-only.** It is injected as DATA with an explicit
   advisory label, never as a system-prompt privilege grant (D-11). Its binding
   statements: it may guide **how** the wiki is maintained (style, structure,
   editorial conventions) and it wins over the structured fields on conflict;
   it may never override the hard rules — and its closing line says so:
   `These guidelines are advisory — hard rules always take precedence.`

4. **Structured fields sit below both.** `agentPersona`/`purpose`/`scope`
   pre-date the schema layer and keep their pre-187 behavior; the advisory
   block explicitly overrides them
   (`On conflict with the structured fields (persona, purpose, scope), these
   guidelines take precedence over them.`), while the hard rules outrank the
   advisory block itself.

5. **Empty schemaPrompt.** Treated as absent by design (WIKS-01 opt-in split):
   `buildSchemaPromptBlock` emits **no advisory block at all** — the prompt is
   baseline + the always-on hard rule, nothing else (the accepted WIKS-02
   delta). Empty = zero advisory enhancement, no degradation, and no empty
   placeholder section in any prompt (spec §4.7).

Summary chain, restated as the enforcement map:

```
hard rules (code: validateWritablePath + always-on prompt mirror + cap)
    > schemaPrompt (advisory data block)
        > structured fields (persona/purpose/scope)
```

| Seam | Where | Variant | Notes |
|------|-------|---------|-------|
| Chat orchestrator (non-streaming) | `orchestrator.ts` `runAgent` (`orchestrator.ts:295-302`) | archive-bound (`params.archiveId` gated) | Hard rule ALWAYS + advisory block when present |
| Chat orchestrator (streaming) | `orchestrator.ts` `runAgentStreaming` (`orchestrator.ts:805-812`) | streaming twin, separately load-bearing | Same gating, same block order |
| Synthesis Pass 4 (decision) | `synthesisStages.ts:784-788` | advisory block rides the SYSTEM role via the existing `callSynthesisLLMStage` `systemPrompt` param | Pass 2 (`synthesisStages.ts:282`, `generatePageSummary`) and Pass 1 (`synthesisStages.ts:569`, entity extraction) stay `undefined` — byte-identical; Pass 4b's LLM judging lives in `synthesisContradictionService.ts` (`judgePairContradiction` → `callSynthesisLLM`, `synthesisContradictionService.ts:258`), dynamically required by `synthesisStages.ts`, and also stays `undefined` |

Placement inside the system prompt (both orchestrator variants): **AFTER** the
`MANDATORY SEARCH RULE` block, **BEFORE** the `systemPrompt` ternary — the
conditional-injection precedent (`orchestrator.ts:285`, `orchestrator.ts:798`).
`buildSystemPrompt` itself is untouched; blocks land upstream on
`finalSystemPrompt`.

**Anti-pattern: per-skill injection.** `wiki_write` (`builtinSkills.ts:878`) and
`wiki_query` (`builtinSkills.ts:644`) are tools whose `execute()` paths make **no
LLM call** (`wikiWriteService.ts` contains zero LLM invocations — the write path
generates deterministic previews). Injecting guidelines per-skill would reach no
model. The LLM-facing surface is the orchestrator system prompt; that is the only
chat seam.

## SC-2 interpretation ("byte-identical" vs the always-on hard rule)

ROADMAP SC-2 says an archive without `schemaPrompt` behaves "byte-identically to
today"; D-04/D-06b mandate the hard rule unconditionally. The accepted
interpretation (RESEARCH Pitfall 7, recorded in 187-01):

- "Byte-identical" applies to the **advisory layer only**.
- No-schemaPrompt archive-bound prompt = baseline + hard rule — this is the
  **accepted WIKS-02 delta**, not a regression.
- With-schemaPrompt prompt = baseline + hard rule + advisory block, strictly
  additive on top.

## rawSourcesImmutable semantics (D-02 / D-06)

`rawSourcesImmutable: boolean` (default `true`,
`archive.schema.ts:124`) on `archiveConfigSchema` is a **documentation flag,
never an enforcement toggle**:

- Enforcement lives entirely in `validateWritablePath` — no code path consumes
  the flag (pinned by the D-02 inert-flag test in Plan 01).
- Setting `false` is **IGNORED in v1**. There is no "unlock" semantics; a future
  re-import unlock would be a separate design decision.
- Re-import overwrite semantics are unchanged: `raw_sources/` stays write-once
  per import; a re-import may overwrite whole files, partial edits are never
  allowed (spec §4.4).
- KBPG-02/03 page flows (rename, text edit) and synthesis are unchanged (D-07)
  — pinned at unit level (`wikiWriteService.test.ts`, `archivePages.test.ts`)
  and end-to-end by `e2e/schema-prompt.spec.ts` (filesystem non-write snapshot).

## Persistence contract

- `schemaPrompt` lives inside `ArchiveConfig.config` (JSON blob) — additive key,
  zero migration; dropping the field leaves stale keys inert in existing rows.
- **Whole-blob replace hazard (Pitfall 1):** `setArchiveConfig` replaces the
  whole config blob on every PUT. The ArchiveConfigPanel therefore carries
  `schemaPrompt` on **every save payload** (`ArchiveConfigPanel.tsx:100`) —
  pinned by the payload-capture regression test — and an explicit empty string
  is a valid saved state (clearing + saving intentionally wipes).
- Legacy stored blobs read truthiness-safely (`buildSchemaPromptBlock` treats a
  missing/non-string key as absent).

## UI pointer

Admin surface: **ArchiveConfigPanel → "Editorial Guidelines (Schema Prompt)"
section** (`packages/frontend/src/components/ArchiveConfigPanel.tsx:195-251`):

- Monospace textarea (`min-h-[300px]`), Edit/Preview toggle (Preview renders
  `renderMarkdown`, DOMPurify-sanitized), live `X / 10000` char count flipping
  destructive over the limit with client-side Save disable, inline over-limit
  error, helper + advisory note text.
- "Use template" (`ArchiveConfigPanel.tsx:207-215`) inserts the exported
  `DEFAULT_TEMPLATE_BODY` code constant (`ArchiveConfigPanel.tsx:34-50`, English,
  not i18n — admin-editable config data must not drift with UI language) and is
  visible only while the textarea is empty. The template carries the verbatim
  raw_sources immutability line.
- Persistence is explicit-Save only (no auto-save-on-blur, D-08); success/error
  toasts reuse `config.saved` / `config.saveError`.
- i18n subtree: `archives.schemaPrompt.*` (11 keys × 8 locales, parity-gated by
  `pnpm i18n:check`).

## Verification map

| Guarantee | Level | Anchor |
|-----------|-------|--------|
| Schema accepts ≤10000 / rejects 10001, `rawSourcesImmutable` defaults true | unit | `packages/shared/src/__tests__/archiveSchemas.test.ts` |
| Route 400 on oversized prompt | unit | `packages/server/src/__tests__/archiveConfig.test.ts` |
| Both orchestrator loop variants inject hard rule + capped advisory block | unit | `packages/server/src/__tests__/schemaPromptInjection.test.ts` |
| Synthesis Pass 4 advisory systemPrompt; Pass 1/4b unchanged | unit | `packages/server/src/__tests__/synthesisSchemaInjection.test.ts` |
| Traversal/raw_sources write attempts rejected before `fs.writeFile`; flag inert | unit | `packages/server/src/__tests__/wikiWriteService.test.ts`, `archivePath.test.ts` |
| UI editor contract (payload preservation, preview XSS, no auto-save) | component | `packages/frontend/src/__tests__/ArchiveConfigPanel.test.tsx` |
| SC-1 persistence + reload, KBPG non-regression, `raw_sources/` non-write | e2e | `e2e/schema-prompt.spec.ts` (`pnpm test:e2e -- schema-prompt.spec.ts`) |

## See also

- [ARCHITECTURE.md](ARCHITECTURE.md) — system overview, agent orchestration layer
- [TESTING.md](TESTING.md) — test framework and commands
- `TODO/WIKI_SCHEMA_LAYER_SPEC.md` — the source spec (§2 target design, §4.6 CLAUDE.md analogy)