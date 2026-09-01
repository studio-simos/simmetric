// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * D-15 PHI gate propagation — populates ArchiveConfig.config.localLLMOnly
 * from WorkspaceTemplate.constraints.localLLMOnly (B1 fix, KB-04).
 *
 * The PHI gate in synthesisService.callSynthesisLLM reads
 * ArchiveConfig.config.localLLMOnly. Without propagation, that flag is dead
 * code — never populated in production. This module provides:
 *
 *   - resolveUserLocalLLMOnly(userId): single Prisma query joining
 *     WorkspaceAccess -> Workspace -> WorkspaceTemplate. Returns true if
 *     ANY of the user's accessible workspaces has a template with
 *     constraints.localLLMOnly === true (strictest-wins — conservative
 *     privacy bias per B1 rationale). W1 fix: the userId filter is merged
 *     into the where clause so it is not silently overwritten.
 *
 *   - propagateLocalLLMOnlyForUser(userId, archiveId): resolves the flag
 *     for the creator and, when true, upserts ArchiveConfig.config with
 *     localLLMOnly: true (merged into any existing config). When false,
 *     the function skips (does not create ArchiveConfig rows for archives
 *     that don't want one).
 *
 *   - backfillLocalLLMOnlyPropagation(): idempotent startup task. Scans all
 *     non-deleted archives and populates the flag for creators whose
 *     accessible workspaces include a Medical-template workspace. Skips
 *     archives whose ArchiveConfig.config.localLLMOnly is already true
 *     (idempotent — only sets to true, never to false).
 *
 * Threat register: T-64-30 (PHI gate dead code) mitigated; T-64-31
 * (strictest-wins over-blocking) accepted.
 *
 * The creator->workspace join is intentionally conservative (strictest-wins)
 * rather than archive-scoped: an archive does not carry a workspaceId, so
 * we cannot disambiguate which Medical workspace a given archive belongs
 * to. False positive (gate fires, user must switch provider) is safer
 * than false negative (PHI leaks). The user can clear the flag by removing
 * the WorkspaceAccess grant for the Medical workspace and re-running the
 * backfill (which leaves the flag at true — the user must manually flip
 * it in the admin ArchiveConfig UI, or we accept the conservative bias).
 */

import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { type ArchiveLocalLLMConfig } from "@simmetric-chat/shared";

/**
 * Resolve whether the user has access to ANY workspace whose template
 * constraints.localLLMOnly === true (strictest-wins).
 *
 * Uses a single Prisma query joining WorkspaceAccess -> Workspace ->
 * WorkspaceTemplate. W1 fix: the userId filter is merged into the where
 * clause so it is not silently overwritten by the templateId filter.
 *
 * Returns true if ANY matching workspace has the flag; false otherwise.
 */
async function resolveUserLocalLLMOnly(userId: string): Promise<boolean> {
  const workspaces = await prisma.workspaceAccess.findMany({
    where: {
      userId,
      workspace: {
        deletedAt: null,
        templateId: { not: null },
        template: { isNot: null },
      },
    },
    select: {
      workspace: {
        select: {
          templateId: true,
          template: { select: { constraints: true } },
        },
      },
    },
  });

  for (const access of workspaces) {
    const constraintsRaw = access.workspace?.template?.constraints;
    if (!constraintsRaw) continue;
    try {
      const constraints = JSON.parse(constraintsRaw) as Record<string, unknown>;
      if (constraints?.localLLMOnly === true) {
        return true;
      }
    } catch {
      // Malformed constraints JSON — skip this workspace.
      logger.warn("[archiveLocalLLMOnlyPropagation] Malformed template constraints, skipping", {
        templateId: access.workspace?.templateId,
      });
    }
  }
  return false;
}

/**
 * Propagate the localLLMOnly flag from the creator's accessible workspaces
 * to the archive's ArchiveConfig. When the flag resolves to true, upserts
 * ArchiveConfig.config with localLLMOnly: true (merged into any existing
 * config). When false, the function skips (does not create an ArchiveConfig
 * row for archives that don't want one).
 *
 * Called fire-and-forget from archiveService.createArchive so a propagation
 * failure does not block archive creation (T-64-32).
 */
export async function propagateLocalLLMOnlyForUser(
  userId: string,
  archiveId: string,
): Promise<void> {
  const localLLMOnly = await resolveUserLocalLLMOnly(userId);

  if (!localLLMOnly) {
    logger.debug("[archiveLocalLLMOnlyPropagation] No localLLMOnly constraint resolved — skipping", {
      archiveId,
      userId,
    });
    return;
  }

  // Read existing config (if any) so we can merge localLLMOnly into it
  // rather than overwriting the whole JSON object.
  const existing = await prisma.archiveConfig.findUnique({
    where: { archiveId },
    select: { config: true },
  });

  const existingConfig = (existing?.config as Record<string, unknown> | null) ?? {};
  const mergedConfig: ArchiveLocalLLMConfig = { ...existingConfig, localLLMOnly: true };

  await prisma.archiveConfig.upsert({
    where: { archiveId },
    create: { archiveId, config: mergedConfig as Prisma.InputJsonValue },
    update: { config: mergedConfig as Prisma.InputJsonValue },
  });

  logger.info("[archiveLocalLLMOnlyPropagation] Populated localLLMOnly=true on ArchiveConfig", {
    archiveId,
    userId,
    module: "propagation",
    event: "local_llm_only_populated",
  });
}

/**
 * Idempotent startup backfill. Scans all non-deleted archives and populates
 * ArchiveConfig.config.localLLMOnly from each creator's accessible
 * workspaces (strictest-wins). Skips archives whose ArchiveConfig.config
 * .localLLMOnly is already true (no-op). Does NOT set the flag to false —
 * the backfill is corrective, not destructive.
 *
 * Returns { updated, scanned } for observability.
 */
export async function backfillLocalLLMOnlyPropagation(): Promise<{
  updated: number;
  scanned: number;
}> {
  const archives = await prisma.archive.findMany({
    where: { deletedAt: null },
    select: { id: true, createdBy: true },
  });

  let updated = 0;
  for (const archive of archives) {
    const localLLMOnly = await resolveUserLocalLLMOnly(archive.createdBy);
    if (!localLLMOnly) continue;

    // Check current state — skip if already true (idempotent).
    const existing = await prisma.archiveConfig.findUnique({
      where: { archiveId: archive.id },
      select: { config: true },
    });
    const currentFlag = (existing?.config as Record<string, unknown> | null)?.localLLMOnly;
    if (currentFlag === true) continue;

    // Merge and upsert (same logic as propagateLocalLLMOnlyForUser)
    const existingConfig = (existing?.config as Record<string, unknown> | null) ?? {};
    const mergedConfig: ArchiveLocalLLMConfig = { ...existingConfig, localLLMOnly: true };
    await prisma.archiveConfig.upsert({
      where: { archiveId: archive.id },
      create: { archiveId: archive.id, config: mergedConfig as Prisma.InputJsonValue },
      update: { config: mergedConfig as Prisma.InputJsonValue },
    });
    updated++;
  }

  logger.info("[backfill] Archive localLLMOnly propagation", {
    module: "backfill",
    event: "local_llm_only_backfill",
    updatedCount: updated,
    scannedCount: archives.length,
  });

  return { updated, scanned: archives.length };
}