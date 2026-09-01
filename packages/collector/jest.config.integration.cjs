// Jest config per collector integration tests (Phase 91-04).
//
// First integration test infra for the collector package. Pattern: dedicated
// `pgvector_test` DB on port 5433, NEVER main DB (Pitfall 4
// integration-harness-maindb-leak). Operator must start pgvector on port 5433
// before running:
//   docker run -d -p 5433:5432 -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
//     -e POSTGRES_DB=pgvector_test pgvector/pgvector:pg16
//
// NOTE: `setupFilesAfterEach` is NOT a valid Jest 30 option (plan-checker
// MINOR finding #1). We use `globalSetup` (probe PG + set PGVECTOR_AVAILABLE
// env) + `setupFiles` (Pitfall 4 guard + PGVECTOR_TEST_URL) + `afterEach`
// hooks inside the test file for per-test cleanup.
//
// ts-jest is the rollback transformer — 'git revert <DEP-01 commit>' restores
// it (D-03). @swc/jest is the active transform (Phase 89-01 swap).
module.exports = {
  displayName: "collector-integration",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.integration.test.ts"],
  globalSetup: "<rootDir>/src/__tests__/integration-globalSetup.cjs",
  globalTeardown: "<rootDir>/src/__tests__/integration-globalTeardown.cjs",
  setupFiles: ["<rootDir>/src/__tests__/setup-integration.ts"],
  moduleNameMapper: {
    "^@simmetric-chat/shared$": "<rootDir>/../shared/dist/index.js",
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
  // Integration tests hit real PG — allow more time than the unit 5s default.
  testTimeout: 30000,
  // pg.Pool connections can linger (idle clients); force-exit so jest doesn't
  // hang waiting for the event loop to drain.
  forceExit: true,
};