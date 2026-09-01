// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 97 (MEM-03 D-06) — memory service: sensitivity classification, deny-list,
 * dedup rewrite, and the Prisma write path for applied memory operations.
 *
 * Pitfall 3 invariants (LOCKED in 97-RESEARCH.md §Common Pitfalls):
 *   - `classifySensitivity` is AUTHORITATIVE over the LLM-emitted sensitivity
 *     (research Q2 RESOLVED). The DLP deny-list (dlpFilter.scanContent) +
 *     agent-instruction deny-list reject credentials/PII/agent-instructions
 *     regardless of what the LLM classified. If the heuristic returns a higher
 *     sensitivity than the LLM, the higher value wins (defense-in-depth).
 *   - `dedupRewrite` prevents the dedup-explosion failure mode (same fact
 *     extracted 50× across turns): cosine ≥ AGENT_MEMORY_DEDUP_THRESHOLD
 *     (default 0.92) OR path-level @@unique collision rewrites `add` → `replace`
 *     with the existing memory's id.
 *
 * Design inspired by open-webui's memory feature. The sensitivity
 * classification, the DLP/agent-instruction deny-list, and the dedup-rewrite
 * logic below are original to Simmetric Chat; no source code derived from
 * open-webui. The path-ranking idea (see memoryPathRank.ts) follows a common
 * hierarchical-match pattern.
 */

import type { MemoryOp } from "@simmetric-chat/shared";
import { scanContent } from "../services/dlpFilter";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { logEvent } from "../services/eventLogService";
import { getEnv } from "../config/env";
import axios from "axios";

// ---------------------------------------------------------------------------
// Agent-instruction deny-list (Pitfall 3 prompt-injection guard).
// ---------------------------------------------------------------------------

export const AGENT_INSTRUCTION_DENY_PATTERNS: RegExp[] = [
  /ignore (?:previous|prior|all) (?:previous )?instructions/i,
  /disregard (?:all|previous|prior) (?:previous )?instructions/i,
  /always (?:do|respond|cite|use|answer|refer) /i,
  /never (?:do|respond|cite|use|answer|refer) /i,
  /remember (?:that|to) (?:always|never|respond|cite|use) /i,
  /from now on,? /i,
  /your (?:new |updated )?(?:instructions|rules|directive) are/i,
  /system prompt/i,
];

export interface SensitivityResult {
  allowed: boolean;
  sensitivity: "low" | "medium" | "high";
  reason?: string;
}

/**
 * Classify a candidate memory's content. Authoritative — overrides the LLM's
 * own sensitivity classification (research Q2 RESOLVED).
 *
 *  1. DLP scan (dlpFilter.scanContent) — hard deny on any PII match
 *     (email, credit_card, ssn, api_key, aws_key, private_key).
 *  2. Agent-instruction deny-list — hard deny on prompt-injection patterns
 *     ("ignore previous instructions", "always do X", "remember to ...").
 *  3. Soft sensitivity bump — phone-like patterns and health/dietary terms
 *     become `medium` (allowed but classified; never auto-injected by 97-02).
 *  4. Default — `low` (general preferences/facts).
 */
export function classifySensitivity(content: string): SensitivityResult {
  if (typeof content !== "string" || content.length === 0) {
    return { allowed: false, sensitivity: "high", reason: "Empty content" };
  }

  // 1. DLP scan — hard deny on PII.
  const dlp = scanContent(content);
  if (dlp.hasMatch) {
    const types = [...new Set(dlp.matches.map((m) => m.type))].join(", ");
    return {
      allowed: false,
      sensitivity: "high",
      reason: `Deny-list match: ${types}`,
    };
  }

  // 2. Agent-instruction deny-list — hard deny on prompt injection.
  for (const pattern of AGENT_INSTRUCTION_DENY_PATTERNS) {
    if (pattern.test(content)) {
      return {
        allowed: false,
        sensitivity: "high",
        reason: `Agent-instruction deny-list match: ${pattern.source}`,
      };
    }
  }

  // 3. Soft sensitivity bump (allowed but classified as medium).
  if (/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/.test(content)) {
    return { allowed: true, sensitivity: "medium", reason: "Phone-like pattern" };
  }
  if (/\b(allerg(?:y|ies|ic)?|diabet(?:ic|es)?|medication|health(?:y)?|disease|condition)\b/i.test(content)) {
    return { allowed: true, sensitivity: "medium", reason: "Health-adjacent term" };
  }

  return { allowed: true, sensitivity: "low" };
}

/**
 * Resolve the final sensitivity between the LLM-emitted hint and the
 * server-side authoritative classification. The higher value wins
 * (defense-in-depth — research Q2 RESOLVED).
 */
export function resolveSensitivity(
  llmSensitivity: "low" | "medium" | "high" | undefined,
  server: SensitivityResult,
): "low" | "medium" | "high" {
  if (!server.allowed) return "high";
  const order: Record<"low" | "medium" | "high", number> = { low: 0, medium: 1, high: 2 };
  const llm = llmSensitivity ?? "low";
  return order[server.sensitivity] >= order[llm] ? server.sensitivity : llm;
}

// ---------------------------------------------------------------------------
// Dedup rewrite (cosine ≥ threshold OR path-level @@unique collision).
// ---------------------------------------------------------------------------

interface DedupExistingMemory {
  id: string;
  content: string;
  path: string | null;
  /** Optional precomputed cosine similarity to the candidate content (0..1).
   *  When omitted, only the path-level collision check applies. */
  similarity?: number;
}

export interface DedupRewriteOpts {
  op: MemoryOp;
  userId: string;
  workspaceId: string;
  existingMemories: DedupExistingMemory[];
  threshold: number;
}

/**
 * Rewrite an `add` op → `replace` when a near-duplicate is detected, either
 * by cosine similarity ≥ threshold (semantic dedup) OR by path-level collision
 * on `[userId, workspaceId, path]` (the @@unique constraint from 97-01).
 *
 * For `replace` / `move` / `remove` ops the op already carries an `id`, so the
 * caller does not need to dedup — return unchanged.
 *
 * Returns the (possibly rewritten) op.
 */
export function dedupRewrite(opts: DedupRewriteOpts): MemoryOp {
  const { op, existingMemories, threshold } = opts;
  if (op.op !== "add") return op;

  // (a) Path-level collision — the @@unique([userId, workspaceId, path]) from
  //     97-01 catches exact-path dupes; rewrite add → replace with the
  //     existing memory's id.
  if (op.path) {
    const pathMatch = existingMemories.find((m) => m.path === op.path);
    if (pathMatch) {
      return {
        op: "replace",
        id: pathMatch.id,
        type: op.type,
        path: op.path,
        content: op.content,
        sensitivity: op.sensitivity,
      };
    }
  }

  // (b) Cosine ≥ threshold — semantic near-duplicate across different paths.
  //     The caller pre-computes the similarity (it has the collector embedding
  //     query results); we pick the highest-similarity existing memory.
  let bestMatch: DedupExistingMemory | null = null;
  let bestSim = -1;
  for (const m of existingMemories) {
    const sim = typeof m.similarity === "number" ? m.similarity : -1;
    if (sim > bestSim) {
      bestSim = sim;
      bestMatch = m;
    }
  }
  if (bestMatch && bestSim >= threshold) {
    return {
      op: "replace",
      id: bestMatch.id,
      type: op.type,
      path: op.path,
      content: op.content,
      sensitivity: op.sensitivity,
    };
  }

  return op;
}
// ---------------------------------------------------------------------------
// applyMemoryOps — Prisma write path for validated memory operations.
// ---------------------------------------------------------------------------

/** Non-embedding fields — excludes the Unsupported vector column (Prisma
 *  cannot deserialize it; embedding is write-only via $executeRaw). */
const MEMORY_SELECT = {
  id: true,
  userId: true,
  workspaceId: true,
  type: true,
  path: true,
  content: true,
  sourceMessageId: true,
  sensitivity: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface ApplyMemoryOpsOpts {
  userId: string;
  workspaceId: string;
  ops: MemoryOp[];
  /** Existing memories for this user+workspace (for dedup). The caller
   *  pre-fetches via Prisma to avoid N+1 queries inside the loop. */
  existingMemories: { id: string; content: string; path: string | null }[];
  /** Optional sourceMessageId to attach to extracted memories (GDPR reaper
   *  cascade — when the source ChatMessage is purged, the memory cascades). */
  sourceMessageId?: string | null;
}

/**
 * Apply a batch of validated memory operations to the database. Each op is
 * classified by `classifySensitivity` (authoritative), deduped via
 * `dedupRewrite` (cosine ≥ threshold OR path-level collision), and written
 * via the Prisma dual-write pattern ($executeRaw INSERT + $executeRaw UPDATE
 * for the embedding column — Prisma `create` is unavailable on models with
 * Unsupported columns per 97-01 finding).
 *
 * The function is best-effort per op: a single op failure does NOT abort the
 * batch (the extraction is fire-and-forget background). Failures are logged.
 */
export async function applyMemoryOps(opts: ApplyMemoryOpsOpts): Promise<void> {
  const { userId, workspaceId, ops, existingMemories, sourceMessageId = null } = opts;
  if (!ops.length) return;

  const threshold = getEnv().AGENT_MEMORY_DEDUP_THRESHOLD;

  for (const rawOp of ops) {
    try {
      // 1. Classify sensitivity (authoritative — research Q2 RESOLVED).
      //    Only add/replace ops carry content to classify.
      const opContent = rawOp.op === "add" || rawOp.op === "replace" ? rawOp.content : null;
      if (opContent !== null) {
        const classification = classifySensitivity(opContent);
        if (!classification.allowed) {
          logger.info(
            `[memory] Op rejected by deny-list: ${classification.reason}`,
            { userId, workspaceId, op: rawOp.op, path: "path" in rawOp ? rawOp.path : null },
          );
          await logEvent("memory", userId, "extract.skip", null, {
            workspaceId,
            reason: classification.reason,
            op: rawOp.op,
          });
          continue;
        }
      }

      // 2. Dedup rewrite (add → replace on cosine ≥ threshold OR path collision).
      const op = dedupRewrite({
        op: rawOp,
        userId,
        workspaceId,
        existingMemories,
        threshold,
      });

      // 3. Apply the op via the appropriate Prisma path.
      if (op.op === "add") {
        const sensitivity =
          opContent !== null
            ? resolveSensitivity(op.sensitivity, classifySensitivity(opContent))
            : "low";
        const id = crypto.randomUUID();
        await prisma.$executeRaw`
          INSERT INTO "memories"
            ("id", "userId", "workspaceId", "type", "path", "content", "sourceMessageId", "sensitivity", "createdAt", "updatedAt")
          VALUES
            (${id}, ${userId}, ${workspaceId}, ${op.type}::"MemoryType", ${op.path ?? null}, ${op.content}, ${sourceMessageId}::text, ${sensitivity}::"MemorySensitivity", NOW(), NOW())
        `;
        await logEvent("memory", userId, "extract", id, {
          workspaceId,
          op: "add",
          path: op.path,
          type: op.type,
        });
      } else if (op.op === "replace") {
        const sensitivity =
          opContent !== null && op.sensitivity
            ? resolveSensitivity(op.sensitivity, classifySensitivity(opContent))
            : undefined;
        await prisma.memory.update({
          where: { id: op.id, userId, workspaceId },
          data: {
            ...(op.type !== undefined && { type: op.type }),
            ...(op.path !== undefined && { path: op.path ?? null }),
            content: op.content,
            ...(sensitivity !== undefined && { sensitivity }),
            sourceMessageId: sourceMessageId ?? null,
          },
          select: MEMORY_SELECT,
        });
        await logEvent("memory", userId, "extract", op.id, {
          workspaceId,
          op: "replace",
          path: op.path,
        });
      } else if (op.op === "move") {
        await prisma.memory.update({
          where: { id: op.id, userId, workspaceId },
          data: { path: op.path ?? null },
          select: MEMORY_SELECT,
        });
        await logEvent("memory", userId, "extract", op.id, {
          workspaceId,
          op: "move",
          path: op.path,
        });
      } else if (op.op === "remove") {
        await prisma.memory.delete({
          where: { id: op.id, userId, workspaceId },
          select: MEMORY_SELECT,
        });
        await logEvent("memory", userId, "extract", op.id, {
          workspaceId,
          op: "remove",
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[memory] applyMemoryOps op failed (continuing batch): ${msg}`, {
        userId,
        workspaceId,
        op: rawOp.op,
      });
    }
  }
}

/**
 * Embed content via the collector and query existing memories for cosine
 * similarity (dedup source). Returns the existing memories annotated with
 * their similarity to the candidate content.
 *
 * Best-effort: collector failure → returns the existing memories without
 * similarity scores (path-level dedup still applies).
 */
export async function queryExistingMemoriesForDedup(opts: {
  userId: string;
  workspaceId: string;
  candidateContent: string;
  existingMemories: { id: string; content: string; path: string | null }[];
}): Promise<{ id: string; content: string; path: string | null; similarity?: number }[]> {
  const { userId, workspaceId, candidateContent, existingMemories } = opts;
  if (existingMemories.length === 0) return [];

  const collection = `user_memory_${userId}_${workspaceId}`;
  try {
    const env = getEnv();
    const resp = await axios.post(
      `${env.COLLECTOR_URL}/api/ingest/query`,
      { query: candidateContent, workspaceId: collection, limit: 20 },
      {
        headers: { "X-Collector-Secret": env.COLLECTOR_SECRET },
        timeout: 5000,
        validateStatus: (s: number) => s < 500,
      },
    );
    if (resp.status >= 400 || !resp.data) return existingMemories;
    const hits: Array<{ id?: string; score?: number; content?: string }> = Array.isArray(resp.data.results)
      ? resp.data.results
      : [];
    // Map collector hit id → similarity score; merge with existing memories.
    const scoreById = new Map<string, number>();
    for (const h of hits) {
      if (h.id && typeof h.score === "number") scoreById.set(h.id, h.score);
    }
    return existingMemories.map((m) => ({
      ...m,
      similarity: scoreById.get(m.id),
    }));
  } catch {
    return existingMemories;
  }
}
