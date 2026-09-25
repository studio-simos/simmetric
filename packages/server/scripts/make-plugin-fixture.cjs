#!/usr/bin/env node
/**
 * Phase 202 (202-06 Task 1) — E2E plugin zip fixture generator.
 *
 * Builds `e2e/fixtures/plugin-fixture.zip`: a REAL loadable CJS module
 * (RESEARCH A5) — package.json + index.js exporting
 * { default: { apiVersion, register, licenseMode } }. The install probe
 * requires the entry WITHOUT calling register (D-02 step 5); register stays
 * uncalled during install AND during the managed load probe (license gate
 * precedes register for platform rows).
 *
 * The generator lives under packages/server (NOT e2e/) because pnpm does not
 * hoist server deps to the repo root: adm-zip (202-01, gated install)
 * resolves from packages/server/node_modules ONLY, so the generator must
 * execute where its require() resolves.
 *
 * Usage: node packages/server/scripts/make-plugin-fixture.cjs --out <path>
 */

const path = require("path");
const fs = require("fs");
// Resolved from packages/server/node_modules (pnpm does NOT hoist to root).
const AdmZip = require("adm-zip");

const outArgIdx = process.argv.indexOf("--out");
const outPath = path.resolve(
  process.cwd(),
  outArgIdx > -1 ? process.argv[outArgIdx + 1] : "e2e/fixtures/plugin-fixture.zip",
);

const zip = new AdmZip();
zip.addFile(
  "package.json",
  Buffer.from(
    JSON.stringify({
      name: "@fixture/widget",
      version: "1.0.0",
      main: "index.js",
      description: "E2E plugin fixture — install→license→enable→disable→uninstall journey",
    }),
  ),
);
zip.addFile(
  "index.js",
  Buffer.from(
    "module.exports.default = { apiVersion: 1, register: function () {}, licenseMode: 'platform' };",
  ),
);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, zip.toBuffer());
process.stdout.write(`plugin fixture written: ${outPath}\n`);