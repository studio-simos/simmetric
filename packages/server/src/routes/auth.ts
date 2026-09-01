// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router } from "express";
import bcrypt from "bcryptjs";
import { register, login, invalidateAuthCache, verifyToken, getCachedUserWithRoles } from "../services/authService";
import { isTokenRevoked } from "../services/tokenRevocation";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin } from "../middleware/rbac";
import { authRateLimiter } from "../middleware/rateLimit";
import { getEnv } from "../config/env";
import {
  adminRegisterSchema,
  adminResetPasswordSchema,
  changePasswordSchema,
  loginSchema,
  setInitialPasswordSchema,
  getOidcProviderFromDiscoveryUrl,
} from "@simmetric-chat/shared";
import prisma from "../utils/prisma";
import { isAdmin } from "../utils/auth";
// Phase 143 (EPA-03): `services/ssoService.ts` + `services/oidcClient.ts`
// moved to the enterprise package (Plans 01 + 02). The community
// `/api/auth/sso/status` endpoint stays in community (public, no auth — the
// LoginPage reads it to decide whether to show the SSO button). It inlines
// `getSsoConfig` as a thin wrapper over `prisma.ssoConfig.findFirst()`
// (returns SsoConfigResponse | null) and imports `getOidcProviderFromDiscoveryUrl`
// from `@simmetric-chat/shared` (Plan 03 — single source of truth; the pure
// string-match function lives in the shared kernel, same precedent as
// `normalizeSource()` in types/index.ts).

const router = Router();

// ─── Phase 143 inlined helper (ssoService moved to enterprise) ──

/**
 * Inlined replica of `getSsoConfig` (was in `services/ssoService.ts`, which
 * moved to the enterprise package in Plan 02 — `saveSsoConfig` +
 * `testSsoConnection` move; `getSsoConfig` stays in community via this inline).
 * Returns the singleton SsoConfig (first record) with the encrypted client
 * secret NEVER exposed (only a `clientSecretConfigured` boolean, T-113-01-01).
 * Returns null when no config exists.
 *
 * D-07 guard note (RESEARCH Finding 3 — Plan 03 finalized): the guard
 * `if (!prisma.ssoConfig)` would NEVER trigger, because `schema-enterprise.prisma`
 * lives in the COMMUNITY `prisma/` dir (Phase 141 verdict (a) — D-04). The
 * `prismaSchemaFolder` feature (GA in 7.9.1, directory mode in `prisma.config.ts`
 * per Phase 142 D-08) merges that fragment with `schema.prisma` at
 * `prisma generate` time, so the generated client ALWAYS has the
 * `prisma.ssoConfig` delegate — even in a pure community build with NO
 * enterprise plugin loaded. The real community code path is the empty-table
 * path: `prisma.ssoConfig.findFirst()` returns `null` when no SsoConfig row
 * exists → the handler below returns the empty-shape response
 * `{ enabled: false, provider: null, oidcProvider: null }`. The guard is kept
 * as documentation of intent; the empty-table path is the actual behavior.
 *
 * Downgrade edge case (acceptable for Phase 143): a stale SsoConfig row left
 * in the DB after the enterprise plugin is removed → the LoginPage shows the
 * SSO button but `/api/auth/saml/*` + `/api/auth/oidc/*` return 404 in
 * community. Phase 147 reworks the frontend with proper conditional
 * lazy-loading of enterprise UI chunks.
 */
async function getSsoConfigInlined(): Promise<{
  id: string;
  provider: "saml" | "oidc";
  enabled: boolean;
  clientId: string | null;
  discoveryUrl: string | null;
  entryPoint: string | null;
  cert: string | null;
  entityId: string | null;
  redirectUri: string | null;
  createdAt: string;
  updatedAt: string;
  clientSecretConfigured: boolean;
} | null> {
  const config = await prisma.ssoConfig.findFirst();
  if (!config) return null;

  return {
    id: config.id,
    provider: config.provider as "saml" | "oidc",
    enabled: config.enabled,
    clientId: config.clientId,
    discoveryUrl: config.discoveryUrl,
    entryPoint: config.entryPoint,
    cert: config.cert,
    entityId: config.entityId,
    redirectUri: config.redirectUri,
    createdAt: config.createdAt.toISOString(),
    updatedAt: config.updatedAt.toISOString(),
    clientSecretConfigured: !!config.clientSecretEncrypted,
  };
}

/**
 * @openapi
 * /auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Register a new user
 *     description: Open registration when ALLOW_REGISTRATION=true, otherwise admin-only via Bearer token.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, email, password]
 *             properties:
 *               username: { type: string, example: jdoe }
 *               email: { type: string, format: email, example: jdoe@example.com }
 *               password: { type: string, format: password, minLength: 8 }
 *     responses:
 *       201: { description: User created }
 *       400: { description: Validation error }
 *       403: { description: Registration disabled }
 */
// POST /api/auth/register — open when ALLOW_REGISTRATION=true, admin-only otherwise
router.post("/register", authRateLimiter, async (req, res) => {
  const env = getEnv();

  if (!env.ALLOW_REGISTRATION) {
    // Registration is closed — require admin auth. The 403-not-401 for a
    // missing header is deliberate UX: it tells the frontend "registration
    // is disabled" instead of "your token is bad" (informative contract).
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(403).json({ error: "Registration is disabled. Only admins can create users." });
      return;
    }

    try {
      const token = authHeader.substring(7); // safe: startsWith("Bearer ") passed above
      const payload = verifyToken(token);
      // TEC-03b: a revoked admin token must not mint users (privilege-escalation
      // surface). The `payload.jti &&` guard keeps pre-deploy tokens working (D-04).
      if (payload.jti && (await isTokenRevoked(payload.jti))) {
        res.status(401).json({ error: "Token revoked" });
        return;
      }
      const user = await getCachedUserWithRoles(payload.userId);

      if (!user) {
        res.status(401).json({ error: "Invalid token" });
        return;
      }

      if (!isAdmin(user)) {
        res.status(403).json({ error: "Only admins can create users when registration is disabled" });
        return;
      }
    } catch {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
  }

  try {
    const result = await register(req.body);
    res.status(201).json(result);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// POST /api/auth/admin-register — admin-only user creation (always requires auth)
router.post("/admin-register", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const parsed = adminRegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }

    const { username, email, password, role } = parsed.data;
    const result = await register({ username, email, password });

    // If a specific role was requested, assign it
    if (role && role !== "user") {
      const targetRole = await prisma.role.findFirst({ where: { name: role } });
      if (targetRole) {
        // Remove default user role assignment and add the requested role
        const defaultUserRole = await prisma.role.findFirst({ where: { name: "user", isDefault: true } });
        if (defaultUserRole) {
          await prisma.userRole.deleteMany({
            where: { userId: result.user.id, roleId: defaultUserRole.id },
          });
        }
        await prisma.userRole.create({
          data: { userId: result.user.id, roleId: targetRole.id },
        });
      }
    }

    res.status(201).json(result);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Login and obtain JWT token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username: { type: string, example: jdoe }
 *               password: { type: string, format: password }
 *     responses:
 *       200:
 *         description: JWT token and user info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token: { type: string }
 *                 user: { type: object }
 *       401: { description: Invalid credentials }
 */
// POST /api/auth/login
router.post("/login", authRateLimiter, async (req, res) => {
  // G-4 (T-DRD-04): route-level safeParse — an invalid body is a 400
  // { error, details } like every other auth route, NOT a 401 with a raw
  // Zod message leaked from the service-level parse (which stays as inner
  // defense for direct service callers).
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const result = await login(parsed.data);
    res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(401).json({ error: message });
  }
});

/**
 * @openapi
 * /auth/sso/status:
 *   get:
 *     tags: [Auth]
 *     summary: Public SSO availability status (no auth required)
 *     description: >
 *       Lets the unauthenticated login page discover whether SSO is enabled
 *       and which provider is configured. Returns booleans/enums ONLY —
 *       never clientId, discoveryUrl, cert, entityId, redirectUri, or any
 *       secret (T-260808-p5y-01). The admin-gated GET /api/sso/config remains
 *       the only source of configuration details.
 *     responses:
 *       200:
 *         description: SSO status (public)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled: { type: boolean }
 *                 provider: { type: string, enum: [saml, oidc], nullable: true }
 *                 oidcProvider: { type: string, enum: [google, github, microsoft, oidc], nullable: true }
 *       500: { description: Internal server error }
 */
// GET /api/auth/sso/status — public SSO availability for the login page.
// NO authMiddleware / requireAdmin / requireFeature: the frontend already
// gates the button on useFeature("sso_enabled") via the public license info.
// Phase 143: getSsoConfig + getOidcProviderFromDiscoveryUrl inlined above
// (ssoService.ts + oidcClient.ts move to the enterprise package).
//
// Env-over-DB (260817-kfi): when OIDC_* env vars are set, the env layer is
// active and overrides the DB SsoConfig row for this response. The response
// shape stays identical to ssoStatusResponseSchema — booleans/enums ONLY,
// never clientId/discoveryUrl/secret (T-260808-p5y-01). When no OIDC_* env
// vars are set, the existing DB-only fallthrough runs unchanged (additive).
router.get("/sso/status", async (_req, res) => {
  try {
    const env = getEnv();
    const envOidcActive =
      env.OIDC_ENABLED !== undefined ||
      !!env.OIDC_CLIENT_ID ||
      !!env.OIDC_DISCOVERY_URL ||
      !!env.OIDC_PROVIDER;

    if (envOidcActive) {
      // Env-driven OIDC: read the DB row only to fall back on its enabled
      // flag / discoveryUrl when the corresponding env var is unset. The env
      // layer is the source of truth; DB fills the gaps.
      const dbConfig = await prisma.ssoConfig.findFirst();
      const enabled =
        env.OIDC_ENABLED ??
        (dbConfig?.provider === "oidc" && dbConfig.enabled) ??
        false;
      const oidcProvider =
        env.OIDC_PROVIDER && env.OIDC_PROVIDER !== "oidc"
          ? env.OIDC_PROVIDER
          : getOidcProviderFromDiscoveryUrl(
              env.OIDC_DISCOVERY_URL ?? dbConfig?.discoveryUrl ?? null,
            );
      res.json({
        enabled,
        provider: "oidc" as const,
        oidcProvider: enabled ? oidcProvider : null,
      });
      return;
    }

    // DB-only fallthrough (env unset) — pre-existing behavior, unchanged.
    const config = await getSsoConfigInlined();
    if (!config) {
      // Mirror the empty-shape convention at sso.ts:65.
      res.json({ enabled: false, provider: null, oidcProvider: null });
      return;
    }
    res.json({
      enabled: config.enabled,
      provider: config.provider,
      oidcProvider:
        config.provider === "oidc" && config.enabled
          ? getOidcProviderFromDiscoveryUrl(config.discoveryUrl)
          : null,
    });
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Get current authenticated user
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Current user with roles and permissions
 *       401: { description: Missing or invalid token }
 */
// GET /api/auth/me — get current user with roles/permissions
router.get("/me", authMiddleware, async (req, res) => {
  const user = req.user!;
  const permissions = new Set<string>();

  for (const userRole of user.roles) {
    for (const rp of userRole.role.permissions) {
      permissions.add(rp.permissionName);
    }
  }

  res.json({
    id: user.id,
    username: user.username,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    avatar: user.avatar,
    customInstructions: user.customInstructions,
    textSize: user.textSize,
    mustChangePassword: user.mustChangePassword,
    roles: user.roles.map((ur) => ({
      id: ur.role.id,
      name: ur.role.name,
      isDefault: ur.role.isDefault,
    })),
    permissions: Array.from(permissions),
  });
});

// GET /api/auth/users — list all users (admin only)
router.get("/users", authMiddleware, requireAdmin, async (_req, res) => {
  try {
    const users = await prisma.user.findMany({
      include: {
        roles: {
          include: {
            role: {
              include: {
                permissions: { include: { permission: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const result = users.map((user) => {
      const permissions = new Set<string>();
      for (const userRole of user.roles) {
        for (const rp of userRole.role.permissions) {
          permissions.add(rp.permissionName);
        }
      }
      return {
        id: user.id,
        username: user.username,
        email: user.email,
        createdAt: user.createdAt,
        roles: user.roles.map((ur) => ({
          id: ur.role.id,
          name: ur.role.name,
          isDefault: ur.role.isDefault,
        })),
        permissions: Array.from(permissions),
      };
    });

    res.json(result);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /api/auth/change-password — change own password (requires current password)
router.post("/change-password", authMiddleware, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const { currentPassword, newPassword } = parsed.data;
  const userId = req.userId!;

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const passwordValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!passwordValid) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    const SALT_ROUNDS = 12;
    const salt = await bcrypt.genSalt(SALT_ROUNDS);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash, salt },
    });

    // T-104-01: invalidate auth cache on password change
    invalidateAuthCache(userId).catch(() => {});

    res.json({ message: "Password changed successfully" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * @openapi
 * /auth/set-initial-password:
 *   post:
 *     tags: [Auth]
 *     summary: Set a new password during the forced first-login change
 *     description: >
 *       Authenticated endpoint (no current password required) used by users whose
 *       account has mustChangePassword=true. Saves the new password hash and clears
 *       the flag atomically in a single update.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [newPassword]
 *             properties:
 *               newPassword: { type: string, format: password, minLength: 8 }
 *     responses:
 *       200: { description: Password set successfully }
 *       400: { description: Validation error }
 *       401: { description: Missing or invalid token }
 *       404: { description: User not found }
 */
// POST /api/auth/set-initial-password — set new password + clear mustChangePassword flag atomically
router.post("/set-initial-password", authMiddleware, async (req, res) => {
  const parsed = setInitialPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const { newPassword } = parsed.data;
  const userId = req.userId!;

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Security: this endpoint bypasses the current-password check, so it must
    // only be usable during a forced first-login rotation. Once the flag is
    // cleared, password changes must go through /change-password (which verifies
    // the current password). Without this gate, a stolen session token alone
    // would be enough to take over the account.
    if (!user.mustChangePassword) {
      res.status(403).json({ error: "This endpoint is only available when a password change is required" });
      return;
    }

    const SALT_ROUNDS = 12;
    const salt = await bcrypt.genSalt(SALT_ROUNDS);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    // Persist the new hash AND clear the forced-change flag in one update (T-v4e-02).
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash, salt, mustChangePassword: false },
    });

    // T-104-01: invalidate auth cache on password change
    invalidateAuthCache(userId).catch(() => {});

    res.json({ message: "Password set successfully" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /api/auth/admin-reset-password — admin resets a user's password
router.post("/admin-reset-password", authMiddleware, requireAdmin, async (req, res) => {
  // G-6 (T-DRD-05): shared adminResetPasswordSchema (safeParse) replaces the
  // ad-hoc destructure + manual length check — no unvalidated field reaches
  // Prisma, and the error shape matches the { error, details } convention.
  const parsed = adminResetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const { userId, newPassword } = parsed.data;

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const SALT_ROUNDS = 12;
    const salt = await bcrypt.genSalt(SALT_ROUNDS);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash, salt },
    });

    // T-104-01: invalidate auth cache on password reset
    invalidateAuthCache(userId).catch(() => {});

    res.json({ message: "Password reset successfully" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

export default router;