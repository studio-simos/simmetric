// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Archive Config Service — CRUD for per-archive schema governance configuration.
 *
 * Config is stored as JSON in the ArchiveConfig table and validated
 * against the shared archiveConfigSchema on write.
 */

import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { archiveConfigSchema, type ArchiveConfigInput } from "@simmetric-chat/shared";

/**
 * Get archive config by archiveId.
 * Returns undefined if no config exists.
 */
export async function getArchiveConfig(archiveId: string): Promise<ArchiveConfigInput | undefined> {
  const record = await prisma.archiveConfig.findUnique({ where: { archiveId } });
  return record ? (record.config as unknown as ArchiveConfigInput) : undefined;
}

/**
 * Upsert archive config. Validates input shape with Zod before writing.
 */
export async function setArchiveConfig(archiveId: string, config: ArchiveConfigInput) {
  archiveConfigSchema.parse(config);
  return prisma.archiveConfig.upsert({
    where: { archiveId },
    create: { archiveId, config: config as Prisma.InputJsonValue },
    update: { config: config as Prisma.InputJsonValue },
  });
}

/**
 * Delete archive config record.
 */
export async function deleteArchiveConfig(archiveId: string) {
  return prisma.archiveConfig.delete({ where: { archiveId } });
}

/**
 * Get only the synthesis-relevant fields from archive config.
 */
export async function getSynthesisOverrides(archiveId: string) {
  const config = await getArchiveConfig(archiveId);
  if (!config) return undefined;
  return {
    linkingDensity: config.linkingDensity,
    agentPersona: config.agentPersona,
    maintenanceSchedule: config.maintenanceSchedule,
    purpose: config.purpose,
    scope: config.scope,
  };
}
