#!/usr/bin/env node
/**
 * i18n-check.cjs
 * Recursively compares JSON keys across locale files, scoped to target namespaces.
 * Exits 0 if all locales match the source (en) within the scoped namespaces, exits 1 otherwise.
 *
 * Usage:
 *   node scripts/i18n-check.cjs                           # checks all keys
 *   node scripts/i18n-check.cjs --namespaces=chat.palette,chat.comparison
 */
const fs = require("fs");
const path = require("path");

const LOCALES = ["en", "it", "ru", "de", "es", "fr", "zh", "pt"];
const BASE_DIR = path.join(__dirname, "..", "src", "i18n");

// Parse --namespaces=foo,bar from CLI args
const nsArg = process.argv.slice(2).find((a) => a.startsWith("--namespaces="));
const TARGET_NAMESPACES = nsArg ? nsArg.split("=")[1].split(",") : null;

function flattenKeys(obj, prefix = "") {
  const keys = [];
  for (const key of Object.keys(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (obj[key] !== null && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
      keys.push(...flattenKeys(obj[key], full));
    } else {
      if (!TARGET_NAMESPACES || TARGET_NAMESPACES.some((ns) => full.startsWith(ns))) {
        keys.push(full);
      }
    }
  }
  return keys;
}

function main() {
  const sourcePath = path.join(BASE_DIR, "en", "translation.json");
  const sourceJson = JSON.parse(fs.readFileSync(sourcePath, "utf-8"));
  const sourceKeys = flattenKeys(sourceJson);

  let hasError = false;

  for (const locale of LOCALES.filter((l) => l !== "en")) {
    const localePath = path.join(BASE_DIR, locale, "translation.json");
    const localeJson = JSON.parse(fs.readFileSync(localePath, "utf-8"));
    const localeKeys = flattenKeys(localeJson);

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

  if (hasError) {
    console.error("\ni18n check FAILED. Add missing keys to keep parity.\n");
    process.exit(1);
  } else {
    console.log("i18n check PASSED. All locales are in parity.");
    process.exit(0);
  }
}

main();
