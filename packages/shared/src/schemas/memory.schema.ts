// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

/**
 * Phase 97 (MEM-01 D-01) — per-user-per-workspace Memory request validation.
 *
 * Single source of truth shared by server (route validation) and collector.
 * No business logic — pure Zod schemas + inferred types (shared CLAUDE.md).
 */

const memoryTypeSchema = z.enum(["user", "context"]);
type MemoryType = z.infer<typeof memoryTypeSchema>;

const memorySensitivitySchema = z.enum(["low", "medium", "high"]);
type MemorySensitivity = z.infer<typeof memorySensitivitySchema>;

/**
 * Materialized dotted path (e.g. `preferences.theme`). NON `ltree` (ROADMAP explicit).
 * Segments are non-empty, alphanumeric/`-`/`_`, separated by `.`. Nullable + optional:
 * contextual memories may not carry a structured path; user-edited memories usually do.
 */
const dottedPathSchema = z
  .string()
  .max(500)
  .regex(/^(?:[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)?$/, "Invalid dotted path")
  .nullable()
  .optional();

/** POST /api/memories body. `workspaceId` scopes the memory per-user-per-workspace. */
export const createMemorySchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  type: memoryTypeSchema,
  path: dottedPathSchema,
  content: z.string().min(1).max(5000),
  sensitivity: memorySensitivitySchema.default("low"),
});
type CreateMemoryInput = z.infer<typeof createMemorySchema>;

/**
 * PATCH /api/memories/:id body. Standalone `z.object` (NOT `.partial()` — drops
 * refines per shared CLAUDE.md). All fields optional; `.refine()` enforces at least
 * one field is present so a no-op PATCH is rejected.
 */
export const updateMemorySchema = z
  .object({
    type: memoryTypeSchema.optional(),
    path: dottedPathSchema,
    content: z.string().min(1).max(5000).optional(),
    sensitivity: memorySensitivitySchema.optional(),
  })
  .refine((v) => v.type !== undefined || v.path !== undefined || v.content !== undefined || v.sensitivity !== undefined, {
    message: "At least one field must be provided",
  });
type UpdateMemoryInput = z.infer<typeof updateMemorySchema>;

/** `:id` route param. */
export const memoryIdParamSchema = z.object({
  id: z.string().uuid("Invalid memory ID"),
});
type MemoryIdParam = z.infer<typeof memoryIdParamSchema>;

/** GET /api/memories/export query. JSON now; CSV is a discretion follow-up. */
export const memoryExportQuerySchema = z.object({
  format: z.enum(["json", "csv"]).default("json"),
});
type MemoryExportQuery = z.infer<typeof memoryExportQuerySchema>;

/** GET /api/memories list query — workspaceId required + pagination. */
export const memoryListQuerySchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type MemoryListQuery = z.infer<typeof memoryListQuerySchema>;

/**
 * Phase 97 (MEM-03 D-06) auto-extraction JSON ops gate.
 *
 * A Zod discriminatedUnion over the 4 op variants (add/replace/move/remove)
 * forms the trust boundary between the extraction LLM's untrusted JSON output
 * and the Prisma write path. The gate runs BEFORE `applyMemoryOps` so invalid
 * ops never reach the database. Independent design; no code derived from
 * upstream projects.
 */
const memoryAddOpSchema = z.object({
  op: z.literal("add"),
  type: memoryTypeSchema,
  path: dottedPathSchema,
  content: z.string().min(1).max(5000),
  sensitivity: memorySensitivitySchema.default("low"),
});

const memoryReplaceOpSchema = z.object({
  op: z.literal("replace"),
  id: z.string().uuid("A memory id is required to replace an entry"),
  type: memoryTypeSchema.optional(),
  path: dottedPathSchema,
  content: z.string().min(1).max(5000),
  sensitivity: memorySensitivitySchema.optional(),
});

const memoryMoveOpSchema = z.object({
  op: z.literal("move"),
  id: z.string().uuid("A memory id is required to move an entry"),
  path: dottedPathSchema,
});

const memoryRemoveOpSchema = z.object({
  op: z.literal("remove"),
  id: z.string().uuid("A memory id is required to remove an entry"),
});

const memoryOpSchema = z.discriminatedUnion("op", [
  memoryAddOpSchema,
  memoryReplaceOpSchema,
  memoryMoveOpSchema,
  memoryRemoveOpSchema,
]);

export const memoryOpsSchema = z.object({
  operations: z.array(memoryOpSchema).max(50, "Too many operations in one turn"),
});

export type MemoryOp = z.infer<typeof memoryOpSchema>;
type MemoryOps = z.infer<typeof memoryOpsSchema>;

/**
 * Validate raw LLM output as memory operations. Three output shapes are
 * tolerated:
 *   1. strict `{operations:[...]}` (preferred),
 *   2. markdown-wrapped string (```json ... ``` — fences stripped, then
 *      parsed; the inner payload may itself be the strict object or a bare
 *      array, which falls through to shape 3),
 *   3. bare array `[{op:"add",...}]` (wrapped in `{operations: raw}`).
 *
 * The first shape that fails strict parse determines the error message — the
 * downstream retries' failures are NOT surfaced (the LLM output is the
 * untrusted input; the user-facing error should reflect the original shape).
 */
export function validateMemoryOperations(raw: unknown): MemoryOp[] {
  const strict = memoryOpsSchema.safeParse(raw);
  if (strict.success) return strict.data.operations;

  if (typeof raw === "string") {
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    if (stripped) {
      try {
        const parsed: unknown = JSON.parse(stripped);
        const retried = memoryOpsSchema.safeParse(parsed);
        if (retried.success) return retried.data.operations;
        if (Array.isArray(parsed)) {
          const wrapped = memoryOpsSchema.safeParse({ operations: parsed });
          if (wrapped.success) return wrapped.data.operations;
        }
      } catch {
        // fall through to the final throw — the markdown branch had no valid JSON.
      }
    }
  }

  if (Array.isArray(raw)) {
    const retried = memoryOpsSchema.safeParse({ operations: raw });
    if (retried.success) return retried.data.operations;
  }

  throw new Error(
    `Invalid memory operations: ${
      strict.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") || "shape not recognized"
    }`,
  );
}