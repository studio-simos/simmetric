// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import { tenantContextMiddleware } from "../middleware/tenantContext";
import { requirePermission } from "../middleware/rbac";
import { getArchiveConfig, setArchiveConfig, deleteArchiveConfig } from "../services/archiveConfigService";
import { archiveConfigSchema } from "@simmetric-chat/shared";

const router = Router();

// Phase 187 gap closure (SC-1 first-save deadlock): schema-default empty config
// for row-less archives. archiveConfigSchema.parse({}) materializes
// rawSourcesImmutable via D-02's .default(true) → { rawSourcesImmutable: true }.
// The default lives at the HTTP seam ONLY — getArchiveConfig (service) keeps
// returning undefined for no row, so injection paths keep their no-config
// semantics (SC-2b baseline, D-04 precedence chain untouched).
const EMPTY_ARCHIVE_CONFIG = archiveConfigSchema.parse({});

router.get("/:archiveId/config", authMiddleware, tenantContextMiddleware, requirePermission("archive:read"), async (req, res) => {
  try {
    const archiveId = req.params.archiveId as string;
    const config = await getArchiveConfig(archiveId);
    return res.json(config ?? EMPTY_ARCHIVE_CONFIG);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
});

router.put("/:archiveId/config", authMiddleware, tenantContextMiddleware, requirePermission("archive:write"), async (req, res) => {
  try {
    const parsed = archiveConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid config", details: parsed.error.flatten().fieldErrors });
    }
    const archiveId = req.params.archiveId as string;
    await setArchiveConfig(archiveId, parsed.data);
    return res.json({ message: "Config updated successfully" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
});

router.delete("/:archiveId/config", authMiddleware, tenantContextMiddleware, requirePermission("archive:delete"), async (req, res) => {
  try {
    const archiveId = req.params.archiveId as string;
    await deleteArchiveConfig(archiveId);
    return res.json({ message: "Config deleted successfully" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
});

export default router;
