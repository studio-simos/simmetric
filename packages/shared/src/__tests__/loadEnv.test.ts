// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * loadRootEnv unit suite (root-only contract — Phase 177 cleanup).
 *
 * Precedents copied from repo suites:
 * - tmp-dir fixtures: collector parser.test.ts (fs.mkdtempSync(os.tmpdir()))
 * - process.env hermeticity: ollamaKeepAliveEnv.test.ts (save/delete/restore)
 *
 * Invariants pinned here (must_haves):
 * - 3-level precedence: process.env > root .env > (Zod downstream, out of
 *   scope here). The per-package legacy layer is GONE — no file outside the
 *   repo root is ever consulted.
 * - `KEY=` (empty value) counts as DEFINED; empty file → zero keys;
 *   root file absent → clean no-op.
 * - process.env is NEVER overridden; root keys only fill gaps.
 * - Tauri analog: no pnpm-workspace.yaml up-chain → rootPath null, graceful
 *   skip, no throw.
 * - dist/config depth resolves like src/config depth.
 * - resolveRootEnvPath: marker hit → <root>/.env; no marker → cwd-adjacent
 *   ../../.env fallback (diagnostics still printable).
 * - NEVER logs or returns env VALUES (security T-177-01).
 * - Browser barrel guard: frontend + widget Preact bundle never value-import
 *   the loader (node:fs must stay out of browser graphs).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadRootEnv,
  findRepoRoot,
  resolveRootEnvPath,
} from "../config/loadEnv";

// ---- process.env hermeticity (whole-env snapshot; diff-restored) ----------
const ENV_SNAPSHOT = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ENV_SNAPSHOT)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ENV_SNAPSHOT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ---- console spies (loader logs via bare console) ---------------------------
let debugSpy: jest.SpyInstance;

beforeEach(() => {
  debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  debugSpy.mockRestore();
});

// ---- tmp fixtures (parser.test.ts mkdtempSync precedent) ------------------
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loadenv-"));
  // Repo-root marker — present in the default fixture tree; the no-marker
  // tests build their own independent trees without tmpRoot.
  fs.writeFileSync(path.join(tmpRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeRootEnv(content: string): string {
  const p = path.join(tmpRoot, ".env");
  fs.writeFileSync(p, content);
  return p;
}

/** The per-package dir callers pass as fromDir. */
function pkgConfigDir(): string {
  return path.join(tmpRoot, "packages/server/src/config");
}

// ===========================================================================
describe("precedence (LOCKED order)", () => {
  it("process.env wins over the root file and reports the key as skipped", () => {
    writeRootEnv("LD_SHD=from_root\n");
    process.env.LD_SHD = "from_process";
    const res = loadRootEnv(pkgConfigDir());
    expect(process.env.LD_SHD).toBe("from_process");
    expect(res.skipped).toContain("LD_SHD");
    expect(res.rootApplied).toEqual([]);
  });

  it("root file fills ONLY keys absent from process.env", () => {
    writeRootEnv("LD_DUP=from_root\nLD_FILL=from_root\n");
    process.env.LD_DUP = "preset";
    const res = loadRootEnv(pkgConfigDir());
    expect(process.env.LD_DUP).toBe("preset");
    expect(process.env.LD_FILL).toBe("from_root");
    expect(res.skipped).toEqual(["LD_DUP"]);
    expect(res.rootApplied).toEqual(["LD_FILL"]);
  });
});

// ===========================================================================
describe("existence semantics", () => {
  it("KEY= (empty value) counts as DEFINED — applies the empty string", () => {
    writeRootEnv("LD_EMPTY=\n");
    const res = loadRootEnv(pkgConfigDir());
    expect(process.env.LD_EMPTY).toBe("");
    expect(res.rootApplied).toContain("LD_EMPTY");
  });

  it("empty (zero-byte) root file applies zero keys", () => {
    writeRootEnv("");
    const res = loadRootEnv(pkgConfigDir());
    expect(res.rootApplied).toEqual([]);
    expect(res.skipped).toEqual([]);
  });

  it("root file absent → clean no-op without throw", () => {
    const res = loadRootEnv(pkgConfigDir());
    expect(res.rootApplied).toEqual([]);
    expect(res.skipped).toEqual([]);
    expect(res.rootPath).toBe(tmpRoot); // marker exists (root .env does not)
  });
});

// ===========================================================================
describe("marker-walk root discovery", () => {
  it("resolves the repo root from dist/config depth — Tauri sidecar analog", () => {
    writeRootEnv("LD_FROM_DIST=distworks\n");
    const fromDir = path.join(tmpRoot, "packages/server/dist/config");
    fs.mkdirSync(fromDir, { recursive: true });
    const res = loadRootEnv(fromDir);
    expect(res.rootPath).toBe(tmpRoot);
    expect(res.rootApplied).toContain("LD_FROM_DIST");
    expect(process.env.LD_FROM_DIST).toBe("distworks");
  });

  it("src/config depth resolves identically", () => {
    writeRootEnv("LD_FROM_SRC=srcworks\n");
    const res = loadRootEnv(pkgConfigDir());
    expect(res.rootPath).toBe(tmpRoot);
    expect(res.rootApplied).toContain("LD_FROM_SRC");
  });

  it("no pnpm-workspace.yaml up-chain → rootPath null, no root keys, no throw (Tauri packaged layout)", () => {
    const noMarkerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loadenv-nomarker-"));
    try {
      // NOT a child of tmpRoot — an independent tree with no marker anywhere.
      const fromDir = path.join(noMarkerRoot, "packages/server/dist/config");
      fs.mkdirSync(fromDir, { recursive: true });
      const res = loadRootEnv(fromDir);
      expect(res.rootPath).toBeNull();
      expect(res.rootApplied).toEqual([]);
      expect(res.skipped).toEqual([]);
    } finally {
      fs.rmSync(noMarkerRoot, { recursive: true, force: true });
    }
  });

  it("explicit envRoot option overrides the marker walk", () => {
    const altRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loadenv-altroot-"));
    try {
      fs.writeFileSync(path.join(altRoot, ".env"), "LD_ALTSRC=alt\n");
      const noMarker = fs.mkdtempSync(path.join(os.tmpdir(), "loadenv-noalt-"));
      const fromDir = path.join(noMarker, "x/y/z");
      fs.mkdirSync(fromDir, { recursive: true });
      const res = loadRootEnv(fromDir, { envRoot: altRoot });
      expect(res.rootPath).toBe(altRoot);
      expect(res.rootApplied).toEqual(["LD_ALTSRC"]);
      fs.rmSync(noMarker, { recursive: true, force: true });
    } finally {
      fs.rmSync(altRoot, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
describe("resolveRootEnvPath (diagnostics contract)", () => {
  it("marker hit → <repo-root>/.env", () => {
    expect(resolveRootEnvPath(pkgConfigDir())).toBe(path.join(tmpRoot, ".env"));
  });

  it("no marker → cwd-adjacent ../../.env fallback (still printable)", () => {
    const noMarkerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loadenv-nopath-"));
    try {
      const fromDir = path.join(noMarkerRoot, "packages/server/src/config");
      expect(resolveRootEnvPath(fromDir)).toBe(
        path.join(noMarkerRoot, "packages/server/.env"), // cwd-adjacent fallback shape (../../.env from src/config) — diagnostics path only, never loaded
      );
    } finally {
      fs.rmSync(noMarkerRoot, { recursive: true, force: true });
    }
  });

  it("findRepoRoot mirrors the marker walk", () => {
    expect(findRepoRoot(pkgConfigDir())).toBe(tmpRoot);
    expect(findRepoRoot(path.join(os.tmpdir()))).toBeNull();
  });
});

// ===========================================================================
describe("no-op contract", () => {
  it("keys already in process.env are never overwritten and land in skipped", () => {
    writeRootEnv("LD_NOOP=from_root\nLD_NEW=from_root\n");
    process.env.LD_NOOP = "preset";
    const res = loadRootEnv(pkgConfigDir());
    expect(process.env.LD_NOOP).toBe("preset");
    expect(process.env.LD_NEW).toBe("from_root");
    expect(res.skipped).toContain("LD_NOOP");
    expect(res.rootApplied).toEqual(["LD_NEW"]);
  });

  it("stray per-package .env files are NEVER consulted (legacy layer removed)", () => {
    // A leftover file at the OLD per-package location must be ignored —
    // the loader no longer accepts a pkgEnvPath at all.
    writeRootEnv("LD_ROOTKEY=from_root\n");
    const pkgDir = path.join(tmpRoot, "packages/server");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, ".env"), "LD_STRAY=from_stray_pkg\n");
    const res = loadRootEnv(path.join(pkgDir, "src/config"));
    expect(process.env.LD_STRAY).toBeUndefined();
    expect(process.env.LD_ROOTKEY).toBe("from_root");
    expect(res.rootApplied).toContain("LD_ROOTKEY");
  });
});

// ===========================================================================
describe("no-value disclosure (T-177-01)", () => {
  it("no console.debug output or result metadata ever contains a fixture VALUE substring", () => {
    const SECRET = "SUPERSECRETVALUE-zz9xk2";
    writeRootEnv("LD_SECRET_VAR=" + SECRET + "\n");
    const res = loadRootEnv(pkgConfigDir());
    const allOutput = debugSpy.mock.calls
      .map((c) => c.map(String).join(" "))
      .join("\n");
    expect(allOutput).not.toContain(SECRET);
    // Metadata carries NAMES, never values:
    expect(JSON.stringify(res)).not.toContain(SECRET);
    expect(res.rootApplied).toContain("LD_SECRET_VAR");
  });
});

// ===========================================================================
describe("parser grammar", () => {
  it("normalizes CRLF line endings", () => {
    writeRootEnv("LD_CRLF_A=1\r\nLD_CRLF_B=2\r\n");
    loadRootEnv(pkgConfigDir());
    expect(process.env.LD_CRLF_A).toBe("1");
    expect(process.env.LD_CRLF_B).toBe("2");
  });

  it("strips matching single/double quotes (inner whitespace preserved)", () => {
    writeRootEnv('LD_Q1="hello world"\nLD_Q2=\'single quoted\'\nLD_Q3="unmatched\n');
    loadRootEnv(pkgConfigDir());
    expect(process.env.LD_Q1).toBe("hello world");
    expect(process.env.LD_Q2).toBe("single quoted");
    expect(process.env.LD_Q3).toBe('"unmatched'); // mismatched pair kept literal
  });

  it("skips # comment lines and empty lines", () => {
    writeRootEnv("# LD_COMMENT=hidden\n\n   \nLD_OK=1\n# LD_ANOTHER=2\n");
    loadRootEnv(pkgConfigDir());
    expect(process.env.LD_COMMENT).toBeUndefined();
    expect(process.env.LD_ANOTHER).toBeUndefined();
    expect(process.env.LD_OK).toBe("1");
  });

  it("strips the optional export prefix", () => {
    writeRootEnv("export LD_EXPORTED=1\nexport LD_BROKEN\nLD_PLAIN=2\n");
    loadRootEnv(pkgConfigDir());
    expect(process.env.LD_EXPORTED).toBe("1");
    expect(process.env.LD_BROKEN).toBeUndefined(); // no '=' → line skipped
    expect(process.env.LD_PLAIN).toBe("2");
  });
});

// ===========================================================================
describe("browser-barrel guard (research Pattern 3 / Pitfall 2)", () => {
  it("frontend and widget Preact bundle never reference the env loader", () => {
    // Locate the real repo root by walking up from this test file.
    let dir = path.resolve(__dirname);
    while (!fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error("repo root not found");
      dir = parent;
    }
    // Browser graphs only: frontend (whole src) + the widget IIFE sources.
    // packages/widget/src Node-service files (config/env.ts, routes, …) are
    // INTENDED consumers — they are not part of any browser bundle.
    const browserRoots = [
      path.join(dir, "packages/frontend/src"),
      path.join(dir, "packages/widget/src/widget"),
    ];
    const offenders: string[] = [];
    const scan = (base: string): boolean => {
      if (!fs.existsSync(base)) return false;
      const stack = [base];
      while (stack.length > 0) {
        const cur = stack.pop() as string;
        for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
          const full = path.join(cur, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
            const content = fs.readFileSync(full, "utf-8");
            if (/loadRootEnv|loadEnv/.test(content)) offenders.push(full);
          }
        }
      }
      return true;
    };
    for (const root of browserRoots) scan(root);
    expect(offenders).toEqual([]);
  });
});