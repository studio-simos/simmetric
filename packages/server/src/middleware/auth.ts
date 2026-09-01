// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import type { Request, Response, NextFunction } from "express";
import { verifyToken, getUserWithRoles, getCachedUserWithRoles } from "../services/authService";
import { isTokenRevoked } from "../services/tokenRevocation";
import { validateApiKey } from "../services/apiKeyService";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      user?: Awaited<ReturnType<typeof getUserWithRoles>>;
    }
  }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid authorization header" });
    return;
  }

  const token = authHeader.substring(7);

  try {
    const payload = verifyToken(token);
    // TEC-03b: revoked-jti blacklist (D-01/D-03). The `payload.jti &&` guard
    // keeps pre-deploy tokens without jti working (D-04). isTokenRevoked never
    // throws (non-blocking), so this placement is belt-and-braces fail-closed.
    if (payload.jti && (await isTokenRevoked(payload.jti))) {
      res.status(401).json({ error: "Token revoked" });
      return;
    }
    const user = await getCachedUserWithRoles(payload.userId);

    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    req.userId = payload.userId;
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// API Key authentication (alternative to JWT).
// Phase 163 (SCALE-03): delegates to validateApiKey (HMAC-SHA256 + O(1)
// findUnique). DRY — the middleware is a thin auth-checker; all DB/crypto
// logic lives in apiKeyService. The CSW-05 `take: 10` cap is gone (no loop
// to cap). A missing/invalid API_KEY_HMAC_SECRET makes validateApiKey throw;
// the try/catch returns 500 (fail-loud) so misconfiguration is NOT hidden as
// "Invalid API key" (T-163-02 spoofing vector — a 401 would mask the root
// cause from the operator).
export async function apiKeyMiddleware(req: Request, res: Response, next: NextFunction) {
  const apiKeyHeader = req.headers["x-api-key"] as string | undefined;

  if (!apiKeyHeader) {
    res.status(401).json({ error: "Missing API key" });
    return;
  }

  let createdBy: string | null;
  try {
    createdBy = await validateApiKey(apiKeyHeader);
  } catch {
    // Fail-loud on misconfiguration (missing/invalid API_KEY_HMAC_SECRET).
    // 500, NOT 401 — hiding misconfiguration as "invalid key" is a spoofing vector.
    res.status(500).json({ error: "Internal server error" });
    return;
  }

  if (!createdBy) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  const user = await getCachedUserWithRoles(createdBy);
  if (!user) {
    res.status(401).json({ error: "API key owner not found" });
    return;
  }

  req.userId = createdBy;
  req.user = user;
  next();
}