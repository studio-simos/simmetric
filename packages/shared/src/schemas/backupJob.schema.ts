// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== Backup Job Schemas =====
// Phase 53: Zod validation for backup job CRUD, toggle, and execution.

// --- Enum Schemas ---

export const frequencySchema = z.enum(["daily", "weekly", "monthly", "manual"]);
export type Frequency = z.infer<typeof frequencySchema>;

// --- CRUD Schemas ---

export const createBackupJobSchema = z
  .object({
    name: z.string().min(1).max(200),
    destinationId: z.string().uuid("Invalid destination ID"),
    frequency: frequencySchema,
    time: z
      .string()
      .regex(/^\d{2}:\d{2}$/, "Time must be HH:mm format")
      .optional()
      .default("02:00"),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    retentionDays: z.number().int().min(1).max(365).default(30),
  })
  .refine(
    (data) => {
      if (data.frequency === "weekly" && data.dayOfWeek === undefined) {
        return false;
      }
      if (data.frequency === "monthly" && data.dayOfMonth === undefined) {
        return false;
      }
      return true;
    },
    {
      message:
        'Frequency "weekly" requires dayOfWeek (0-6), "monthly" requires dayOfMonth (1-31)',
    },
  );
export type CreateBackupJobInput = z.infer<typeof createBackupJobSchema>;

/**
 * Schema standalone per update parziale — NON derivato da createBackupJobSchema.partial()
 * perché .partial() eredita i .refine() cross-field (e.g. "weekly requires dayOfWeek"),
 * che sono troppo restrittivi per update parziali dove i valori mancanti provengono
 * dal record esistente. Stesso pattern usato per updateMcpConnectionSchema.
 */
export const updateBackupJobSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    destinationId: z.string().uuid("Invalid destination ID").optional(),
    frequency: frequencySchema.optional(),
    time: z
      .string()
      .regex(/^\d{2}:\d{2}$/, "Time must be HH:mm format")
      .optional(),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    retentionDays: z.number().int().min(1).max(365).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided for update",
  });
export type UpdateBackupJobInput = z.infer<typeof updateBackupJobSchema>;

export const toggleBackupJobSchema = z.object({
  enabled: z.boolean(),
});
export type ToggleBackupJobInput = z.infer<typeof toggleBackupJobSchema>;

export const backupJobIdParamSchema = z.object({
  id: z.string().uuid("Invalid backup job ID"),
});
export type BackupJobIdParam = z.infer<typeof backupJobIdParamSchema>;
