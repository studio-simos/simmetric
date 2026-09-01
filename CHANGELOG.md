# Changelog

All notable changes to Simmetric Chat are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
for release tags (`vMAJOR.MINOR.PATCH`).

> **Beta status:** the project is in pre-1.0 beta. Version numbering was
> rebased from the 1.x line back to the 0.x series (2026-08-30) — the 1.x tags
> were development milestones, never published releases. The 0.x line
> continues from where v0.20 left off; versioning discipline (version:check
> + changelog:check + version:bump at every milestone) is unchanged and applies
> to beta releases too.

> **Operator-facing upgrade notes** live in `docs/API_KEY_MIGRATION.md`,
> `docs/ENCRYPTION_KEY_ROTATION.md`, `docs/MIGRATION_SAFETY.md`, and
> `docs/SCALING.md`. This changelog is the chronological summary; those docs
> are the action-required detail.

---

## [Unreleased]

### Added
- Tooling: a dead-code gate now runs in CI (knip) and fails on unused files,
 dependencies, or exports outside the documented allowlists; a repo-wide
 sweep removed ~3,400 lines of dead code, the widget API key generation now
 lives behind the standard admin flow, and both i18n scripts report
 defined-but-never-used translation keys as a non-blocking cleanup hint.
- Widgets: per-widget response model pin — each widget's admin configuration
 can now select the LLM provider + model that serves that widget's chat
 responses (`responseProviderId`/`responseModel`, additive migration
 `add_widget_response_model`). The pin is resolved server-side from the
 widget DB row on every chat request (never client-supplied — the widget
 proxy and visitor UI are untouched), takes priority over the workspace
 default, and unset widgets keep the existing workspace/global resolution
 chain. Widget chats now record the model that actually serves them.

### Fixed
- Enterprise builds: the Settings → Advanced → Backup section (and the `/sso`
 and `/logs` routes) no longer stay locked behind the "requires Enterprise"
 card after an in-app login or SSO sign-in. The enterprise-modules manifest
 query (`GET /api/enterprise/modules`) is now auth-gated and session-reactive:
 previously it was fetched once, unauthenticated, at app boot and cached for
 the whole session (`retry: false` + `staleTime: Infinity`), so on the login
 screen it 401'd and Enterprise features stayed hidden until a full page
 reload WITH the stored token. The hook now subscribes to `useMe()` and
 refetches the manifest when a session appears (password login, SSO `?token=`
 handoff), and never probes the endpoint without a session at all.
- Docker: the production secret provisioning helper
 (`docker/provision-encryption-key.sh`) no longer crash-loops the server when
 the root `.env` is deployed with an unfilled `.env.example` template
 placeholder (`<sostituire-con-valore-generato>`) as the
 `API_KEY_HMAC_SECRET`/`ENCRYPTION_KEY` value — a placeholder is now
 recognized as "unset" (loud warning) and provisioning falls through to the
 restore/generate paths. Any other non-empty invalid value still fails loud
 at the boot gate.
- Security: the E2E helper router (`/api/__tests__`, unauthenticated
 start/stop echo MCP server) is no longer mounted when the server runs with
 `NODE_ENV=production` — production boots now 404 there, enforcing the
 router's own documented dev/test-only contract (no unauthenticated
 process-spawn endpoint in production).
- Security: the archive import collector-secret callback check
 (`PUT /api/archives/import/:jobId/callback`) now compares the
 `X-Collector-Secret` header in constant time (`crypto.timingSafeEqual` with
 a length guard), matching the timing-safe discipline already used by the
 documents status callback and the collector's own secret gate — closing the
 last plaintext secret comparison on the server.
- Auth: `POST /api/auth/login` now validates its body at the route level with
 the shared `loginSchema` (`safeParse`) — an invalid or empty body returns
 `400 { error, details }` consistent with every other auth route, instead of
 a `401` carrying a raw Zod message. Valid-but-wrong credentials still
 return `401 "Invalid credentials"`.
- Auth: `login` now runs a dummy `bcrypt.compare` against a fixed throwaway
 hash when the user is not found, so response timing no longer distinguishes
 existing from non-existing usernames (enumeration hardening). Both paths
 still return the same `401 "Invalid credentials"`.
- Auth: `POST /api/auth/admin-reset-password` now validates its body with the
 new shared `adminResetPasswordSchema` (`userId` UUID + `newPassword`
 8-128 chars, `safeParse` → `400 { error, details }`) — the last auth route
 moves off ad-hoc destructured body validation.
- Auth: the closed-registration branch of `POST /api/auth/register` no
 longer duplicates auth logic inline — it uses the statically imported
 `verifyToken` / `isTokenRevoked` / `isAdmin` / `getCachedUserWithRoles`
 (no dynamic `await import`, no dead header re-check, cached user lookup)
 while preserving every response shape and the revocation-before-lookup
 order.
- Security: the widget cache-bust endpoint (`POST /api/config/:widgetId/cache-bust`)
 now compares the `X-Api-Key` header in constant time
 (`crypto.timingSafeEqual` with a length guard) and fails closed if the
 expected key is unset, instead of the previous plaintext compare with a
 fail-open `expected &&` shape — the widget's key check now matches the
 timing-safe discipline used by the server and collector secret gates.

## [v0.22.0] — 2026-08-30

### Added
- RAG: metadata filtering for `rag_search` — the agent can now scope retrieval
 to document types (`documentTypes`: pdf/md/txt/csv/docx/xlsx) and ingest
 dates (`dateFrom`/`dateTo`, ISO; a date-only upper bound includes the whole
 day), fixing the "2023 docs for 2025 questions" failure mode. Filters thread
 through hybrid search into both retrieval legs: the vector leg reaches the
 collector as true pre-filters on stamped ingest metadata (pgvector JSONB
 predicates + Qdrant payload must-clauses; LanceDB and Chroma ignore the new
 keys with a logged warn), and the FTS leg gains parameterized SQL predicates
 on the documents table. A server-side post-retrieval backstop against the
 authoritative documents table guarantees filtered correctness on every
 provider. Documents ingested from now on are always filterable; legacy
 vectors (pre-stamping) are excluded while a filter is active and regain
 filterability via admin re-embed — no schema change, no re-embedding of
 existing documents, and behavior without filters is unchanged.
- DLP: four new built-in patterns for common European (esp. Italian)
 identifiers, seeded idempotently by a data-only migration and mirrored into
 the DB-down fallback set — `it_vat_iva` (Partita IVA; label-anchored, so a
 bare 11-digit number never matches), `it_codice_fiscale` (16-char codice
 fiscale; uppercase-only, prose words like "foschi" can never match), `iban`
 (country prefix + length ≥ 15; compact and space-grouped forms,
 linear-time/ReDoS-safe), and `eu_phone` (phone IT/EU; seeded DISABLED for
 admin review since any structured phone regex flags order/reference digit
 runs). Built-ins are now 10 in total; existing deployments get the new rows
 on `migrate deploy` with `ON CONFLICT DO NOTHING` replay safety.
- Chat: admins can now reveal or re-hide the DLP-redacted matched texts across
 the whole conversation at once, via a new "Show DLP texts" / "Hide DLP texts"
 item in the chat input's more-actions (+) menu (Eye/EyeOff icon, shown only
 to admins since only they can expand a DLP notice). The preference is
 session-scoped, defaults to hidden, and applies to every notice including
 newly arrived messages; the per-notice eye button still works for manual
 per-message overrides between global toggles.
- DLP pattern configuration: the six DLP patterns are now database-backed
 (`dlp_patterns` table, seeded idempotently by the migration so existing
 deployments get the built-ins) instead of hardcoded. Admins manage them in
 Settings → Advanced → DLP Patterns: enable/disable any pattern by row,
 rename built-ins (their regex is frozen — modify attempts return 400),
 and add up to 50 custom patterns (snake_case name, regex source with
 compile validation at save, flags, replacement) with a live test preview
 showing matched segments and the redacted text. Scans that can load the
 DB set — the filter plugin inlet/outlet and the end-of-response final
 flush — use the configured patterns through a 5-minute TTL cache with
 per-pattern compiled-regex caching, falling back to the built-in set when
 the database is unreachable; the token-by-token streaming flush keeps the
 built-in patterns (documented v1 limitation). The whole panel is localized
 in all 8 locales.
- DLP role bypass: a new `DLP_BYPASS_ROLES` system setting (JSON array of
 role names, default `[]`) lets admins exempt selected roles from ALL DLP
 scanning and redaction — the filter plugin inlet/outlet and the streaming
 progressive-flush core (including the RAG-context scan and thinking
 redaction, for both JWT chat and the widget service account) all honor
 the same gate. Every bypassed run fires one fire-and-forget `dlp.bypassed`
 audit event recording WHO bypassed (the intersected role names) and the
 origin surface — never the scanned content. Admin UI: a roles multi-select
 with an exposure warning in Settings → Advanced → DLP, and a "Bypassed"
 action label in the DLP Match History panel, localized in all 8 locales.
- DLP audit source tagging and filtering: every `dlp.*` event log carries
 `source: "chat" | "widget"` in its metadata — the shared SSE stream core
 derives the tag from the widget `X-Widget-Id` header so widget
 conversations are redacted the same as chat ones but now distinguishable
 in the DLP Match History panel (Settings → Advanced). The panel gains
 client-side filters for source (All/Chat/Widget), chat ID and user.
- Admin settings UI for the upload-draft reaper: a new section in
 Settings → Maintenance exposes the enabled toggle
 (`upload_draft_reaper_enabled`) and the cadence cron expression
 (`upload_draft_reaper_cron`) via `PUT /api/system/settings`, with a
 client-side five-field cron shape pre-check (the server keeps its
 warn-and-fallback behavior for invalid values), localized success/error
 toasts, and descriptions in all 8 locales. `.env.example` documents the
 reaper keys as env-var overrides (`upload_draft_reaper_enabled`,
 `upload_draft_reaper_cron`, `upload_draft_retention_days`).

- Config: the environment configuration is now defined once in a shared Zod
 schema (`@simmetric-chat/shared`), the effective precedence is documented and
 test-pinned as **DB > ENV > default** (settings UI edits win immediately; 8-case
 matrix), and keys that would be ignored because an env var overrides them are
 shown with an `envOverridden` badge in the settings UI.
- Config: the repository-root `.env` is now the single runtime config for the
 server, collector and widget — a new zero-dependency loader (`loadRootEnv()`)
 merges it under per-package `.env` overrides (legacy), with a once-per-boot
 deprecation warning listing affected key names (never values); Docker and Tauri
 aligned (compose `env_file` points at the root file, no image bakes secrets).
- Config: all three package `.env.example` files are regenerated from their Zod
 schemas (83/15/6 keys, grouped, defaults synced) with Jest tripwires that fail
 when a future schema key goes undocumented; raw `process.env` reads kept outside
 the schema (HF/openai-quirks, encryption/HMAC keys, LOG_LEVEL, test gates) are
 pinned by 44 behavioral guard probes.
- UX: deleting a workspace now asks a standard confirm dialog (was an inline
 mini-confirm), workspaces support multi-select bulk delete with a confirmation
 dialog and a results toast counting skipped rows (no-permission rows are skipped,
 never a silent failure), the OCR preview side-by-side keeps the extracted text
 bound to the same page slice as the image pane, and the synthesis run detail
 shows the approve button disabled with the explicit reason on runs that cannot
 be approved yet.
- UX: workspace selection checkboxes and bulk delete are localized in all 8
 languages.
### Changed
- The upload-draft reaper is fully configurable via system settings: an
 enabled/disabled toggle (`upload_draft_reaper_enabled`, default "true") and
 a cadence override (`upload_draft_reaper_cron`, default daily 03:00 UTC),
 both managed through `PUT /api/system/settings`. Invalid cron values log a
 warning and fall back to the default cadence instead of failing boot;
 default behavior is unchanged.

### Fixed
- Fixed a Docker production boot crash-loop where server start died with a
 unique-constraint failure on `api_keys.prefix`: the widget API key seeder
 now derives the display prefix from the HMAC digest and tolerates prefix
 collisions (re-check by key hash, warn instead of crash), and API key
 generation retries with a fresh key on a prefix collision (max 3 attempts).
- Chat citations now reflect the sources an answer actually grounds on
 instead of everything the search tools retrieved: after citation
 deduplication, a grounding filter caps citations per document at the top-2
 by relevance score and drops chunk citations whose text shares no
 meaningful lexical overlap with the final answer (conservative gate —
 wiki/archive pages, web/memory results, citations without chunk text, and
 very short answers are always kept). "No further info" replies no longer
 show "Fonti (5)" of one document at ~1.5% relevance; the "No supporting
 evidence" disclaimer is likewise judged on the filtered set (both the
 streaming and non-streaming paths). Citation pipeline only — no UI, i18n,
 or schema change.
- Docker: ollama service healthcheck replaced the `curl` probe (the
 `ollama/ollama` image ships no curl/wget/node — the container reported
 "unhealthy" forever) with an `ollama ls` probe; qdrant healthcheck replaced
 the `wget` probe (image ships no wget/busybox) with a bash `/dev/tcp`
 socket check — both services now report `healthy`. The single-container
 `docker/entrypoint.sh` now sources `provision-encryption-key.sh` (parity
 with the split image): production standalone boots auto-provision
 `ENCRYPTION_KEY` + `API_KEY_HMAC_SECRET` instead of failing the gate. All five Dockerfiles lint clean under hadolint (documented
 unpinned-deps policy + placeholder-ENV waivers).
- DLP audit chronology events no longer show "no match details" when the
 matched content arrived in an early stream chunk: the streaming
 `dlp.output_match` event now derives its match types AND matched-text list
 from the matches accumulated across the whole run (all progressive flushes
 plus the final tail scan) instead of the last chunk scan alone — historical
 rows could store an empty `matchTypes` array while the row still showed a
 match-type badge. Matched text is stored per the DLP filter-plugin
 precedent (`dlp.input_match` / non-streaming `dlp.output_match` already
 carry it); the audit panel is admin-only and Enterprise-gated. The audit
 panel's expanded view now renders the detected type list with a
 "type-only" hint for events that record match types without matches
 (localized in all 8 languages), keeping the "no details" fallback only for
 truly empty metadata.
- Uploaded files remain available for retry: collector terminal status
 callbacks no longer delete staged draft files from
 `storage/uploads/drafts/` (any sibling document's callback could erase the
 file every retry depends on), and `/retry`/`/assign` self-heal by
 restoring the staged file from the persistent OCR copy
 (`storage/ocr-sources/`) when present instead of failing with
 "no longer exists on disk".
- Deleting a failed stale upload draft no longer returns blocked (409) —
 `DELETE /api/uploads/:id` now treats terminal (completed or failed) leg
 states as deletable and only rejects drafts with a genuinely in-flight
 (non-terminal enabled) leg, and the frontend bulk delete uses the same
 in-flight predicate as the filter chips so what the UI offers to delete is
 exactly what the server accepts.
- RAG/KB retry of an upload whose staged draft file is missing now returns a
 clear re-upload error (400) instead of a false success toast, failed
 collector legs no longer delete the draft's staged file from
 `storage/uploads/drafts/` (future retries stay possible — the 24h reaper
 and the DELETE route remain the only draft-file deleters), and retry
 toasts now reflect the per-leg outcome: a rejected leg on HTTP 200 shows
 a localized error toast and bulk retry tallies it as failed.
- Docker production deployments auto-provision a persistent `ENCRYPTION_KEY`
 (server-storage volume, `/app/storage/.encryption-key`) instead of
 crash-looping on the hard default. The server entrypoint
 generates the key once before any Prisma step, restores it on every
 restart/rebuild, prefers an operator-supplied value, and fails loud on a
 corrupt persisted key. `.env.example` and `docs/DEPLOYMENT.md` updated to
 mark the variable Required-in-production. See
 `docs/ENCRYPTION_KEY_ROTATION.md` for the Docker notes.
- KB OCR pages no longer fail when the Ollama vision stream is closed by the
 model engine without the final `done` marker after complete transcription
 (observed with the glm-ocr custom engine): `ocrPage` now salvages the
 accumulated non-empty output as the page result with a `truncated` flag
 and a warning log, instead of discarding a real transcription behind
 "Did not receive done or success response in stream." A done-less stream
 with no content still fails the page.
- OCR job summaries are truthful about page health: pages that end with a
 `[FAILED:` marker are counted and stored as `failedPages` in the job
 result JSON, and completion logs emit a
 `[ocr] Job completed with failed pages` warning, so a COMPLETED job with
 some failed pages is no longer indistinguishable from a clean success
 (zero tokens + floor quality score alone were ambiguous).
- Documented + fixed failure mode for Enterprise deployments: when
 `@simmetric-chat/shared` gains NEW source files, an out-of-date enterprise
 `file:` dependency snapshot can crash the server at boot with
 "Cannot find module './env.schema'" — pnpm snapshots the `file:` package
 into `node_modules/.pnpm` and files created after the last `pnpm install`
 never reach that snapshot (hardlinks only update already-existing files),
 so the snapshot's `schemas/index.js` requires a module that does not exist
 on the enterprise side, and the loader's fail-loud policy turns the plugin
 registration failure into a boot crash loop. The fix ships as
 documentation: the enterprise repo's rebuild runbook now covers the
 reinstall-not-rebuild distinction (refresh the snapshot with
 `pnpm install`, then `pnpm build`), and the air-gap install runbook in
 `docs/ENTERPRISE_PLUGIN.md` gains the matching troubleshooting subsection
 (symptom, cause, fix, sanity check) so operators without the private repo
 still find the remedy.

## [v0.21.0] — 2026-08-28 — Debt Sweep & Release Hygiene (was: v1.5.0)

### Added
- `docs/LICENSE_DECISION.md` — license-model analysis for the dual distribution
 (community + enterprise). **Decision: AGPL-3.0 (community) + proprietary
 commercial (enterprise).**
- `LICENSE` replaced Apache-2.0 → GNU AGPL-3.0 (community repo).
- `LICENSE_EE.md` — proprietary commercial license for the enterprise plugin
 (`@simmetric-chat/enterprise`).
- `NOTICE` — dual-license explanation at repo root.
- `CLA.md` — Contributor License Agreement (v1.0) — copyright + patent grant,
 dual-license-aware. Required for all external contributions.
- AGPL-3.0 copyright headers added to all 981 source files across 5 packages
 (`.ts`/`.tsx`). Applied via `scripts/add-headers.cjs` (idempotent).
- `docs/ENTERPRISE_LICENSE_TERMS.md` — operator-facing commercial/SLA terms for
 enterprise customers.
- `.github/workflows/release.yml` — GitHub Release + GHCR image publish on tag
 push.
- `CHANGELOG.md` (this file) — Keep-a-Changelog format, seeded from milestone
 history.
- `.planning/milestones/v1.5-debt-sweep-ROADMAP.md` — debt-evaluation milestone
 scope (E2E carry-forward, debug sessions, quick-task triage, version-stamp
 sync discipline).

### Changed
- `package.json` version bumped `0.17.0` → `1.4.0` (synced with the latest git
 tag `v1.4`). Per-package versions remain at `0.22.0`/`0.23.0` (private
 packages, not published to any registry).
- `package.json` + all `packages/*/package.json` `license` field set to
 `AGPL-3.0-or-later`.
- `README.md` license badge updated Apache-2.0 → AGPL-3.0; license section
 updated to describe the dual-license model; Contributing section added with
 CLA requirement.
- `CONTRIBUTING.md` updated with CLA signing instructions.

---

## [v0.20.1] — 2026-08-27 — Horizontal Scale (Redis Layer Completion) (was: v1.4)

**Goal:** Close the 4 SCALE deferred items (CSW-19 + SCALE-02/03/04) and prove
horizontal scaling with a real multi-instance integration test — enabling
safe multi-instance server deployment behind a load balancer.

**Shipped:** 7 phases (161–167), 13 plans, 29 tasks. All 22/22 requirements
satisfied. Git tag: `v1.4`.

### Added
- **SCALE-01 (CSW-19):** 3 remaining schedulers lock-wrapped →
 then all 8 migrated to pg-boss cron jobs; `setInterval` +
 `isRunning` + `withDistributedLock` removed from all 8 migrated schedulers.
- **SCALE-02:** `scryptSync` ENCRYPTION_KEY fallback removed in production —
 fail-loud boot (`logger.error` + `process.exit(1)`) + defense-in-depth
 service throw; dev/test preserves scrypt; rotation runbook updated.
- **SCALE-03:** bcrypt-loop API-key verification → keyed-HMAC O(1)
 `findUnique({key_hash})` digest lookup; breaking `DROP COLUMN hashedKey` +
 `ADD COLUMN key_hash` migration; `API_KEY_HMAC_SECRET` env var; operator
 migration runbook `docs/API_KEY_MIGRATION.md`.
- **SCALE-04:** 8 `setInterval` schedulers migrated to **pg-boss**
 (Postgres-backed job queue, air-gap friendly); 2 latency-sensitive 10s
 pollers (OCR + synthesis) stay as `setInterval`; pg-boss singleton
 (`jobQueue.ts`) with graceful degradation.
- **SSE fan-out verification:** cross-instance deferral closed — 4
 mock-based cross-instance tests proving the Redis pub/sub SSE relay
 (A publishes → B relays, origin-skip, teardown, degradation).
- **Operator docs:** `docs/SCALING.md` (377 lines) — multi-instance deployment
 topology, REDIS_URL requirement, pg-boss Postgres dependency, SCALE-02/03
 cross-references, 10s pollers, graceful degradation.

### Breaking changes — operator action required
- **`ENCRYPTION_KEY`** must be set in production `.env` (base64, 32 bytes) or
 the server refuses to boot. See `docs/ENCRYPTION_KEY_ROTATION.md`.
- **API keys** switched from bcrypt (`apiKeyHash`) → HMAC-SHA256 (`key_hash`).
 Operators must re-issue widget/collector API keys. See
 `docs/API_KEY_MIGRATION.md`.

### Infrastructure
- New dependency: `pg-boss` v12.28.0 (server). New env var:
 `API_KEY_HMAC_SECRET`. Boot order changed — pg-boss init is now the 8th
 async init step with a shutdown teardown.

---

## [v0.20.0] — 2026-08-26 — Concerns Sweep (was: v1.3)

**Goal:** Sweep the 2026-08-26 CONCERNS.md audit — fix all easy wins directly,
tackle the medium-effort items in focused phases, and evaluate (defer or
document) the blocking/large-effort points.

**Shipped:** 7 phases (154–160), 14 plans. Brownfield hardening milestone;
no new user-facing features.

### Added
- docs gitignore fix, chat.ts file map, lint rule flips.
- code hardening easy wins (apiKeyMiddleware take:10 cap, etc.).
- frontend lint debt reduction (3 plans, warn→error flips).
- ENCRYPTION_KEY production boot warning (CSW-11) + batched
 title+tags+followUps generation.
- module splits (provider parser extraction, capability
 registries).
- test coverage (chatImportService, chatExportService,
 apiKeyService, 5 remaining services; collector + widget wired into root
 jest config).
- evaluate & document (.env license JWT entitlements, license
 signing key rotation runbook, stale AGENTS.md claim fix).

---

## [v0.19.1] — 2026-08-25 — Refinements (was: v1.2)

**Goal:** Branding, AI disclaimer, TypeScript reimplementation of the wiki
graph algorithm, RAG search fixes, MCP hardening, Setup Wizard first-run.

**Shipped:** 6 phases (149–153 + 153.1).

### Added
- **BRAND-01/02:** SVG S-monogram favicon, reusable Monogram component,
 muted localized AI disclaimer below every assistant message (7 locales).
- **MCP-01/02/03:** MCP hardening — per-session SSE transport Map,
 MCP_API_KEY Bearer auth gate, list_workspaces IDOR closed,
 getMCPToolsForWorkspace wired into resolveSkillsForChat.
- **RAG-01/02/03:** FTS locale fix (multi-locale tokenisation for
 it/ru/de/es/fr/zh), deduplication of fallback results rag_search↔wiki_query,
 LLM affordance prompt for rag_search vs wiki_query.
- **WIKI-01:** TypeScript reimplementation of the Graphify wiki algorithm
 (community detection + wiki markdown generation, Apache-2.0 clean
 reimplementation, ~280 LOC Python → TS).
- **WIZ-01/02:** Setup Wizard first-run UI (multi-step: admin account +
 provider config + vector DB, consume /api/system/initialize);
 SEED_BOOTSTRAP_ADMIN disabled when the wizard is active.
- .1: v1.2 tech debt cleanup (React Compiler warn→error flip).

---

## [v0.19.0] — 2026-08-19 — Enterprise Plugin Architecture (was: v1.1)

**Goal:** Refactor the licensing model from "runtime feature flags in the
public source" to a "separate private enterprise plugin": enterprise features
(SSO, audit log, white-label, backup) live in a private package delivered
only to paying customers; the community repo contains no enterprise feature
code. Commodity features become always-ON in community.

**Shipped:** 9 phases (140–148), 19 plans, 26 tasks.

### Added
- **EPA-01:** `PluginContext`/`EnterprisePlugin` types in shared; loader seam
 `loadEnterprisePlugin(app)` / `shutdownEnterprisePlugin()` with two-step
 `require.resolve`→`require` (MODULE_NOT_FOUND = community no-op, other
 errors = `process.exit(1)` fail-loud).
- **EPA-02:** 9 commodity flags removed from `FEATURE_FLAGS` (20→10):
 web_search, webhooks, push_notifications, memory, lead_export,
 widget_analytics, auto_title, synthesis_rate_limit. Commodity routes
 always-ON.
- **EPA-03:** SSO (SAML + OIDC + SCIM 2.0) extracted to enterprise plugin.
- **EPA-04:** Audit log (immutable `event_log` table + INSERT-only DB role)
 extracted to enterprise plugin.
- **EPA-05:** White-label branding (config-key validator IoC hook) extracted
 to enterprise plugin.
- **EPA-06:** Backup (~1400 LOC: backupService, provider registry, Bree
 scheduler, restore, routes, UI) extracted to enterprise plugin.
- **EPA-07:** `overrideFeatureLimit` resolver with reactive revocation;
 `GET /api/enterprise/modules` manifest; `React.lazy` conditional loading
 of 4 enterprise panels.
- **EPA-08/09/10:** `priority_support` removed; `custom_agents` = numeric
 limit (community 3, enterprise Infinity); `licensePayloadSchema`
 byte-identical (RS256).
- **EPA-12:** docs/env alignment (`docs/ENTERPRISE_PLUGIN.md`, docker-compose
 volume mount, `.env.example` split), air-gap CI profile (grep gate on
 license service for HTTP primitives).

---

## [v0.18.0] — 2026-08-12 — Public Release candidate (simmetric-chat) (was: v1.0)

**Goal:** Prepare and publish the project as a clean public repo, renamed to
**simmetric-chat**, without secrets/personal data/local paths, with dependency
license verification, enterprise keygen tool (separate, not published), and
complete documentation.

**Shipped:** 8 phases (132–139), 12 plans, 16 tasks. Public repo published,
rename complete, license audit, enterprise keygen (HS256 → migrated to RS256
post-v1.0), canonical docs, CI GitHub Actions, fresh repo.

---

## [v0.20] — 2026-08-11 — Widget UX, i18n & Reliability

**Shipped:** 7 phases (125–131), 32 plans, 75 tasks, 16/16 requirements
satisfied.

### Added
- **WID-ADMIN:** Widget create/edit tabbed subpage (`/widgets/:id` +
 `/widgets/new`), live preview pane, dirty-guard, leads tab.
- **WID-I18N:** JSON-block transport (kills `%20` bug), visitor→widget-default→en
 fallback chain, 7-locale chrome + content localization, locale threading
 widget→proxy→server→orchestrator.
- **WID-QUEST:** Tri-state suggested questions (Default/None/Custom), 7 locale
 groups, line-clamp overflow fix.
- **WID-CREDITS:** Footer credits + AI badge, white-label gated removal,
 real-embed popup relay verified.
- **WID-BUGS:** 44px input buttons, host-FAB round-trip, SVG-only icon
 contract, contact banner, wiki loop, lead persistence, RAG-degraded i18n.

---

## [v0.19] — 2026-08-08 — Diagnostics & Debt

**Shipped:** 5 phases (120–124). License diagnostics (boot logs, admin-only
diagnose endpoint, `pnpm license:check` script), test debt (ESM drift,
LoginPage QueryClientProvider, fixture shape spec), tech debt evaluation
(Redis scale layer spike — deferred to v1.4).

---

## [v0.18] — 2026-08-04 — Stabilization

**Shipped:** 4 phases (116–119).

---

## [v0.17] — 2026-08-02 — Enterprise & Polish

**Shipped:** 8 phases (108–115).

---

Earlier milestones (v0.1–v0.16) are documented in `.planning/PROJECT.md`
(Milestone History section). The full phase-level history lives in
`.planning/MILESTONES.md`.