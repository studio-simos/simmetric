// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import sharp from "sharp";
import multer from "multer";
import fs from "fs";
import path from "path";
import { DEFAULT_ORG_ID } from "@simmetric-chat/shared";
import { logger } from "../utils/logger";
import prisma from "../utils/prisma";
import { getStorageProvider } from "./storageProvider";

export const AVATAR_SIZES = [32, 64, 128] as const;
const AVATAR_DIR = "storage/uploads/avatars";
export const AVATAR_MAX_SIZE = 512 * 1024; // 512 KB per D-01

export const avatarUpload = multer({
  dest: "storage/uploads/avatars/tmp/",
  limits: { fileSize: AVATAR_MAX_SIZE },
  fileFilter: (_req: Express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

/**
 * Resolve the organization id that prefixes avatar provider keys (D-03 row's-org
 * rule). Users are identity-pure (Phase 182 D-01 — User carries NO organizationId
 * column), so the org resolves from the user's LIVE OrganizationMember row;
 * a user with no live membership falls back to the default org (air-gap
 * tenancy root) so existing callers keep working.
 */
async function resolveUserOrgId(userId: string): Promise<string> {
  try {
    const membership = await prisma.organizationMember.findFirst({
      where: { userId, deletedAt: null },
      select: { organizationId: true },
    });
    if (membership?.organizationId) return membership.organizationId;
  } catch (err) {
    logger.debug("[avatar] organization lookup failed — using default org", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return DEFAULT_ORG_ID;
}

/**
 * Extract the userId from an avatar filename ({userId}-{timestamp}.webp
 * naming — resizeAvatar). The userId is everything BEFORE the trailing
 * timestamp segment: User ids are UUIDs (contain dashes), so splitting on
 * the first "-" would truncate the id (Rule 1 fix — the plan's literal
 * first-dash suggestion cannot address org-keyed UUID users). Returns null
 * when the name does not carry a trailing numeric timestamp (foreign/
 * legacy name shapes) — callers then skip the provider arm; the fs arm
 * still runs.
 */
function extractUserIdFromFilename(filename: string): string | null {
  const match = /^(.+)-(\d+)\.webp$/.exec(filename);
  return match?.[1] ?? null;
}

/**
 * Best-effort provider delete of the three size variants under
 * {orgId}/avatars/{size}/{filename}.webp. Never throws — cleanup must not
 * mask the primary operation (reaper try/catch-warn shape).
 */
async function deleteProviderAvatarKeys(orgId: string, filename: string): Promise<void> {
  let provider;
  try {
    provider = await getStorageProvider(orgId);
  } catch (err) {
    // Provider resolution failure (e.g. s3 configured but incomplete/down) —
    // cleanup is best-effort; the legacy fs arm below still runs.
    logger.debug("[avatar] provider resolution failed — provider arm skipped", {
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  for (const size of AVATAR_SIZES) {
    const key = `${orgId}/avatars/${size}/${filename}`;
    try {
      await provider.delete(key);
    } catch (err) {
      logger.debug(`[avatar] provider delete failed for size ${size} (best-effort)`, {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function resizeAvatar(inputPath: string, userId: string, organizationId?: string): Promise<string> {
  const timestamp = Date.now();
  const filename = `${userId}-${timestamp}`;
  let primaryPath = "";

  // D-03 row's-org rule: the key prefix comes from the caller-supplied
  // organizationId (the user row's org — callers look it up), falling back to
  // a lookup of the user's live membership, then the default org. Resolved
  // ONCE per upload, then put ×3 through the same provider.
  const orgId = organizationId ?? (await resolveUserOrgId(userId));
  const provider = await getStorageProvider(orgId);

  for (const size of AVATAR_SIZES) {
    const dest = path.join(AVATAR_DIR, String(size), `${filename}.webp`);
    // Ensure directory exists
    fs.mkdirSync(path.join(AVATAR_DIR, String(size)), { recursive: true });
    await sharp(inputPath)
      .resize(size, size, { fit: "cover" })
      .webp({ quality: 85 })
      .toFile(dest);
    // D-03: the resized webp rides the local tmp, then lands in the provider
    // under {orgId}/avatars/{size}/{filename}.webp. provider.put is
    // overwrite-idempotent; a mid-loop failure leaves prior sizes servable
    // (user.avatar is only updated after ALL puts succeed — routes/users.ts
    // ordering invariant).
    await provider.put(dest, `${orgId}/avatars/${size}/${filename}.webp`);
    if (size === 128) {
      primaryPath = `/avatars/128/${filename}.webp`;
    }
  }

  // Clean up temp file (best-effort — ingress buffer, WR-01 shape)
  try {
    fs.unlinkSync(inputPath);
  } catch {
    // Best-effort cleanup
  }

  return primaryPath;
}

export async function deleteOldAvatars(avatarPath: string): Promise<void> {
  const filename = path.basename(avatarPath);

  // D-03: new-layout URLs resolve userId → user org → provider keys
  // ({orgId}/avatars/{size}/{filename}.webp); the fs arm below is the
  // permanent legacy fallback (pre-phase avatars + D-03 rollback aid).
  const userId = extractUserIdFromFilename(filename);
  if (userId) {
    const orgId = await resolveUserOrgId(userId);
    await deleteProviderAvatarKeys(orgId, filename);
  }

  for (const size of AVATAR_SIZES) {
    try {
      const oldFile = path.join(AVATAR_DIR, String(size), filename);
      if (fs.existsSync(oldFile)) {
        fs.unlinkSync(oldFile);
      }
    } catch (err) {
      // Best-effort per file
      logger.debug(`[avatar] Failed to delete old file for size ${size}`, { error: String(err) });
    }
  }
}

export async function removeAvatarFiles(avatarPath: string): Promise<void> {
  // Validate path starts with /avatars/ to prevent path traversal (T-19-06)
  if (!avatarPath.startsWith("/avatars/")) {
    logger.warn(`[avatar] Refusing to remove avatar with invalid path: ${avatarPath}`);
    return;
  }

  const filename = path.basename(avatarPath);

  // D-03 provider arm: same userId→org→key resolution as deleteOldAvatars.
  const userId = extractUserIdFromFilename(filename);
  if (userId) {
    const orgId = await resolveUserOrgId(userId);
    await deleteProviderAvatarKeys(orgId, filename);
  }

  // Legacy fs arm — pre-phase files (and the D-03 rollback point) keep being
  // removed exactly as before.
  for (const size of AVATAR_SIZES) {
    try {
      const filePath = path.join(AVATAR_DIR, String(size), filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      logger.debug(`[avatar] Failed to delete avatar file for size ${size}`, { error: String(err) });
    }
  }

  logger.info(`[avatar] Removed avatar files for: ${filename}`);
}