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
});