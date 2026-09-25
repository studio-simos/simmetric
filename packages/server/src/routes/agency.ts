// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 206 (AGENCY-01, D-07): web-agency sub-user routes.
// Chain order auth → tenant → permission (roles.ts:21-28 idiom). Gated on
// requirePermission("agency:users:manage") — deliberately NOT requireAdmin
// (that would exclude the exact audience this phase creates; D-07).
// Cross-sponsor fetches resolve to 404 (D-04/SC-1) — never 403.

import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import { tenantContextMiddleware } from "../middleware/tenantContext";
import { requirePermission } from "../middleware/rbac";
import {
  createSubUserSchema,
  resetSubUserPasswordSchema,
  permissionNameSchema,
} from "@simmetric-chat/shared";
import {
  AgencyError,
  createSubUser,
  getSubUser,
  listSubUsers,
  getSponsorCeiling,
  listDelegatablePermissions,
  replaceSubUserPermissions,
  setSubUserDisabled,
  resetSubUserPassword,
} from "../services/agencyUserService";
import { logEvent } from "../services/eventLogService";
import prisma from "../utils/prisma";

const router = Router();

router.use(authMiddleware);
router.use(tenantContextMiddleware);

/**
 * @openapi
 * /agency/users:
 *   post:
 *     tags: [Agency]
 *     summary: Create a sub-user (sponsor-scoped, ceiling-enforced)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateSubUserInput'
 */
router.post("/users", requirePermission("agency:users:manage"), async (req, res) => {
  try {
    const parsed = createSubUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const actorId = req.userId!;
    const result = await createSubUser(actorId, parsed.data, req.organizationId ?? null);
    logEvent("user", result.user.id, "subuser.created", actorId, {
      organizationId: req.organizationId ?? null,
    }).catch(() => {});
    res.status(201).json(result);
  } catch (err: unknown) {
    if (err instanceof AgencyError) {
      res.status(err.status).json(err.payload);
      return;
    }
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * @openapi
 * /agency/ceiling:
 *   get:
 *     tags: [Agency]
 *     summary: Remaining sub-user allowance (max/active/remaining)
 */
router.get("/ceiling", requirePermission("agency:users:manage"), async (req, res) => {
  try {
    res.json(await getSponsorCeiling(req.userId!));
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * @openapi
 * /agency/delegatable-permissions:
 *   get:
 *     tags: [Agency]
 *     summary: Permissions the agency may delegate (effective minus denylist)
 */
router.get(
  "/delegatable-permissions",
  requirePermission("agency:users:manage"),
  async (req, res) => {
    try {
      res.json({ permissions: await listDelegatablePermissions(req.userId!) });
    } catch (err: unknown) {
      if (err instanceof AgencyError) {
        res.status(err.status).json(err.payload);
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

/**
 * @openapi
 * /agency/users/{id}/permissions:
 *   put:
 *     tags: [Agency]
 *     summary: Replace a sub-user's delegated permissions (lattice-validated, full-replace)
 */
router.put(
  "/users/:id/permissions",
  requirePermission("agency:users:manage"),
  async (req, res) => {
    try {
      const bodySchema = permissionNameSchema;
      const body = req.body as { permissions?: unknown };
      if (!Array.isArray(body.permissions)) {
        res.status(400).json({ error: "permissions array required" });
        return;
      }
      const grants: string[] = [];
      for (const entry of body.permissions) {
        const parsed = permissionNameSchema.safeParse(entry);
        if (!parsed.success) {
          res.status(400).json({ error: "Unknown permission in grant set" });
          return;
        }
        grants.push(parsed.data);
      }
      const actorId = req.userId!;
      const count = await replaceSubUserPermissions(actorId, req.params.id as string, grants);
      logEvent("user", req.params.id as string, "subuser.permissions.updated", actorId, {
        count,
      }).catch(() => {});
      res.json({ count });
    } catch (err: unknown) {
      if (err instanceof AgencyError) {
        res.status(err.status).json(err.payload);
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

/**
 * @openapi
 * /agency/users/{id}/disable:
 *   post:
 *     tags: [Agency]
 *     summary: Disable a sub-user (fail-closed lifecycle, D-05)
 */
router.post(
  "/users/:id/disable",
  requirePermission("agency:users:manage"),
  async (req, res) => {
    try {
      const result = await setSubUserDisabled(req.userId!, req.params.id as string, true);
      logEvent("user", result.id, "subuser.disabled", req.userId!, {}).catch(() => {});
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof AgencyError) {
        res.status(err.status).json(err.payload);
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

/**
 * @openapi
 * /agency/users/{id}/enable:
 *   post:
 *     tags: [Agency]
 *     summary: Re-enable a disabled sub-user
 */
router.post(
  "/users/:id/enable",
  requirePermission("agency:users:manage"),
  async (req, res) => {
    try {
      const result = await setSubUserDisabled(req.userId!, req.params.id as string, false);
      logEvent("user", result.id, "subuser.enabled", req.userId!, {}).catch(() => {});
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof AgencyError) {
        res.status(err.status).json(err.payload);
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

/**
 * @openapi
 * /agency/users/{id}/reset-password:
 *   post:
 *     tags: [Agency]
 *     summary: Agency password reset — temp password returned once (D-06)
 */
router.post(
  "/users/:id/reset-password",
  requirePermission("agency:users:manage"),
  async (req, res) => {
    try {
      const result = await resetSubUserPassword(req.userId!, req.params.id as string);
      logEvent("user", req.params.id as string, "subuser.password.reset", req.userId!, {}).catch(() => {});
      // D-06: the temp password rides the response EXACTLY ONCE and is never
      // logged (secret discipline — log key names, never values).
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof AgencyError) {
        res.status(err.status).json(err.payload);
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

/**
 * @openapi
 * /agency/users:
 *   get:
 *     tags: [Agency]
 *     summary: List the actor's own sub-users (sponsorship-scoped)
 */
router.get("/users", requirePermission("agency:users:manage"), async (req, res) => {
  try {
    const users = await listSubUsers(req.userId!);
    res.json({ users });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * @openapi
 * /agency/users/{id}:
 *   get:
 *     tags: [Agency]
 *     summary: Fetch a sub-user (sponsorship-scoped; foreign id → 404)
 */
router.get("/users/:id", requirePermission("agency:users:manage"), async (req, res) => {
  try {
    const user = await getSubUser(req.userId!, req.params.id as string);
    if (!user) {
      // D-04/SC-1: foreign/not-owned → 404 (never 403 — existence leak).
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ user });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;