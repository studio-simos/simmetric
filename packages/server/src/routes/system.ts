// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import axios from "axios";
import { Prisma } from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client-runtime-utils";
import { initializeSchema } from "@simmetric-chat/shared";
import type { SetConfigInput, ConfigKey } from "@simmetric-chat/shared";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { getSetting } from "../services/systemConfigService";
import { getEnv } from "../config/env";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin } from "../middleware/rbac";
import { probeRateLimiter } from "../middleware/rateLimit";
import { assertSafeProbeUrl } from "../utils/ssrfGuard";
import { getRedis } from "../services/redisService";
import { prewarmModel } from "../ocr/prewarm";
import { MULTI_CONFIG_TSVECTOR } from "../services/ftsService";
import { parseMetadata } from "../utils/parseMetadata";

const router = Router();

const SALT_ROUNDS = 12;

async function isInitialized(): Promise<boolean> {
  const adminRole = await prisma.role.findFirst({ where: { name: "admin" } });
  if (!adminRole) return false;

  const adminCount = await prisma.userRole.count({
    where: { roleId: adminRole.id },
  });
  return adminCount > 0;
}

// GET /api/system/is-initialized — check if system has an admin user
router.get("/is-initialized", async (_req: Request, res: Response) => {
  try {
    const initialized = await isInitialized();
    // Phase 152 (WIZ-02, D-04): expose setup_wizard_mode so the frontend can
    // branch wizard-vs-login without a second round-trip. Default to "active"
    // when the row is unset/empty (pre-152 install / missing seed / cache miss)
    // so a fresh-install user always sees the wizard — the wizard owns admin
    // creation on fresh install (D-04). A wrong "completed" default here
    // independently suppresses the wizard even after the G-152-1 Redis fix; this
    // flip is the defense-in-depth second layer. Existing installs have a
    // non-empty "completed" row so the fallback is never hit for them.
    const mode = await getSetting("setup_wizard_mode");
    const setupWizardMode = mode.value || "active";
    res.json({ initialized, setupWizardMode });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /api/system/initialize — first-launch setup (only when setup_wizard_mode=active)
//
// Phase 152 gap G-152-3 (CR-02): the admin creation + role + config + mode-
// flip run inside a single prisma.$transaction (Serializable isolation,
// 10s timeout). The OUTER fast-path 404 gate (mode !== "active") and the
// safeParse/400 + isInitialized/409 + existingUser/409 stay as cheap pre-
// filters; the INNER re-check inside the transaction is the race-safe
// authority. MODE-FLIP-FIRST: setup_wizard_mode flips to "completed" INSIDE
// the transaction, BEFORE the JWT is issued — the D-10 404 gate arms the
// instant the transaction commits. The race-loser's P2034 serialization-
// failure (the winner's mode-flip aborted it) is mapped to 409
// "System is already initialized" (Warning 1) — never 500. Post-commit the
// Redis cache is invalidated (G-152-1 invariant preserved, non-blocking).
router.post("/initialize", async (req: Request, res: Response) => {
  // Sentinels thrown INSIDE the transaction to signal non-error 404/409
  // outcomes. The outer catch maps these to their status codes BEFORE the
  // P2034 / generic-500 branches (ordering: sentinel-404 → sentinel-409 →
  // P2034-409 → generic-500). They carry no message — the catch block owns
  // the response body (Pitfall 4: the 404 body stays exactly
  // { error: "Not found" }).
  const GATE_NOT_ACTIVE = Symbol("GATE_NOT_ACTIVE");
  const ALREADY_INITIALIZED = Symbol("ALREADY_INITIALIZED");
  const EXISTING_USER = Symbol("EXISTING_USER");

  try {
    // OUTER fast-path 404 gate (D-10): the initialize endpoint is reachable
    // ONLY while setup_wizard_mode === "active". After the wizard completes
    // (mode → "completed") this gate returns 404 — closing the re-
    // initialization backdoor. The 404 body is exactly { error: "Not found" }
    // (Pitfall 4): indistinguishable from a missing route, no "already
    // initialized" hint, no details.
    //
    // SECURITY: this check runs BEFORE safeParse so an attacker probing a
    // completed endpoint gets a 404 with no body-validation feedback. The
    // INNER re-check inside the transaction (step 1 below) is the race-safe
    // authority — a concurrent winner that flipped the mode between this
    // outer read and the transaction's inner read is caught there.
    const wizardMode = await getSetting("setup_wizard_mode");
    if (wizardMode.value !== "active") {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // Validate input (400) before checking initialization (409) — these only
    // matter when the wizard IS active (a legitimate user).
    const parsed = initializeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    // OUTER fast-path isInitialized/409 and existingUser/409 — cheap pre-
    // filters that reject the common non-race cases without paying for a
    // transaction. The INNER re-check inside the transaction is the race-
    // safe authority.
    const initialized = await isInitialized();
    if (initialized) {
      res.status(409).json({ error: "System is already initialized" });
      return;
    }

    const { username, email, password, config } = parsed.data;

    const existingUser = await prisma.user.findFirst({
      where: { OR: [{ username }, { email }] },
    });
    if (existingUser) {
      res.status(409).json({ error: "Username or email already exists" });
      return;
    }

    // === Transaction-wrapped admin creation + role + config + mode-flip ===
    // Serializable isolation + mode-flip-first makes the race window zero:
    // the second concurrent request blocks on the row lock until the first
    // commits, then the inner re-check 404s it (or it aborts at commit with
    // P2034 → 409). bcrypt is computed INSIDE the transaction — acceptable
    // because the timeout (10s) bounds the wall-clock and the race we are
    // closing is the logical gate, not the bcrypt cost.
    const user = await prisma.$transaction(
      async (tx) => {
        // (1) Re-read setup_wizard_mode via tx — if not "active", a
        //     concurrent winner already flipped it. Throw GATE_NOT_ACTIVE
        //     → outer catch maps to 404 { error: "Not found" }.
        const modeRow = await tx.systemConfig.findUnique({
          where: { key: "setup_wizard_mode" },
        });
        if (!modeRow || modeRow.value !== "active") {
          throw GATE_NOT_ACTIVE;
        }

        // (2) Re-run isInitialized() via tx — if true, a concurrent winner
        //     already created an admin. Throw ALREADY_INITIALIZED → 409.
        const adminRole = await tx.role.findFirst({ where: { name: "admin" } });
        if (adminRole) {
          const adminCount = await tx.userRole.count({
            where: { roleId: adminRole.id },
          });
          if (adminCount > 0) {
            throw ALREADY_INITIALIZED;
          }
        }

        // (3) Re-run existingUser via tx — if present, throw EXISTING_USER → 409.
        const conflict = await tx.user.findFirst({
          where: { OR: [{ username }, { email }] },
        });
        if (conflict) {
          throw EXISTING_USER;
        }

        // (4) bcrypt salt + hash INSIDE the transaction (the Serializable
        //     isolation + mode-flip-first makes the race window zero even
        //     with bcrypt inside — the second concurrent request blocks on
        //     the row lock until the first commits).
        const salt = await bcrypt.genSalt(SALT_ROUNDS);
        const passwordHash = await bcrypt.hash(password, salt);

        // (5) tx.user.create with mustChangePassword: false. The inner re-
        //     check (step 1) already proved mode=active, so the WR-02
        //     dead-code ternary is removed — set false directly. The wizard
        //     IS the first password set (D-08).
        const created = await tx.user.create({
          data: { username, email, passwordHash, salt, mustChangePassword: false },
        });

        // (6) tx.userRole.create (admin role from step 2's adminRole lookup).
        if (adminRole) {
          await tx.userRole.create({
            data: { userId: created.id, roleId: adminRole.id },
          });
        }

        // (7) Save optional LLM/vector config via tx.systemConfig.upsert
        //     (mirror the existing updateSettings lines but against tx, and
        //     SKIP the updateSettings readOnly/validator/rejection path —
        //     those are user-PUT guards, not wizard-internal writes; the
        //     wizard is trusted boot-equivalent code writing known keys).
        if (config && Object.keys(config).length > 0) {
          const configs: SetConfigInput[] = Object.entries(config)
            .filter(([, value]) => value !== undefined && value !== "")
            .map(([key, value]) => ({ key: key as ConfigKey, value: String(value) }));
          for (const c of configs) {
            await tx.systemConfig.upsert({
              where: { key: c.key },
              create: { key: c.key, value: c.value },
              update: { value: c.value },
            });
          }
        }

        // (8) D-04: close self-service registration for this deployment.
        await tx.systemConfig.upsert({
          where: { key: "ALLOW_REGISTRATION" },
          create: { key: "ALLOW_REGISTRATION", value: "false" },
          update: { value: "false" },
        });

        // (9) MODE-FLIP-FIRST: tx.systemConfig.update setup_wizard_mode →
        //     "completed" INSIDE the transaction, BEFORE the JWT is issued.
        //     This arms the D-10 404 gate the INSTANT the transaction commits.
        //     A concurrent request that already passed the outer fast-path
        //     gate will hit the inner re-check (step 1) on its own
        //     transaction and 404 (or abort at commit with P2034 → 409).
        await tx.systemConfig.update({
          where: { key: "setup_wizard_mode" },
          data: { value: "completed" },
        });

        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10_000 },
    );

    // (10) Post-commit: invalidate the Redis cache for setup_wizard_mode
    //      (G-152-1 invariant — mirror updateSettings lines 239-245 + the
    //      ensureSetupWizardMode pattern in systemConfigService.ts). The
    //      CONFIG_CACHE_PREFIX constant is not exported from
    //      systemConfigService.ts, so hardcode "config:" inline with a
    //      comment referencing the constant (the G-152-1 precedent in
    //      ensureSetupWizardMode already hardcodes the key string in its
    //      DEL). Non-blocking on Redis error (the DB write already
    //      succeeded).
    const redis = getRedis();
    if (redis) {
      try {
        // "config:" is CONFIG_CACHE_PREFIX in systemConfigService.ts (not exported).
        await redis.del("config:setup_wizard_mode");
      } catch (err: unknown) {
        logger.warn("[redis] config cache invalidation failed (non-blocking)", {
          error: err instanceof Error ? err.message : String(err),
          key: "setup_wizard_mode",
        });
      }
    }

    logger.info(`[system] Initialized with admin user "${username}"`);

    // (11) AFTER tx + Redis invalidation: generate the JWT (routed through
    //      generateToken so the D-02 jti invariant holds by construction).
    const { generateToken } = await import("../services/authService");
    const token = generateToken(user.id);

    // Fetch roles and permissions for the response via the outer prisma
    // singleton (read-only, post-commit). Reuse the tx.user.create result's
    // user.id/username/email/mustChangePassword (avoid a redundant fetch).
    const userWithRoles = await prisma.user.findUnique({
      where: { id: user.id },
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
    });

    const permissions = new Set<string>();
    const roles: { id: string; name: string; isDefault: boolean }[] = [];
    if (userWithRoles) {
      for (const userRole of userWithRoles.roles) {
        roles.push({
          id: userRole.role.id,
          name: userRole.role.name,
          isDefault: userRole.role.isDefault,
        });
        for (const rp of userRole.role.permissions) {
          permissions.add(rp.permissionName);
        }
      }
    }

    res.status(201).json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        mustChangePassword: user.mustChangePassword,
        roles,
        permissions: Array.from(permissions),
      },
      token,
    });
  } catch (err: unknown) {
    // Mapping ordering: sentinel-404 → sentinel-409 → P2034-409 → generic-500.
    // The sentinels are thrown INSIDE the transaction to signal non-error
    // outcomes; map them BEFORE inspecting Prisma errors so a real Prisma
    // error is never swallowed as a 404/409.
    if (err === GATE_NOT_ACTIVE) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (err === ALREADY_INITIALIZED) {
      res.status(409).json({ error: "System is already initialized" });
      return;
    }
    if (err === EXISTING_USER) {
      res.status(409).json({ error: "Username or email already exists" });
      return;
    }
    // Warning 1: P2034 serialization-failure (the winner's mode-flip aborted
    // the loser's Serializable transaction at commit). The loser is
    // semantically "already initialized": the winner already flipped
    // setup_wizard_mode to "completed" — exactly the condition the inner
    // re-check (step 1) would have caught if the loser's transaction had
    // serialized after the winner's. Map to 409 (NOT 500) so the concurrent-
    // test assertion `results.filter(r => r.status === 500).length === 0`
    // passes and the unauthenticated caller gets a semantically correct
    // signal. The security invariant (one admin) already holds — the
    // loser's transaction rolled back.
    if (err instanceof PrismaClientKnownRequestError && err.code === "P2034") {
      res.status(409).json({ error: "System is already initialized" });
      return;
    }
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[system] Initialization failed", { error: message });
    res.status(500).json({ error: message });
  }
});

// Phase 152 (WIZ-01, D-06, RESEARCH OQ1) — public wizard-gated probe
// endpoints. Both are PUBLIC (no authMiddleware — the wizard runs before the
// user has a JWT) but wizard-gated: 404 { error: "Not found" } when
// setup_wizard_mode !== "active" (same D-10 hard-gate pattern as initialize).
// Failed probes are non-blocking (D-06): 200 with { ok: false, error } so the
// wizard can show the error but still let the user proceed.

// POST /api/system/probe-llm — list available models from the configured LLM
// provider. Reuses the existing provider model-availability logic (the
// Ollama /api/tags listing via getOllamaClient, and the OpenAI-compatible
// /v1/models path for openai/openrouter/anthropic). Returns model names only
// (no internal hostnames — RESEARCH threat register T-152-04).
//
// Phase 152 gap G-152-2 (CR-01): the probe is unauthenticated (wizard-gated
// only) and issues a server-side outbound request to an attacker-chosen
// baseUrl. assertSafeProbeUrl validates the URL BEFORE any outbound call
// (protocol allowlist + RFC1918/link-local/cloud-metadata/loopback block),
// and PINs the resolved IP into the outbound URL's hostname (DNS-rebinding
// defense, Warning 2). The probeRateLimiter caps the scan budget at 10/min
// (prod). Failure returns a generic "Could not reach the configured
// endpoint" — the detailed err.message stays in server logs only (no
// topology leak to the unauthenticated client).
router.post("/probe-llm", probeRateLimiter, async (req: Request, res: Response) => {
  try {
    // D-10 hard gate — same 404-when-completed pattern as initialize. Runs
    // before any body parsing so a completed-mode probe gets no feedback.
    const wizardMode = await getSetting("setup_wizard_mode");
    if (wizardMode.value !== "active") {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const { provider, baseUrl, apiKey } = req.body as {
      provider?: string;
      baseUrl?: string;
      apiKey?: string;
    };

    if (!provider || typeof provider !== "string") {
      res.status(400).json({ error: "provider is required" });
      return;
    }

    // Non-blocking probe: on any failure return 200 { ok: false, error }.
    try {
      let models: string[] = [];

      if (provider === "ollama") {
        const ollamaHost = baseUrl || "http://localhost:11434";
        // G-152-2 (CR-01): SSRF guard with allowLoopback=true so the local
        // Ollama default (http://localhost:11434) keeps working. The guard
        // rejects RFC1918/loopback-non-allowlisted/link-local/cloud-metadata
        // and PINS the resolved IP into the returned URL so the outbound
        // request does not re-resolve the hostname (DNS-rebinding defense).
        // Throwing is caught by the inner catch below and mapped to the
        // generic non-leaking error.
        const validated = await assertSafeProbeUrl(ollamaHost, {
          allowLoopback: true,
        });
        // Reuse the shared getOllamaClient factory (Phase 92-01). Short
        // timeout so an unreachable host fails fast (wizard UX). The pinned
        // validatedUrl.href is passed so getOllamaClient connects to the
        // validated IP directly (no re-resolution).
        const { getOllamaClient } = await import("../services/ollamaClient");
        const response = await getOllamaClient(validated.href, { timeoutMs: 5000 }).list();
        models = (response.models || []).map((m: { name: string }) => m.name);
      } else if (provider === "openai" || provider === "openrouter") {
        const base = (baseUrl || "https://api.openai.com").replace(/\/v1\/?$/, "");
        // G-152-2 (CR-01): SSRF guard, allowLoopback=false (remote-style).
        const validated = await assertSafeProbeUrl(base, { allowLoopback: false });
        const headers: Record<string, string> = {};
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        const modelsUrl = new URL("/v1/models", validated).href;
        const response = await axios.get(modelsUrl, {
          headers,
          timeout: 10000,
        });
        const data: Array<{ id: string }> = response.data?.data || [];
        models = data.map((m) => m.id);
      } else if (provider === "anthropic") {
        const base = baseUrl || "https://api.anthropic.com";
        if (!apiKey) {
          res.status(200).json({ ok: false, error: "API key required for Anthropic probe" });
          return;
        }
        // G-152-2 (CR-01): SSRF guard, allowLoopback=false (remote-style).
        const validated = await assertSafeProbeUrl(base, { allowLoopback: false });
        const modelsUrl = new URL("/v1/models", validated).href;
        const response = await axios.get(modelsUrl, {
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
          timeout: 10000,
        });
        const data: Array<{ id: string }> = response.data?.data || [];
        models = data.map((m) => m.id);
      } else {
        // IN-01: do not echo the input provider value back to the client.
        res.status(200).json({ ok: false, error: "Unsupported provider" });
        return;
      }

      // T-152-04: return model names only — no internal IPs/hostnames. The
      // user supplied the baseUrl; the response adds no new topology.
      res.status(200).json({ ok: true, models });
    } catch (err: unknown) {
      // G-152-2 (CR-01): generic non-leaking error to the unauthenticated
      // client; the detailed err.message is kept in server logs only so an
      // operator can diagnose, but the client gets no host/port/connection
      // topology signal (no err.message echo).
      logger.warn("[system] probe-llm failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(200).json({ ok: false, error: "Could not reach the configured endpoint" });
    }
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[system] probe-llm failed", { error: message });
    res.status(500).json({ error: message });
  }
});

// POST /api/system/probe-vector — health-check the configured vector DB.
// LanceDB (default, local) needs no network check → { ok: true }. Qdrant /
// Chroma get an HTTP ping to the configured URL. pgvector gets a lightweight
// Postgres connection check. Returns minimal info (no internal IPs — T-152-04).
//
// Phase 152 gap G-152-2 (CR-01): the probe is unauthenticated (wizard-gated
// only) and issues a server-side outbound HTTP request to an attacker-
// chosen url for qdrant/chroma and (optionally) a pgvector URL. The guard
// validates with allowLoopback=false (these are remote-style providers —
// the local loopback exception is reserved for the probe-llm Ollama
// default). The pinned IP is used for the outbound call (DNS-rebinding
// defense). Generic error + probeRateLimiter as above.
router.post("/probe-vector", probeRateLimiter, async (req: Request, res: Response) => {
  try {
    // D-10 hard gate — same 404-when-completed pattern as initialize.
    const wizardMode = await getSetting("setup_wizard_mode");
    if (wizardMode.value !== "active") {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const { provider, url } = req.body as { provider?: string; url?: string };

    if (!provider || typeof provider !== "string") {
      res.status(400).json({ error: "provider is required" });
      return;
    }

    // Non-blocking probe: on any failure return 200 { ok: false, error }.
    try {
      if (provider === "lancedb") {
        // LanceDB is local-disk — no network check needed. The wizard's
        // "Test connection" confirms the provider is selectable.
        res.status(200).json({ ok: true });
      } else if (provider === "qdrant") {
        if (!url) {
          res.status(200).json({ ok: false, error: "url is required for qdrant probe" });
          return;
        }
        // G-152-2 (CR-01): SSRF guard, allowLoopback=false (remote-style
        // provider — loopback is blocked, closing the SSRF pivot to
        // internal hosts on the qdrant/chroma port).
        const validated = await assertSafeProbeUrl(url, { allowLoopback: false });
        // Qdrant exposes GET /healthz. A simple GET to the root health
        // endpoint confirms reachability (pinned IP, no re-resolution).
        await axios.get(new URL("/healthz", validated).href, { timeout: 5000 });
        res.status(200).json({ ok: true });
      } else if (provider === "chroma") {
        if (!url) {
          res.status(200).json({ ok: false, error: "url is required for chroma probe" });
          return;
        }
        // G-152-2 (CR-01): SSRF guard, allowLoopback=false.
        const validated = await assertSafeProbeUrl(url, { allowLoopback: false });
        // Chroma exposes GET /api/v1/heartbeat (or /api/v2).
        await axios.get(new URL("/api/v1/heartbeat", validated).href, { timeout: 5000 });
        res.status(200).json({ ok: true });
      } else if (provider === "pgvector") {
        // pgvector uses the main DATABASE_URL — the server's prisma singleton
        // is already connected, so a trivial query confirms reachability.
        // If the caller supplied a `url` (testing an alternate pgvector
        // endpoint), validate it with the SSRF guard before opening a
        // short-lived pool — also closes WR-03's false-positive by testing
        // the SUPPLIED url (not the server's own DB).
        if (url) {
          const validated = await assertSafeProbeUrl(url, { allowLoopback: false });
          // Open a short-lived pool on the pinned IP and SELECT 1.
          const { Pool } = require("pg");
          const pool = new Pool({ connectionString: validated.href });
          try {
            await pool.query("SELECT 1");
          } finally {
            await pool.end();
          }
        } else {
          await prisma.$queryRaw`SELECT 1`;
        }
        res.status(200).json({ ok: true });
      } else {
        // IN-01: do not echo the input provider value.
        res.status(200).json({ ok: false, error: "Unsupported provider" });
      }
    } catch (err: unknown) {
      // G-152-2 (CR-01): generic non-leaking error; details to logs only.
      logger.warn("[system] probe-vector failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(200).json({ ok: false, error: "Could not reach the configured endpoint" });
    }
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[system] probe-vector failed", { error: message });
    res.status(500).json({ error: message });
  }
});

/**
 * @openapi
 * /system/reset-db:
 *   post:
 *     tags: [System]
 *     summary: Reset database (delete documents, chats, messages)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [confirm]
 *             properties:
 *               confirm:
 *                 type: string
 *                 description: Must be exactly "RESET" to confirm
 *     responses:
 *       200:
 *         description: Database reset completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid confirmation body
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Internal server error
 */
// POST /api/system/reset-db — reset database (admin only, requires confirmation)
router.post("/reset-db", authMiddleware, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { confirm } = req.body;
    if (confirm !== "RESET") {
      res.status(400).json({ error: "Invalid confirmation. Send { confirm: 'RESET' } to confirm database reset." });
      return;
    }

    await prisma.$transaction([
      prisma.document.deleteMany(),
      prisma.chat.deleteMany(),
      prisma.chatMessage.deleteMany(),
    ]);

    logger.info("[system] Database reset performed");

    res.json({ message: "Database reset completed" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[system] Database reset failed", { error: message });
    res.status(500).json({ error: message });
  }
});

/**
 * @openapi
 * /system/reindex-documents:
 *   post:
 *     tags: [System]
 *     summary: Rebuild PostgreSQL FTS index for all documents from vector DB
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 description: Optional — limit to a specific workspace
 *               documentIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Optional — limit to specific document IDs
 *     responses:
 *       200:
 *         description: Re-index results
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Admin access required
 */
// POST /api/system/reindex-documents — rebuild FTS index from vector DB (admin only)
router.post("/reindex-documents", authMiddleware, requireAdmin, async (req: Request, res: Response) => {
  const startTime = Date.now();
  let reindexed = 0;
  let skipped = 0;
  // Phase 151 (RAG-01, D-04): chunks whose INSERT populated searchVectorMulti
  // in this run. Pre-existing rows are covered by the startup backfill.
  let backfilledMulti = 0;
  const errors: string[] = [];

  try {
    const { workspaceId, documentIds } = req.body as { workspaceId?: string; documentIds?: string[] };

    // Find documents that are "completed" and don't have chunks in document_chunks yet
    const documentWhere: Record<string, unknown> = {
      status: "completed",
      deletedAt: null,
    };
    if (workspaceId) documentWhere.workspaceId = workspaceId;
    if (documentIds?.length) documentWhere.id = { in: documentIds };

    const documents = await prisma.document.findMany({
      where: documentWhere,
      select: { id: true, workspaceId: true, name: true },
    });

    logger.info(`[system] Re-indexing ${documents.length} documents`);

    for (const doc of documents) {
      try {
        // Check if chunks already exist in PostgreSQL
        // D-08/D-11 (TYP-02): typed $queryRaw row — the SELECT projects a single
        // `cnt` column (int). Field name matches the unquoted Postgres alias.
        interface ExistingChunkRow { cnt: number }
        const existingChunks: Array<ExistingChunkRow> = await prisma.$queryRaw<Array<ExistingChunkRow>>`
          SELECT COUNT(*)::int as cnt FROM "document_chunks" WHERE "documentId" = ${doc.id}
        `;
        if ((existingChunks[0]?.cnt ?? 0) > 0) {
          skipped++;
          continue;
        }

        // Fetch chunks from the collector (which reads from the configured vector DB)
        const env = getEnv();
        const collectorUrl = env.COLLECTOR_URL || "http://localhost:3210";
        const wsId = doc.workspaceId || "global";

        const response = await axios.get(
          `${collectorUrl}/api/ingest/chunks/${doc.id}`,
          { params: { workspaceId: wsId }, timeout: 30000 },
        );

        const chunks: { chunkIndex: number; chunkText: string; paragraph?: number; charStart?: number; charEnd?: number }[] =
          response.data?.chunks || [];

        if (chunks.length === 0) {
          logger.warn(`[system] No chunks in vector DB for document ${doc.id} (${doc.name})`);
          skipped++;
          continue;
        }

        // Insert chunks into PostgreSQL with searchVector + searchVectorMulti
        // (Phase 151 RAG-01: both columns populated in the same statement —
        // chunks reindexed here must not leave searchVectorMulti NULL).
        for (const chunk of chunks) {
          await prisma.$executeRaw`
            INSERT INTO "document_chunks" ("id", "documentId", "chunkText", "metadata", "embeddingId", "searchVector", "searchVectorMulti", "createdAt")
            VALUES (
              ${crypto.randomUUID()},
              ${doc.id},
              ${chunk.chunkText},
              ${JSON.stringify({ paragraph: chunk.paragraph, charStart: chunk.charStart, charEnd: chunk.charEnd })},
              ${`${doc.id}-${chunk.chunkIndex}`},
              to_tsvector('english', ${chunk.chunkText}),
              (SELECT ${Prisma.raw(MULTI_CONFIG_TSVECTOR)} FROM (SELECT ${chunk.chunkText}::text AS t) AS t),
              NOW()
            )
          `;
          backfilledMulti++;
        }

        reindexed++;
        logger.info(`[system] Re-indexed document ${doc.id} (${doc.name}): ${chunks.length} chunks`);
      } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
        const msg = `Document ${doc.id} (${doc.name}): ${message}`;
        errors.push(msg);
        logger.error(`[system] Re-index failed for ${doc.id}: ${message}`);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    res.json({
      reindexed,
      skipped,
      backfilledMulti,
      errors,
      totalDocuments: documents.length,
      durationSeconds: parseFloat(duration),
    });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[system] Re-index failed", { error: message });
    res.status(500).json({ error: message });
  }
});

/**
 * @openapi
 * /system/reembed-documents:
 *   post:
 *     tags: [System]
 *     summary: Re-embed all documents into the current vector DB
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 description: Optional — limit to a specific workspace
 *               documentIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Optional — limit to specific document IDs
 *     responses:
 *       200:
 *         description: Re-embed results (same shape as /system/reindex-documents)
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Admin access required
 */
router.post("/reembed-documents", authMiddleware, requireAdmin, async (req: Request, res: Response) => {
  const startTime = Date.now();
  let reindexed = 0;
  let skipped = 0;
  const errors: string[] = [];

  interface ReembedChunkRow {
    id: string;
    documentId: string;
    embeddingId: string;
    metadata: string;
    chunkText: string;
  }

  try {
    const { workspaceId, documentIds } = req.body as { workspaceId?: string; documentIds?: string[] };

    const documentWhere: Record<string, unknown> = {
      status: "completed",
      deletedAt: null,
    };
    if (workspaceId) documentWhere.workspaceId = workspaceId;
    if (documentIds?.length) documentWhere.id = { in: documentIds };

    const documents = await prisma.document.findMany({
      where: documentWhere,
      include: { workspace: { select: { name: true } } },
    });

    logger.info(`[system] Re-embedding ${documents.length} documents into current vector DB`);

    const env = getEnv();
    const collectorUrl = env.COLLECTOR_URL || "http://localhost:3210";

    for (const doc of documents) {
      try {
        const rawChunks = await prisma.$queryRaw<ReembedChunkRow[]>`
          SELECT id, "documentId", "embeddingId", "metadata", "chunkText"
          FROM "document_chunks"
          WHERE "documentId" = ${doc.id}
          ORDER BY id ASC
        `;

        if (rawChunks.length === 0) {
          logger.warn(`[system] No document_chunks rows for document ${doc.id} (${doc.name})`);
          skipped++;
          continue;
        }

        const reembedChunks: Array<{ chunkIndex: number; chunkText: string }> = [];
        for (const c of rawChunks) {
          const prefix = `${doc.id}-`;
          let chunkIndex: number | undefined;
          if (c.embeddingId.startsWith(prefix)) {
            const suffix = c.embeddingId.slice(prefix.length);
            const parsed = Number.parseInt(suffix, 10);
            if (Number.isInteger(parsed) && !Number.isNaN(parsed)) {
              chunkIndex = parsed;
            }
          }
          if (chunkIndex === undefined) {
            // CSW-04: parseMetadata guarantees a non-null object
            // (Record<string, unknown>); the meta !== null && typeof meta ===
            // "object" && !Array.isArray(meta) guard is now redundant but the
            // inner chunkIndex type/integer check is still meaningful.
            const meta = parseMetadata(c.metadata);
            const chunkIndexCandidate = meta.chunkIndex;
            if (
              typeof chunkIndexCandidate === "number" &&
              Number.isInteger(chunkIndexCandidate)
            ) {
              chunkIndex = chunkIndexCandidate;
            }
          }
          if (chunkIndex === undefined) {
            logger.warn(`[system] Doc ${doc.id}: chunk ${c.id} has no derivable chunkIndex (embeddingId=${c.embeddingId}), skipping`);
            continue;
          }
          reembedChunks.push({ chunkIndex, chunkText: c.chunkText });
        }

        if (reembedChunks.length === 0) {
          logger.warn(`[system] Doc ${doc.id}: all chunks have no derivable chunkIndex, cannot re-embed`);
          errors.push(`Document ${doc.id} (${doc.name}): no chunks with derivable chunkIndex`);
          continue;
        }

        await axios.post(
          `${collectorUrl}/api/ingest/reembed`,
          {
            documentId: doc.id,
            workspaceId: doc.workspaceId,
            workspaceName: doc.workspace?.name,
            chunks: reembedChunks,
            embeddingModel: doc.embeddingModel,
            // 260830-ur9: re-stamp filterable metadata from the authoritative
            // Document row so admin re-embeds preserve (or newly add) the
            // documentType/documentCreatedAt(+Ms) stamps the RAG metadata
            // filters key on.
            documentType: doc.type,
            documentCreatedAt: doc.createdAt.toISOString(),
          },
          {
            timeout: 60000,
            headers: {
              "X-Collector-Secret": env.COLLECTOR_SECRET,
              "Content-Type": "application/json",
            },
          },
        );

        reindexed++;
        logger.info(`[system] Re-embedded document ${doc.id} (${doc.name}): ${reembedChunks.length} chunks`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const msg = `Document ${doc.id} (${doc.name}): ${message}`;
        errors.push(msg);
        logger.error(`[system] Re-embed failed for ${doc.id}: ${message}`);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    res.json({
      reindexed,
      skipped,
      errors,
      totalDocuments: documents.length,
      durationSeconds: parseFloat(duration),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[system] Re-embed failed", { error: message });
    res.status(500).json({ error: message });
  }
});

// POST /api/system/ocr/prewarm — manually pre-warm an OCR vision model (admin only)
router.post("/ocr/prewarm", authMiddleware, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { model } = req.body as { model?: string };
    if (!model || typeof model !== "string" || model.trim().length === 0) {
      res.status(400).json({ error: "Model name is required" });
      return;
    }
    const result = await prewarmModel(model.trim());
    if (result.success) {
      res.json(result);
    } else {
      // prewarmModel returns structured failure, not throwing — use 502 for upstream failure
      res.status(502).json(result);
    }
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[system] Pre-warm failed", { error: message });
    res.status(500).json({ error: "Pre-warm failed unexpectedly" });
  }
});

export default router;