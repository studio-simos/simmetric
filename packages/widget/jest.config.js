// ts-jest is the rollback transformer — 'git revert <DEP-01 commit>' restores it (D-03).
const path = require("path");
const fs = require("fs");

// D-03: Redirect TMPDIR to project-local .jest-cache/tmp to avoid /tmp tmpfs quota exhaustion
// (Phase 87 STATE.md: TMPDIR redirect to .jest-cache/ for jest-haste-map write failure)
const tmpDir = path.resolve(__dirname, "../../.jest-cache/tmp");
fs.mkdirSync(tmpDir, { recursive: true });
process.env.TMPDIR = tmpDir;

module.exports = {
  displayName: "widget",
  // verbose REQUIRED (quick 260831-sqr CI fix — see the server twin for the
  // full post-mortem): the default buffered reporter can trigger a native
  // CJS-loader abort inside @jest/source-map's lazy requires; the streaming
  // per-test reporter does not.
  verbose: true,
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  // Per-package cache dir (CI fix 260831): turbo runs the 5 package test
  // tasks CONCURRENTLY, and a single shared ../../.jest-cache let parallel
  // jest-transform workers race on the same cache entries — torn .map files
  // crashed @jest/source-map parseMap with a Node 24 native abort (exit 134).
  // One subdirectory per package keeps the caches disjoint.
  cacheDirectory: path.resolve(__dirname, "../../.jest-cache/widget"),
  moduleNameMapper: {
    "^@simmetric-chat/shared$": "<rootDir>/../shared/src/index.ts",
  },
  transform: {
    "^.+\\.(t|j)sx?$": [
      "@swc/jest",
      {
        jsc: {
          parser: { syntax: "typescript", tsx: true },
          target: "es2022",
        },
        module: { type: "commonjs" },
      },
    ],
  },
};
