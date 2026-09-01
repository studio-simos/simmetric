// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * synthesisStages.ts — SYNTH-01 pipeline body (MOD-04 extraction target)
 *
 * Single stage-grouped module (D-06 — NOT a directory of one file per stage)
 * with 4 pipeline-phase groups mirroring the existing 7-sibling pattern:
 *   1. Setup     — SynthesisRun create/update + BudgetTracker + getSynthesisConfig
 *                  + recordLlmFailure + PASS_NAMES + abort counters
 *   2. Collection — Pass 1 entity extraction + Pass 2 generatePageSummary +
 *                    Pass 3 candidate-slug $queryRaw
 *   3. Decision  — Pass 4 parseDecisionJson + newPageSlugs + persona prompt +
 *                    newPagesCollected accumulator
 *   4. Persist   — Pass 4b detectContradictions + Pass 5 write/finalize
 *
 * The 7 existing `synthesis*Service.ts` siblings are IMPORTED via dynamic
 * require for Bree worker compatibility (NOT re-implemented — RESEARCH Don't
 * Hand-Roll, D-06).
 *
 * `callSynthesisLLM` stays NON-STREAMING (RESEARCH Pitfall 6 — uses
 * `callNonStreamingLLM` from `../../providerService`, never any streaming
 * transport).
 *
 * Public surface (exported for the facade to delegate):
 *   - `runPipelineStages` — the single pipeline entry
 *   - `callSynthesisLLMStage` — non-streaming LLM call (Pitfall 6)
 *   - `getSynthesisConfigStage` — per-archive config merge
 *   - `defaultRunNameStage` — deterministic run name
 *
 * Local interfaces `SynthesisChangeEntry` / `SynthesisResultRow` /
 * `SynthesisArchivePage` are re-defined locally (no external importer relies
 * on re-exports from `synthesisService.ts`; `synthesisPageWriter.ts` has its
 * own local definitions — verified by grep, see plan acceptance criteria).
 */

import { Prisma } from "@prisma/client";
import { logger } from "../../utils/logger";
import prisma from "../../utils/prisma";
import { getEnv } from "../../config/env";
import { getSynthesisOverrides } from "../archiveConfigService";
import { callNonStreamingLLM, resolveProviderConfig } from "../providerService";
import { MULTI_CONFIG_PLAINTO_TSQUERY } from "../ftsService";

// Type-only imports from shared (no runtime cost)
import type { SynthesisConfidence, SynthesisPreview } from "@simmetric-chat/shared";

// Type-only imports from local services (no runtime cost; the runtime
// instances are loaded via dynamic require inside runPipelineStages for
// Bree worker compatibility).
import type { BudgetTracker } from "../synthesisBudgetService";
import type { ArchivePage, SynthesisContradictionItem } from "../synthesisContradictionService";

// ============================================================================
// Local typed shapes for the synthesis pipeline accumulators (D-08).
// Mirrors the local interfaces in synthesisService.ts (Phase 87 typed them
// in-place, not re-exported). No external importer relies on these — kept
// local to avoid churn.
// ============================================================================

interface SynthesisChangeEntry {
  pageSlug: string;
  action: "create" | "update" | "skip";
  category: string;
  title: string;
  currentContent?: string;
  proposedContent: string;
  confidence: SynthesisConfidence;
  sources: Array<{ fileName: string; ingestDate: string }>;
  approved: boolean;
}

interface SynthesisResultRow {
  slug: string;
}

/**
 * Minimal ArchivePage shape used by the pipeline for the dynamically-required
 * `getPages`/`getPage` returns (which are `any` because they come through
 * `require()`). Mirrors the local interface in synthesisService.ts.
 */
interface SynthesisArchivePage {
  id: string;
  archiveId: string;
  slug: string;
  title: string;
  bodyText: string;
  frontmatter: unknown;
  category: string | null;
  createdAt: Date;
  createdBy: string;
  wikilinks: string[];
  updatedAt: Date;
}

// ============================================================================
// Inter-stage handoff context objects (D-10-style typed context — keeps the
// stage boundary an explicit contract instead of long positional params).
// ============================================================================

interface SetupCtx {
  runId: string;
  archiveId: string;
  userId: string;
  tracker: BudgetTracker;
  synthConfig: {
    linkingDensity: { min: number; max: number };
    agentPersona: string;
    maintenanceSchedule: string;
    purpose: string;
    scope: string;
  };
  PASS_NAMES: {
    pass1: string;
    pass2: string;
    pass3: string;
    pass4: string;
    pass4b: string;
    pass5: string;
  };
  // Abort counters + recordLlmFailure (shared mutable state across stages).
  consecutiveLlmFailures: number;
  totalLlmFailures: number;
  MAX_CONSECUTIVE_LLM: number;
  MAX_TOTAL_LLM: number;
  pipelineError: string | null;
  recordLlmFailure: (pageSlug: string, passName: string, err: unknown) => boolean;
  // Output accumulators (mutated by collection/decision/persist).
  pagesRead: number;
  pagesWritten: number;
  contradictions: SynthesisContradictionItem[];
  changes: SynthesisChangeEntry[];
}

interface CollectionResult {
  allPages: SynthesisArchivePage[];
  entities: Set<string>;
  summaries: Map<string, string>;
  candidateSlugs: Set<string>;
}

interface DecisionResult {
  newPagesCollected: ArchivePage[];
}

// ============================================================================
// callSynthesisLLMStage — non-streaming LLM call for synthesis (D-09, Pitfall 6)
// ============================================================================

export async function callSynthesisLLMStage(
  prompt: string,
  systemPrompt?: string,
  archiveId?: string,
): Promise<{ content: string; tokensUsed: number }> {
  // ── D-15 PHI gate (pre-egress) ────────────────────────────────────────
  // When an archive's ArchiveConfig.config.localLLMOnly is true AND the
  // resolved synthesis provider is NOT ollama, the run must abort BEFORE
  // any prompt/messages construction — RESEARCH Pitfall 1. The flag is
  // populated in production by Task 3's propagation
  // (archiveLocalLLMOnlyPropagation.ts), so the gate is not dead code.
  if (archiveId) {
    const cfg = await prisma.archiveConfig.findUnique({
      where: { archiveId },
      select: { config: true },
    });
    const localLLMOnly = (cfg?.config as Record<string, unknown> | null | undefined)?.localLLMOnly === true;
    if (localLLMOnly) {
      // Dynamic require for Bree compatibility per server CLAUDE.md
      const { getSetting } = require("../../services/systemConfigService");
      const providerIdEntry = await getSetting("SYNTHESIS_LLM_PROVIDER_ID");
      if (providerIdEntry?.value) {
        const resolved = await resolveProviderConfig(providerIdEntry.value);
        if (resolved && resolved.type !== "ollama") {
          logger.error("[synthesis] PHI gate aborted", {
            module: "synthesis",
            event: "phi_gate_abort",
            archiveId,
            providerType: resolved.type,
            templateLocalLLMOnly: true,
          });
          throw new Error("Archive template requires local LLM; external provider configured (PHI gate).");
        }
      }
    }
  }

  const env = getEnv();

  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: prompt });

  // 1. Try DB-backed provider config (SYNTHESIS_LLM_PROVIDER_ID + SYNTHESIS_LLM_MODEL)
  try {

    const { getSetting } = require("../../services/systemConfigService");
    const providerId = await getSetting("SYNTHESIS_LLM_PROVIDER_ID");
    const model = await getSetting("SYNTHESIS_LLM_MODEL");

    if (providerId && providerId.value) {
      const resolved = await resolveProviderConfig(
        providerId.value,
        model?.value || undefined,
      );
      if (resolved) {
        const result = await callNonStreamingLLM(resolved, messages);
        return result;
      }
    }
  } catch (err: unknown) {
    logger.warn("[synthesis] Failed to resolve provider from DB config, falling back to env vars", {
      error: (err instanceof Error ? err.message : String(err)),
    });
  }

  // 2. Fallback: env-var-based Ollama (backward compatibility)
  const model = env.SYNTHESIS_LLM_MODEL || env.LLM_MODEL;
  const baseUrl = env.OLLAMA_BASE_URL || "http://ollama:11434";

  const fallbackConfig = {
    type: "ollama" as const,
    baseUrl,
    apiKey: null as string | null,
    model,
    displayName: null as string | null,
    temperature: 0.7,
    isLocal: true,
  };

  return callNonStreamingLLM(fallbackConfig, messages);
}

// ============================================================================
// getSynthesisConfigStage — per-archive overrides with fallback defaults
// ============================================================================

export async function getSynthesisConfigStage(archiveId: string) {
  const overrides = await getSynthesisOverrides(archiveId);
  return {
    linkingDensity: overrides?.linkingDensity || { min: 0.005, max: 0.15 },
    agentPersona: overrides?.agentPersona || "balanced",
    maintenanceSchedule: overrides?.maintenanceSchedule || "0 2 * * 0", // weekly Sundays at 2am
    purpose: overrides?.purpose || "",
    scope: overrides?.scope || "",
  };
}

// ============================================================================
// Pass 2 helper — extract a 1-2 sentence summary from page bodyText
// (moved into the Collection group — D-06)
// ============================================================================

async function generatePageSummary(
  bodyText: string,
  tracker: BudgetTracker,
  passName: string,
  archiveId: string,
  onLlmFailure?: () => void,
): Promise<string> {
  if (!tracker.canContinue(passName)) {
    logger.warn("[synthesis] Budget exhausted before summary generation");
    return "";
  }

  const excerpt = bodyText.slice(0, 2000);
  const prompt = `Summarize this text in 1-2 sentences focusing on key facts and claims. Text: ${excerpt}`;

  try {
    const { content, tokensUsed } = await callSynthesisLLMStage(prompt, undefined, archiveId);
    tracker.consumeTokens(tokensUsed, passName);
    tracker.consumeLlmCall(passName);
    return content.trim();
  } catch (err: unknown) {
    // D-13: surface the failure to the caller so abort counters can trip.
    if (onLlmFailure) onLlmFailure();
    logger.warn("[synthesis] Pass 2 LLM call failed for summary generation", {
      error: (err instanceof Error ? err.message : String(err)),
    });
    return "";
  }
}

// ============================================================================
// Pass 4 helper — parse LLM decision JSON into a structured change object
// (moved into the Decision group — D-06)
// ============================================================================

function parseDecisionJson(
  rawContent: string,
  _pageSlug: string,
  _category: string,
  _title: string,
): {
  decision: string;
  reason: string;
  suggestedContent: string;
  confidence: SynthesisConfidence;
} {
  try {
    // Try direct JSON parse
    const parsed = JSON.parse(rawContent);
    return {
      decision: parsed.decision || "SKIP",
      reason: parsed.reason || "",
      suggestedContent: parsed.suggestedContent || "",
      confidence: parsed.confidence || "MEDIUM",
    };
  } catch {
    // Try extracting JSON block from markdown
    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          decision: parsed.decision || "SKIP",
          reason: parsed.reason || "",
          suggestedContent: parsed.suggestedContent || "",
          confidence: parsed.confidence || "MEDIUM",
        };
      } catch {
        // Fall through
      }
    }
  }

  return {
    decision: "SKIP",
    reason: "Failed to parse LLM response",
    suggestedContent: "",
    confidence: "LOW",
  };
}

// ============================================================================
// Setup group — formatRunDate + defaultRunNameStage
// (formatRunDate is used by defaultRunName — D-06 puts both in the Setup group)
// ============================================================================

/**
 * Format a Date as `DD/MM/YYYY HH:mm` in the server's local timezone.
 *
 * The Prisma `@default(now())` on SynthesisRun.createdAt stores a timestamp
 * without timezone conversion, so the helper must format using local time
 * to match what the DB would store. Kept manual to avoid pulling a runtime
 * dependency into the synthesis module (no `date-fns` / `Intl.DateTimeFormat`
 * formatting differences across Node builds).
 */
function formatRunDate(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getFullYear());
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

/**
 * Compute the default name for a SynthesisRun at creation time (D-11).
 *
 *   "Sintesi · {archive.name || "Senza nome"} · {DD/MM/YYYY HH:mm}"
 *
 * The same-day disambiguation between two runs on the same archive is
 * carried by the `HH:mm` component — two calls with different `createdAt`
 * times produce different names. Exported (as `defaultRunNameStage`) for
 * the facade to delegate.
 */
export function defaultRunNameStage(
  archive: { name: string | null },
  createdAt: Date,
): string {
  const archiveName = archive.name && archive.name.length > 0 ? archive.name : "Senza nome";
  return `Sintesi · ${archiveName} · ${formatRunDate(createdAt)}`;
}

/**
 * Compute the default name for a wiki-graph SynthesisRun at creation time
 * (WR-05 — dedupes the inline `dd/mm/yyyy hh:mm` + `Senza nome` fallback
 * that the `/trigger-graph-wiki` route previously hand-rolled). Mirrors
 * `defaultRunNameStage` exactly except for the `Wiki Graph ·` prefix (vs
 * `Sintesi ·`), so the two run kinds are distinguishable in the UI list.
 *
 *   "Wiki Graph · {archive.name || "Senza nome"} · {DD/MM/YYYY HH:mm}"
 *
 * Exported (as `defaultWikiGraphRunNameStage`) for the facade to delegate.
 */
export function defaultWikiGraphRunNameStage(
  archive: { name: string | null },
  createdAt: Date,
): string {
  const archiveName = archive.name && archive.name.length > 0 ? archive.name : "Senza nome";
  return `Wiki Graph · ${archiveName} · ${formatRunDate(createdAt)}`;
}

// ============================================================================
// Stage 1 — Setup
// ============================================================================

async function runSynthesisSetupStage(
  archiveId: string,
  userId: string,
  existingRunId?: string,
): Promise<SetupCtx> {
  // Dynamic imports for Bree compatibility — lazy-load services at call time.
  // Paths are `../../` because this module lives in `services/synthesis/`.

  const { BudgetTracker, loadBudgetConfig } = require("../../services/synthesisBudgetService");

  const PASS_NAMES = {
    pass1: "pass1",
    pass2: "pass2",
    pass3: "pass3",
    pass4: "pass4",
    pass4b: "pass4b_contradiction",
    pass5: "pass5",
  };

  // ── Use existing or create SynthesisRun record ──────────────────────────
  let runId: string;

  if (existingRunId) {
    // Scheduler path: update the already-claimed PENDING run
    // D-14: refresh expiresAt on the PROCESSING transition so the reaper
    // window resets if the run is retried manually.
    await prisma.synthesisRun.update({
      where: { id: existingRunId },
      data: {
        status: "PROCESSING",
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      },
    });
    runId = existingRunId;
  } else {
    // Direct invocation path (e.g., manual trigger): create new run
    // D-14: set expiresAt = now + 2h so the in-process reaper can flip
    // an orphaned PROCESSING run (crash recovery) to FAILED.
    // D-11: compute a human-readable name at creation time so the run row
    // is readable in the UI before the user renames it. Fetch the archive
    // name first (mirror routes/synthesis.ts:85); fall back to "Senza nome"
    // if the archive lookup fails (defensive — should not happen since the
    // pipeline is only invoked on an existing archive).
    let archiveName: string | null = null;
    try {
      const archiveRow = await prisma.archive.findFirst({
        where: { id: archiveId },
        select: { name: true },
      });
      archiveName = archiveRow?.name ?? null;
    } catch (archiveLookupErr) {
      logger.error("[synthesis] archive lookup for default name failed", {
        archiveId,
        error: archiveLookupErr instanceof Error ? archiveLookupErr.message : String(archiveLookupErr),
      });
    }
    const run = await prisma.synthesisRun.create({
      data: {
        archiveId,
        status: "PROCESSING",
        createdBy: userId,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
        name: defaultRunNameStage({ name: archiveName }, new Date()),
      },
    });
    runId = run.id;
  }
  const budgetConfig = loadBudgetConfig(archiveId);
  const tracker = new BudgetTracker(budgetConfig);

  const synthConfig = await getSynthesisConfigStage(archiveId);

  // ── D-13 abort counters (mirror Fase 62 D-03 breaker) ─────────────────
  // 3 consecutive LLM failures OR 5 total LLM failures abort the pipeline
  // with an explicit FAILED status + partial preview. The consecutive
  // counter resets on any successful LLM call; the total counter is monotonic.
  const MAX_CONSECUTIVE_LLM = 3;
  const MAX_TOTAL_LLM = 5;

  const ctx: SetupCtx = {
    runId,
    archiveId,
    userId,
    tracker,
    synthConfig,
    PASS_NAMES,
    consecutiveLlmFailures: 0,
    totalLlmFailures: 0,
    MAX_CONSECUTIVE_LLM,
    MAX_TOTAL_LLM,
    pipelineError: null,
    pagesRead: 0,
    pagesWritten: 0,
    contradictions: [],
    changes: [],
    recordLlmFailure: (pageSlug: string, passName: string, err: unknown): boolean => {
      ctx.consecutiveLlmFailures++;
      ctx.totalLlmFailures++;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("[synthesis] LLM call failed", {
        pass: passName,
        pageSlug,
        consecutive: ctx.consecutiveLlmFailures,
        total: ctx.totalLlmFailures,
        error: message,
      });
      if (ctx.consecutiveLlmFailures >= ctx.MAX_CONSECUTIVE_LLM || ctx.totalLlmFailures >= ctx.MAX_TOTAL_LLM) {
        ctx.pipelineError = `Aborted: ${ctx.consecutiveLlmFailures >= ctx.MAX_CONSECUTIVE_LLM ? "3 consecutive" : "5 total"} LLM failures`;
        return true;
      }
      return false;
    },
  };

  return ctx;
}

// ============================================================================
// Stage 2 — Collection (Pass 1 + Pass 2 + Pass 3)
// ============================================================================

async function runSynthesisCollectionStage(setup: SetupCtx): Promise<CollectionResult> {
  // Dynamic require for Bree compatibility (path adjusted for services/synthesis/).
  const { getPages } = require("../../services/archivePageService");

  const { archiveId, PASS_NAMES, tracker, recordLlmFailure } = setup;

  // ====================================================================
  // Pass 1 — Entity Extraction
  // ====================================================================
  logger.info("[synthesis] Pass 1: entity_extraction started", { archiveId, runId: setup.runId });

  // Phase 155 / CSW-06 (D-07): getPages now defaults to take=500 to bound
  // unbounded archivePage loads. Synthesis's entity-extraction pass needs ALL
  // pages in the archive (it walks every page for entity extraction), so pass
  // an explicit large take that preserves the pre-bounding behavior. This is a
  // batch job (Bree worker), not a request handler — the OOM risk profile is
  // different from the UI list route. The high limit mirrors the prior
  // unbounded findMany while staying a finite, auditable bound.
  const SYNTHESIS_PAGES_TAKE = 100000;
  const allPages: SynthesisArchivePage[] = await getPages(archiveId, undefined, SYNTHESIS_PAGES_TAKE);
  setup.pagesRead = allPages.length;

  const entities = new Set<string>();

  for (const page of allPages) {
    if (!tracker.canContinue(PASS_NAMES.pass1)) {
      logger.warn("[synthesis] Budget exhausted during Pass 1");
      break;
    }

    const excerpt = page.bodyText.slice(0, 1500);
    const prompt =
      `Extract all entities (people, organizations, concepts, technologies, events) from this text. Return as a JSON array of strings. Text: ${excerpt}`;

    let content: string;
    let tokensUsed: number;
    try {
      const result = await callSynthesisLLMStage(prompt, undefined, archiveId);
      content = result.content;
      tokensUsed = result.tokensUsed;
      tracker.consumeTokens(tokensUsed, PASS_NAMES.pass1);
      tracker.consumeLlmCall(PASS_NAMES.pass1);
      // D-13: reset consecutive counter on success — scattered failures
      // must not trip the consecutive threshold.
      setup.consecutiveLlmFailures = 0;
    } catch (err: unknown) {
      if (recordLlmFailure(page.slug, PASS_NAMES.pass1, err)) {
        break;
      }
      continue;
    }

    if (content) {
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          for (const entity of parsed) {
            if (typeof entity === "string" && entity.trim()) {
              entities.add(entity.trim());
            }
          }
        }
      } catch {
        // Try array extraction from text: look for [...] patterns
        const arrayMatch = content.match(/\[[\s\S]*?\]/);
        if (arrayMatch) {
          try {
            const parsed = JSON.parse(arrayMatch[0]);
            if (Array.isArray(parsed)) {
              for (const entity of parsed) {
                if (typeof entity === "string" && entity.trim()) {
                  entities.add(entity.trim());
                }
              }
            }
          } catch {
            // Skip unparseable responses
          }
        }
      }
    }
  }

  logger.info("[synthesis] Pass 1 complete", {
    archiveId,
    runId: setup.runId,
    entitiesFound: entities.size,
    pagesRead: allPages.length,
  });

  // ====================================================================
  // Pass 2 — Summary Generation
  // ====================================================================
  logger.info("[synthesis] Pass 2: summary_generation started", { archiveId, runId: setup.runId });

  const summaries = new Map<string, string>();

  for (const page of allPages) {
    // Only process pages without synthesis_generation in frontmatter
    // or recently ingested (within accumulation window)
    const fm = page.frontmatter as Record<string, unknown> | null;
    const hasSynthesisGen = fm && typeof fm.synthesis_generation === "number";

    if (!hasSynthesisGen) {
      if (!tracker.canContinue(PASS_NAMES.pass2)) {
        logger.warn("[synthesis] Budget exhausted during Pass 2");
        break;
      }

      let pass2Aborted = false;
      const summary = await generatePageSummary(
        page.bodyText,
        tracker,
        PASS_NAMES.pass2,
        archiveId,
        () => {
          if (recordLlmFailure(page.slug, PASS_NAMES.pass2, new Error("Pass 2 LLM call failed"))) {
            pass2Aborted = true;
          }
        },
      );
      if (pass2Aborted) {
        break;
      }
      if (summary) {
        summaries.set(page.slug, summary);
        // D-13: reset consecutive counter on a successful summary call
        setup.consecutiveLlmFailures = 0;
      }
    }
  }

  logger.info("[synthesis] Pass 2 complete", {
    archiveId,
    runId: setup.runId,
    summariesGenerated: summaries.size,
  });

  // D-13: if Pass 1 or Pass 2 tripped the abort threshold, short-circuit
  // to the persistence path by throwing a sentinel. The outer catch
  // detects the sentinel and preserves the existing pipelineError
  // (the abort reason) instead of overwriting it with the sentinel.
  if (setup.pipelineError) {
    throw new Error(`__D13_ABORT__${setup.pipelineError}`);
  }

  // ====================================================================
  // Pass 3 — BM25 Candidate Search (PostgreSQL tsvector)
  // ====================================================================
  logger.info("[synthesis] Pass 3: candidate_search started", { archiveId, runId: setup.runId });

  const candidateSlugs = new Set<string>();

  for (const entity of entities) {
    if (!tracker.canContinue(PASS_NAMES.pass3)) {
      logger.warn("[synthesis] Budget exhausted during Pass 3");
      break;
    }

    if (entity.length < 2) continue;

    try {
      const results: Array<SynthesisResultRow> = await prisma.$queryRaw<Array<SynthesisResultRow>>`
        SELECT slug FROM archive_pages
        WHERE "archiveId" = ${archiveId}
          AND "searchVectorMulti" @@ (SELECT ${Prisma.raw(MULTI_CONFIG_PLAINTO_TSQUERY)} FROM (SELECT ${entity}::text AS q) AS q)
          AND "deletedAt" IS NULL
      `;

      for (const row of results) {
        if (row.slug) {
          candidateSlugs.add(String(row.slug));
        }
      }
    } catch (err: unknown) {
      logger.warn("[synthesis] Pass 3 tsvector search failed for entity", {
        entity,
        error: (err instanceof Error ? err.message : String(err)),
      });
    }
  }

  logger.info("[synthesis] Pass 3 complete", {
    archiveId,
    runId: setup.runId,
    candidatesFound: candidateSlugs.size,
  });

  return { allPages, entities, summaries, candidateSlugs };
}

// ============================================================================
// Stage 3 — Decision (Pass 4)
// ============================================================================

async function runSynthesisDecisionStage(
  setup: SetupCtx,
  collection: CollectionResult,
): Promise<DecisionResult> {
  // Dynamic require for Bree compatibility (path adjusted for services/synthesis/).
  const { getPage } = require("../../services/archivePageService");

  const { archiveId, PASS_NAMES, tracker, recordLlmFailure, synthConfig } = setup;
  const { allPages, summaries, candidateSlugs } = collection;

  // ====================================================================
  // Pass 4 — LLM Decision
  // ====================================================================
  logger.info("[synthesis] Pass 4: llm_decision started", { archiveId, runId: setup.runId });

  const newPageSlugs = new Set(
    allPages
      .filter((p: SynthesisArchivePage) => {
        const fm = p.frontmatter as Record<string, unknown> | null;
        return !(fm && typeof fm.synthesis_generation === "number");
      })
      .map((p: SynthesisArchivePage) => p.slug),
  );

  // Pass 4b (D-06): collect ArchivePage objects for candidates whose
  // decision was non-SKIP with non-empty suggestedContent (after the D-03
  // guard). These are the "new/modified" pages the contradiction pass pairs
  // against the existing archive pages.
  const newPagesCollected: ArchivePage[] = [];

  for (const pageSlug of candidateSlugs) {
    if (!tracker.canContinue(PASS_NAMES.pass4)) {
      logger.warn("[synthesis] Budget exhausted during Pass 4");
      break;
    }

    try {
      const page = await getPage(archiveId, pageSlug);
      const summary = summaries.get(pageSlug) || "";
      const newContentSummary = summary || page.bodyText.slice(0, 500);

      const personaPrompt =
        synthConfig.agentPersona === "conservative"
          ? " Be strict: only update if the new content adds verifiable facts."
          : synthConfig.agentPersona === "exploratory"
            ? " Be creative: suggest new links and connections even if speculative."
            : " Be balanced: update when new content meaningfully improves the page.";

      const prompt =
        `Given this new content: "${newContentSummary}", and this existing page content: "${page.bodyText.slice(0, 1500)}", decide: CREATE (new page needed), UPDATE (enhance existing), SKIP (no changes needed), or FLAG_CONTRADICTION (conflict detected).${personaPrompt} Return JSON: { decision: string, reason: string, suggestedContent?: string, confidence?: string }`;

      const { content, tokensUsed } = await callSynthesisLLMStage(prompt, undefined, archiveId);
      tracker.consumeTokens(tokensUsed, PASS_NAMES.pass4);
      tracker.consumeLlmCall(PASS_NAMES.pass4);
      // D-13: reset consecutive counter on success.
      setup.consecutiveLlmFailures = 0;

      const decision = parseDecisionJson(
        content,
        pageSlug,
        page.category,
        page.title,
      );

      // Only create changes for non-SKIP decisions on new pages
      const isNewPage = newPageSlugs.has(pageSlug);

      // ── D-03 guard ──────────────────────────────────────────────────────
      // Discard any non-SKIP decision whose suggestedContent is empty or
      // whitespace. Previously the code fell back to `page.bodyText`, which
      // produced no-op writes indistinguishable from the existing content
      // (D-01 branch b). The guard logs a warning and skips the push so the
      // user only sees changes that actually propose new content.
      const suggested = (decision.suggestedContent ?? "").trim();
      if (decision.decision !== "SKIP" && !suggested) {
        logger.warn("[synthesis] Pass 4: discarding decision with empty suggestedContent", {
          pageSlug,
          runId: setup.runId,
          decision: decision.decision,
          reason: decision.reason,
        });
      } else if (decision.decision === "CREATE" && isNewPage) {
        setup.changes.push({
          pageSlug,
          action: "create",
          category: page.category || "entities",
          title: page.title,
          currentContent: page.bodyText,
          proposedContent: decision.suggestedContent,
          confidence: decision.confidence || "MEDIUM",
          sources: [
            {
              fileName: `${page.slug}.md`,
              ingestDate: page.createdAt.toISOString(),
            },
          ],
          approved: false,
        });
        newPagesCollected.push(page);
      } else if (decision.decision === "UPDATE") {
        setup.changes.push({
          pageSlug,
          action: "update",
          category: page.category || "entities",
          title: page.title,
          currentContent: page.bodyText,
          proposedContent: decision.suggestedContent,
          confidence: decision.confidence || "MEDIUM",
          sources: [
            {
              fileName: `${page.slug}.md`,
              ingestDate: page.createdAt.toISOString(),
            },
          ],
          approved: false,
        });
        newPagesCollected.push(page);
      } else if (decision.decision === "FLAG_CONTRADICTION") {
        // D-06: the legacy in-loop detectContradictions call is removed.
        // The new Pass 4b (below) runs independent of the LLM
        // FLAG_CONTRADICTION verdict and pairs all non-SKIP candidates by
        // Jaccard overlap. The flagged change is still pushed so the user
        // sees the LLM's flag in the preview.
        setup.changes.push({
          pageSlug,
          action: "update",
          category: page.category || "entities",
          title: `${page.title} (flagged)`,
          currentContent: page.bodyText,
          proposedContent: decision.suggestedContent,
          confidence: "LOW",
          sources: [
            {
              fileName: `${page.slug}.md`,
              ingestDate: page.createdAt.toISOString(),
            },
          ],
          approved: false,
        });
        newPagesCollected.push(page);
      }
      // SKIP: no action needed
    } catch (err: unknown) {
      // D-13: record LLM failures (and other Pass 4 errors) against the
      // abort thresholds. Non-LLM errors (parse failures, getPage misses)
      // still trip the counters conservatively — a failing Pass 4 loop is
      // a failing synthesis either way, and the user should see FAILED
      // rather than a silent partial.
      if (recordLlmFailure(pageSlug, PASS_NAMES.pass4, err)) {
        break;
      }
      continue;
    }
  }

  logger.info("[synthesis] Pass 4 complete", {
    archiveId,
    runId: setup.runId,
    changesGenerated: setup.changes.length,
    contradictionsFound: setup.contradictions.length,
  });

  // D-13: short-circuit to persistence if Pass 4 tripped the threshold.
  if (setup.pipelineError) {
    throw new Error(`__D13_ABORT__${setup.pipelineError}`);
  }

  return { newPagesCollected };
}

// ============================================================================
// Stage 4 — Persist (Pass 4b + Pass 5)
// ============================================================================

async function runSynthesisPersistStage(
  setup: SetupCtx,
  decision: DecisionResult,
  collection: CollectionResult,
): Promise<SynthesisPreview> {
  // Dynamic require for Bree compatibility (paths adjusted for services/synthesis/).
  const {
    detectContradictions,
  } = require("../../services/synthesisContradictionService");

  const { logEvent } = require("../../services/eventLogService");

  const { archiveId, userId, PASS_NAMES, tracker, runId } = setup;
  const { allPages } = collection;
  const { newPagesCollected } = decision;

  // ====================================================================
  // Pass 4b — Contradiction Detection (D-06/D-07/D-08/D-09)
  // ====================================================================
  if (newPagesCollected.length > 0) {
    logger.info("[synthesis] Pass 4b: contradiction_pairing started", {
      archiveId,
      runId,
      newPagesCount: newPagesCollected.length,
      existingPagesCount: allPages.length,
    });

    const existingArchivePages = allPages.map((p: SynthesisArchivePage) => ({
      id: p.id,
      archiveId: p.archiveId,
      slug: p.slug,
      title: p.title,
      bodyText: p.bodyText,
      wikilinks: p.wikilinks as string[],
      createdAt: p.createdAt,
      createdBy: p.createdBy,
    }));

    const detectedContradictions = await detectContradictions({
      newPages: newPagesCollected,
      existingPages: existingArchivePages,
      archiveId,
      tracker,
      recordLlmFailure: setup.recordLlmFailure,
      passName: PASS_NAMES.pass4b,
    });

    setup.contradictions.push(...detectedContradictions);

    // D-13: short-circuit if Pass 4b LLM failures tripped the abort threshold.
    if (setup.pipelineError) {
      throw new Error(`__D13_ABORT__${setup.pipelineError}`);
    }

    logger.info("[synthesis] Pass 4b complete", {
      archiveId,
      runId,
      contradictionsFound: setup.contradictions.length,
    });
  } else {
    logger.info("[synthesis] Pass 4b: skipped (no non-SKIP candidates)", {
      archiveId,
      runId,
    });
  }

  // ====================================================================
  // Pass 5 — Generate Preview & Persist
  // ====================================================================
  logger.info("[synthesis] Pass 5: write_overview started", { archiveId, runId });

  if (!tracker.canContinue(PASS_NAMES.pass5)) {
    logger.warn("[synthesis] Budget exhausted before Pass 5");
  }

  const budgetSnapshot = tracker.getSnapshot();
  // D-02: pagesProposed counts non-SKIP changes pushed to the preview. This
  // distinguishes proposals from applied pages (pagesApplied is persisted
  // by the approve route from applyApprovedChanges result.applied). SKIPs
  // are never pushed to changes[], so changes.length is equivalent — the
  // explicit filter documents intent.
  const pagesProposed = setup.changes.filter((c) => c.action !== "skip").length;
  // pagesWritten stays 0 at pipeline time: nothing is applied until the
  // user approves. The approve route sets pagesApplied from
  // applyApprovedChanges result.applied (D-02).
  setup.pagesWritten = 0;

  const isPartial = tracker.isExhausted();
  const finalStatus = setup.pipelineError
    ? "FAILED"
    : isPartial
      ? "PARTIAL"
      : "COMPLETED";

  const preview: SynthesisPreview = {
    runId,
    archiveId,
    status: finalStatus as SynthesisPreview["status"],
    createdAt: new Date().toISOString(),
    budgetUsed: {
      pagesRead: budgetSnapshot.pagesRead,
      pagesWritten: budgetSnapshot.maxPagesWritten, // Track max capacity
      tokensUsed: budgetSnapshot.tokensUsed,
      llmCallsUsed: budgetSnapshot.llmCallsUsed,
    },
    contradictions: setup.contradictions,
    changes: setup.changes,
  };

  // Log per-archive config metadata for transparency
  logger.info("[synthesis] Pipeline config snapshot", {
    runId,
    archiveId,
    agentPersona: setup.synthConfig.agentPersona,
    maintenanceSchedule: setup.synthConfig.maintenanceSchedule,
    linkingDensity: setup.synthConfig.linkingDensity,
    purpose: setup.synthConfig.purpose,
    scope: setup.synthConfig.scope,
  });

  // Update SynthesisRun with preview data
  await prisma.synthesisRun.update({
    where: { id: runId },
    data: {
      status: finalStatus as unknown as Record<string, unknown>,
      pagesRead: budgetSnapshot.pagesRead,
      pagesWritten: setup.pagesWritten,
      pagesProposed,
      tokensUsed: budgetSnapshot.tokensUsed,
      llmCallsUsed: budgetSnapshot.llmCallsUsed,
      contradictionsFound: setup.contradictions.length,
      previewJson: preview as Prisma.InputJsonValue,
    },
  });

  logger.info("[synthesis] Pipeline complete", {
    archiveId,
    runId,
    status: finalStatus,
  });

  // Log completion event
  logEvent("synthesis_run", runId, "synthesis.completed", userId, {
    archiveId,
    pagesRead: budgetSnapshot.pagesRead,
    pagesWritten: setup.pagesWritten,
    pagesProposed,
    tokensUsed: budgetSnapshot.tokensUsed,
    llmCallsUsed: budgetSnapshot.llmCallsUsed,
    contradictionsFound: setup.contradictions.length,
  }).catch((err: unknown) => {
    logger.error("[synthesis] Failed to log completion event", {
      error: (err instanceof Error ? err.message : String(err)),
      runId,
    });
  });

  // Push notification: synthesis completed
  import("../../routes/push")
    .then(({ sendPushNotification }) =>
      sendPushNotification(
        "Sintesi completata",
        `Sintesi del knowledge base terminata — ${pagesProposed} pagine proposte, ${setup.pagesWritten} aggiornate`,
        userId,
        "/archives",
      ).catch(() => {}),
    )
    .catch(() => {});

  return preview;
}

// ============================================================================
// NOTE (Phase 180 dead-code sweep)
// ============================================================================
// The `runWikiGraphPipeline` + `WikiGraphPipelineResult` re-exports from
// ../wikiGraphStage were REMOVED — zero consumers imported them through this
// facade (routes/synthesis.ts imports the source module directly). The
// pipeline itself lives on in wikiGraphStage.ts; the LLM `runPipelineStages`
// above is UNCHANGED.

// ============================================================================
// runPipelineStages — single entry orchestrating the 4 stage groups
// ============================================================================

/**
 * Run the 5-pass synthesis pipeline by orchestrating the 4 stage groups:
 *   1. Setup      — SynthesisRun + BudgetTracker + config + abort counters
 *   2. Collection — Pass 1 (entity extraction) + Pass 2 (summaries) + Pass 3 (candidates)
 *   3. Decision   — Pass 4 (LLM decision per candidate) + newPagesCollected accumulator
 *   4. Persist    — Pass 4b (contradiction detection) + Pass 5 (preview + persist)
 *
 * The outer try/catch preserves the D-13 abort sentinel + the partial-preview
 * persistence path byte-for-byte (the abort reason is preserved across the
 * sentinel boundary; a FAILED row with `previewJson` + `error` is always
 * persisted, even on catastrophic failure).
 */
export async function runPipelineStages(
  archiveId: string,
  userId: string,
  existingRunId?: string,
): Promise<SynthesisPreview> {
  const setup = await runSynthesisSetupStage(archiveId, userId, existingRunId);

  // Dynamic require for Bree compatibility — logEvent is used by both the
  // success path (Persist stage) and this orchestrator's catch path.
  const { logEvent } = require("../../services/eventLogService");

  try {
    const collection = await runSynthesisCollectionStage(setup);
    const decision = await runSynthesisDecisionStage(setup, collection);
    return await runSynthesisPersistStage(setup, decision, collection);
  } catch (err: unknown) {
    // ── Pipeline failure ──────────────────────────────────────────
    // D-13: detect the abort sentinel and preserve the existing
    // pipelineError (the abort reason) instead of overwriting it with
    // the sentinel message. The sentinel format is `__D13_ABORT__<reason>`.
    const rawErrMessage = err instanceof Error ? err.message : String(err);
    const isD13AbortSentinel = rawErrMessage.startsWith("__D13_ABORT__");
    if (!setup.pipelineError) {
      setup.pipelineError = isD13AbortSentinel
        ? rawErrMessage.replace(/^__D13_ABORT__/, "")
        : rawErrMessage;
    } else if (isD13AbortSentinel) {
      // pipelineError already holds the abort reason; keep it.
    }

    logger.error("[synthesis] Pipeline failed", {
      archiveId: setup.archiveId,
      runId: setup.runId,
      error: setup.pipelineError,
    });

    // D-13: build a partial preview so the user sees what was processed
    // before the abort, not a silent empty result. Mirror Fase 62 D-04
    // save-token path.
    const abortPreview: SynthesisPreview = {
      runId: setup.runId,
      archiveId: setup.archiveId,
      status: "FAILED" as SynthesisPreview["status"],
      createdAt: new Date().toISOString(),
      budgetUsed: {
        pagesRead: setup.pagesRead,
        pagesWritten: setup.pagesWritten,
        tokensUsed: setup.tracker.getSnapshot().tokensUsed,
        llmCallsUsed: setup.tracker.getSnapshot().llmCallsUsed,
      },
      contradictions: setup.contradictions,
      changes: setup.changes,
    };

    try {
      // D-02: pagesProposed counts non-SKIP changes pushed to the preview
      // (same definition as the success path). pagesWritten is 0 (nothing
      // applied before the abort).
      const pagesProposed = setup.changes.filter((c) => c.action !== "skip").length;
      await prisma.synthesisRun.update({
        where: { id: setup.runId },
        data: {
          status: "FAILED",
          error: setup.pipelineError,
          pagesRead: setup.pagesRead,
          pagesWritten: setup.pagesWritten,
          pagesProposed,
          tokensUsed: setup.tracker.getSnapshot().tokensUsed,
          llmCallsUsed: setup.tracker.getSnapshot().llmCallsUsed,
          contradictionsFound: setup.contradictions.length,
          previewJson: abortPreview as Prisma.InputJsonValue,
        },
      });

      logEvent("synthesis_run", setup.runId, "synthesis.failed", setup.userId, {
        archiveId: setup.archiveId,
        error: setup.pipelineError,
      }).catch(() => {});
    } catch (updateErr: unknown) {
      logger.error("[synthesis] Failed to update run as FAILED", {
        error: (updateErr instanceof Error ? updateErr.message : String(updateErr)),
        runId: setup.runId,
      });
    }

    return abortPreview;
  }
}