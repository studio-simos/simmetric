// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import { createApiKey, listApiKeys, revokeApiKey } from "../services/apiKeyService";

const router = Router();

router.use(authMiddleware);

/**
 * @openapi
 * /api-keys:
 *   get:
 *     tags: [API Keys]
 *     summary: List current user's API keys
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Array of API keys (hashed) }
 */
// GET /api/api-keys — list current user's API keys
router.get("/", async (req, res) => {
  try {
    const keys = await listApiKeys(req.userId!);
    res.json(keys);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * @openapi
 * /api-keys:
 *   post:
 *     tags: [API Keys]
 *     summary: Generate a new API key
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, example: "My API Key" }
 *               expiresAt: { type: string, format: date-time }
 *     responses:
 *       201:
 *         description: API key created (plain key returned only once)
 *       400: { description: Name is required }
 */
// POST /api/api-keys — generate a new API key
router.post("/", async (req, res) => {
  try {
    const { name, expiresAt, expiresInDays } = req.body;

    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "Name is required" });
      return;
    }

    // Support both expiresAt (ISO date string) and expiresInDays (number of days from now)
    let expiry: Date | undefined;
    if (expiresInDays && typeof expiresInDays === "number" && expiresInDays > 0) {
      expiry = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    } else if (expiresAt) {
      expiry = new Date(expiresAt);
    }

    const result = await createApiKey(name, req.userId!, expiry);

    // Return as "key" for frontend compatibility
    res.status(201).json({
      id: result.id,
      name: result.name,
      key: result.plainKey,
      expiresAt: result.expiresAt,
      createdAt: result.createdAt,
    });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// DELETE /api/api-keys/:keyId — revoke an API key
router.delete("/:keyId", async (req, res) => {
  try {
    await revokeApiKey(req.params.keyId, req.userId!);
    res.json({ message: "API key revoked" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    if (message === "API key not found") {
      res.status(404).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

export default router;