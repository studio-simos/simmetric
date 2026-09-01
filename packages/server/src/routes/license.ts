// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { getEnv, ENV_PATH } from "../config/env";
import { verifyLicenseKey, getLicenseInfo, LICENSE_PUBLIC_KEY } from "../services/licenseService";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin } from "../middleware/rbac";

const router = Router();

// GET /api/license/info — returns current license state for frontend
router.get("/info", (_req: Request, res: Response) => {
  const info = getLicenseInfo();
  res.json(info);
});

/**
 * LIC-02 (D-01): local redaction helper — the mechanical guarantee behind the
 * canary-absence test. Stringifies the response body and replaces every
 * occurrence of the configured LICENSE_KEY with the literal "[REDACTED]" so a
 * secret substring can never leak into the JSON response. Route-local per
 * D-01 discretion (do NOT lift to a shared util).
 */
function redactSecret(body: unknown): unknown {
  const env = getEnv();
  const secrets: string[] = [];
  if (typeof env.LICENSE_KEY === "string" && env.LICENSE_KEY.length > 0) {
    secrets.push(env.LICENSE_KEY);
  }
  if (secrets.length === 0) return body;

  let serialized = JSON.stringify(body);
  for (const secret of secrets) {
    serialized = serialized.split(secret).join("[REDACTED]");
  }
  return JSON.parse(serialized);
}

// GET /api/license/diagnose — admin-only license diagnostics (LIC-02, D-01).
// Per-route middleware (NOT router.use — GET /info stays unauthenticated).
// OQ2 resolution: the verdict comes from a DIRECT call to the shared
// verifyLicenseKey (the same code path initLicense delegates to) — the closed
// reason source; getLicenseInfo() supplies the cached tier. jwt.decode is
// display-only for structural booleans — the decoded payload is NEVER
// serialized into the response.
router.get("/diagnose", authMiddleware, requireAdmin, (_req: Request, res: Response) => {
  const env = getEnv();
  const verdict = verifyLicenseKey(env.LICENSE_KEY, LICENSE_PUBLIC_KEY);
  const info = getLicenseInfo();

  // Pitfall 8: jwt.decode(null/undefined/garbage) returns null, never throws —
  // but guard on the env type anyway. Derive ONLY structural booleans.
  let isJwt = false;
  let hasExp = false;
  if (typeof env.LICENSE_KEY === "string") {
    const decoded = jwt.decode(env.LICENSE_KEY);
    isJwt = decoded !== null && typeof decoded === "object" && !Array.isArray(decoded);
    hasExp = isJwt && "exp" in (decoded as object);
  }

  const body = {
    tier: info.tier,
    licensee: info.licensee,
    expiresAt: info.expiresAt,
    reason: verdict.ok ? "ok" : verdict.reason,
    env: {
      licenseKeyPresent: Boolean(env.LICENSE_KEY),
      licensePublicKeyPresent: true, // embedded by default; always available
      envPath: ENV_PATH,
    },
    cachedTier: info.tier,
    jwt: { isJwt, hasExp },
  };

  res.json(redactSecret(body));
});

export default router;
