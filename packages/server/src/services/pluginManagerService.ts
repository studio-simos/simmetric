// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 202 (PLGM-01) — managed plugin install service.
 *
 * The ONE vertical install path (D-02 six-step order, 202-01-PLAN.md):
 *   (1) construct AdmZip(buffer)            — garbage → typed 400
 *   (2) OUR guard matrix on RAW entryName   — BEFORE any extraction
 *   (3) extractAllTo storage/plugins/.tmp-<uuid>/
 *   (4) package.json + npm-name validation  — BEFORE slug derivation
 *   (5) probe (require WITHOUT register)    — capture apiVersion/hasRegister/licenseMode
 *   (6) atomic rename tmp → slug + PluginInstall row
 *
 * Any failure at ANY step removes the tmp dir and writes NO row (E1).
 *
 * The guard matrix is OURS, never delegated to adm-zip's extraction-side
 * sanitization (D-01; RESEARCH Pitfall 3: raw-crafted archives surface raw
 * names, and the library's normalization is a moving target across
 * versions). adm-zip is isolated to this file (reversible per D-01).
 *
 * The probe executes the plugin's module top-level code in-process —
 * accepted trust boundary per spec D6 (admin upload is the trust boundary;
 * sandboxing out of scope, Pitfall 7). register() is NEVER invoked at
 * install time — the loader owns register at boot (managedLoader, 202-03).
 */

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { createRequire } from "module";
import AdmZip from "adm-zip";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";

/** Registry root — relative to the server cwd, mirroring storage/branding. */
export const PLUGINS_STORAGE_DIR = path.resolve("storage/plugins");

/** Typed install error → 400-shaped { error, details } at the route layer (202-04). */
export class InstallError extends Error {
  /** Machine-readable failure code (route maps INVALID_* → 400, DUPLICATE_SLUG → 409). */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InstallError";
    this.code = code;
  }
}

/**
 * What the install probe captured from the entry module WITHOUT calling
 * register (D-02 step 5). `hasRegister` lets the route surface a clear
 * "not a plugin package" 400 before the loader ever sees the row.
 */
interface PluginProbe {
  apiVersion: number | undefined;
  hasRegister: boolean;
  licenseMode: string;
}

/** npm-name contract (RESEARCH: no new dep — hand-rolled regex, Pitfall 2). */
const NPM_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/**
 * T-202-01 — OUR entry-name guard matrix, run over RAW entry.entryName
 * BEFORE any extraction. The library's own extraction sanitization is NOT
 * the contract (Pitfall 3). Checks (after backslash → slash normalization):
 *  - `..` segments (traversal, incl. the sneaky `a/../../evil` shapes)
 *  - absolute POSIX (/etc/passwd) or drive-absolute (C:/) paths
 *  - NUL bytes (C-string truncation attacks on the extractor)
 *  - symlink entries (external-attr high-16 filetype mask — the D-15
 *    restoreService idiom; a symlink inside the plugin dir could point OUT)
 *  - duplicate entry names (zip-writer ambiguity — first-match-wins is
 *    attacker-favorable; adm-zip throws DUPLICATE_ENTRY but we want OUR
 *    400 shape and a deterministic rejection point BEFORE extraction)
 */
export function assertEntryNameSafe(rawName: string, attr: number): void {
  const name = rawName.replace(/\\/g, "/");
  if (name.includes("\0")) {
    throw new InstallError("UNSAFE_ENTRY", `Entry name contains NUL byte: ${JSON.stringify(rawName)}`);
  }
  if (name.startsWith("/")) {
    throw new InstallError("UNSAFE_ENTRY", `Entry name is absolute (POSIX): ${JSON.stringify(rawName)}`);
  }
  if (/^[A-Za-z]:\//.test(name)) {
    throw new InstallError("UNSAFE_ENTRY", `Entry name is absolute (drive): ${JSON.stringify(rawName)}`);
  }
  const segments = name.split("/");
  if (segments.includes("..")) {
    throw new InstallError("UNSAFE_ENTRY", `Entry name contains '..' segment: ${JSON.stringify(rawName)}`);
  }
  // Symlink: high 16 bits of the external attributes carry the POSIX mode
  // (S_IFMT shift). 0o120000 = S_IFLNK. Mirrors the D-15 restoreService mask.
  const typeBits = (attr >>> 16) & 0o170000;
  if (typeBits === 0o120000) {
    throw new InstallError("UNSAFE_ENTRY", `Entry is a symlink: ${JSON.stringify(rawName)}`);
  }
}

/**
 * T-202-02 — validate pkg.name BEFORE deriving the slug (Pitfall 2). A
 * crafted "a/../../evil" would otherwise yield slug "a+../../evil" and
 * escape storage/plugins via path.join. The npm regex allows exactly ONE
 * slash (scoped names), so the `+` substitution is injective for valid
 * names and the derived slug cannot traverse.
 */
export function assertValidNpmName(name: unknown): void {
  if (typeof name !== "string" || !NPM_NAME_RE.test(name)) {
    throw new InstallError("INVALID_PACKAGE_NAME", `package.json "name" is not a valid npm package name: ${JSON.stringify(name)}`);
  }
  // Belt-and-braces: the slug must resolve INSIDE the registry dir even if
  // the regex above is ever loosened (Edge E2 containment arm).
  const slug = name.replace("/", "+");
  const resolved = path.resolve(PLUGINS_STORAGE_DIR, slug);
  const root = path.resolve(PLUGINS_STORAGE_DIR);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new InstallError("INVALID_SLUG", `Derived slug escapes the plugin registry: ${JSON.stringify(slug)}`);
  }
}

/** Ensure the storage dir exists (idempotent — mirrors the branding mkdir). */
function ensurePluginsStorage(): void {
  fs.mkdirSync(PLUGINS_STORAGE_DIR, { recursive: true });
}

/**
 * D-02 six-step install. Buffer in (multer memoryStorage at the route,
 * 202-04), PluginInstall row out. Throws InstallError on every guarded
 * failure — the caller maps it to the 400/409 API shape.
 */
/**
 * Phase 202 (Edge E3 / Pitfall 5): module-level single-flight install mutex.
 * Concurrent same-slug uploads SERIALIZE through this chain — the second
 * install sees the first's row/dir and becomes a replace-swap (or hits the
 * P2002 → 409 backstop). Admin-rare surface, single-instance doctrine: no
 * Redis/redlock (RESEARCH A3). A failed install must not poison the chain —
 * the tail catch swallows so the next queued install still runs.
 */
let installQueue: Promise<unknown> = Promise.resolve();

export function installFromZip(buffer: Buffer): Promise<{ id: string }> {
  const run = installQueue.then(() => installFromZipCore(buffer));
  installQueue = run.catch(() => undefined);
  return run;
}

async function installFromZipCore(buffer: Buffer): Promise<{ id: string }> {
  ensurePluginsStorage();

  // (1) Parse — adm-zip throws on empty/garbage (INVALID_FORMAT, probe-verified).
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err: unknown) {
    throw new InstallError(
      "INVALID_FORMAT",
      `Not a valid zip archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // (2) Guard matrix on RAW names BEFORE extraction (Pitfall 3).
  const seen = new Set<string>();
  for (const entry of zip.getEntries()) {
    assertEntryNameSafe(entry.entryName, entry.attr);
    if (seen.has(entry.entryName)) {
      throw new InstallError("DUPLICATE_ENTRY", `Archive contains duplicate entry: ${JSON.stringify(entry.entryName)}`);
    }
    seen.add(entry.entryName);
  }

  // (3) Extract to a staging dir — never directly into the registry.
  const tmpDir = path.join(PLUGINS_STORAGE_DIR, `.tmp-${randomUUID()}`);
  try {
    zip.extractAllTo(tmpDir, /* overwrite */ true);

    // (4) package.json + npm-name validation BEFORE slug derivation (Pitfall 2).
    const pkgPath = path.join(tmpDir, "package.json");
    if (!fs.existsSync(pkgPath)) {
      throw new InstallError("MISSING_PACKAGE_JSON", "Archive has no package.json at its root");
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      name?: unknown;
      main?: unknown;
      version?: unknown;
      displayName?: unknown;
    };
    assertValidNpmName(pkg.name);
    const packageName = pkg.name as string;
    const slug = packageName.replace("/", "+");

    // (5) Probe — resolve + require WITHOUT register (D-02 step 5; Pitfall 7
    // documents the accepted top-level-code execution boundary, spec D6).
    const probe = probePlugin(tmpDir, pkg);

    if (!probe.hasRegister) {
      throw new InstallError("MISSING_REGISTER", "Entry module does not export a register function");
    }

    // (6) Atomic rename then the row (slug @unique is the P2002 → 409 backstop).
    // Replace-swap (spec §4 "replace atomico"): a second install of the same
    // slug (different version) renames the old dir to `.old-<ts>`, swaps the
    // new one in, and deferred-removes the old dir in the finally block. The
    // install mutex (E3) serializes same-slug installs so the swap never
    // interleaves.
    const targetDir = path.join(PLUGINS_STORAGE_DIR, slug);
    let oldDir: string | null = null;
    if (fs.existsSync(targetDir)) {
      oldDir = path.join(PLUGINS_STORAGE_DIR, `.old-${randomUUID()}`);
      fs.renameSync(targetDir, oldDir);
    }
    fs.renameSync(tmpDir, targetDir);
    try {
      const data = {
        displayName: typeof pkg.displayName === "string" ? pkg.displayName : null,
        version: typeof pkg.version === "string" ? pkg.version : null,
        apiVersion: probe.apiVersion ?? 0,
        packageJson: pkg as object,
        licenseMode: probe.licenseMode,
      };
      // Replace arm: an existing row (same slug) is UPDATED in place; a fresh
      // install creates it. The slug @unique index is the cross-process
      // P2002 → 409 backstop (Edge E3).
      const existing = await prisma.pluginInstall.findUnique({ where: { slug } });
      const row = existing
        ? await prisma.pluginInstall.update({
            where: { id: existing.id },
            data: { ...data, status: "installed", lastError: null },
          })
        : await prisma.pluginInstall.create({
            data: {
              slug,
              packageName,
              enabled: false,
              status: "installed",
              ...data,
            },
          });
      logger.info("[plugins] installed", { slug, packageName, apiVersion: probe.apiVersion });
      // Deferred-removal (D-02 step 6): the .old-<ts> dir goes away only
      // AFTER the row write is durable (create/update succeeded).
      if (oldDir && fs.existsSync(oldDir)) {
        fs.rmSync(oldDir, { recursive: true, force: true });
      }
      return { id: row.id };
    } catch (err: unknown) {
      // Row write failed after the swap — roll the directory back so the
      // filesystem and the DB stay in agreement (E1: no row ⇒ no dir).
      // On the replace path the OLD dir is restored (swap-back) so the
      // previously-installed plugin survives the failed upgrade.
      fs.rmSync(targetDir, { recursive: true, force: true });
      if (oldDir && fs.existsSync(oldDir)) {
        fs.renameSync(oldDir, targetDir);
      }
      if ((err as { code?: string })?.code === "P2002") {
        throw new InstallError(
          "DUPLICATE_SLUG",
          `Plugin "${packageName}" is already installed (slug ${slug})`,
        );
      }
      throw err;
    }
  } finally {
    // E1: every failure arm leaves NO tmp dir (renamed-away tmp no longer
    // exists, so force is a no-op on the success path).
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}


/**
 * Probe step (RESEARCH "The install probe" verbatim shape): createRequire
 * anchored INSIDE the extracted dir resolves the entry against the plugin's
 * own module graph, then we require it WITHOUT calling register. Capture
 * apiVersion / hasRegister / licenseMode (D6 default "none").
 */
function probePlugin(tmpDir: string, pkg: { main?: unknown }): PluginProbe {
  const main = typeof pkg.main === "string" && pkg.main.length > 0 ? pkg.main : "index.js";
  let entryPath: string;
  try {
    const serverRequire = createRequire(path.join(tmpDir, "package.json"));
    // A bare "index.js" main is a FILE path inside the archive, not a
    // package specifier — normalize to "./index.js" so createRequire
    // resolves it relative to the anchor (a bare specifier would fall
    // through node_modules lookup and MODULE_NOT_FOUND).
    const specifier = main.startsWith("./") || main.startsWith("../") || path.isAbsolute(main) ? main : `./${main}`;
    entryPath = serverRequire.resolve(specifier);
  } catch (err: unknown) {
    throw new InstallError(
      "ENTRY_NOT_FOUND",
      `Entry "${main}" could not be resolved from the archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let mod: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- probe is CJS by contract (D-02 step 5)
    mod = require(entryPath);
  } catch (err: unknown) {
    throw new InstallError("ENTRY_NOT_LOADABLE", `Entry module failed to load: ${err instanceof Error ? err.message : String(err)}`);
  }
  const plugin =
    mod && typeof mod === "object" && "default" in (mod as Record<string, unknown>)
      ? (mod as { default: Record<string, unknown> }).default
      : (mod as Record<string, unknown> | undefined);
  const apiVersion = plugin && typeof plugin.apiVersion === "number" ? plugin.apiVersion : undefined;
  const hasRegister = Boolean(plugin && typeof plugin.register === "function");
  const licenseMode =
    plugin &&
    (plugin.licenseMode === "platform" || plugin.licenseMode === "self" || plugin.licenseMode === "none")
      ? plugin.licenseMode
      : "none";
  return { apiVersion, hasRegister, licenseMode };
}
// ═══════════════════════════════════════════════════════════════════════
// Phase 202 (202-03) — lifecycle + native detection + license helpers.
// The 202-01 tracer surface expanded with the route-facing contract. The
// license verify pipeline is NEVER re-implemented here — persistence and
// verification DELEGATE to 202-05's pluginLicenseService exports.
// ═══════════════════════════════════════════════════════════════════════

import {
  savePluginLicense as savePluginLicenseImpl,
  verifyPluginLicense as verifyPluginLicenseImpl,
} from "./pluginLicenseService";

/**
 * Enable/disable toggle (PUT /:id route contract). Enabling flips the row
 * back to "installed" — the LOADER writes "loaded" at the next boot (the
 * restart-deferred effect, D-08): a toggle never loads code in-process.
 */
export async function setPluginEnabled(
  id: string,
  enabled: boolean,
): Promise<Record<string, unknown>> {
  return (await prisma.pluginInstall.update({
    where: { id },
    data: { enabled, status: enabled ? "installed" : "disabled" },
  })) as Record<string, unknown>;
}

/**
 * Uninstall (DELETE /:id route contract, D-08): DISABLED rows only. The rm
 * is containment-checked — the slug MUST resolve strictly inside
 * storage/plugins (Edge E2 belt-and-braces; the npm-name regex already
 * forbids traversal shapes, this is the second layer).
 */
export async function uninstallPlugin(id: string): Promise<void> {
  const row = (await prisma.pluginInstall.findUnique({ where: { id } })) as
    | { id: string; slug: string; enabled: boolean }
    | null;
  if (!row) {
    throw new InstallError("NOT_FOUND", "Plugin not found");
  }
  if (row.enabled) {
    throw new InstallError("PLUGIN_ENABLED", "Disable the plugin before uninstalling it");
  }
  const root = path.resolve(PLUGINS_STORAGE_DIR);
  const targetDir = path.resolve(PLUGINS_STORAGE_DIR, row.slug);
  if (!targetDir.startsWith(root + path.sep)) {
    // Traversal-attempted slug (never produced by the npm-name guard, but
    // the containment check is the contract — Edge E2).
    throw new InstallError(
      "UNSAFE_SLUG",
      `Slug "${row.slug}" resolves outside the plugin registry — refusing to delete`,
    );
  }
  fs.rmSync(targetDir, { recursive: true, force: true });
  await prisma.pluginInstall.delete({ where: { id } });
  logger.info("[plugins] uninstalled", { slug: row.slug });
}

/** What `detectNativePlugins()` reports per built-in plugin (probe-only, D-05). */
export interface NativePluginDetection {
  packageName: string;
  label: string;
  resolvable: boolean;
}

/** The two built-in plugin specifiers (community builds resolve neither). */
const NATIVE_PLUGIN_SPECIFIERS: ReadonlyArray<{ packageName: string; label: string }> = [
  { packageName: "@simmetric-chat/enterprise", label: "enterprise" },
  { packageName: "@simmetric-chat/saas", label: "saas" },
];

/**
 * Read-only native probe (D-05): `createRequire(...).resolve` on the two
 * built-in specifiers inside try/catch. PROBE-ONLY — this NEVER requires,
 * loads, or registers a plugin; the boot loaders (enterpriseLoader /
 * saasLoader) remain the only load path. Community builds report
 * resolvable:false for both.
 */
export function detectNativePlugins(): NativePluginDetection[] {
  return NATIVE_PLUGIN_SPECIFIERS.map(({ packageName, label }) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- probe-only resolution (D-05), never a load
      createRequire(__filename).resolve(packageName);
      return { packageName, label, resolvable: true };
    } catch {
      return { packageName, label, resolvable: false };
    }
  });
}

/**
 * License paste → verify + encrypt + persist (PUT /:id/license). DELEGATES
 * to 202-05's savePluginLicense (probe-first: an invalid JWT is never
 * written; the at-rest blob is AES-256-GCM ciphertext via the REUSED
 * encryptionService). The route maps the closed-enum verdict to 200/400.
 */
export function setPluginLicense(
  id: string,
  licenseJwt: string,
): Promise<{ ok: boolean; reason: string }> {
  return savePluginLicenseImpl(id, licenseJwt);
}

/**
 * Probe-only license re-verification (POST /:id/verify-license) — DELEGATES
 * to 202-05's verifyPluginLicense. NEVER persists: the row's
 * licenseKeyEncrypted/licenseStatus are untouched (the A-6/A-7 modal contract).
 */
export function probePluginLicense(
  id: string,
  licenseJwt: string,
): Promise<{ ok: boolean; reason: string }> {
  return verifyPluginLicenseImpl(id, licenseJwt);
}
