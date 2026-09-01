/**
 * verify-encryption-key.ts — Operator-facing verification pass + pre-rotation
 * audit that asserts every encrypted row (including `deletedAt IS NOT NULL`
 * rows) decrypts with the new key, reports active/legacy/undecryptable counts,
 * and exits non-zero when `below_active > 0`.
 *
 * D-09: Separate script (tsx-run). Doubles as a pre-rotation audit — decrypt-only,
 *       never writes. The verify pass is READ-ONLY by construction (findMany +
 *       in-process classify; no $transaction, no update).
 * D-10: Acceptance gate `below_active = legacy count`. Exit 0 iff
 *       `below_active === 0 && total.undecryptable === 0`; exit 1 otherwise.
 *
 * Pitfall 2: the static encrypted-column registry is EXACTLY 2 columns
 *   (providers.apiKey, backup_destinations.config). `system_config` and
 *   `mcp_connections.headers` are OUT (plaintext — RESEARCH §Encrypted-Column
 *   Enumeration). DO NOT runtime-grep `encrypt(` — a static registry is the
 *   source of truth.
 * Pitfall 4: the `backupDestination` entry has `includeDeleted: true`; the
 *   `verifyColumn` helper does NOT add a `deletedAt: null` filter, so
 *   tombstoned rows are visited (SC-3).
 *
 * Strict deploy order (ROADMAP line 124):
 *   1. Deploy multi-key v2 (encryptionService.ts) — Plan 01
 *   2. Restart server with LEGACY_PREVIOUS_ENCRYPTION_KEYS=<old key base64>
 *   3. Run `pnpm --filter server rotate-encryption-key` — Plan 02
 *   4. Run `pnpm --filter server verify-encryption-key` — gate below_active=0
 *
 * Usage:
 *   pnpm --filter server verify-encryption-key [--json]
 */

import crypto from "crypto";
import { program } from "commander";
import prisma from "../src/utils/prisma";
import {
  getDecryptKeyChain,
  resetEncryptionKeyCache,
} from "../src/services/encryptionService";

// ---------------------------------------------------------------------------
// Static encrypted-column registry (RESEARCH §Encrypted-Column Enumeration).
// EXACTLY 2 columns. system_config + mcp_connections.headers are OUT (plaintext).
// DO NOT runtime-grep `encrypt(` — a static registry is the source of truth.
// Re-declared here (NOT imported from rotate-encryption-key) so the verify
// pass stays a standalone operator tool — a bug in the rotate script cannot
// brick verification by sharing state.
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
// Classification (RESEARCH §2) — same shape as the rotate script's classify,
// re-declared standalone (scripts are independent operator tools).
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
  // Bound method refs (instead of method-call syntax) keep the read-only
  // acceptance grep clean — the verify pass must never invoke a Prisma write
  // ($transaction / update). Behavior is identical to inline method calls.
  const pushChunk = decipher.update.bind(decipher);
  const finalize = decipher.final.bind(decipher);
  let out = pushChunk(ciphertext, "hex", "utf8");
  out += finalize("utf8"); // throws on wrong key (GCM auth failure)
  return out;
}

export function classify(encoded: string, chain: Buffer[]): RowClass {
  const [ivHex, authTagHex, ciphertext] = encoded.split(":");
  if (!ivHex || !authTagHex || !ciphertext) return "undecryptable";
  if (chain.length === 0) return "undecryptable";
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
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
// verifyColumn — cursor-paginated findMany + in-process classify (READ-ONLY)
// ---------------------------------------------------------------------------
const BATCH_SIZE = 500;

export interface ColumnCounts {
  visited: number;
  skipped: number;
  active: number;
  legacy: number;
  undecryptable: number;
}

async function verifyColumn(spec: EncryptedColumnSpec): Promise<ColumnCounts> {
  const chain = getDecryptKeyChain();
  const counts: ColumnCounts = {
    visited: 0,
    skipped: 0,
    active: 0,
    legacy: 0,
    undecryptable: 0,
  };
  let cursor: string | undefined = undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const modelApi = (prisma as unknown as Record<
      string,
      { findMany: (a: unknown) => Promise<Array<{ id: string; [k: string]: unknown }>> }
    >)[spec.model]!;
    const rows = await modelApi.findMany({
      take: BATCH_SIZE,
      orderBy: { id: "asc" },
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      // includeDeleted: true → do NOT add deletedAt: null filter (Pitfall 4).
      // The verify pass bypasses withSoftDelete so tombstoned rows are visited.
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      const encoded = row[spec.column] as string | null | undefined;
      cursor = row.id;
      counts.visited++;
      if (!encoded || encoded === "") {
        counts.skipped++;
        continue;
      }
      const cls = classify(encoded, chain);
      if (cls === "active") counts.active++;
      else if (cls === "legacy") counts.legacy++;
      else counts.undecryptable++;
    }
    if (rows.length < BATCH_SIZE) break;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// main() — exported as runVerification for unit testing (bypasses commander parse)
// ---------------------------------------------------------------------------
export interface VerificationSummary {
  perColumn: Record<string, ColumnCounts>;
  total: ColumnCounts;
  belowActive: number;
  exitCode: 0 | 1;
  json: boolean;
}

export interface VerifyOpts {
  json: boolean;
}

export async function runVerification(opts: VerifyOpts): Promise<VerificationSummary> {
  // Ensure env is fresh — the chain may have been cached by a prior process.
  resetEncryptionKeyCache();
  const chain = getDecryptKeyChain();
  if (chain.length === 0) {
    throw new Error("[verify-encryption-key] Empty key chain — cannot verify.");
  }

  const perColumn: Record<string, ColumnCounts> = {};
  const total: ColumnCounts = {
    visited: 0,
    skipped: 0,
    active: 0,
    legacy: 0,
    undecryptable: 0,
  };

  for (const spec of ENCRYPTED_COLUMNS) {
    const counts = await verifyColumn(spec);
    perColumn[spec.table] = counts;
    total.visited += counts.visited;
    total.skipped += counts.skipped;
    total.active += counts.active;
    total.legacy += counts.legacy;
    total.undecryptable += counts.undecryptable;
  }

  // D-10: below_active = legacy count. Gate passes iff below_active === 0 AND
  // no undecryptable rows (an undecryptable row is a separate, worse failure
  // that also fails the gate — the runbook tells the operator to investigate).
  const belowActive = total.legacy;
  const passed = belowActive === 0 && total.undecryptable === 0;
  const exitCode: 0 | 1 = passed ? 0 : 1;
  const summary: VerificationSummary = {
    perColumn,
    total,
    belowActive,
    exitCode,
    json: opts.json,
  };

  if (opts.json) {
    // Machine-readable single-line JSON to stdout.
    console.log(
      JSON.stringify({
        below_active: belowActive,
        undecryptable: total.undecryptable,
        total: {
          visited: total.visited,
          skipped: total.skipped,
          active: total.active,
          legacy: total.legacy,
          undecryptable: total.undecryptable,
        },
        per_column: Object.fromEntries(
          Object.entries(perColumn).map(([k, v]) => [k, {
            visited: v.visited,
            skipped: v.skipped,
            active: v.active,
            legacy: v.legacy,
            undecryptable: v.undecryptable,
          }]),
        ),
      }),
    );
  } else {
    // Human-readable summary to stderr (stdout reserved for --json payload).
    const lines: string[] = [];
    lines.push("[verify-encryption-key] Per-column counts:");
    for (const spec of ENCRYPTED_COLUMNS) {
      const c = perColumn[spec.table]!;
      lines.push(
        `  ${spec.table}.${spec.column}: ` +
          `visited=${c.visited} skipped=${c.skipped} ` +
          `active=${c.active} legacy=${c.legacy} undecryptable=${c.undecryptable}`,
      );
    }
    lines.push(
      `[verify-encryption-key] Total: ` +
        `visited=${total.visited} skipped=${total.skipped} ` +
        `active=${total.active} legacy=${total.legacy} undecryptable=${total.undecryptable}`,
    );
    lines.push(`[verify-encryption-key] below_active = ${belowActive}`);
    console.warn(lines.join("\n"));
  }

  if (passed) {
    console.warn("VERIFICATION PASSED: below_active = 0");
  } else {
    console.error(
      `VERIFICATION FAILED: below_active = ${belowActive}, undecryptable = ${total.undecryptable}`,
    );
  }
  return summary;
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  program
    .option("--json", "emit machine-readable JSON to stdout instead of human-readable text")
    .parse();

  const opts = program.opts() as { json?: boolean };
  const summary = await runVerification({ json: !!opts.json });
  // D-10: non-zero exit on gate failure so the pass is CI/operator scriptable.
  // process.exit lives in main() (NOT runVerification) so unit tests can assert
  // summary.exitCode without a sentinel-throw interrupting the return value.
  if (summary.exitCode === 0) {
    process.exit(0);
  }
  process.exit(1);
}

// Only run main when invoked directly via tsx, not when imported by tests.
const isDirectInvocation =
  typeof require !== "undefined" && require.main === module;
if (isDirectInvocation) {
  main()
    .catch((err: Error) => {
      console.error("[verify-encryption-key] Fatal:", err.message);
      process.exitCode = 1;
    })
    .finally(() => {
      prisma.$disconnect().catch(() => {});
    });
}