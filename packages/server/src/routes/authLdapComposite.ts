// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 193 (LDAP-01, D-13/D-15) — the community composite login route.
 *
 * This router is the SOLE deliverer of the D-13 local fallback. Mount order
 * (index.ts boot sequence) is the entire mechanism:
 *
 *   1. createApp() mounts community authRoutes        (BEFORE the plugins)
 *   2. loadEnterprisePlugin(app) mounts the enterprise LDAP login route
 *      (POST /api/auth/ldap/login) via ctx.mountPublic
 *   3. loadSaaSPlugin(app)
 *   4. THIS router — app.use("/api/auth", composite)  (AFTER the plugins,
 *      BEFORE mountCatchAlls)
 *   5. mountCatchAlls(app)                            (always last)
 *
 * One handler, one semantic per request — no double-handling is possible:
 *
 *  - Enterprise build: the enterprise LDAP route serves the request itself
 *    on every non-eligible arm. On fallback-eligible arms (stage `config`,
 *    `unreachable` or `bindFailure` with `ldapFallbackToLocal` true) it
 *    calls next() with NO response — the request falls through to THIS
 *    router, which serves local auth. When `ldapFallbackToLocal` is false
 *    the enterprise route answers the uniform 401 and never defers — this
 *    router structurally never sees the request.
 *  - Community build (no enterprise plugin): unmatched
 *    POST /api/auth/ldap/login requests reach this router directly. The
 *    SsoConfig row must report provider "ldap" (the operator pre-staged the
 *    LDAP config in community mode); anything else (no row, saml/oidc
 *    provider) 404s { error: "Not found" } — preserving today's
 *    community-mode contract where the path is simply absent.
 *
 * Uniform responses (D-15): the response body NEVER reveals which path
 * served. Local-success returns { user, token } identical in shape to the
 * enterprise route's 200; local-fail returns 401 { error: "Invalid
 * credentials" } — the exact body authService.login throws. Which arm ran
 * is audit metadata ONLY (server-side logEvent, never a response field).
 *
 * The fallback arm NEVER replays credentials against a weaker path
 * (T-193-18): it delegates to the SAME bcrypt-validated local login
 * (authService.login) that POST /api/auth/login uses.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { login as localLogin } from "../services/authService";
import { authRateLimiter } from "../middleware/rateLimit";
import { logEvent } from "../services/eventLogService";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { ldapLoginSchema } from "@simmetric-chat/shared";

// The uniform local-failure body — byte-identical to POST /login's 401 and
// to the enterprise route's D-15 LDAP_UNIFORM_FAILURE. One body for every
// failure arm (D-15: no user-existence enumeration, no stage disclosure).
const LOCAL_FALLBACK_FAILURE = "Invalid credentials";

/**
 * Router factory. Deliberately dependency-free (the community side has no
 * plugin ctx here — it reads the singleton prisma + local services directly),
 * exported so index.ts mounts it and the test suite can mount it behind a
 * mock enterprise router that mimics the defer-then-serve contract.
 */
export function createAuthLdapCompositeRouter(): Router {
  const router = Router();

  // POST /api/auth/ldap/login — the composite arm.
  // authRateLimiter PRECEDES the handler (the community brute-force surface
  // precedent — mirrors POST /login; 10/min prod per IP, memory/Redis store).
  router.post(
    "/ldap/login",
    authRateLimiter,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      // Route-level safeParse — invalid body is 400 { error, details },
      // byte-identical to POST /login's G-4 arm (never a 401 with a raw
      // Zod message).
      const parsed = ldapLoginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }
      const { username, password } = parsed.data;

      // Community-mode contract gate: this route only exists as a serving
      // arm when the SsoConfig row reports provider "ldap". In a community
      // build the operator pre-stages the LDAP config in the DB (the panel
      // row) — the local-auth arm is the ONLY arm that can ever answer here.
      // Anything else (no row / saml / oidc) 404s like today: the path is
      // simply not a thing in this build. Keyed on provider alone (the
      // enterprise resolver never reads `enabled` — the same row must behave
      // identically in both builds).
      let provider: string | null = null;
      try {
        const config = await prisma.ssoConfig.findFirst();
        provider = config?.provider ?? null;
      } catch (err: unknown) {
        // DB read failure must NOT turn into a 500 that leaks the composite
        // path's existence in an enterprise build — degrade to the 404 arm
        // (structurally indistinguishable from "not staged").
        logger.warn("[authLdapComposite] SsoConfig read failed — 404 arm", {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(404).json({ error: "Not found" });
        return;
      }

      if (provider !== "ldap") {
        res.status(404).json({ error: "Not found" });
        return;
      }

      // Deferred (enterprise build, fallbackToLocal true) or community
      // staged-provider request: serve LOCAL auth. ldapFallbackToLocal needs
      // NO re-check here — false means the enterprise route answered the
      // uniform 401 and never deferred, so the request structurally cannot
      // arrive (true means the defer arrived, or a community build staged
      // the provider deliberately).
      try {
        const result = await localLogin({ username, password });
        // D-15 uniformity: { user, token } identical in shape to the
        // enterprise route's 200 — no servedBy/fallback marker, ever.
        res.json({ user: result.user, token: result.token });
        return;
      } catch {
        // Local auth failed: audit server-side ONLY (the body is the same
        // uniform 401 for every failure arm — D-15). Metadata names the
        // stage + the serving path for the audit trail; the response never
        // reveals which path served (prohibition: no fallback badge).
        logEvent("user", username, "ldap.login.failed", null, {
          stage: "localFallback",
          servedBy: "local",
        }).catch(() => {
          // log-only failure arm — never blocks the response
        });
        res.status(401).json({ error: LOCAL_FALLBACK_FAILURE });
        return;
      }
    },
  );

  return router;
}