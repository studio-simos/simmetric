# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary buyer/administrator:** IT / platform owners of self-hosting organizations (companies, teams, public bodies) who deploy Simmetric Chat themselves — Docker/Compose, Coolify, or fully air-gapped — and administer workspaces, roles, providers, and integrations.
- **Primary end users:** members of those organizations who work in the app daily: private RAG chat with their org's documents, model switching, document upload/OCR, archives/knowledge bases. Role tiers in-app: Superuser, Admin, User.
- **Secondary audience:** solo technical users running everything locally on one machine (Ollama + local vector DB). Community build must feel first-class to them even without the enterprise license.

## Product Purpose

A local-first, air-gap-capable AI chat workspace: multi-provider LLM chat with retrieval-augmented generation (citations, OCR ingestion, archives with wikilinks, AI synthesis), RBAC, embeddable chat widgets, and an MCP marketplace. It exists so organizations can give their members AI chat over private knowledge without sending data to third parties. Success means: an org deploys it once (no phone-home, no telemetry), members adopt it as their daily private chat surface, and it passes their compliance/security review.

## Positioning

Privacy plus enterprise-grade control: private/local model execution, real RBAC, soft deletes, audit logging, SSO, license-gated enterprise modules, and air-gap install with zero telemetry. A neighboring open-source chat UI (e.g. Open WebUI, LibreChat) could not truthfully claim the same depth of organization-grade control combined with the air-gap-capable, plugin-isolated enterprise architecture.

## Operating Context

- Deployment: Docker/Coolify server-side, Tauri desktop shell as an alternative; production frontend served same-origin behind a reverse proxy.
- Daily workflows: chat with SSE streaming and citation panels; model comparison (side-by-side); document upload → parse/OCR → chunk/embed pipeline with processing status; admin settings across providers, roles, users, vector DB, backups, DLP; MCP marketplace install/pin; widget creation and embed-code generation.
- Localization: 8 locales (en, it, ru, de, fr, es, zh, pt) with strict parity enforced in CI; language persisted per user.
- Licensing tiers: Community (default fallback) vs Enterprise (license JWT unlocks SSO, audit, branding, backup, widgets and more); UI degrades gracefully to community.

## Capabilities and Constraints

Confirmed functionality:

- Multi-workspace RAG chat with SSE streaming, per-chat model persistence, model fallback, `/model` slash command, Cmd+K model palette, two-pane model comparison.
- Citations with source panel; document management with OCR pipeline and job approval flow; archives (multi-page knowledge bases with wikilinks and graph view); admin-only synthesis runs.
- RBAC: 13 menu sections filtered by role; permission-gated endpoints (server-side) drive UI gating.
- MCP marketplace browsing/install/pinning; widget admin + embeddable widget service.
- Theme system: light/dark via `.dark` class + CSS custom properties; UI font scale and density preferences applied pre-paint (FOUC-safe).

Constraints future work must respect:

- **Strict i18n parity**: every new UI string must exist in all 8 locales; `pnpm i18n:check` fails CI on any gap (namespaced list in `packages/frontend/package.json` is the source of truth).
- **Theme tokens**: components must use CSS custom properties (`bg-[var(--surface)]`, `text-[var(--text-muted)]`), not raw Tailwind palette colors for themeable surfaces.
- **RBAC-driven UI**: sidebar sections and settings sections render per `menuSections`/license features; enterprise-only UI must render a locked/upgrade state, never a broken state, in community tier.
- **No silent data loss**: settings saves may partially reject (`{ updated, rejected }`); destructive actions are soft deletes; upload/drop zones disabled while streaming.

Undecided facts (recorded, not invented):

- Whether the widget bundle (`packages/widget`) is treated as a separate design surface with its own brief — likely, but not yet decided.

## Brand Commitments

None binding. Confirmed by the product owner (2026-09-21): the name "Simmetric Chat" and existing logo assets are not contractual constraints; no typography, palette, or visual direction is pinned. Future design work may propose a replacement visual world, but must preserve product truth, information architecture, and the technical constraints above.

## Evidence on Hand

- Extensive internal technical documentation in `docs/` (ARCHITECTURE, DEPLOYMENT, ENTERPRISE_PLUGIN, TESTING, WIDGET, MCP_MARKETPLACE, WIKI_SCHEMA_LAYER, and more) and `packages/frontend/AGENTS.md`.
- Working, mature SPA implementation (`packages/frontend/src`) with an incumbent token-based theme system in `index.css`.
- No customer testimonials, case studies, benchmarks, press, or marketing proof assets exist. Future work must not fabricate any of these; do not invent pricing or deployment-scale claims.

## Product Principles

1. **Privacy is the default, not a setting.** Nothing leaves the deployment unless the operator configures it; local providers are first-class peers of cloud ones.
2. **Operate over ornament.** Users are completing work; scanability, consistency, and predictable behavior outrank expression. Brand lives in precise details.
3. **Degrade gracefully.** Community tier must feel complete and honest; gated features show clear upgrade paths, never dead ends or broken UI.
4. **Trust through transparency.** Processing states, errors, and fallbacks are surfaced truthfully (document status, model fallback notices, citation sources are visible).
5. **Reachable by everyone.** 8-locale parity, keyboard navigation, WCAG AA contrast in both themes, adequate touch targets are floor requirements, not enhancements.

## Accessibility & Inclusion

- Required standard: WCAG AA for normal text in both light and dark themes.
- Established patterns that must persist: full keyboard navigation (palette/comparison/dialogs follow WAI-ARIA patterns with focus return), visible focus rings, `aria-live` toast announcements, ≥44px touch targets, ARIA roles on overlays (dialog, listbox, option).
- Known user needs: screen-reader users, keyboard-only users, users on mobile/notched devices (safe-area handling), non-English users across 8 locales.