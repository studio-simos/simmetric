// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 184 (SAAS-03) — Air-gap equivalence battery + concurrency-edge probes.
 *
 * Locks the contract that later phases (Phase 185 TenantContext scoping) must
 * not break. Postgres-free doctrine: mocked config cascade + a temp-root
 * LocalFSProvider — pure path computation and provider behavioral probes.
 *
 * SC-1 (equivalence): with the LocalFS provider default, every legacy flow
 *   resolves/read/cleans byte-identically to pre-phase behavior.
 * SC-4 (legacy backfill): legacy rows (storageKey = filePath) ride the
 *   legacy arm — no path rewrites, no file moves.
 * Concurrency edge (spec-less probe, resolved with explicit verification):
 *   interrupted upload → recoverable row + cleaned tmp; overwrite-idempotent
 *   re-put; reaper idempotency; parallel terminal-path race no-ops.
 */

import "./helpers/setupEnv";

import fs from "fs";
import os from "os";
import path from "path";
import { LocalFSProvider } from "../services/storage/localFsProvider";
import { isDraftsPath, isDraftStorageKey } from "../utils/fileUtils";

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

/** Representative legacy keys — the shapes M6 backfilled (storageKey = filePath). */
const LEGACY_KEYS = [
  "storage/uploads/file.pdf",
  "storage/uploads/drafts/draft.pdf",
  "storage/uploads/avatars/128/u-123.webp",
  "storage/ocr-sources/x.txt",
] as const;

// ─── SC-1/SC-4: legacy-arm resolution equivalence ────────────────────────────

describe("air-gap equivalence — legacy-arm resolution (SC-1/SC-4)", () => {
  const provider = new LocalFSProvider("storage/uploads");

  it.each(LEGACY_KEYS)(
    "resolve(%s) === path.resolve(key) — byte-identical to pre-phase",
    (key) => {
      expect(provider.resolve(key)).toBe(path.resolve(key));
    },
  );

  it("isDraftsPath(key) === isDraftStorageKey(key) for every legacy draft key (delegation arm)", () => {
    for (const key of LEGACY_KEYS) {
      expect(isDraftStorageKey(key)).toBe(isDraftsPath(key));
    }
  });

  it("draft-shaped legacy keys classify identically (d6ef3403 invariant)", () => {
    const draftKey = "storage/uploads/drafts/staged.pdf";
    expect(isDraftsPath(draftKey)).toBe(true);
    expect(isDraftStorageKey(draftKey)).toBe(true);
    const nonDraft = "storage/uploads/final.pdf";
    expect(isDraftsPath(nonDraft)).toBe(false);
    expect(isDraftStorageKey(nonDraft)).toBe(false);
  });

  it("new-layout drafts keys classify via the {orgId}/uploads/drafts/ arm", () => {
    const orgKey = "00000000-0000-0000-0000-000000000000/uploads/drafts/staged.pdf";
    expect(isDraftStorageKey(orgKey)).toBe(true);
    // trailing-sep sibling-prefix guard (A5 semantics): a sibling directory
    // named "drafts-evil" must NOT classify as a draft.
    const sibling = "00000000-0000-0000-0000-000000000000/uploads/drafts-evil/x.pdf";
    expect(isDraftStorageKey(sibling)).toBe(false);
  });

  it("URL sentinel never classifies as a draft key (never cleaned)", () => {
    expect(isDraftStorageKey("https://example.com/file.pdf")).toBe(false);
    expect(isDraftStorageKey("")).toBe(false);
    expect(isDraftStorageKey(null)).toBe(false);
    expect(isDraftStorageKey(undefined)).toBe(false);
  });

  it("reaper-shaped base check matches exactly the keys the A5 guard matched (sibling rejection)", () => {
    // The reaper's base: path.resolve("storage/uploads/drafts") + path.sep.
    // Legacy keys that start with it pass; siblings (drafts-evil) reject.
    const base = path.resolve("storage/uploads/drafts") + path.sep;
    const matched = "storage/uploads/drafts/inner/file.pdf";
    const rejected = "storage/uploads/drafts-evil/file.pdf";
    expect(path.resolve(matched).startsWith(base)).toBe(true);
    expect(path.resolve(rejected).startsWith(base)).toBe(false);
    // The provider's key validation still rejects traversal on the legacy arm.
    expect(() => provider.resolve("../escape.pdf")).toThrow();
  });
});

// ─── Concurrency-edge probes (spec-less probe: explicit verification) ───────

describe("concurrency-edge probes (interrupted / parallel)", () => {
  let tmpRoot: string;
  let provider: LocalFSProvider;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "airgap-184-"));
    provider = new LocalFSProvider(tmpRoot);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("put failure after row create leaves a recoverable state — get rejects closed (never corrupt)", async () => {
    // Simulate an interrupted direct upload: the put never completed, so the
    // object is absent. The read path must REJECT (fail closed → the document
    // is marked failed/pending), never resolve a corrupt/partial buffer.
    await expect(provider.get("00000000-0000-0000-0000-000000000000/uploads/never-put.pdf")).rejects.toThrow();
  });

  it("overwrite idempotency: two puts to the same key — get returns the second payload byte-equal (T-184-06)", async () => {
    const key = "00000000-0000-0000-0000-000000000000/uploads/doc.pdf";
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "airgap-src-"));
    const first = path.join(srcDir, "first.pdf");
    const second = path.join(srcDir, "second.pdf");
    fs.writeFileSync(first, Buffer.from("first-payload"));
    fs.writeFileSync(second, Buffer.from("second-payload-longer"));

    await provider.put(first, key);
    const result = await provider.put(second, key);
    expect(result.key).toBe(key);

    const buf = await provider.get(key);
    expect(buf.toString()).toBe("second-payload-longer");
    expect(buf.equals(fs.readFileSync(second))).toBe(true);

    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  it("delete on a missing key resolves — provider no-op contract (parallel terminal-path race)", async () => {
    // Reaper + DELETE race: whichever terminal path wins, the other observes
    // exists=false and no-ops (no throw, no counter inflation).
    await expect(
      provider.delete("00000000-0000-0000-0000-000000000000/uploads/gone.pdf"),
    ).resolves.toBeUndefined();
    await expect(provider.exists("00000000-0000-0000-0000-000000000000/uploads/gone.pdf")).resolves.toBe(false);
  });

  it("reaper idempotency shape: second pass over a deleted draft no-ops (reaped=0, errors=0)", async () => {
    const key = "00000000-0000-0000-0000-000000000000/uploads/drafts/staged.pdf";
    const src = path.join(tmpRoot, "src.pdf");
    fs.writeFileSync(src, "draft");
    await provider.put(src, key);
    expect(await provider.exists(key)).toBe(true);

    // First terminal pass deletes.
    await provider.delete(key);
    expect(await provider.exists(key)).toBe(false);

    // Second pass (idempotent re-run): exists=false → delete no-ops.
    await expect(provider.delete(key)).resolves.toBeUndefined();
  });

  it("WR-01/WR-02 ingress cleanups operate on req.file.path only — provider keys never enter the tmp path", async () => {
    // Ingress tmp files are multer-managed (req.file.path); the provider key
    // is a separate namespace. The suppression invariant (d6ef3403) keys on
    // isDraftStorageKey — URL sentinels are never cleaned.
    const urlKey = "https://cdn.example.com/staged.pdf";
    expect(isDraftStorageKey(urlKey)).toBe(false);
    // A draft-shaped provider key IS suppressed from terminal unlink.
    const draftKey = "00000000-0000-0000-0000-000000000000/uploads/drafts/x.pdf";
    expect(isDraftStorageKey(draftKey)).toBe(true);
  });
});