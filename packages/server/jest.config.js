// ts-jest is the rollback transformer — 'git revert <DEP-01 commit>' restores it (D-03).
const path = require("path");
const fs = require("fs");

// D-03 (widget twin precedent): redirect TMPDIR OFF the /tmp tmpfs (quota —
// os error 122 under turbo; e.g. check-build-freshness.test.ts fixtures).
// OUTSIDE the repo tree so fixture trees built in os.tmpdir() can never
// collide with repo-root marker walks (loadEnv.test.ts contract — see the
// shared jest.config twin for the full rationale).
const tmpDir = path.join(require("os").homedir(), ".jest-tmp");
fs.mkdirSync(tmpDir, { recursive: true });
process.env.TMPDIR = tmpDir;

module.exports = {
  displayName: "server",
  // verbose REQUIRED (quick 260831-sqr CI fix): the default (buffered)
  // reporter triggered a deterministic native abort on the full suite —
  // `CompileFunctionForCJSLoader` assert `args[0]->IsString()` inside
  // @jest/source-map's lazy require('convert-source-map') (SIGABRT, exit
  // 134 on CI + locally, all Node majors 20/24). The per-test streaming
  // reporter never hits it (verified 4/4 full runs + --runInBand). Do NOT
  // remove without re-checking `pnpm --filter server test`.
  verbose: true,
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/scripts"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  testPathIgnorePatterns: ["\\.integration\\.test\\.ts$"],
  // Per-package cache dir (CI fix 260831): turbo runs the 5 package test
  // tasks CONCURRENTLY, and a single shared ../../.jest-cache let parallel
  // jest-transform workers race on the same cache entries — torn .map files
  // crashed @jest/source-map parseMap with a Node 24 native abort (exit 134).
  // One subdirectory per package keeps the caches disjoint.
  cacheDirectory: path.resolve(__dirname, "../../.jest-cache/server"),
  setupFiles: ["<rootDir>/src/__tests__/helpers/setupEnv.ts"],
  moduleNameMapper: {
    "^@simmetric-chat/shared$": "<rootDir>/../shared/dist/index.js",
    "^uuid$": "<rootDir>/src/__mocks__/uuid.ts",
    "^jsdom$": "<rootDir>/src/__mocks__/jsdom.ts",
    "^@mozilla/readability$":
      "<rootDir>/src/__mocks__/@mozilla-readability.ts",
    "^turndown$": "<rootDir>/src/__mocks__/turndown.ts",
    "^archiver$": "<rootDir>/src/__mocks__/archiver.ts",
    "^pdfjs-dist": "<rootDir>/src/__mocks__/pdfjs-dist.ts",
    "^puppeteer$": "<rootDir>/src/__mocks__/puppeteer.ts",
    // Phase 164 (SCALE-04, RESEARCH Pitfall 3): pg-boss v12.28.0 is pure ESM
    // (`"type": "module"`). A static import in src/services/jobQueue.ts →
    // src/index.ts means every suite that transitively loads index.ts crashes
    // with `SyntaxError: Cannot use import statement outside a module`. Adding
    // pg-boss to transformIgnorePatterns would require also allowlisting its
    // transitive ESM deps (cron-parser, serialize-error, …) — fragile. A manual
    // mock is the established pattern (see __mocks__/puppeteer.ts for the same
    // ESM-in-CJS issue). The dedicated unit tests in jobQueue.test.ts use their
    // own jest.mock("pg-boss", …) factory for per-test start/stop control; this
    // manual mock only unblocks suites that load index.ts transitively.
    "^pg-boss$": "<rootDir>/src/__mocks__/pg-boss.ts",
  },
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
  transformIgnorePatterns: [
    // Scoped exception (Jest bug #16266): @swc/jest transforms the transitive
    // ESM-only `jose`/`oauth4webapi`/`openid-client` packages pulled in by
    // `passport-saml`/`openid-client`. NOT a global `transformIgnorePatterns: []`
    // un-mock — only these named packages bypass the ignore. Per D-03.
    "node_modules/(?!(pdfjs-dist|@napi-rs/canvas|jose|oauth4webapi|openid-client)/)",
  ],
};