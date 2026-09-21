// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * archivePath utility tests — validateArchivePath (anti-traversal) +
 * validateWritablePath (D-03: raw_sources/ immutability guard).
 */
import os from "os";
import path from "path";
import fs from "fs/promises";
import {
  validateArchivePath,
  validateWritablePath,
} from "../utils/archivePath";

describe("validateArchivePath", () => {
  it("accepts a path inside the archive base", () => {
    const base = "/tmp/arch";
    expect(() => validateArchivePath(base, "wiki/entities/foo.md")).not.toThrow();
  });

  it("rejects path traversal outside the archive base", () => {
    const base = "/tmp/arch";
    expect(() => validateArchivePath(base, "../../etc/passwd")).toThrow(
      /traversal|outside/i,
    );
  });
});

describe("validateWritablePath", () => {
  let tmpBase: string;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "arch-"));
    // Scaffold wiki/ subtree so the prefix check is realistic.
    await fs.mkdir(path.join(tmpBase, "wiki", "entities"), { recursive: true });
    await fs.mkdir(path.join(tmpBase, "wiki", "concepts"), { recursive: true });
    await fs.mkdir(path.join(tmpBase, "raw_sources"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it("accepts a write target under wiki/entities/", () => {
    expect(() =>
      validateWritablePath(tmpBase, "wiki/entities/foo.md"),
    ).not.toThrow();
  });

  it("accepts a write target under wiki/concepts/", () => {
    expect(() =>
      validateWritablePath(tmpBase, "wiki/concepts/bar.md"),
    ).not.toThrow();
  });

  it("rejects a write target under raw_sources/ (immutable)", () => {
    expect(() => validateWritablePath(tmpBase, "raw_sources/foo.md")).toThrow(
      /outside wiki/i,
    );
  });

  it("rejects a path-traversal target with a traversal/outside message", () => {
    expect(() => validateWritablePath(tmpBase, "../etc/passwd")).toThrow(
      /traversal|outside/i,
    );
  });

  // Phase 187 (WIKS-02/D-06a, RESEARCH Pitfall 8): message-identifying pin —
  // the guard's rejection carries the immutability-identifying substring so
  // any future API-level mapping surfaces an actionable reason. NO status-code
  // pin and NO route change this phase (audit-only, additive tests).
  it("raw_sources rejection message contains the immutability identifier 'raw_sources/ is immutable'", () => {
    expect(() => validateWritablePath(tmpBase, "raw_sources/foo.md")).toThrow(
      /raw_sources\/ is immutable/,
    );
  });

  // Phase 187 (D-02): the rawSourcesImmutable documentation flag is inert —
  // validateWritablePath's signature takes no config, so a `false` flag can
  // never unlock raw_sources writes. Behavioral pin of the D-02 invariant.
  it("rawSourcesImmutable: false never alters guard behavior (flag is documentation only, D-02)", () => {
    // The flag lives in ArchiveConfig.config — passed nowhere near this guard.
    // The load-bearing assertion is that rejection semantics are unchanged.
    const docFlag = { rawSourcesImmutable: false };
    expect(docFlag.rawSourcesImmutable).toBe(false);
    expect(() => validateWritablePath(tmpBase, "raw_sources/foo.md")).toThrow(
      /raw_sources\/ is immutable/,
    );
    // And a wiki/ target still passes with the flag false in the (unused) fixture.
    expect(() => validateWritablePath(tmpBase, "wiki/entities/ok.md")).not.toThrow();
  });
});