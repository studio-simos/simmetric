// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== Backup Destination Schemas =====
// Phase 52: Zod validation for backup destination CRUD.

// --- Enum Schemas ---

const destinationTypeSchema = z.enum([
  "local",
  "s3",
  "s3_compatible",
  "google_drive",
  "dropbox",
  "sftp",
  "ftp",
  "email",
]);
type DestinationTypeSchema = z.infer<typeof destinationTypeSchema>;

const destinationStatusSchema = z.enum([
  "online",
  "offline",
  "error",
  "unknown",
]);
type DestinationStatusSchema = z.infer<typeof destinationStatusSchema>;

// --- Config Schemas per Provider Type ---

export const localConfigSchema = z.object({
  path: z.string().min(1).max(500),
});
type LocalConfigInput = z.infer<typeof localConfigSchema>;

export const s3ConfigSchema = z.object({
  bucket: z.string().min(1),
  region: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
});
type S3ConfigInput = z.infer<typeof s3ConfigSchema>;

export const s3CompatibleConfigSchema = z.object({
  bucket: z.string().min(1),
  region: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  endpoint: z.string().url(),
  forcePathStyle: z.boolean().optional().default(false),
});
type S3CompatibleConfigInput = z.infer<typeof s3CompatibleConfigSchema>;

const googleDriveConfigSchema = z.object({
  folderId: z.string().min(1),
  serviceAccountKey: z.string().min(1),
});
type GoogleDriveConfigInput = z.infer<typeof googleDriveConfigSchema>;

const dropboxConfigSchema = z.object({
  folderPath: z.string().min(1),
  accessToken: z.string().min(1),
});
type DropboxConfigInput = z.infer<typeof dropboxConfigSchema>;

export const sftpConfigSchema = z
  .object({
    host: z.string().min(1),
    port: z.coerce.number().int().min(1).max(65535),
    username: z.string().min(1),
    password: z.string().min(1).optional(),
    privateKey: z.string().min(1).optional(),
  })
  .refine(
    (data: { password?: string; privateKey?: string }) => data.password !== undefined || data.privateKey !== undefined,
    {
      message: "Either password or privateKey is required for SFTP",
    },
  );
type SftpConfigInput = z.infer<typeof sftpConfigSchema>;

const ftpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  username: z.string().min(1),
  password: z.string().min(1),
});
type FtpConfigInput = z.infer<typeof ftpConfigSchema>;

const emailConfigSchema = z.object({
  smtpHost: z.string().min(1),
  smtpPort: z.coerce.number().int().min(1).max(65535),
  username: z.string().min(1),
  password: z.string().min(1),
  fromAddress: z.string().email(),
  toAddress: z.string().email(),
});
type EmailConfigInput = z.infer<typeof emailConfigSchema>;

// --- Config Schema Map per Cross-Field Validation ---

const configSchemaMap: Record<string, z.ZodTypeAny> = {
  local: localConfigSchema,
  s3: s3ConfigSchema,
  s3_compatible: s3CompatibleConfigSchema,
  google_drive: googleDriveConfigSchema,
  dropbox: dropboxConfigSchema,
  sftp: sftpConfigSchema,
  ftp: ftpConfigSchema,
  email: emailConfigSchema,
};

// --- CRUD Schemas ---

export const createBackupDestinationSchema = z
  .object({
    name: z.string().min(1).max(200),
    type: destinationTypeSchema,
    config: z.record(z.string(), z.unknown()),
  })
  .refine(
    (data: { type: string; config: Record<string, unknown> }) => {
      const schema = configSchemaMap[data.type];
      if (!schema) return false;
      const result = schema.safeParse(data.config);
      return result.success;
    },
    {
      message: "Config does not match the expected schema for the selected destination type",
    },
  );
type CreateBackupDestinationInput = z.infer<typeof createBackupDestinationSchema>;

export const updateBackupDestinationSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((data: Record<string, unknown>) => Object.keys(data).length > 0, {
    message: "At least one field must be provided for update",
  });
type UpdateBackupDestinationInput = z.infer<typeof updateBackupDestinationSchema>;

// Nota: type NON è modificabile in update — il tipo di destinazione è immutabile.

export const backupDestinationIdParamSchema = z.object({
  id: z.string().uuid("Invalid backup destination ID"),
});
type BackupDestinationIdParam = z.infer<typeof backupDestinationIdParamSchema>;

// ===== Restore Schemas =====
// Phase 55: Zod validation for the restore workflow.

/**
 * Selective mode for restore operations (D-04, D-05, D-06, D-07).
 * - "db": restore only the database from the dump
 * - "files": restore only the file-system directories
 * - "complete": restore both (db first, then files; on db failure files are not touched)
 */
const restoreSelectiveSchema = z.enum(["db", "files", "complete"]);
type RestoreSelective = z.infer<typeof restoreSelectiveSchema>;

/**
 * Request body for POST /api/backups/restore/:logId (D-09, D-10).
 * Requires the literal string "RESTORE" in the `confirmation` field —
 * case-sensitive, exact match. A missing or wrong value triggers 400.
 */
const restoreRequestSchema = z.object({
  selective: restoreSelectiveSchema.default("complete"),
  confirmation: z.literal("RESTORE", {
    error: 'Confirmation required. Send confirmation: "RESTORE" to proceed.',
  }),
});
type RestoreRequestInput = z.infer<typeof restoreRequestSchema>;

/**
 * Response from GET /api/backups/restore/:logId/dry-run (D-11, D-12).
 * Describes what the restore WOULD do, without applying any changes.
 */
const restoreDryRunResponseSchema = z.object({
  success: z.literal(true),
  isValid: z.boolean(),
  fileSize: z.number().int().nonnegative(),
  checksumVerified: z.boolean(),
  contents: z.object({
    files: z.array(z.string()),
    tables: z.array(z.string()),
  }),
});
type RestoreDryRunResponse = z.infer<typeof restoreDryRunResponseSchema>;

/**
 * Response from POST /api/backups/restore/:logId (D-13, D-14).
 * Synchronous restore that waits up to 30 minutes before returning.
 */
const restoreResponseSchema = z.object({
  status: z.enum(["success", "failed"]),
  summary: z.object({
    restoredAt: z.string().datetime(),
    safetyBackupPath: z.string(),
    restoredDb: z.boolean(),
    restoredFiles: z.boolean(),
    durationMs: z.number().int().nonnegative(),
  }),
  error: z.string().optional(),
});
type RestoreResponse = z.infer<typeof restoreResponseSchema>;

/**
 * Path parameter validation for any route that operates on a BackupLog UUID.
 * Used by GET /api/backups, /dry-run, and the POST /restore endpoints.
 */
const backupLogIdParamSchema = z.object({
  logId: z.string().uuid("Invalid backup log ID"),
});
type BackupLogIdParam = z.infer<typeof backupLogIdParamSchema>;

// ===== Backup Log List Query (Phase 57-03) =====
/**
 * Query params for GET /api/backups. Server-side filtering + offset pagination.
 *
 * Defaults applied by the route handler (NOT by the schema) to preserve
 * backward compatibility — the original handler returned `BackupLog[]`
 * without any query params, and the new envelope shape only kicks in when
 * the client opts in by passing page/pageSize or filters. The schema uses
 * `.partial()` + safe parsing to allow missing fields.
 *
 * - status: BackupLog status enum (4 values)
 * - destinationId/jobId: UUID foreign keys
 * - dateFrom/dateTo: ISO-8601 strings (parsed to Date by the route)
 * - page: 1-based page number, default 1
 * - pageSize: 1..100, default 20
 * - sort: leading "-" means descending; allowlist prevents injection
 */
const backupLogStatusSchema = z.enum([
  "running",
  "success",
  "failed",
  "restored",
]);

const backupLogListQuerySchema = z.object({
  status: backupLogStatusSchema.optional(),
  destinationId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().optional(),
});
type BackupLogListQuery = z.infer<typeof backupLogListQuerySchema>;

/**
 * Paginated response envelope for GET /api/backups.
 */
const backupLogsResponseSchema = z.object({
  data: z.array(z.unknown()),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  totalPages: z.number().int().min(0),
});
type BackupLogsResponse = z.infer<typeof backupLogsResponseSchema>;
