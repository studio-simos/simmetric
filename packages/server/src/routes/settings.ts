// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { tenantContextMiddleware } from "../middleware/tenantContext";
import { requireAdmin } from "../middleware/rbac";
import { getAllSettings, getSetting, updateSettings } from "../services/systemConfigService";
import { decrypt } from "../services/encryptionService";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import prisma from "../utils/prisma";
import { bulkSetConfigSchema } from "@simmetric-chat/shared";
import { resolveOllamaUrl } from "../services/providerService";

const router = Router();

// GET /api/system/embedding-config — returns the active embedding provider config
// (unauthenticated: called by collector service)
router.get("/embedding-config", async (_req: Request, res: Response) => {
  try {
    const providerSetting = await getSetting("EMBEDDING_PROVIDER");
    const modelSetting = await getSetting("EMBEDDING_MODEL");
    const embeddingProviderType = providerSetting.value || "local";
    const embeddingModel = modelSetting.value || "";

    // Local embedding: return the model from SystemConfig so the collector
    // uses the model set in the settings page (not just the collector's .env).
    if (embeddingProviderType === "local") {
      res.json({
        providerId: "local",
        model: embeddingModel || "Xenova/all-MiniLM-L6-v2",
        type: "local",
        baseUrl: null,
        apiKey: null,
      });
      return;
    }

    // Ollama: resolve from the Provider table if available, otherwise
    // return a config using the model from SystemConfig + env OLLAMA_BASE_URL.
    if (embeddingProviderType === "ollama") {
      const provider = await prisma.provider.findFirst({
        where: {
          isEnabled: true,
          type: "ollama",
        },
        include: {
          models: {
            where: { isEmbedding: true, isEnabled: true, isAvailable: true },
            orderBy: { isDefault: "desc" },
          },
        },
      });

      if (provider && provider.models.length > 0) {
        const baseUrl = resolveOllamaUrl(provider.baseUrl);
        res.json({
          providerId: provider.id,
          model: embeddingModel || provider.models[0]!.name,
          type: "ollama",
          baseUrl,
          apiKey: null,
        });
        return;
      }

      // No Provider record — fall back to env-based Ollama config
      const env = getEnv();
      res.json({
        providerId: "ollama-env",
        model: embeddingModel || env.EMBEDDING_MODEL || "nomic-embed-text",
        type: "ollama",
        baseUrl: resolveOllamaUrl(env.OLLAMA_BASE_URL),
        apiKey: null,
      });
      return;
    }

    // OpenAI and other remote providers: require a Provider record
    const provider = await prisma.provider.findFirst({
      where: {
        isEnabled: true,
        type: embeddingProviderType,
      },
      include: {
        models: {
          where: { isEmbedding: true, isEnabled: true, isAvailable: true },
          orderBy: { isDefault: "desc" },
        },
      },
    });

    if (!provider || provider.models.length === 0) {
      res.status(404).json({ error: "No embedding provider configured" });
      return;
    }

    const apiKey = provider.apiKey ? decrypt(provider.apiKey) : null;
    const baseUrl = provider.type === "ollama" ? resolveOllamaUrl(provider.baseUrl) : provider.baseUrl;

    res.json({
      providerId: provider.id,
      model: embeddingModel || provider.models[0]!.name,
      type: provider.type,
      baseUrl,
      apiKey,
    });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[settings] Error fetching embedding config", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/system/vector-db-config — returns the active vector database provider config
// (unauthenticated: called by collector service)
router.get("/vector-db-config", async (_req: Request, res: Response) => {
  try {
    const providerSetting = await getSetting("VECTOR_DB_PROVIDER");
    const urlSetting = await getSetting("VECTOR_DB_URL");
    const apiKeySetting = await getSetting("VECTOR_DB_API_KEY");

    const provider = providerSetting.value || "lancedb";
    let url: string | undefined = urlSetting.value || undefined;
    let apiKey: string | undefined = apiKeySetting.value || undefined;
    // D-02 (Phase 91-01): pgvector URL is sourced from the server's DATABASE_URL
    // at runtime. The "collector env has no DATABASE_URL" rule (CLAUDE.md
    // collector) stays literally true: the collector fetches this endpoint and
    // connects to PG, never reads DATABASE_URL from its own env.
    if (provider === "pgvector") {
      url = getEnv().DATABASE_URL;
      apiKey = undefined; // pgvector does not use an API key
    }

    res.json({ provider, url, apiKey });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[settings] Error fetching vector DB config", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// All settings routes require admin access
router.use(authMiddleware, tenantContextMiddleware, requireAdmin);

// Phase 183 (SAAS-02, T-183-09): the org target arrives explicitly in the
// query string — uuid-validate it at the route boundary (SP-4 safeParse;
// 400 { error, details } on a malformed value).
const orgIdQuerySchema = z.object({ organizationId: z.string().uuid() });

// WR-02 (183-REVIEW Fix Round 1): uuid-shape validation alone let a
// valid-uuid UNKNOWN organizationId through — the PUT then died as a raw
// P2003 FK violation (500 with Prisma driver internals) and the GET
// returned a global-equivalent view mislabeled as org-resolved. Both org
// surfaces now resolve the org (cheap findFirst on organizations, live
// rows only — deletedAt: null soft-delete norm) before doing any work;
// unknown org → 400 "Organization not found" (repo error shape: one-line
// string error, no driver details leaked).
async function resolveOrgIdOr400(
  organizationId: string,
  res: Response,
): Promise<boolean> {
  const org = await prisma.organization.findFirst({
    where: { id: organizationId, deletedAt: null },
  });
  if (!org) {
    res.status(400).json({ error: "Organization not found" });
    return false;
  }
  return true;
}

// GET /api/system/settings — retrieve all system settings.
// Optional ?organizationId=<uuid> returns the org-resolved view (cascade
// tenant > global > ENV > default) with a per-entry `source` flag (D-05).
// Absent param → the global view, byte-identical to the pre-183 payload
// (Pitfall P2 — no source field on any entry).
router.get("/", async (req: Request, res: Response) => {
  try {
    const orgParam = req.query.organizationId;
    if (orgParam !== undefined) {
      const orgId = Array.isArray(orgParam) ? orgParam[0] : orgParam;
      const parsed = orgIdQuerySchema.safeParse({ organizationId: orgId });
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid organizationId",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }
      // WR-02 (Fix Round 1): unknown org → 400 (a uuid-shaped id that does
      // not resolve must not return a global-equivalent view labeled as an
      // org view).
      if (!(await resolveOrgIdOr400(parsed.data.organizationId, res))) return;
      const settings = await getAllSettings(parsed.data.organizationId);
      res.json(settings);
      return;
    }
    const settings = await getAllSettings();
    res.json(settings);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// PUT /api/system/settings — update system settings.
// Phase 183 (SAAS-02, D-04): configs[] items may carry an optional
// organizationId (shared bulkSetConfigSchema, uuid-validated). It rides the
// parsed data into updateSettings untouched — tenant-row vs global-row
// routing is the service's single-write-helper concern. No route logic
// beyond the pre-existing schema gate; { updated, rejected } partial-success
// shape kept (repo API-shape convention). ALWAYS_READONLY keys are rejected
// for org-scoped items too (D-11 — service-side, probed below). WR-02 (Fix
// Round 1): org existence is validated BEFORE updateSettings — unknown org
// → 400 "Organization not found" instead of a raw P2003 500.
router.put("/", async (req: Request, res: Response) => {
  try {
    const parsed = bulkSetConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }

    // WR-02 (Fix Round 1): every org-scoped item's organizationId must
    // resolve to a live org BEFORE any write is attempted. Pre-fix, an
    // unknown org escaped validation and the helper's create died as a raw
    // P2003 FK error → 500 with Prisma driver internals. One check per
    // DISTINCT org id (cheap findFirst each); unknown org → 400 — a whole-
    // request client error, not a per-item rejection (the client targeted
    // an org that does not exist; no item in the batch is meaningfully
    // writable against it).
    const requestedOrgIds = [
      ...new Set(
        parsed.data.configs
          .map((c) => c.organizationId)
          .filter((id): id is string => typeof id === "string"),
      ),
    ];
    for (const orgId of requestedOrgIds) {
      if (!(await resolveOrgIdOr400(orgId, res))) return;
    }

    const result = await updateSettings(parsed.data.configs);

    // Return 200 with both updated and rejected — frontend handles partial success
    res.json({
      updated: result.updated,
      rejected: result.rejected,
    });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

export default router;