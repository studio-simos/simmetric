#!/usr/bin/env node
/**
 * i18n-usage-check.cjs
 * Usage-vs-existence gate: extracts t() translation keys from frontend source
 * and verifies each exists in the en locale file (src/i18n/en/translation.json).
 *
 * The parity gate (i18n-check.cjs) compares locales to each other and cannot
 * catch a key that exists in NO locale — e.g. t("common.discard") rendered as
 * a raw key string in the UI. This gate closes that blind spot: a key used in
 * code that does not exist in en fails the check (unless allowlisted as
 * pre-existing debt).
 *
 * Usage:
 *   node scripts/i18n-usage-check.cjs
 *
 * Exits 0 when every extracted key exists in en (or is in ALLOWLIST),
 * exits 1 otherwise, printing the per-key file list.
 */
const fs = require("fs");
const path = require("path");

const BASE_DIR = path.join(__dirname, "..", "src");

// Pre-existing missing-key debt (verified 2026-08-09 by running this script
// with an empty allowlist after the 129-07 common.discard fix). These keys are
// used in code but do not exist in en — same bug class as common.discard but
// out of scope to fix here. The allowlist documents the debt so the gate
// passes today and catches NEW wrong keys. Do NOT add new entries here without
// verifying the key genuinely does not exist in en AND is pre-existing debt.
const ALLOWLIST = new Set([
  // Pre-existing unprotected missing-key debt (verified 2026-08-09 by running
  // this script with an empty allowlist after the 129-07 common.discard fix).
  // These t() calls have NO fallback argument and the key does not exist in
  // en — the same bug class as common.discard (raw key rendered in the UI),
  // out of scope to fix here. Categories: analytics.*, breadcrumb.*,
  // common.retry/selectAll, createWorkspace.*, eventLog.*, ocr.preview.*,
  // settings.backups.*, sidebar.*, synthesis.*, urlIngestion.*, workspaces.*.
  // Do NOT add new entries without verifying the key is missing from en AND
  // is pre-existing debt.
  "analytics.pageTitle",
  "breadcrumb.createWorkspace",
  "common.retry",
  "common.selectAll",
  "createWorkspace.pageTitle",
  "eventLog.exportError",
  "eventLog.fetchError",
  "eventLog.licenseRequired",
  "ocr.preview.duration",
  "ocr.preview.qualityScore",
  "ocr.preview.tokensUsed",
  "settings.backups.destinations.enterpriseRequired",
  "settings.backups.jobs.scheduleRequired",
  "sidebar.moveFailed",
  "synthesis.detail",
  "synthesis.pageTitle",
  "urlIngestion.jobProgress.extracting",
  "workspaces.pageTitle",
]);

/**
 * Recursively flatten all leaf keys of a JSON object to dotted paths.
 */
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

/**
 * Strip block (/* *\/) and line (//) comments from source, preserving
 * string contents. A simple state machine avoids mangling strings that
 * contain "//" (e.g. URLs) or "/*".
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  let inString = null; // null | '"' | "'" | "`"
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next || "";
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Extract t() call keys from stripped source.
 * Pattern: word-boundary t( followed by a quoted string literal — the
 * boundary prevents getByText(, apiPut(, jest.fn(, etc. from matching.
 * Template-literal keys (t(`key.${x}`)) and non-dotted keys are skipped.
 */
function extractKeys(stripped) {
  const keys = [];
  const re = /\bt\(\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const key = m[1];
    // Skip template-literal-ish / dynamic keys (no static verification)
    if (key.includes("${")) continue;
    // Skip non-dotted keys — i18n keys are namespaced; non-dotted matches
    // are false positives (e.g. t("name") on a data field).
    if (!key.includes(".")) continue;
    // Skip calls whose second argument is a string literal (t("key", "fallback")
    // renders the fallback safely) or an options object containing defaultValue.
    const after = stripped.slice(re.lastIndex);
    const second = /^\s*,\s*/.exec(after);
    if (second) {
      const rest = after.slice(second[0].length);
      const secondRe = /^(["'`][^"'`]*["'`])|^\{[^}]*\}/;
      const secondMatch = secondRe.exec(rest);
      if (secondMatch) {
        const secondArg = secondMatch[0];
        if (secondArg.startsWith('"') || secondArg.startsWith("'") || secondArg.startsWith("`")) {
          continue; // string-literal fallback — renders safely
        }
        if (secondArg.includes("defaultValue")) {
          continue; // options object with defaultValue — renders safely
        }
      }
    }
    keys.push({ key, index: m.index });
  }
  return keys;
}

/** Template-literal t() prefixes (t(`ns.${x}`)) — keys under these are dynamically used. */
function collectDynamicPrefixes() {
  const prefixes = new Set();
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "__tests__") continue;
        if (full === path.join(BASE_DIR, "i18n")) continue;
        walk(full);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        const stripped = stripComments(fs.readFileSync(full, "utf-8"));
        let dm;
        const dre = /\bt\(\s*`([^`$]*)\$\{/g;
        while ((dm = dre.exec(stripped)) !== null) {
          if (dm[1]) prefixes.add(dm[1]);
        }
      }
    }
  }
  walk(BASE_DIR);
  return prefixes;
}

function main() {
  const enPath = path.join(BASE_DIR, "i18n", "en", "translation.json");
  const enJson = JSON.parse(fs.readFileSync(enPath, "utf-8"));
  const enKeys = new Set(flattenKeys(enJson));

  const missing = new Map(); // key -> Set of files
  const usedKeys = new Set(); // every statically-extracted key (PUB-05)

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        if (entry.name === "__tests__") continue; // tests mock t as identity
        if (full === path.join(BASE_DIR, "i18n")) continue; // locale resources
        walk(full);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        const src = fs.readFileSync(full, "utf-8");
        const stripped = stripComments(src);
        const found = extractKeys(stripped);
        for (const { key } of found) {
          usedKeys.add(key);
          if (enKeys.has(key) || ALLOWLIST.has(key)) continue;
          if (!missing.has(key)) missing.set(key, new Set());
          missing.get(key).add(path.relative(BASE_DIR, full));
        }
      }
    }
  }

  walk(BASE_DIR);

  if (missing.size > 0) {
    console.error(`i18n usage check FAILED — ${missing.size} key(s) used in code missing from en:`);
    for (const [key, files] of [...missing.entries()].sort()) {
      console.error(`  ${key}`);
      for (const f of [...files].sort()) {
        console.error(`    - ${f}`);
      }
    }
    console.error(
      "\nIf these are pre-existing debt (same bug class, out of scope), add them to the ALLOWLIST const."
    );
    process.exit(1);
  }
  console.log("i18n usage check PASSED. All t() keys exist in en.");

  // ---- Inverse report (Phase 180 PUB-05): defined-but-never-used keys ----
  // WARNING-ONLY: prints a count (+ samples via I18N_UNUSED_VERBOSE=1),
  // always exit 0. Deletion churn is deliberately out of scope (8-locale
  // parity makes key removal an 8-file edit). Template-literal prefixes
  // (t(`ns.${x}`)) mark every key under that prefix as potentially used —
  // verify by hand before deleting any reported key.
  const dynPrefixes = collectDynamicPrefixes();
  const unused = [...enKeys].filter((k) => {
    if (usedKeys.has(k)) return false;
    for (const p of dynPrefixes) if (k.startsWith(p)) return false;
    return true;
  });
  console.log(
    `i18n inverse report: ${unused.length} defined-but-never-used en key(s) (warning-only — cleanup candidates, NOT deleted here). Set I18N_UNUSED_VERBOSE=1 to list them.`
  );
  if (process.env.I18N_UNUSED_VERBOSE === "1") {
    for (const k of [...unused].sort()) console.log(`  - ${k}`);
  }

  process.exit(0);
}

main();