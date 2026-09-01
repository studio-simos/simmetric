// ts-jest is the rollback transformer — 'git revert <DEP-01 commit>' restores it (D-03).
const path = require("path");
const fs = require("fs");

// D-03 (widget twin precedent): redirect TMPDIR OFF the /tmp tmpfs (os
// error 122 quota — turbo-spawned workers don't reliably inherit a shell
// TMPDIR override). MUST stay OUTSIDE the repo tree: loadEnv.test.ts builds
// "no marker up-chain" fixture trees in os.tmpdir() — a repo-inside tmpdir
// would let the marker walk find the real pnpm-workspace.yaml and break
// the Tauri-packaged-layout assertions.
const tmpDir = path.join(require("os").homedir(), ".jest-tmp");
fs.mkdirSync(tmpDir, { recursive: true });
process.env.TMPDIR = tmpDir;

module.exports = {
  displayName: "shared",
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
  cacheDirectory: path.resolve(__dirname, "../../.jest-cache/shared"),
  transform: {
    "^.+\\.(t|j)sx?$": [
      "@swc/jest",
      {
        jsc: {
          parser: { syntax: "typescript", tsx: false },
          target: "es2022",
        },
        module: { type: "commonjs" },
      },
    ],
  },
};