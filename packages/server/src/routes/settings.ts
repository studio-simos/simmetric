// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
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
router.use(authMiddleware, requireAdmin);

// GET /api/system/settings — retrieve all system settings
router.get("/", async (_req: Request, res: Response) => {
  try {
    const settings = await getAllSettings();
    res.json(settings);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// PUT /api/system/settings — update system settings
router.put("/", async (req: Request, res: Response) => {
  try {
    const parsed = bulkSetConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
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