// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import sharp from "sharp";
import multer from "multer";
import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";

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

export async function resizeAvatar(inputPath: string, userId: string): Promise<string> {
  const timestamp = Date.now();
  const filename = `${userId}-${timestamp}`;
  let primaryPath = "";

  for (const size of AVATAR_SIZES) {
    const dest = path.join(AVATAR_DIR, String(size), `${filename}.webp`);
    // Ensure directory exists
    fs.mkdirSync(path.join(AVATAR_DIR, String(size)), { recursive: true });
    await sharp(inputPath)
      .resize(size, size, { fit: "cover" })
      .webp({ quality: 85 })
      .toFile(dest);
    if (size === 128) {
      primaryPath = `/avatars/128/${filename}.webp`;
    }
  }

  // Clean up temp file
  try {
    fs.unlinkSync(inputPath);
  } catch {
    // Best-effort cleanup
  }

  return primaryPath;
}

export async function deleteOldAvatars(avatarPath: string): Promise<void> {
  const filename = path.basename(avatarPath);

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