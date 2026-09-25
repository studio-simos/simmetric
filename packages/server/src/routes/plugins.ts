// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 202 (PLGM-01..05) — the /api/plugins admin surface.
 *
 * 7 RBAC-gated routes over the tracer-proven service (202-01/02/05):
 *   GET    /api/plugins              — list: managed rows + probe-only native detection
 *   POST   /api/plugins              — upload/install (.zip ≤100MB, multer memoryStorage)
 *   PUT    /api/plugins/:id          — enable/disable toggle (restart-deferred effect)
 *   DELETE /api/plugins/:id          — uninstall (D-08: disabled rows ONLY)
 *   PUT    /api/plugins/:id/license  — paste license (verify → encrypt → persist)
 *   POST   /api/plugins/:id/verify-license — probe-only re-verification (never persists)
 *   POST   /api/plugins/restart      — 202 first, then the ONE gracefulShutdown path
 *
 * Gate chain (filters.ts:40 idiom — the permission subsumes admin):
 *   authMiddleware → tenantContextMiddleware → requirePermission("plugins:manage")
 *
 * Serialization (P4, PATTERNS Pattern 3): responses parse through the STRICT
 * shared pluginRowSchema — licenseKeyEncrypted and packageJson REJECT a
 * response payload rather than silently stripping (the .strict() hard gate).
 * License verify/persist DELEGATE to pluginLicenseService (202-05) — the
 * RS256 pipeline is never reimplemented at the route layer (T-202-15).
 */

import { Router, type NextFunction, type Request, type Response } from "express";
import multer, { MulterError } from "multer";
import prisma from "../utils/prisma";
import { authMiddleware } from "../middleware/auth";
import { tenantContextMiddleware } from "../middleware/tenantContext";
import { requirePermission } from "../middleware/rbac";
import { logger } from "../utils/logger";
import {
  pluginListResponseSchema,
  pluginRowSchema,
  pluginIdParamSchema,
  updatePluginSchema,
  setPluginLicenseSchema,
  verifyPluginLicenseSchema,
  type PluginRow,
} from "@simmetric-chat/shared";
import {
  installFromZip,
  InstallError,
  setPluginEnabled,
  uninstallPlugin,
  detectNativePlugins,
  setPluginLicense,
  probePluginLicense,
  type NativePluginDetection,
} from "../services/pluginManagerService";
import { gracefulShutdown } from "../services/shutdownSequence";

// Multer for the plugin zip upload (chatImport.ts memoryStorage precedent —
// the archive lives in RAM only, no disk residue; D-02 cap 100MB).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB (D-02)
  fileFilter: (_req, file, cb) => {
    // ZIP-only filter (documents.ts:103-118 fileFilter shape, keyed on the
    // original filename — mimetype is client-asserted and NOT trusted).
    if (file.originalname.toLowerCase().endsWith(".zip")) {
      cb(null, true);
    } else {
      cb(new Error("Only .zip plugin archives are accepted"));
    }
  },
});

/**
 * Multer wrapper — copied VERBATIM from documents.ts:130-142 (T-61-04):
 * intercepts MulterError BEFORE the route handler so oversized files get a
 * clean 413 instead of falling through to the Express-5 catch-all 500.
 */
function uploadSingle(field: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    upload.single(field)(req, res, (err: unknown) => {
      if (err instanceof MulterError && err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "File too large", limit: "100MB" });
      }
      if (err) {
        return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
      next();
    });
  };
}

/**
 * Secrets-strip serialization (P4, connectors.ts serializeConnector idiom):
 * licenseKeyEncrypted and packageJson are destructured OUT of the row and
 * the result parses through the STRICT pluginRowSchema — a payload that
 * carries a secret column fails loudly instead of leaking.
 */
function serializePluginRow(row: Record<string, unknown>): PluginRow {
  // organizationId is the schema seam column (null = instance-scoped, spec
  // §3.2) — NOT part of the public surface; the STRICT pluginRowSchema would
  // reject it (found live: the route 500'd on every real row).
  const { licenseKeyEncrypted: _lk, packageJson: _pj, organizationId: _org, ...rest } = row;
  void _lk;
  void _pj;
  void _org;
  return pluginRowSchema.parse({
    ...rest,
    displayName: row.displayName ?? null,
    version: row.version ?? null,
    lastError: row.lastError ?? null,
    licenseStatus: row.licenseStatus ?? null,
    licenseCheckedAt: row.licenseCheckedAt
      ? new Date(row.licenseCheckedAt as Date).toISOString()
      : null,
    source: "managed",
    createdAt: new Date(row.createdAt as Date).toISOString(),
    updatedAt: new Date(row.updatedAt as Date).toISOString(),
  });
}

/** Map a managed DB row to the shared serialized shape (shared mapper for GET). */
function nativeRowFromDetection(d: NativePluginDetection): PluginRow {
  const now = new Date().toISOString();
  return pluginRowSchema.parse({
    id: `native:${d.packageName}`,
    slug: d.packageName.replace("/", "+"),
    packageName: d.packageName,
    displayName: d.label,
    version: null,
    apiVersion: 0,
    enabled: true,
    status: "loaded",
    lastError: null,
    // Built-in plugins are NEVER per-plugin license-gated (P3/D6 — the
    // enterprise license is the INSTANCE license, not a plugin license).
    licenseMode: "self",
    licenseStatus: null,
    licenseCheckedAt: null,
    source: "native",
    createdAt: now,
    updatedAt: now,
  });
}

/** Map an InstallError machine code onto the repo HTTP shape. */
function installErrorStatus(err: InstallError): number {
  if (err.code === "DUPLICATE_SLUG") return 409;
  return 400;
}

const router = Router();

// Every /api/plugins route requires plugins:manage (T-202-12). The permission
// check subsumes admin — requireAdmin is unnecessary (filters.ts:40 idiom).
router.use(authMiddleware, tenantContextMiddleware, requirePermission("plugins:manage"));

// GET /api/plugins — list: managed rows (secrets-stripped) merged with the
// probe-only native detection (D-05). restartMode is SERVER-OWNED (RESEARCH
// A1): supervisor in production (Docker/Coolify respawn), manual otherwise —
// zero new env keys.
router.get("/", async (_req: Request, res: Response) => {
  try {
    const rows = (await prisma.pluginInstall.findMany({
      orderBy: { createdAt: "asc" },
    })) as Array<Record<string, unknown>>;
    const managed = rows.map((row) => serializePluginRow(row));

    // D-05: detection NEVER writes a DB row and NEVER loads a plugin.
    const natives = detectNativePlugins()
      .filter((d) => d.resolvable)
      .map((d) => nativeRowFromDetection(d));

    const restartMode = process.env.NODE_ENV === "production" ? "supervisor" : "manual";
    const body = pluginListResponseSchema.parse({
      restartMode,
      plugins: [...natives, ...managed],
    });
    res.json(body);
  } catch (err: unknown) {
    logger.error("[plugins] list failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: "Failed to list plugins" });
  }
});

// POST /api/plugins — upload/install (multer wrapper → installFromZip).
router.post("/", uploadSingle("file"), async (req: Request, res: Response) => {
  try {
    if (!req.file?.buffer) {
      res.status(400).json({ error: "No plugin archive uploaded" });
      return;
    }
    const { id } = await installFromZip(req.file.buffer);
    const row = (await prisma.pluginInstall.findUnique({ where: { id } })) as
      | Record<string, unknown>
      | null;
    if (!row) {
      res.status(500).json({ error: "Installed row vanished" });
      return;
    }
    res.status(201).json(serializePluginRow(row));
  } catch (err: unknown) {
    if (err instanceof InstallError) {
      res.status(installErrorStatus(err)).json({ error: err.message, code: err.code });
      return;
    }
    logger.error("[plugins] install failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: "Failed to install plugin" });
  }
});

// PUT /api/plugins/:id — enable/disable toggle (restart-deferred effect:
// the loader flips status at next boot; a toggle never loads code in-process).
// License-gated arm (D4): enabling a licenseMode=platform row WITHOUT a
// verified license → 402 (the repo license-gate shape).
router.put("/:id", async (req: Request, res: Response) => {
  const parsedParams = pluginIdParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ error: "Invalid plugin ID", details: parsedParams.error.flatten().fieldErrors });
    return;
  }
  const parsed = updatePluginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  try {
    const row = (await prisma.pluginInstall.findUnique({
      where: { id: parsedParams.data.id },
    })) as Record<string, unknown> | null;
    if (!row) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }
    // D4 route-level gate (P3 stays intact: none/self rows are NEVER gated —
    // this arm only fires for licenseMode=platform rows).
    if (
      parsed.data.enabled &&
      row.licenseMode === "platform" &&
      row.licenseStatus !== "verified"
    ) {
      res.status(402).json({ error: "A verified license is required to enable this plugin", feature: "plugin-license", tier: "platform" });
      return;
    }
    const updated = await setPluginEnabled(parsedParams.data.id, parsed.data.enabled);
    res.json(serializePluginRow(updated));
  } catch (err: unknown) {
    logger.error("[plugins] toggle failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: "Failed to update plugin" });
  }
});

// DELETE /api/plugins/:id — uninstall (D-08: DISABLED rows only; enabled → 409).
router.delete("/:id", async (req: Request, res: Response) => {
  const parsedParams = pluginIdParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ error: "Invalid plugin ID", details: parsedParams.error.flatten().fieldErrors });
    return;
  }
  try {
    await uninstallPlugin(parsedParams.data.id);
    res.status(200).json({ success: true });
  } catch (err: unknown) {
    if (err instanceof InstallError) {
      if (err.code === "NOT_FOUND") {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err.code === "PLUGIN_ENABLED") {
        res.status(409).json({ error: err.message });
        return;
      }
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }
    logger.error("[plugins] uninstall failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: "Failed to uninstall plugin" });
  }
});

// PUT /api/plugins/:id/license — paste license (verify → encrypt → persist).
// P3: licenseMode=none/self rows are NEVER license-managed — 400 (the UI
// renders no license affordance for them either).
router.put("/:id/license", async (req: Request, res: Response) => {
  const parsedParams = pluginIdParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ error: "Invalid plugin ID", details: parsedParams.error.flatten().fieldErrors });
    return;
  }
  const parsed = setPluginLicenseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  try {
    const row = (await prisma.pluginInstall.findUnique({
      where: { id: parsedParams.data.id },
    })) as Record<string, unknown> | null;
    if (!row) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }
    if (row.licenseMode !== "platform") {
      res.status(400).json({
        error: "License paste is only available for platform-mode plugins",
        licenseMode: row.licenseMode,
      });
      return;
    }
    const verdict = await setPluginLicense(parsedParams.data.id, parsed.data.licenseKey);
    if (!verdict.ok) {
      // Closed-enum reason only — the JWT/derived key material never echoes
      // back (P4/T-202-14). 402-style license failures use 400 here: the
      // paste itself is the remediation, not a payment wall.
      res.status(400).json({ error: "License verification failed", reason: verdict.reason });
      return;
    }
    // Response carries ONLY the status surface — never the ciphertext or the
    // plaintext JWT (P4).
    res.json({ licenseStatus: "verified" });
  } catch (err: unknown) {
    logger.error("[plugins] license save failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: "Failed to save license" });
  }
});

// POST /api/plugins/:id/verify-license — probe-only re-verification. NEVER
// persists: the row's licenseKeyEncrypted/licenseStatus are untouched (the
// A-6/A-7 modal contract depends on it).
router.post("/:id/verify-license", async (req: Request, res: Response) => {
  const parsedParams = pluginIdParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ error: "Invalid plugin ID", details: parsedParams.error.flatten().fieldErrors });
    return;
  }
  const parsed = verifyPluginLicenseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  try {
    const row = (await prisma.pluginInstall.findUnique({
      where: { id: parsedParams.data.id },
    })) as Record<string, unknown> | null;
    if (!row) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }
    const verdict = await probePluginLicense(parsedParams.data.id, parsed.data.licenseKey);
    // Response: the licenseStatus surface ONLY (P4 — no key material).
    res.json({ licenseStatus: verdict.ok ? "verified" : verdict.reason });
  } catch (err: unknown) {
    logger.error("[plugins] license verify failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: "Failed to verify license" });
  }
});

// POST /api/plugins/restart — 202 FIRST, teardown SECOND (D-06; Pitfall 6
// documents the accepted in-flight-install race — the boot .tmp-* sweep from
// 202-02 recovers orphans). The import is the SAME gracefulShutdown the
// SIGTERM/SIGINT handlers call — never a second restart-specific variant
// (T-202-10). The route lives under the router-level RBAC gate like the rest.
router.post("/restart", (_req: Request, res: Response) => {
  res.status(202).json({ restarting: true });
  void gracefulShutdown("restart").catch((err: unknown) => {
    logger.error("[restart] shutdown failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
});

export default router;