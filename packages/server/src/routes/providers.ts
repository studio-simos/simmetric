// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { execFile } from "node:child_process";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin, requirePermission } from "../middleware/rbac";
import { createProviderSchema, updateProviderSchema, updateProviderModelSchema } from "@simmetric-chat/shared";
import { maskApiKey } from "../services/encryptionService";
import * as providerService from "../services/providerService";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import type { ProgressResponse } from "ollama";

const router = Router();

// All provider routes require authentication
router.use(authMiddleware);

// GET /models/available — all enabled providers with their enabled+available models (for chat model selector)
// Must be before /:id routes to avoid route conflicts
router.get("/models/available", requirePermission("provider:read"), async (_req: Request, res: Response) => {
  try {
    const providers = await providerService.listAvailableProviders();
    res.json(providers);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[providers] Error listing available models", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// Helper: mask API keys in provider response
function maskProvider(p: Record<string, unknown> | null) {
  if (!p) return p;
  const { apiKey, ...rest } = p;
  return { ...rest, apiKey: apiKey ? maskApiKey(apiKey as string) : null };
}

// Helper: run `docker exec <OLLAMA_CONTAINER_NAME> ollama login` via the host
// Docker socket (mounted in docker-compose.yml). T-lwy-01/02: command args are
// fully static — container name comes from the Zod-validated env var, NOT
// from the request; execFile (not exec) prevents shell injection. T-lwy-04:
// 15s timeout + 1MB maxBuffer cap a stuck `ollama login` process.
// Returns { status: "pending", connectUrl } when stdout contains an
// https://ollama.com/connect?... URL, or { status: "authenticated" } when
// the daemon is already signed in (no URL in output).
async function runOllamaLogin(
  providerId: string,
): Promise<{ status: "pending" | "authenticated"; connectUrl?: string }> {
  const provider = await providerService.getProvider(providerId);
  if (!provider) {
    throw new Error("Provider not found");
  }
  if (provider.type !== "ollama") {
    throw new Error("Ollama Cloud login is only supported for Ollama providers");
  }

  const containerName = getEnv().OLLAMA_CONTAINER_NAME;

  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      ["exec", containerName, "ollama", "login"],
      { timeout: 15000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          // ENOENT = the docker binary is not on PATH (non-Docker deployment).
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new Error("DOCKER_UNAVAILABLE"));
            return;
          }
          reject(new Error(stderr?.trim() || err.message));
          return;
        }
        const match = stdout.match(/https:\/\/ollama\.com\/connect\?[^\s]+/);
        if (match) {
          resolve({ status: "pending", connectUrl: match[0] });
        } else {
          resolve({ status: "authenticated" });
        }
      },
    );
  });
}

// GET / — List all providers
router.get("/", requirePermission("provider:read"), async (_req: Request, res: Response) => {
  try {
    const providers = await providerService.listProviders();
    res.json(providers.map(maskProvider));
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[providers] Error listing providers", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id — Get single provider
router.get("/:id", requirePermission("provider:read"), async (req: Request, res: Response) => {
  try {
    const provider = await providerService.getProvider(req.params.id as string as string);
    if (!provider) {
      res.status(404).json({ error: "Provider not found" });
      return;
    }
    res.json(maskProvider(provider));
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[providers] Error getting provider", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST / — Create provider
router.post("/", requirePermission("provider:write"), async (req: Request, res: Response) => {
  try {
    const parsed = createProviderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const provider = await providerService.createProvider(parsed.data);
    res.status(201).json(maskProvider(provider));
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[providers] Error creating provider", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /:id — Update provider
router.put("/:id", requirePermission("provider:write"), async (req: Request, res: Response) => {
  try {
    const parsed = updateProviderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const provider = await providerService.updateProvider(req.params.id as string, parsed.data);
    res.json(maskProvider(provider));
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const errCode = (err as { code?: string }).code;
    if (errCode === "P2025") {
      res.status(404).json({ error: "Provider not found" });
      return;
    }
    logger.error("[providers] Error updating provider", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:id — Delete provider
router.delete("/:id", requirePermission("provider:write"), async (req: Request, res: Response) => {
  try {
    await providerService.deleteProvider(req.params.id as string);
    res.json({ message: "Provider deleted successfully" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const errCode = (err as { code?: string }).code;
    if (errCode === "P2025") {
      res.status(404).json({ error: "Provider not found" });
      return;
    }
    logger.error("[providers] Error deleting provider", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /:id/set-default — Set default provider
router.put("/:id/set-default", requirePermission("provider:read"), async (req: Request, res: Response) => {
  try {
    await providerService.setDefaultProvider(req.params.id as string);
    const provider = await providerService.getProvider(req.params.id as string);
    res.json(maskProvider(provider));
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[providers] Error setting default provider", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id/models — List models for a provider
router.get("/:id/models", requirePermission("provider:read"), async (req: Request, res: Response) => {
  try {
    const models = await providerService.listModels(req.params.id as string);
    res.json(models);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[providers] Error listing models", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:id/models/refresh — Refresh models from provider API
router.post("/:id/models/refresh", requirePermission("provider:write"), async (req: Request, res: Response) => {
  try {
    const count = await providerService.refreshModels(req.params.id as string);
    const models = await providerService.listModels(req.params.id as string);
    res.json({ refreshed: count, models });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    if (message === "Provider not found") {
      res.status(404).json({ error: "Provider not found" });
      return;
    }
    logger.error("[providers] Error refreshing models", { error: message });
    res.status(500).json({ error: "Failed to refresh models", details: message });
  }
});

// POST /:providerId/models/pull — Pull/download an Ollama model (SSE progress)
router.post("/:providerId/models/pull", requirePermission("provider:write"), async (req: Request, res: Response) => {
  const { modelName } = req.body || {};
  if (!modelName || typeof modelName !== "string") {
    res.status(400).json({ error: "modelName is required (string)" });
    return;
  }

  try {
    const { stream: ollamaStream, modelName: resolvedName } =
      await providerService.startOllamaPull(req.params.providerId as string, modelName);

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    let clientDisconnected = false;
    req.on("close", () => { clientDisconnected = true; });

    const sendSSE = (event: string, data: unknown) => {
      if (clientDisconnected) return;
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
    };

    let pullSucceeded = false;

    // 92-02: ollama-js pull iterator — per-frame shapes mirror the old NDJSON
    // parser 1:1 (progress/error/success). A disconnected client does NOT
    // cancel the pull (flag-only semantics preserved — no iterator.abort()).
    // ollama-js 0.6.3 also THROWS Error(frame.error) on daemon error frames
    // (AbortableAsyncIterator) instead of yielding them; both paths surface
    // the same frozen { error } SSE shape (loop branch is duck-typed because
    // ProgressResponse doesn't declare `error`).
    for await (const progress of ollamaStream) {
      const frameError = (progress as ProgressResponse & { error?: string }).error;
      if (frameError) {
        sendSSE("error", { error: frameError });
        throw new Error(frameError);
      }
      if (progress.status === "success") {
        pullSucceeded = true;
      }
      sendSSE("progress", {
        status: progress.status,
        digest: progress.digest,
        total: progress.total,
        completed: progress.completed,
      });
    }

    if (pullSucceeded) {
      await providerService.refreshModels(req.params.providerId as string);
      sendSSE("done", { modelName: resolvedName });
    }

    res.end();
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    if (message === "Provider not found") {
      res.status(404).json({ error: "Provider not found" });
      return;
    }
    if (message === "Model pulling is only supported for Ollama providers") {
      res.status(400).json({ error: message });
      return;
    }
    if (typeof message === "string" && message.startsWith("Ollama unreachable")) {
      logger.error("[providers] Ollama connectivity error", { error: message });
      if (res.headersSent) {
        try { res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`); res.end(); } catch { /* client gone */ }
      } else {
        res.status(503).json({ error: "Ollama is unreachable", details: message });
      }
      return;
    }
    logger.error("[providers] Error pulling model", { error: message });
    if (res.headersSent) {
      try { res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`); res.end(); } catch { /* client gone */ }
    } else {
      res.status(500).json({ error: "Failed to pull model", details: message });
    }
  }
});

// PUT /:providerId/models/:modelId — Update model
router.put("/:providerId/models/:modelId", requirePermission("provider:write"), async (req: Request, res: Response) => {
  try {
    const parsed = updateProviderModelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }

    // If enabling embedding on an Ollama model, verify model exists on the Ollama server
    if (parsed.data.isEmbedding === true) {
      const modelRecord = await providerService.getModelById(req.params.modelId as string);
      if (modelRecord) {
        await providerService.validateOllamaModelAvailability(
          req.params.providerId as string,
          modelRecord.name,
        );
      }
    }

    const model = await providerService.updateModel(req.params.modelId as string, parsed.data);
    res.json(model);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const errCode = (err as { code?: string }).code;
    if (errCode === "P2025") {
      res.status(404).json({ error: "Model not found" });
      return;
    }
    if (message.includes("not found on the Ollama server")) {
      res.status(400).json({ error: message });
      return;
    }
    if (message.includes("Cannot verify model availability")) {
      res.status(504).json({ error: message });
      return;
    }
    logger.error("[providers] Error updating model", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /:providerId/models/:modelId/set-default — Set default model
router.put("/:providerId/models/:modelId/set-default", requirePermission("provider:read"), async (req: Request, res: Response) => {
  try {
    await providerService.setDefaultModel(req.params.modelId as string);
    res.json({ message: "Default model updated" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const errCode = (err as { code?: string }).code;
    if (errCode === "P2025") {
      res.status(404).json({ error: "Model not found" });
      return;
    }
    logger.error("[providers] Error setting default model", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:providerId/models/:modelId — Delete model
router.delete("/:providerId/models/:modelId", requirePermission("provider:write"), async (req: Request, res: Response) => {
  try {
    await providerService.deleteModel(req.params.modelId as string);
    res.json({ message: "Model deleted successfully" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const errCode = (err as { code?: string }).code;
    if (errCode === "P2025") {
      res.status(404).json({ error: "Model not found" });
      return;
    }
    logger.error("[providers] Error deleting model", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:id/ollama-login — trigger `ollama login` inside the Ollama container
// (via the host Docker socket) to obtain the ollama.com/connect URL. Admin-only.
// No request body is parsed; container name comes from the Zod-validated
// OLLAMA_CONTAINER_NAME env var (T-lwy-02: no user-controlled input reaches
// docker CLI args — execFile with a static args array, never exec).
router.post("/:id/ollama-login", requireAdmin, async (req: Request, res: Response) => {
  try {
    const result = await runOllamaLogin(req.params.id as string);
    res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "Provider not found") {
      res.status(404).json({ error: "Provider not found" });
      return;
    }
    if (message === "Ollama Cloud login is only supported for Ollama providers") {
      res.status(400).json({ error: message });
      return;
    }
    if (message === "DOCKER_UNAVAILABLE") {
      res.status(501).json({
        error: "Ollama Cloud login is only available in Docker deployments. Run 'ollama login' on the Ollama host manually.",
      });
      return;
    }
    logger.error("[providers] Error triggering Ollama Cloud login", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id/ollama-login/status — re-run `ollama login` to check auth state.
// If the daemon is already signed in, `ollama login` exits 0 with no URL in
// stdout → { status: "authenticated" }. If still pending, it prints the
// connect URL again → { status: "pending", connectUrl }. Admin-only.
router.get("/:id/ollama-login/status", requireAdmin, async (req: Request, res: Response) => {
  try {
    const result = await runOllamaLogin(req.params.id as string);
    res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "Provider not found") {
      res.status(404).json({ error: "Provider not found" });
      return;
    }
    if (message === "Ollama Cloud login is only supported for Ollama providers") {
      res.status(400).json({ error: message });
      return;
    }
    if (message === "DOCKER_UNAVAILABLE") {
      res.status(501).json({
        error: "Ollama Cloud login is only available in Docker deployments. Run 'ollama login' on the Ollama host manually.",
      });
      return;
    }
    logger.error("[providers] Error checking Ollama Cloud login status", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;