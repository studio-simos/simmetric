// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Synthesis Pipeline Orchestrator — SYNTH-01 (PUBLIC FACADE)
 *
 * MOD-04 (Phase 88): the pipeline body was surgically split into
 * `./synthesis/synthesisStages.ts` (single stage-grouped module — D-06 — with
 * 4 pipeline-phase groups: setup / collection / decision / persist). This
 * file remains a thin facade (D-03) preserving the byte-identical public
 * surface:
 *   - `runSynthesisPipeline(archiveId, userId, existingRunId?)` delegates to
 *     `runPipelineStages`
 *   - `callSynthesisLLM(prompt, systemPrompt?, archiveId?)` delegates to
 *     `callSynthesisLLMStage` — stays NON-STREAMING (RESEARCH Pitfall 6)
 *   - `getSynthesisConfig(archiveId)` delegates to `getSynthesisConfigStage`
 *   - `defaultRunName(archive, date)` delegates to `defaultRunNameStage`
 *
 * Synthesis routes (`routes/synthesis.ts`) keep their import path
 * `../services/synthesisService` unchanged. The 7 existing
 * `synthesis*Service.ts` siblings (budget/contradiction/fidelity/orphan/
 * pageWriter/reaperJob/trigger) are IMPORTED by `synthesisStages.ts` via
 * dynamic require for Bree worker compatibility — NOT re-implemented here.
 *
 * The local interfaces `SynthesisChangeEntry` / `SynthesisResultRow` /
 * `SynthesisArchivePage` (Phase 87 typed them in-place) stay defined here to
 * avoid churn; `synthesisPageWriter.ts` has its OWN local definitions and
 * does NOT import them from this module (verified by grep — no external
 * importer relies on re-exports of these types).
 */

// Type-only imports from shared (no runtime cost)
import type { SynthesisConfidence } from "@simmetric-chat/shared";

// ============================================================================
// Local typed shapes for the synthesis pipeline accumulators (D-08).
// SynthesisChangeEntry mirrors the pushed change shape and is structurally
// assignable to SynthesisPreview["changes"] (confidence is the enum, not
// string, so the preview assignment at the end of the pipeline type-checks).
// SynthesisResultRow mirrors the Pass 3 $queryRaw SELECT projection
// (D-11; slug is the only projected column).
//
// These local interfaces are kept here to avoid churn (Phase 87 typed them
// in-place, not re-exported). The new `synthesisStages.ts` has its OWN local
// definitions of the same shapes; no external importer relies on re-exports
// from this file.
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
 * `require()`). Declaring this lets the `.filter`/`.map` callbacks over
 * `allPages` drop the explicit any-annotation without tripping noImplicitAny.
 * `frontmatter` is `unknown` so the existing `as Record<string, unknown> | null`
 * narrowing cast continues to compile.
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

// Void the unused-local-interface lint without re-exporting them (no
// external importer relies on these — kept here to avoid churn).
// (The interfaces are referenced via `void` expressions so TS noUnusedLocals
// does not flag them. The runtime body lives in `./synthesis/synthesisStages`.)
void (0 as unknown as SynthesisChangeEntry);
void (0 as unknown as SynthesisResultRow);
void (0 as unknown as SynthesisArchivePage);

// ============================================================================
// Facade — thin wrappers delegating to `./synthesis/synthesisStages`
// ============================================================================

import {
  runPipelineStages,
  callSynthesisLLMStage,
  getSynthesisConfigStage,
  defaultRunNameStage,
  defaultWikiGraphRunNameStage,
} from "./synthesis/synthesisStages";

// ── callSynthesisLLM — non-streaming LLM call for synthesis (D-09, Pitfall 6)
// Thin wrapper delegating to `callSynthesisLLMStage` (synthesisStages.ts).
// Stays NON-STREAMING — uses `callNonStreamingLLM`, never any streaming
// transport.
export async function callSynthesisLLM(
  prompt: string,
  systemPrompt?: string,
  archiveId?: string,
): Promise<{ content: string; tokensUsed: number }> {
  return callSynthesisLLMStage(prompt, systemPrompt, archiveId);
}

// ── getSynthesisConfig — per-archive overrides with fallback defaults.
// Thin wrapper delegating to `getSynthesisConfigStage` (synthesisStages.ts).
export async function getSynthesisConfig(archiveId: string) {
  return getSynthesisConfigStage(archiveId);
}

// ── defaultRunName — deterministic run name.
// Thin wrapper delegating to `defaultRunNameStage` (synthesisStages.ts).
export function defaultRunName(
  archive: { name: string | null },
  createdAt: Date,
): string {
  return defaultRunNameStage(archive, createdAt);
}

// ── defaultWikiGraphRunName — deterministic wiki-graph run name (WR-05).
// Thin wrapper delegating to `defaultWikiGraphRunNameStage` (synthesisStages.ts).
// Used by the /trigger-graph-wiki route so the name format is sourced from a
// single helper instead of inlined dd/mm/yyyy hh:mm formatting.
export function defaultWikiGraphRunName(
  archive: { name: string | null },
  createdAt: Date,
): string {
  return defaultWikiGraphRunNameStage(archive, createdAt);
}

// ── runSynthesisPipeline — 5-pass pipeline orchestrator (SYNTH-01).
// Thin wrapper delegating to `runPipelineStages` (synthesisStages.ts).
// Signature is byte-identical to the pre-split implementation.
export async function runSynthesisPipeline(
  archiveId: string,
  userId: string,
  existingRunId?: string,
): Promise<import("@simmetric-chat/shared").SynthesisPreview> {
  return runPipelineStages(archiveId, userId, existingRunId);
}