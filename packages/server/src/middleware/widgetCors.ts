// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { type Request, type Response, type NextFunction } from "express";
import prisma from "../utils/prisma";

const ALLOWED_METHODS = "GET, POST, PATCH, OPTIONS";
const ALLOWED_HEADERS = "Content-Type, Authorization, X-Api-Key, X-Widget-Session";
const MAX_AGE = "86400"; // 24 hours preflight cache

/**
 * Dynamic CORS middleware for widget embed routes.
 *
 * Reads the Origin header, looks up which widgets allow that origin,
 * and responds with the specific origin (never a wildcard).
 *
 * For preflight (OPTIONS) requests: responds immediately with 204.
 * For actual requests: sets per-origin CORS headers and calls next().
 */
export async function widgetCors(req: Request, res: Response, next: NextFunction): Promise<void> {
  const origin = req.headers.origin;

  // No origin header = not a browser request (curl, server-to-server) — skip CORS
  if (!origin) {
    next();
    return;
  }

  try {
    // Check if any widget allows this origin
    // allowedOrigins is a JSON-encoded string array, e.g. '["http://localhost:3000","https://example.com"]'
    const widgets = await prisma.widget.findMany({
      where: { deletedAt: null, isActive: true },
      select: { allowedOrigins: true },
    });

    const isOriginAllowed = widgets.some((w) => {
      if (!w.allowedOrigins) return false;
      try {
        const origins: string[] = JSON.parse(w.allowedOrigins);
        return origins.includes(origin);
      } catch {
        return false;
      }
    });

    if (!isOriginAllowed) {
      if (req.method === "OPTIONS") {
        res.status(403).json({ error: "Origin not allowed" });
        return;
      }
      // Non-preflight from disallowed origin: proceed without CORS headers.
      // Browser will block the response, which is the safe default.
      next();
      return;
    }

    // Origin is allowed — set per-origin CORS headers
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
    res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Max-Age", MAX_AGE);

    // Respond to preflight immediately
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  } catch {
    // On DB error, fall through without CORS headers — browser will block
    // which is the safe default (fail-closed).
    next();
  }
}