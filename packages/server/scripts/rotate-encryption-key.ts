/**
 * rotate-encryption-key.ts — Operator-facing CLI that re-encrypts every
 * encrypted row from the previous key to the new key, idempotently +
 * resumably + fail-closed.
 *
 * D-04: CLI-only (tsx-run). NOT mounted on any Express route.
 * D-06: --dry-run (no-write) + --resume (from marker) flags.
 * D-07: Fail-closed on any undecryptable row — aborts with {table, id, error}.
 * D-08: Resume marker via direct prisma.systemConfig.upsert (NOT the settings
 *       service, which validates against the closed configKeySchema enum and
 *       would reject the marker key). Mirrors seedConfigDefaults() pattern.
 *
 * Strict deploy order (ROADMAP line 124):
 *   1. Deploy multi-key v2 (encryptionService.ts) — Plan 01
 *   2. Restart server with LEGACY_PREVIOUS_ENCRYPTION_KEYS=<old key base64>
 *   3. Run `pnpm --filter server rotate-encryption-key`
 *   4. Run `pnpm --filter server verify-encryption-key` — gate below_active=0
 *
 * Usage:
 *   pnpm --filter server rotate-encryption-key [--dry-run] [--resume]
 */

import crypto from "crypto";
import { program } from "commander";
import prisma from "../src/utils/prisma";
import {
  encrypt,
  decrypt,
  getDecryptKeyChain,
  resetEncryptionKeyCache,
} from "../src/services/encryptionService";

// ---------------------------------------------------------------------------
// Static encrypted-column registry (RESEARCH §Encrypted-Column Enumeration).
// EXACTLY 2 columns. system_config + mcp_connections.headers are OUT (plaintext).
// DO NOT runtime-grep `encrypt(` — a static registry is the source of truth.
// ---------------------------------------------------------------------------
export const ENCRYPTED_COLUMNS = [
  {
    table: "provider",
    column: "apiKey",
    model: "provider" as const,
    includeDeleted: false,
  },
  {
    table: "backupDestination",
    column: "config",
    model: "backupDestination" as const,
    includeDeleted: true, // bypass withSoftDelete (Pitfall 4) — tombstoned rows still brick
  },
] as const;

export type EncryptedColumnSpec = (typeof ENCRYPTED_COLUMNS)[number];

// ---------------------------------------------------------------------------
// Resume marker (D-08 — direct prisma.systemConfig.upsert, NOT the settings service)
// ---------------------------------------------------------------------------
const MARKER_KEY = "encryption_key_rotation_progress";

export interface ResumeMarker {
  fromKeyFingerprint: string;
  toKeyFingerprint: string;
  startedAt: string;
  lastTable: string;
  lastId: string;
  status: "in_progress" | "complete";
}

export function keyFingerprint(key: Buffer): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
}

async function readMarker(): Promise<ResumeMarker | null> {
  const row = await prisma.systemConfig.findUnique({ where: { key: MARKER_KEY } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as ResumeMarker;
  } catch {
    return null;
  }
}

async function writeMarker(m: ResumeMarker): Promise<void> {
  await prisma.systemConfig.upsert({
    where: { key: MARKER_KEY },
    create: { key: MARKER_KEY, value: JSON.stringify(m) },
    update: { value: JSON.stringify(m) },
  });
}

async function clearMarker(): Promise<void> {
  await prisma.systemConfig.deleteMany({ where: { key: MARKER_KEY } });
}

// ---------------------------------------------------------------------------
// Classification (RESEARCH §2) — shared by rotate + verify
// ---------------------------------------------------------------------------
export type RowClass = "active" | "legacy" | "undecryptable";

function tryKey(
  key: Buffer,
  iv: Buffer,
  authTag: Buffer,
  ciphertext: string,
): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  let out = decipher.update(ciphertext, "hex", "utf8");
  out += decipher.final("utf8"); // throws on wrong key (GCM auth failure)
  return out;
}

export function classify(encoded: string, chain: Buffer[]): RowClass {
  const [ivHex, authTagHex, ciphertext] = encoded.split(":");
  if (!ivHex || !authTagHex || !ciphertext) return "undecryptable";
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  if (chain.length === 0) return "undecryptable";
  // chain[0] = new key. If it decrypts, the row is already rotated (active).
  const [newKey, ...rest] = chain;
  try {
    tryKey(newKey!, iv, authTag, ciphertext);
    return "active";
  } catch {
    /* not new — try the rest */
  }
  for (const key of rest) {
    try {
      tryKey(key, iv, authTag, ciphertext);
      return "legacy";
    } catch {
      /* try next */
    }
  }
  return "undecryptable";
}

// ---------------------------------------------------------------------------
// Sweep (RESEARCH §3 — interactive per-row $transaction)
// ---------------------------------------------------------------------------
const BATCH_SIZE = 500;

interface SweepResult {
  visited: number;
  skipped: number;
  reEncrypted: number;
  legacyDetected: number;
  undecryptable: number;
}

interface SweepOpts {
  dryRun: boolean;
  resumeMarker: ResumeMarker | null;
}

async function sweepColumn(
  spec: EncryptedColumnSpec,
  opts: SweepOpts,
): Promise<SweepResult> {
  const chain = getDecryptKeyChain();
  const result: SweepResult = {
    visited: 0,
    skipped: 0,
    reEncrypted: 0,
    legacyDetected: 0,
    undecryptable: 0,
  };

  // Resume: skip this table entirely if the marker already passed it.
  const markerTables: string[] = ENCRYPTED_COLUMNS.map((c) => c.table);
  const specIndex = markerTables.indexOf(spec.table);
  const markerIndex = opts.resumeMarker
    ? markerTables.indexOf(opts.resumeMarker.lastTable)
    : -1;
  if (
    opts.resumeMarker &&
    markerIndex > specIndex &&
    opts.resumeMarker.status === "in_progress"
  ) {
    // This table was fully completed before the marker advanced.
    return result;
  }

  // Cursor pagination — start after the marker's lastId if resuming in-table.
  let cursor: string | undefined =
    opts.resumeMarker && opts.resumeMarker.lastTable === spec.table
      ? opts.resumeMarker.lastId
      : undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const modelApi = (prisma as unknown as Record<string, { findMany: (a: unknown) => Promise<Array<{ id: string; [k: string]: unknown }>>; findUnique: (a: unknown) => Promise<unknown>; update: (a: unknown) => Promise<unknown> }>)[spec.model]!;
    const rows = await modelApi.findMany({
      take: BATCH_SIZE,
      orderBy: { id: "asc" },
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      // includeDeleted: true → do NOT add deletedAt: null filter (Pitfall 4).
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      const encoded = row[spec.column] as string | null | undefined;
      cursor = row.id;
      result.visited++;
      if (!encoded || encoded === "") {
        result.skipped++;
        continue;
      }
      const cls = classify(encoded, chain);
      if (cls === "active") {
        result.skipped++;
        continue;
      }
      if (cls === "undecryptable") {
        result.undecryptable++;
        // D-07: fail-closed — abort the sweep, no silent skip.
        throw new Error(
          `Fail-closed: cannot decrypt ${spec.table}.id=${row.id} with any key in chain`,
        );
      }
      // cls === "legacy" → re-encrypt with chain[0] (the new key).
      result.legacyDetected++;
      if (opts.dryRun) {
        // Dry-run: report but do NOT write, do NOT count as reEncrypted.
        continue;
      }
      const plaintext = decrypt(encoded); // try-chain finds the working key
      const reEncrypted = encrypt(plaintext); // emits new-key ciphertext (chain[0])
      await prisma.$transaction(async (tx) => {
        const txApi = (tx as unknown as Record<string, { findUnique: (a: unknown) => Promise<unknown>; update: (a: unknown) => Promise<unknown> }>)[spec.model]!;
        const fresh = await txApi.findUnique({
          where: { id: row.id },
          select: { [spec.column]: true },
        });
        // Re-check under the tx: if another process already re-encrypted, skip.
        if (fresh && (fresh as Record<string, unknown>)[spec.column] !== encoded) {
          return; // row changed mid-sweep — skip
        }
        await txApi.update({
          where: { id: row.id },
          data: { [spec.column]: reEncrypted },
        });
      });
      // Update the resume marker after each committed row.
      if (opts.resumeMarker) {
        opts.resumeMarker.lastTable = spec.table;
        opts.resumeMarker.lastId = row.id;
        await writeMarker(opts.resumeMarker);
      }
      result.reEncrypted++;
    }
    if (rows.length < BATCH_SIZE) break;
  }
  return result;
}

// ---------------------------------------------------------------------------
// main() — exported as runRotation for unit testing (bypasses commander parse)
// ---------------------------------------------------------------------------
export interface RotationSummary {
  provider: SweepResult & { legacyDetected: number };
  backupDestination: SweepResult & { legacyDetected: number };
  resumedFrom: { lastTable: string; lastId: string } | null;
}

export interface RunOpts {
  dryRun: boolean;
  resume: boolean;
}

export async function runRotation(opts: RunOpts): Promise<RotationSummary> {
  // Ensure env is fresh — the chain may have been cached by a prior process.
  resetEncryptionKeyCache();
  const chain = getDecryptKeyChain();
  if (chain.length === 0) {
    throw new Error("[rotate-encryption-key] Empty key chain — cannot rotate.");
  }
  const newKey = chain[0];
  const toFingerprint = keyFingerprint(newKey!);

  // Warn (do NOT abort) if LEGACY_PREVIOUS_ENCRYPTION_KEYS is unset — signals
  // the operator may not have completed step 1 of the strict deploy order.
  if (!process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS || process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS.trim() === "") {
    console.warn(
      "[rotate-encryption-key] WARNING: LEGACY_PREVIOUS_ENCRYPTION_KEYS is not set. " +
        "Ensure the server has been restarted with the previous key in the chain BEFORE running this CLI " +
        "(strict deploy order — ROADMAP line 124, Pitfall 1).",
    );
  }

  // Resume handling (D-08).
  let resumeMarker: ResumeMarker | null = null;
  let resumedFrom: { lastTable: string; lastId: string } | null = null;
  if (opts.resume) {
    const existing = await readMarker();
    if (existing && existing.toKeyFingerprint === toFingerprint) {
      resumeMarker = existing;
      resumedFrom = { lastTable: existing.lastTable, lastId: existing.lastId };
      console.warn(
        `[rotate-encryption-key] Resuming from ${existing.lastTable}.id=${existing.lastId}`,
      );
    } else {
      console.warn(
        "[rotate-encryption-key] --resume requested but no matching marker found; starting fresh.",
      );
    }
  }

  // Write a fresh marker (or overwrite a stale one) when not dry-running.
  if (!opts.dryRun && !resumeMarker) {
    resumeMarker = {
      fromKeyFingerprint: chain.length > 1 ? keyFingerprint(chain[1]!) : "",
      toKeyFingerprint: toFingerprint,
      startedAt: new Date().toISOString(),
      lastTable: ENCRYPTED_COLUMNS[0].table,
      lastId: "",
      status: "in_progress",
    };
    await writeMarker(resumeMarker);
  }

  const summary: RotationSummary = {
    provider: { visited: 0, skipped: 0, reEncrypted: 0, legacyDetected: 0, undecryptable: 0 },
    backupDestination: { visited: 0, skipped: 0, reEncrypted: 0, legacyDetected: 0, undecryptable: 0 },
    resumedFrom,
  };

  for (const spec of ENCRYPTED_COLUMNS) {
    const res = await sweepColumn(spec, { dryRun: opts.dryRun, resumeMarker });
    (summary as unknown as Record<string, SweepResult>)[spec.table] = res;
  }

  // On success: clear the marker (non-dry-run only) + log a summary.
  if (!opts.dryRun && resumeMarker) {
    await clearMarker();
  }

  console.warn(
    `[rotate-encryption-key] Summary: ` +
      `provider { visited: ${summary.provider.visited}, skipped: ${summary.provider.skipped}, ` +
      `reEncrypted: ${summary.provider.reEncrypted}, legacyDetected: ${summary.provider.legacyDetected} }, ` +
      `backupDestination { visited: ${summary.backupDestination.visited}, skipped: ${summary.backupDestination.skipped}, ` +
      `reEncrypted: ${summary.backupDestination.reEncrypted}, legacyDetected: ${summary.backupDestination.legacyDetected} }` +
      (opts.dryRun ? " (dry-run — no writes)" : ""),
  );

  return summary;
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  program
    .option("--dry-run", "decrypt + classify + report, WITHOUT writing any row or marker")
    .option("--resume", "continue from the encryption_key_rotation_progress marker")
    .parse();

  const opts = program.opts() as { dryRun?: boolean; resume?: boolean };
  await runRotation({ dryRun: !!opts.dryRun, resume: !!opts.resume });
}

// Only run main when invoked directly via tsx, not when imported by tests.
const isDirectInvocation =
  typeof require !== "undefined" && require.main === module;
if (isDirectInvocation) {
  main()
    .then(() => prisma.$disconnect())
    .catch((err: Error) => {
      console.error("[rotate-encryption-key] Fatal:", err.message);
      prisma.$disconnect()
        .catch(() => {})
        .finally(() => process.exit(1));
    });
}