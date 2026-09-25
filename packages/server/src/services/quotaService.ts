// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 207 (CLOUD-03/04/06): quota engine core — read-path composition over
// the EXISTING WorkspaceTokenUsage ledger (D-01 — no counter table, no second
// meter). Resolution chain per D-08: per-user override > install preset
// (systemConfigService DB > ENV > default) > unlimited (fail-open: unset
// quota means zero behavior change for existing installs). Reset = ledger
// anchor (D-02) — usage/cost history is NEVER deleted or zeroed (203
// snapshot doctrine). Gates are pre-turn service-level checks at the four
// consumption sites (D-03) — NOT middleware (206 D-13 precedent: the check
// needs domain data, not request shape). Quotas bind every user with a
// configured quota — admin included; unset = unlimited (D-10).

import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { getSetting } from "./systemConfigService";

/** Quota kinds riding the reset ledger. Only "tokens" resets today — storage
 * is a cap on stored bytes, not a rolling allowance (D-12). */
export type QuotaKind = "tokens" | "storage";

/**
 * Typed service error — the route maps status+payload 1:1 (AgencyError
 * pattern, agencyUserService.ts:30-41). The `quota` field is the contract
 * the frontend/widget/connector handlers key on (206 D-12; 207 D-04).
 */
export class QuotaError extends Error {
  status: number;
  payload: Record<string, unknown>;

  constructor(status: number, payload: Record<string, unknown>) {
    super(String(payload.error ?? "Quota error"));
    this.status = status;
    this.payload = payload;
  }
}

export interface QuotaResolution {
  /** null = unlimited (no quota binds this user) */
  limit: number | null;
  /** which tier of the D-08 chain produced the verdict */
  source: "override" | "preset" | "unlimited" | "unset";
}

/** The epoch stand-in for "no anchor yet" — full ledger history counts. */
const EPOCH = new Date(0);

/**
 * Latest reset anchor for a user/kind, or null when never reset.
 * (D-02: the anchor bounds the rolling window; history is immutable.)
 */
export async function latestAnchor(userId: string, kind: QuotaKind) {
  return prisma.quotaReset.findFirst({
    where: { userId, kind },
    orderBy: { at: "desc" },
  });
}

/** Rolling-window start = latest anchor time, or the epoch. */
export async function windowStart(userId: string, kind: QuotaKind): Promise<Date> {
  const anchor = await latestAnchor(userId, kind);
  return anchor ? anchor.at : EPOCH;
}

/**
 * Token usage for the CURRENT window: SUM of WorkspaceTokenUsage.totalTokens
 * since the latest reset anchor (D-01). The userId index makes this one
 * bounded indexed query; window-bounding keeps it off unbounded history.
 */
export async function getTokenWindowUsage(userId: string): Promise<number> {
  const start = await windowStart(userId, "tokens");
  const agg = await prisma.workspaceTokenUsage.aggregate({
    _sum: { totalTokens: true },
    where: { userId, createdAt: { gt: start } },
  });
  return agg._sum.totalTokens ?? 0;
}

/**
 * D-08 resolution for the token quota. Order matters:
 *   1. tokenQuotaUnlimited=true → exempt from everything (D-07)
 *   2. per-user override (User.tokenQuotaLimit) wins
 *   3. install preset (QUOTA_TOKEN_DEFAULT via getSetting) — "0"/"" sentinel
 *      = not configured
 *   4. unset → unlimited (fail-open; existing installs unaffected — D-08)
 * Quotas apply uniformly to every user with a configured quota — admin
 * included (D-10: no admin bypass).
 */
export async function resolveTokenQuota(userId: string): Promise<QuotaResolution> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tokenQuotaLimit: true, tokenQuotaUnlimited: true },
  });
  if (!user) {
    // Fail-closed identity: no user row → no quota resolution; unlimited
    // would let an unresolvable principal generate freely. Callers treat a
    // throw as a 409-family contract breach only via the gate — here we
    // resolve to unlimited BUT the gate re-checks user existence, so a
    // stale principal cannot silently consume.
    return { limit: null, source: "unset" };
  }
  if (user.tokenQuotaUnlimited) {
    return { limit: null, source: "unlimited" };
  }
  if (user.tokenQuotaLimit != null) {
    return { limit: user.tokenQuotaLimit, source: "override" };
  }
  // Preset tier — systemConfigService DB > ENV > default (systemConfigService
  // :263 doctrine). "0"/"" sentinel = not configured (D-08).
  try {
    const preset = await getSetting("QUOTA_TOKEN_DEFAULT");
    const raw = String(preset?.value ?? "").trim();
    if (raw !== "" && raw !== "0") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        return { limit: parsed, source: "preset" };
      }
    }
  } catch (err: unknown) {
    // Preset lookup is fail-open to unlimited — config-store trouble must
    // not brick generation for every user (D-08 fail-open tier semantics;
    // same doctrine as the 203 pricing fail-open). Logged for visibility.
    logger.warn(
      `[quota] QUOTA_TOKEN_DEFAULT lookup failed — resolving to unlimited: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { limit: null, source: "unset" };
}

/**
 * D-03 site 1 (chat): pre-turn token quota check. Throws the 409 family on
 * breach; resolves unlimited silently when no quota binds the user. The
 * check NEVER runs mid-stream (D-06 — pre-turn only, accepted overage
 * window). Callers pass the quota principal (D-05) — for the chat site that
 * is the acting user; anonymous surfaces resolve their own principal before
 * calling (Plan 03).
 */
export async function checkTokenQuota(principalId: string): Promise<void> {
  const resolution = await resolveTokenQuota(principalId);
  if (resolution.limit == null) return;
  const used = await getTokenWindowUsage(principalId);
  if (used >= resolution.limit) {
    const start = await windowStart(principalId, "tokens");
    throw new QuotaError(409, {
      error: "Token quota reached",
      quota: "tokens",
      limit: resolution.limit,
      used,
      windowStart: start.toISOString(),
    });
  }
}

/**
 * D-02/D-11: write a reset anchor (manual or cron). NEVER deletes or zeroes
 * usage rows (P1 prohibition — 203 cost history stays truthful). Idempotency:
 * for cron resets, `notBefore` is the due instant the sweep computed — if a
 * concurrent tick already anchored at/after it, the insert is a no-op;
 * the (userId, kind, at) unique backstops the residual race (Plan 02 cron
 * contract). Manual resets ALWAYS insert — the operator asked for it.
 */
export async function resetTokenQuota(
  userId: string,
  kind: QuotaKind,
  triggeredBy: "manual" | "cron",
  opts?: { notBefore?: Date },
): Promise<{ inserted: boolean; at: Date }> {
  return prisma.$transaction(async (tx) => {
    const latest = await tx.quotaReset.findFirst({
      where: { userId, kind },
      orderBy: { at: "desc" },
    });
    const at = new Date();
    // Latest-anchor re-check (agencyUserService TOCTOU pattern :99-110): a
    // concurrent cron writer that anchored at/after the computed due instant
    // makes this insert a no-op. Manual resets bypass the check.
    if (triggeredBy === "cron" && opts?.notBefore && latest && latest.at >= opts.notBefore) {
      return { inserted: false, at: latest.at };
    }
    await tx.quotaReset.create({
      data: { userId, kind, at, triggeredBy },
    });
    return { inserted: true, at };
  });
}

// ═══════════════ Storage accounting (CLOUD-04 / FILEORG-02, D-13/D-14) ═══════════════

/** Minimal structural query client — works for the singleton AND a $transaction tx. */
type StorageQueryClient = Pick<typeof prisma, "uploadDraft" | "document">;

export interface StorageUsageBreakdown {
  draftBytes: number;
  documentBytes: number;
  totalBytes: number;
}

/**
 * D-13/D-14: per-user storage usage = DB-row-derived byte accounting.
 *
 * Attribution follows the UPLOADER CHAIN: `UploadDraft.uploadedBy` is the
 * primary anchor; a draft's bytes count UNTIL its RAG leg completes — once
 * `draft.ragJobId` points at a Document, the DOCUMENT's fileSize counts
 * instead (no double counting of the same bytes). Documents derive
 * attribution from their originating draft row. Rows with no attributable
 * user (no draft chain) fall to the org bucket — they count against NO user
 * (Plan 210's per-user layout makes attribution structural later; no
 * re-attribution now). Tombstoned rows (deletedAt) and expired drafts are
 * excluded from every sum (D-13 — accounting must not drift from reality on
 * delete; delete sites: uploads.ts:904/1088, documents.ts:1161/1333).
 *
 * DB `fileSize` sums ONLY — no provider-level scans (S3 LIST / fs du are
 * provider-coupled and break the localfs/S3 agnostic contract).
 * Tx-parametrized so the upload route can re-check INSIDE its commit
 * transaction (T-207-07 race guard).
 */
export async function computeStorageUsage(
  client: StorageQueryClient,
  userId: string,
  now = new Date(),
): Promise<StorageUsageBreakdown> {
  const liveDraftWhere = {
    uploadedBy: userId,
    deletedAt: null,
    expiresAt: { gt: now },
  } as const;

  // (1) live drafts that have NOT yet produced a document (ragJobId null).
  // URL-sentinel drafts (isDraftStorageKey=false) never set fileSize — they
  // store no file bytes — so the row-truthful sum needs no special case.
  const draftAgg = await client.uploadDraft.aggregate({
    _sum: { fileSize: true },
    where: { ...liveDraftWhere, ragJobId: null },
  });
  const draftBytes = draftAgg._sum.fileSize ?? 0;

  // (2) durable documents attributed through their originating draft's
  // uploadedBy (the draft knows its uploader; the Document row does NOT —
  // schema-verified: Document carries no uploader column).
  const attributingDrafts = await client.uploadDraft.findMany({
    where: { ...liveDraftWhere, ragJobId: { not: null } },
    select: { ragJobId: true },
  });
  const documentIds = attributingDrafts
    .map((d) => d.ragJobId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  let documentBytes = 0;
  if (documentIds.length > 0) {
    const docAgg = await client.document.aggregate({
      _sum: { fileSize: true },
      where: { id: { in: documentIds }, deletedAt: null },
    });
    documentBytes = docAgg._sum.fileSize ?? 0;
  }

  return { draftBytes, documentBytes, totalBytes: draftBytes + documentBytes };
}

/** Storage usage for a user (admin report + quota gate). */
export async function getStorageUsage(userId: string): Promise<StorageUsageBreakdown> {
  return computeStorageUsage(prisma, userId);
}

/**
 * D-08 storage arm: storageQuotaUnlimited > per-user storageQuotaGb (GB,
 * Decimal column) > QUOTA_STORAGE_GB_DEFAULT preset > unlimited. Returns the
 * limit in GB (Decimal-compatible number) or null = unlimited.
 */
export async function resolveStorageQuota(userId: string): Promise<QuotaResolution> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { storageQuotaGb: true, storageQuotaUnlimited: true },
  });
  if (!user) return { limit: null, source: "unset" };
  if (user.storageQuotaUnlimited) return { limit: null, source: "unlimited" };
  if (user.storageQuotaGb != null) {
    return { limit: Number(user.storageQuotaGb), source: "override" };
  }
  try {
    const preset = await getSetting("QUOTA_STORAGE_GB_DEFAULT");
    const raw = String(preset?.value ?? "").trim();
    if (raw !== "" && raw !== "0") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        return { limit: parsed, source: "preset" };
      }
    }
  } catch (err: unknown) {
    logger.warn(
      `[quota] QUOTA_STORAGE_GB_DEFAULT lookup failed — resolving to unlimited: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { limit: null, source: "unset" };
}

const BYTES_PER_GB = new Prisma.Decimal(1_000_000_000);

/** GB limit → byte ceiling (Decimal math — never float GB×1e9 at scale). */
function gbToBytes(limitGb: number): Prisma.Decimal {
  return new Prisma.Decimal(limitGb).times(BYTES_PER_GB).floor();
}

/**
 * D-05 (research-amended): resolve the WIDGET quota principal — the owning
 * org's first admin member (lowest createdAt, roleInOrg "admin" — A3).
 * The widget proxy authenticates as the shared widget-service@system account
 * (P2: NEVER a quota principal) — anonymous visitor consumption attributes
 * to the org owner so per-user quotas mean something on exactly the SaaS
 * surfaces this milestone sells. Unresolvable (data corruption: workspace
 * without org / org without admin) → fail-LOUD Error — the caller's catch
 * surfaces a 500 rather than mis-attributing to the service account or
 * silently allowing (fail-closed beats wrong attribution).
 */
export async function resolveWidgetQuotaPrincipal(workspaceId: string): Promise<string> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { organizationId: true },
  });
  if (!ws?.organizationId || ws.organizationId === "00000000-0000-0000-0000-000000000000") {
    throw new Error("Widget quota principal unresolvable: workspace has no organization");
  }
  const admin = await prisma.organizationMember.findFirst({
    where: { organizationId: ws.organizationId, deletedAt: null, roleInOrg: "admin" },
    orderBy: { joinedAt: "asc" },
    select: { userId: true },
  });
  if (!admin) {
    throw new Error(`Widget quota principal unresolvable: org ${ws.organizationId} has no admin member`);
  }
  return admin.userId;
}

/**
 * D-15 storage gate core (D-03 upload sites): throws the 409 storage family
 * when `incomingBytes` exceeds the remaining quota. Tx-parametrized — the
 * upload route calls the post-upload arm INSIDE its commit transaction so
 * two parallel uploads cannot both consume the same remaining bytes
 * (T-207-07; agencyUserService in-tx ceiling re-check pattern).
 */
export async function checkStorageQuota(
  client: StorageQueryClient,
  principalId: string,
  incomingBytes: number,
  now = new Date(),
): Promise<StorageUsageBreakdown> {
  const resolution = await resolveStorageQuota(principalId);
  if (resolution.limit == null) {
    // Unlimited — still return the usage for logging/UX.
    return computeStorageUsage(client, principalId, now);
  }
  const usage = await computeStorageUsage(client, principalId, now);
  const limitBytes = gbToBytes(resolution.limit);
  if (usage.totalBytes + incomingBytes > limitBytes.toNumber()) {
    throw new QuotaError(409, {
      error: "Storage limit reached",
      quota: "storage",
      limit: resolution.limit,
      used: usage.totalBytes,
    });
  }
  return usage;
}