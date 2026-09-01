// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Synthesis Fidelity Service — SYNTH-05
 *
 * Weekly fidelity sampling: selects random synthesized pages, reads their
 * source files from raw/, compares claims against source content, logs
 * fidelity scores via eventLogService.
 *
 * Designed to be called from a weekly Bree job (initialized in Plan 04).
 */

import { logger } from "../utils/logger";
import prisma from "../utils/prisma";
import path from "path";
import fs from "fs/promises";

// ============================================================================
// Constants
// ============================================================================

const MAX_SAMPLE_SIZE = 5;
const FIDELITY_SAMPLE_RATIO = 0.1; // 10% of total synthesized pages
const MIN_SAMPLE_SIZE = 1;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract key claims from text: first 3 sentences of each paragraph.
 * Returns array of trimmed claim strings.
 */
function extractClaims(bodyText: string): string[] {
  if (!bodyText || bodyText.trim() === "") return [];

  // Split into paragraphs (double newlines or single)
  const paragraphs = bodyText.split(/\n\n+/).filter((p) => p.trim().length > 0);
  const claims: string[] = [];

  for (const paragraph of paragraphs) {
    // Extract first 3 sentences from each paragraph
    const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [];
    const taken = sentences.slice(0, 3).map((s) => s.trim()).filter((s) => s.length > 10);
    claims.push(...taken);
  }

  return claims;
}

/**
 * Check if a claim is present in source content using basic n-gram overlap.
 *
 * Splits the claim into n-grams and checks for substring matches in the
 * source content. A claim is "found" if >= 50% of its 3-word n-grams
 * appear somewhere in the source.
 */
function claimPresentInSource(claim: string, sourceContent: string): boolean {
  const sourceLower = sourceContent.toLowerCase();
  const claimLower = claim.toLowerCase();

  // Direct substring check first (fast path)
  if (sourceLower.includes(claimLower)) {
    return true;
  }

  // N-gram overlap check for paraphrased content
  const words = claimLower.split(/\s+/).filter((w) => w.length > 3);
  if (words.length < 3) {
    // Very short claim — just do substring
    return sourceLower.includes(claimLower);
  }

  const trigrams: string[] = [];
  for (let i = 0; i <= words.length - 3; i++) {
    trigrams.push(words.slice(i, i + 3).join(" "));
  }

  let foundTrigrams = 0;
  for (const trigram of trigrams) {
    if (sourceLower.includes(trigram)) {
      foundTrigrams++;
    }
  }

  return trigrams.length > 0 && foundTrigrams / trigrams.length >= 0.5;
}

// ============================================================================
// runFidelitySample — weekly fidelity check (SYNTH-05)
// ============================================================================

export async function runFidelitySample(): Promise<void> {
  // Dynamic imports for Bree compatibility

  const prismaClient = require("../utils/prisma").default;

  const { logEvent } = require("./eventLogService");

  logger.info("[synthesis] Fidelity sampling started");

  try {
    // Query all non-deleted ArchivePage records
    const allPages = await prismaClient.archivePage.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        archiveId: true,
        slug: true,
        title: true,
        bodyText: true,
        frontmatter: true,
      },
    });

    type PageSummary = (typeof allPages)[number];

    // Filter to pages that have been synthesized at least once
    const synthesizedPages: PageSummary[] = allPages.filter((p: PageSummary) => {
      if (!p.frontmatter || typeof p.frontmatter !== "object") return false;
      const fm = p.frontmatter as Record<string, unknown>;
      const gen = fm.synthesis_generation;
      return typeof gen === "number" && gen >= 1;
    });

    if (synthesizedPages.length === 0) {
      logger.info("[synthesis] Fidelity sampling: no synthesized pages found");
      return;
    }

    // Calculate sample size: up to MAX_SAMPLE_SIZE or 10% of total
    const sampleSize = Math.max(
      MIN_SAMPLE_SIZE,
      Math.min(
        MAX_SAMPLE_SIZE,
        Math.ceil(synthesizedPages.length * FIDELITY_SAMPLE_RATIO),
      ),
    );

    // Randomly select pages
    const selected = selectRandom(synthesizedPages, sampleSize);

    logger.info("[synthesis] Fidelity sampling: selected pages", {
      totalSynthesized: synthesizedPages.length,
      sampleSize: selected.length,
    });

    // Evaluate each selected page
    for (const page of selected) {
      await evaluateFidelity(page, prismaClient, logEvent);
    }

    logger.info("[synthesis] Fidelity sampling complete", {
      pagesSampled: selected.length,
    });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[synthesis] Fidelity sampling failed", {
      error: message,
    });
  }
}

/**
 * Randomly select `count` items from an array (Fisher-Yates partial shuffle).
 */
function selectRandom<T>(items: T[], count: number): T[] {
  const shuffled = [...items];
  // Partial Fisher-Yates: only shuffle what we need
  for (let i = 0; i < Math.min(count, shuffled.length); i++) {
    const j = i + Math.floor(Math.random() * (shuffled.length - i));
    [shuffled[i]!, shuffled[j]!] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled.slice(0, count);
}

/**
 * Evaluate fidelity for a single synthesized page.
 *
 * Steps:
 *   1. Read the page's frontmatter.sources to find source file names
 *   2. For each source, try to read the corresponding raw/ file
 *   3. Extract claims from the synthesized page bodyText
 *   4. Check each claim against source content
 *   5. Calculate fidelity score
 *   6. Log via logEvent
 *   7. Warn if score < 50%
 */
async function evaluateFidelity(
  page: {
    id: string;
    archiveId: string;
    slug: string;
    title: string;
    bodyText: string;
    frontmatter: unknown;
  },
  prismaClient: typeof prisma,
  logEventFn: (entityType: string, entityId: string, action: string, userId: string | null, metadata?: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const fm = page.frontmatter as Record<string, unknown> | null;
  const sources: Array<{ fileName: string; ingestDate: string }> =
    fm?.sources && Array.isArray(fm.sources) ? fm.sources as Array<{ fileName: string; ingestDate: string }> : [];

  // Resolve the archive slug for filesystem path
  const archive = await prismaClient.archive.findFirst({
    where: { id: page.archiveId, deletedAt: null },
    select: { slug: true },
  });

  if (!archive) {
    logger.warn("[synthesis] Fidelity check: archive not found for page", {
      archiveId: page.archiveId,
      pageSlug: page.slug,
    });
    return;
  }

  const ARCHIVES_BASE = path.resolve(process.cwd(), "storage/archives");
  const archiveDir = path.join(ARCHIVES_BASE, archive.slug);
  const rawDir = path.join(archiveDir, "raw_sources");

  // Read all available source content
  let allSourceContent = "";
  for (const source of sources) {
    const sourcePath = path.join(rawDir, source.fileName);
    try {
      const sourceContent = await fs.readFile(sourcePath, "utf-8");
      allSourceContent += "\n" + sourceContent;
    } catch {
      // Source file not found — skip (may have been cleaned up)
      logger.debug("[synthesis] Fidelity check: source file not found", {
        sourceFileName: source.fileName,
        pageSlug: page.slug,
      });
    }
  }

  if (!allSourceContent.trim()) {
    // No source content available — cannot evaluate fidelity
    logEventFn("synthesis_run", page.id, "synthesis.fidelity_check", null, {
      archiveId: page.archiveId,
      pageSlug: page.slug,
      fidelityScore: 0,
      claimsChecked: 0,
      claimsFound: 0,
      status: "NO_SOURCE_AVAILABLE",
    }).catch(() => {});
    return;
  }

  // Extract claims from synthesized page
  const claims = extractClaims(page.bodyText);
  if (claims.length === 0) {
    logEventFn("synthesis_run", page.id, "synthesis.fidelity_check", null, {
      archiveId: page.archiveId,
      pageSlug: page.slug,
      fidelityScore: 100,
      claimsChecked: 0,
      claimsFound: 0,
      status: "NO_CLAIMS_FOUND",
    }).catch(() => {});
    return;
  }

  // Check each claim against source content
  let claimsFound = 0;
  for (const claim of claims) {
    if (claimPresentInSource(claim, allSourceContent)) {
      claimsFound++;
    }
  }

  // Calculate fidelity score
  const fidelityScore = Math.round((claimsFound / claims.length) * 100);

  // Log via eventLogService
  logEventFn("synthesis_run", page.id, "synthesis.fidelity_check", null, {
    archiveId: page.archiveId,
    pageSlug: page.slug,
    fidelityScore,
    claimsChecked: claims.length,
    claimsFound,
  }).catch((err: unknown) => {
    logger.error("[synthesis] Failed to log fidelity event", {
      error: (err as Error).message,
      pageSlug: page.slug,
    });
  });

  // Warn if fidelity score is below threshold
  if (fidelityScore < 50) {
    logger.warn("[synthesis] Low fidelity score detected", {
      archiveId: page.archiveId,
      pageSlug: page.slug,
      fidelityScore,
      claimsChecked: claims.length,
      claimsFound,
    });
  }

  logger.info("[synthesis] Fidelity check complete", {
    pageSlug: page.slug,
    fidelityScore,
    claimsChecked: claims.length,
    claimsFound,
  });
}
