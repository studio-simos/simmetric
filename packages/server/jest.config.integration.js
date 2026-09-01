// ts-jest is the rollback transformer — 'git revert <DEP-01 commit>' restores it (D-03).
module.exports = {
  displayName: "server-integration",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.integration.test.ts"],
  globalSetup: "<rootDir>/jest.globalSetup.js",
  globalTeardown: "<rootDir>/jest.globalTeardown.js",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.integration.ts"],
  moduleNameMapper: {
    "^@simmetric-chat/shared$": "<rootDir>/../shared/dist/index.js",
    "^uuid$": "<rootDir>/src/__mocks__/uuid.ts",
    "^jsdom$": "<rootDir>/src/__mocks__/jsdom.ts",
    "^@mozilla/readability$": "<rootDir>/src/__mocks__/@mozilla-readability.ts",
    "^turndown$": "<rootDir>/src/__mocks__/turndown.ts",
    "^archiver$": "<rootDir>/src/__mocks__/archiver.ts",
    "^pdfjs-dist": "<rootDir>/src/__mocks__/pdfjs-dist.ts",
    "^puppeteer$": "<rootDir>/src/__mocks__/puppeteer.ts",
    // NOTE: the `openid-client` moduleNameMapper entry was REMOVED (Phase
    // 180 dead-code sweep): it mapped to src/__mocks__/openid-client.ts,
    // which was deleted with the SSO move to the enterprise plugin (commit
    // 6a63890e) — the stale mapping made the integration config fail to
    // resolve and knip reported it as an unresolved import. The community
    // server no longer imports openid-client (ssoExtractionGuard.test.ts
    // pins that); the enterprise package carries its own Jest config.
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