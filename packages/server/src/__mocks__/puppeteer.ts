// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Manual CommonJS mock for puppeteer.
//
// puppeteer@25 ships as pure ESM (`export * from 'puppeteer-core'`), which throws
// `SyntaxError: Unexpected token 'export'` under the server's CommonJS ts-jest
// environment because it is not in transformIgnorePatterns. archiveExportService.ts
// imports it statically (`import puppeteer from "puppeteer"`), so every suite that
// transitively loads that service (all archive suites) fails to load. This stub
// satisfies the surface that service touches (default export with `launch()`) and
// never imports the real package. No test exercises PDF export end-to-end.

const browserStub = {
  newPage: () =>
    Promise.resolve({
      setContent: (_html?: unknown, _opts?: unknown) => Promise.resolve(),
      pdf: (_opts?: unknown) => Promise.resolve(Buffer.from("")),
      close: () => Promise.resolve(),
    }),
  close: () => Promise.resolve(),
};

const puppeteer = {
  launch: (_options?: unknown) => Promise.resolve(browserStub),
};

module.exports = puppeteer;
module.exports.default = puppeteer;
