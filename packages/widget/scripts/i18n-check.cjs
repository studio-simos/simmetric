#!/usr/bin/env node
/**
 * i18n-check.cjs — widget locale parity gate (D-05, Option B).
 *
 * Mirrors packages/frontend/scripts/i18n-check.cjs for the widget's own
 * locale resources at packages/widget/src/widget/i18n/:
 *   - en.json is the source of truth; every other locale must have the
 *     EXACT same flat key set (no missing, no extra keys).
 *   - Additionally fails when ANY key value in ANY of the 8 files is an
 *     empty string (ROADMAP SC4 "no blank strings").
 *
 * Exits 0 on parity + non-empty, exits 1 with per-locale listings otherwise.
 *
 * Usage:
 *   node scripts/i18n-check.cjs
 */
const fs = require("fs");
const path = require("path");

const LOCALES = ["en", "it", "ru", "de", "es", "fr", "zh", "pt"];
const BASE_DIR = path.join(__dirname, "..", "src", "widget", "i18n");

function flattenKeys(obj, prefix = "") {
  const keys = [];
  for (const key of Object.keys(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (obj[key] !== null && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
      keys.push(...flattenKeys(obj[key], full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

function findEmptyValues(obj, prefix = "") {
  const empty = [];
  for (const key of Object.keys(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (obj[key] !== null && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
      empty.push(...findEmptyValues(obj[key], full));
    } else if (typeof obj[key] === "string" && obj[key].trim() === "") {
      empty.push(full);
    }
  }
  return empty;
}

function main() {
  const sourcePath = path.join(BASE_DIR, "en.json");
  const sourceJson = JSON.parse(fs.readFileSync(sourcePath, "utf-8"));
  const sourceKeys = flattenKeys(sourceJson);

  let hasError = false;

  for (const locale of LOCALES) {
    const localePath = path.join(BASE_DIR, `${locale}.json`);
    const localeJson = JSON.parse(fs.readFileSync(localePath, "utf-8"));
    const localeKeys = flattenKeys(localeJson);

    if (locale !== "en") {
      const missing = sourceKeys.filter((k) => !localeKeys.includes(k));
      const extra = localeKeys.filter((k) => !sourceKeys.includes(k));

      if (missing.length > 0) {
        console.error(`\n[${locale}] Missing keys (${missing.length}):`);
        for (const key of missing) {
          console.error(`  - ${key}`);
        }
        hasError = true;
      }

      if (extra.length > 0) {
        console.error(`\n[${locale}] Extra keys not in source (${extra.length}):`);
        for (const key of extra) {
          console.error(`  - ${key}`);
        }
        hasError = true;
      }
    }

    const empty = findEmptyValues(localeJson);
    if (empty.length > 0) {
      console.error(`\n[${locale}] Empty-string values (${empty.length}):`);
      for (const key of empty) {
        console.error(`  - ${key}`);
      }
      hasError = true;
    }
  }

  if (hasError) {
    console.error("\nWidget i18n check FAILED. Fix missing/extra keys or empty values to keep parity.\n");
    process.exit(1);
  }
  console.log("Widget i18n check PASSED. All 8 locales are in parity with non-empty values.");

  // ---- Inverse report (Phase 180 PUB-05): defined-but-never-used keys ----
  // WARNING-ONLY (always exit 0). Deletion churn (8-locale parity) is out of
  // scope; template-literal t(`ns.${x}`) prefixes mark keys under them as
  // dynamically used — verify by hand before deleting reported keys.
  const SRC = path.join(__dirname, "..", "src");
  const used = new Set();
  const prefixes = new Set();
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "__tests__") continue;
        walk(full);
      } else if (entry.isFile() && /\.[jt]sx?$/.test(entry.name)) {
        const code = fs
          .readFileSync(full, "utf-8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/[^\n]*/g, "");
        let m;
        const dre = /\bt\(\s*`([^`$]*)\$\{/g;
        while ((m = dre.exec(code)) !== null) {
          if (m[1]) prefixes.add(m[1]);
        }
        const ure = /\bt\(\s*["']([^"']+)["']/g;
        while ((m = ure.exec(code)) !== null) {
          if (m[1].includes(".")) used.add(m[1]);
        }
      }
    }
  })(SRC);
  const unused = sourceKeys.filter((k) => {
    if (used.has(k)) return false;
    for (const p of prefixes) if (k.startsWith(p)) return false;
    return true;
  });
  console.log(
    `i18n inverse report: ${unused.length} defined-but-never-used en key(s) (warning-only — cleanup candidates, NOT deleted here).`
  );
  if (process.env.I18N_UNUSED_VERBOSE === "1") {
    for (const k of unused) console.log(`  - ${k}`);
  }
  process.exit(0);
}

main();
