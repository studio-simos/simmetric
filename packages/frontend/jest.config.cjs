// ts-jest is the rollback transformer — 'git revert <DEP-01 commit>' restores it (D-03).
const path = require("path");

module.exports = {
  displayName: "frontend",
  // verbose REQUIRED (quick 260831-sqr CI fix — see the server package's
  // jest.config.js for the full post-mortem): the default buffered reporter
  // can trigger a native CJS-loader abort inside @jest/source-map's lazy
  // requires; the streaming per-test reporter does not.
  verbose: true,
  testEnvironment: "jsdom",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.{ts,tsx}"],
  // Per-package cache dir (CI fix 260831): turbo runs the 5 package test
  // tasks CONCURRENTLY, and a single shared ../../.jest-cache let parallel
  // jest-transform workers race on the same cache entries — torn .map files
  // crashed @jest/source-map parseMap with a Node 24 native abort (exit 134).
  // One subdirectory per package keeps the caches disjoint.
  cacheDirectory: path.resolve(__dirname, "../../.jest-cache/frontend"),
  moduleNameMapper: {
    "^@simmetric-chat/shared$": "<rootDir>/../shared/src/index.ts",
    "^@/(.*)$": "<rootDir>/src/$1",
    "\\.(css|less|scss)$": "<rootDir>/src/__tests__/__mocks__/styleMock.cjs",
  },
  extensionsToTreatAsEsm: [".ts", ".tsx"],
  transform: {
    "^.+\\.(t|j)sx?$": [
      "@swc/jest",
      {
        jsc: {
          parser: { syntax: "typescript", tsx: true },
          target: "es2022",
          transform: {
            react: { runtime: "automatic" },
          },
        },
        module: { type: "esm" },
      },
    ],
  },
  setupFilesAfterEnv: ["<rootDir>/src/__tests__/jest.setup.ts"],
};