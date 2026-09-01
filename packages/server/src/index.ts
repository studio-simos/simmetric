// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import path from "path";
import fs from "fs";
import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import swaggerUi from "swagger-ui-express";
import { apiRateLimiter } from "./middleware/rateLimit";
import { getEnv } from "./config/env";
import { swaggerSpec } from "./config/swagger";
import { logger } from "./utils/logger";
import prisma from "./utils/prisma";

// Phase 140 (EPA-01) — enterprise plugin loader + shutdown seam.
import { loadEnterprisePlugin, shutdownEnterprisePlugin } from "./services/enterpriseLoader";

// Phase 164 (SCALE-04, Q-01/Q-04): pg-boss job-queue singleton lifecycle.
// startJobQueue has its own internal try/catch (D-05 graceful degradation) and
// never throws — it is safe to call unguarded at boot. stopJobQueue is
// null-safe. Only the start/stop functions are imported here; getBoss /
// schedule / createQueue are Phase 165 concerns.
import { startJobQueue, stopJobQueue } from "./services/jobQueue";
// Phase 165 (Q-02, Plan 04): the inline fidelitySampling scheduler registers
// via the pg-boss API directly (it stays inline in index.ts — Pitfall 7).
// getBoss/createQueue/schedule are the same delegators the 7 extracted
// scheduler files use.
import { getBoss, createQueue, schedule } from "./services/jobQueue";

// Routes
import authRoutes from "./routes/auth";
import userRoutes from "./routes/users";
import roleRoutes from "./routes/roles";
import projectRoutes from "./routes/projects";
import workspaceRoutes from "./routes/workspaces";
import documentRoutes from "./routes/documents";
// Phase 69 — Unified upload backend (stage / assign / pending)
import uploadRoutes from "./routes/uploads";
import apiKeyRoutes from "./routes/apiKeys";
import chatRoutes from "./routes/chat";
import chatListRoutes from "./routes/chatList";
import chatCrudRoutes from "./routes/chatCrud";
import chatAgentConfigRoutes from "./routes/chatAgentConfig";
import chatExportRoutes from "./routes/chatExport";
import chatImportRoutes from "./routes/chatImport";
import chatTokenRoutes from "./routes/chatTokens";
import skillsRoutes from "./routes/skills";
import mcpRoutes from "./routes/mcp";
import mcpPinRoutes from "./routes/mcpPins";
import marketplaceRoutes from "./routes/marketplace";
import providerPresetRoutes from "./routes/providerPresets";
import e2eHelperRoutes from "./routes/e2eHelpers";
import analyticsRoutes from "./routes/analytics";
import archiveRoutes from "./routes/archives";
import archivePageRoutes from "./routes/archivePages";
import archiveConfigRoutes from "./routes/archiveConfig";
import archiveSchemaTemplateRoutes from "./routes/archiveSchemaTemplates";
import archiveSearchRoutes from "./routes/archiveSearch";
import archiveGraphRoutes from "./routes/archiveGraph";
import archiveExportRoutes from "./routes/archiveExport";
import archiveIndexRoutes from "./routes/archiveIndex";
import archiveImportRoutes from "./routes/archiveImport";
import ocrRoutes from "./routes/ocr";
import { ocrCatalogRouter } from "./routes/ocr";
import synthesisRoutes from "./routes/synthesis";
import webhookRoutes from "./routes/webhooks";
import pushRoutes from "./routes/push";
import licenseRoutes from "./routes/license";
// Phase 143 (EPA-03) Plan 02: ssoRoutes + samlRoutes + oidcRoutes + scimRoutes
// moved to the enterprise plugin. They are mounted via
// ctx.mountProtected("/api/sso", ...) + ctx.mountPublic("/api/auth", ...) +
// ctx.mountPublic("/scim/v2", ...) inside the enterprise register(ctx).
// initSamlStrategy() also moved (called from register(ctx)).
import templateRoutes from "./routes/templates";
import settingsRoutes from "./routes/settings";
import healthRoutes from "./routes/health";
import systemRoutes from "./routes/system";
import chatRetentionRoutes from "./routes/chatRetention";
import dlpPatternsRoutes from "./routes/dlpPatterns";
import internalWidgetRoutes from "./routes/internalWidget";
import widgetRoutes from "./routes/widgets";
import memoryRoutes from "./routes/memories";
import providerRoutes from "./routes/providers";
import wikiChatRoutes from "./routes/wikiChat";
import wikilinkRoutes from "./routes/wikilinks";
import filtersRoutes from "./routes/filters";
import { widgetCors } from "./middleware/widgetCors";

// Agent
import "./agent/builtinSkills";

// MCP Server
import { mountMCPServer } from "./agent/mcpServer";

// Phase 143 (EPA-03) Plan 02: SAML strategy init moved to the enterprise
// plugin's register(ctx). The community boot no longer calls initSamlStrategy().

// Phase 146 (EPA-06): the backup scheduler moved to the enterprise plugin —
// registered via the scheduler lifecycle hook in register(ctx). The community
// boot no longer imports or starts it.

// MCP Health-Check
import { initMCPHealthCheckScheduler } from "./services/mcpHealthCheckJob";

// MCP Reaper (D-05/D-07 lifecycle) + MCP connection init/shutdown (D-08/D-18)
import { initMCPReaperScheduler } from "./services/mcpReaperJob";
// D-14: synthesis reaper (pg-boss cron, mirrors mcpReaperJob)
import { initSynthesisReaperScheduler } from "./services/synthesisReaperJob";
// Phase 69 (DST-05, D-69-07): UploadDraft reaper — daily 03:00 soft-delete + best-effort unlink
// Phase 165 (Q-02/Q-03): migrated to pg-boss cron — pg-boss stopJobQueue drains the worker
// (no per-scheduler shutdown).
import { initUploadDraftReaperScheduler } from "./services/uploadDraftReaperJob";
// Phase 84 (SEED-002/003/004): ChatMessage retention reaper — daily 03:00 two-pass soft/hard purge
// Phase 165 (Q-02/Q-03): migrated to pg-boss cron — pg-boss stopJobQueue drains the worker
// (no per-scheduler shutdown).
import { initChatMessageReaperScheduler } from "./services/chatMessageReaperJob";
import { initializeMCPConnections, shutdownMCPConnections } from "./agent/mcpClient";
import { initFilters } from "./filters/initFilters";

// Vector Cleanup (D-08)
import { initVectorCleanupScheduler } from "./services/vectorCleanupJob";

// Phase 161 (DR-01): wiki-consistency scheduler extracted to archiveConsistencyService
// (was inline in index.ts:260-288). Phase 165 (Q-02/Q-03): migrated to pg-boss
// cron — pg-boss stopJobQueue drains the worker (no per-scheduler shutdown).
import { initWikiConsistencyScheduler } from "./services/archiveConsistencyService";

// License
import { initLicense } from "./services/licenseService";

// Templates
import { seedTemplates } from "./services/templateService";

// PostgreSQL FTS
import { initPostgreSQLFTS } from "./services/ftsService";
// Ollama auto-detection
import { autoDetectOllama } from "./services/ollamaAutoDetectService";
// Provider model refresh
import { refreshModels } from "./services/providerService";

// Config defaults
import { seedConfigDefaults, ensureSetupWizardMode } from "./services/systemConfigService";

// Auto-seed (roles, permissions, menu sections, catalog entries, service account)
import { seedDatabase, seedCatalogEntries, seedServiceAccount, seedWidgetApiKey, seedBootstrapAdmin } from "./services/seedService";
// D-11: idempotent backfill of UUID/placeholder ArchivePage titles
import { backfillArchivePageTitles } from "./services/archivePageTitleBackfill";
// D-15: idempotent backfill of ArchiveConfig.config.localLLMOnly from
// WorkspaceTemplate.constraints.localLLMOnly (strictest-wins).
import { backfillLocalLLMOnlyPropagation } from "./services/archiveLocalLLMOnlyPropagation";
// WIKI-02 D-02: idempotent startup rename of legacy raw/ -> raw_sources/.
import { renameRawToRawSources } from "./services/rawSourcesRenameBackfill";
// Phase 151 (RAG-01): idempotent startup backfill of the multi-locale
// searchVectorMulti column (7-config concatenated tsvector).
import { backfillSearchVectorMulti } from "./services/searchVectorMultiBackfill";

/** Maximum number of OCR/URL jobs that can run concurrently. */
const MAX_CONCURRENT_OCR_JOBS = 2;

/**
 * Initialize the scheduler for the OCR/URL ingestion pipeline.
 * Polls every 10 seconds for pending jobs and dispatches to the appropriate
 * pipeline handler (processOcrJob or processUrlJob).
 *
 * Runs in the main thread via setInterval with an isRunning guard to
 * prevent overlap. Errors are logged but never crash the scheduler.
 *
 * Enforces a global concurrency limit via MAX_CONCURRENT_OCR_JOBS:
 * when the number of active jobs (PENDING + PROCESSING) reaches the limit,
 * the scheduler skips the cycle and retries in 10 seconds.
 */
function initOcrPipelineScheduler(): void {
  let isRunning = false;
  setInterval(async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      const { getActiveJobCount, getNextPendingJob } = await import("./services/ocrJobService");
      const { processOcrJob } = await import("./ocr/ocrPipeline");
      const { processUrlJob } = await import("./urlIngestion/urlPipeline");
      const { default: jobPrisma } = await import("./utils/prisma");

      // Concurrency guard: skip dispatch when at capacity
      const activeCount = await getActiveJobCount();
      if (activeCount >= MAX_CONCURRENT_OCR_JOBS) {
        logger.debug("[ocr-scheduler] Concurrency limit reached, skipping cycle", {
          activeCount,
          max: MAX_CONCURRENT_OCR_JOBS,
        });
        return;
      }

      const job = await getNextPendingJob();
      if (!job) return;

      const claimed = await jobPrisma.ocrJob.updateMany({
        where: { id: job.id, status: "PENDING" },
        data: { status: "PROCESSING" },
      });
      if (claimed.count === 0) return;

      if (job.type === "OCR") {
        await processOcrJob(job.id);
      } else if (job.type === "URL") {
        await processUrlJob(job.id);
      }
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[ocr-scheduler] Job processing error", { error: message });
    } finally {
      isRunning = false;
    }
  }, 10000);

  logger.info("[ocr] Pipeline scheduler initialized (every 10 seconds)");
}

/**
 * Initialize the scheduler for the synthesis pipeline.
 * Polls every 10 seconds for pending synthesis jobs and dispatches them.
 * Errors are logged but never crash the scheduler.
 *
 * Runs in the main thread via setInterval with an isRunning guard to
 * prevent overlap.
 */
function initSynthesisPipelineScheduler(): void {
  let isRunning = false;
  setInterval(async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      const { getNextSynthesisJob } = await import("./services/synthesisTriggerService");
      const { runSynthesisPipeline } = await import("./services/synthesisService");

      const job = await getNextSynthesisJob();
      if (!job) return;

      await runSynthesisPipeline(job.archiveId, job.createdBy, job.synthesisRunId);
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[synthesis] Pipeline scheduler error", { error: message });
    } finally {
      isRunning = false;
    }
  }, 10000);

  logger.info("[synthesis] Pipeline scheduler initialized (every 10 seconds)");
}

/**
 * Initialize the scheduler for weekly fidelity sampling.
 * Runs in production mode only to validate synthesis output quality.
 *
 * Phase 165 (Q-02/Q-03, Plan 04): the in-process repeating timer + overlap
 * guard have been REMOVED. The scheduler is now a pg-boss cron job: a queue
 * named `fidelity_sampling` (D-04) with a `0 3 * * 0` weekly-Sunday-03:00
 * UTC cron (D-05 — the former 7-day repeating interval did not pin a day;
 * Sunday 03:00 is the natural choice, avoiding the :00 fleet mark).
 *
 * Stays inline in index.ts (Pitfall 7 — it was never lock-wrapped and never
 * extracted). When pg-boss is unavailable (`getBoss() === null`), the init
 * function logs a warn and returns early — there is NO fallback timer
 * (D-02). The dynamic `import("./services/synthesisFidelityService")` inside
 * the boss.work handler preserves the original lazy-load intent.
 */
const QUEUE_NAME_FIDELITY = "fidelity_sampling"; // D-04
const CRON_FIDELITY = "0 3 * * 0"; // D-05 — weekly Sunday 03:00 UTC

export async function initFidelitySamplingScheduler(): Promise<void> {
  const boss = getBoss();
  if (!boss) {
    // D-02: pg-boss unavailable — scheduler offline. No fallback timer.
    logger.warn("[fidelity] pg-boss unavailable — scheduler offline (D-02)");
    return;
  }

  // Pitfall 1: queue must exist before schedule references it by name.
  await createQueue(QUEUE_NAME_FIDELITY);
  // Idempotent upsert (pg-boss ON CONFLICT DO UPDATE) — safe on every boot.
  await schedule(QUEUE_NAME_FIDELITY, CRON_FIDELITY);

  // Pitfall 2: handler receives a Job[] array, iterate with for...of. The
  // dynamic import is kept inside the handler to preserve the lazy-load
  // intent of the original inline scheduler (Pitfall 7).
  await boss.work(QUEUE_NAME_FIDELITY, async (jobs) => {
    for (const _job of jobs) {
      try {
        const { runFidelitySample } = await import("./services/synthesisFidelityService");
        await runFidelitySample();
      } catch (err: unknown) {
        // Pitfall 3: log + resolve (success) — do NOT re-throw. Re-throwing
        // would make pg-boss retry the job and could cause a retry storm.
        logger.error("[fidelity] sampling error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  logger.info("[fidelity] scheduler registered (pg-boss cron: 0 3 * * 0)");
}

/**
 * Creates the Express app with all middleware, routes, and error handlers.
 * Used by supertest in integration tests without triggering app.listen() or DB init.
 */
export function createApp(): Express {
  const app: Express = express();
  app.set("trust proxy", 1); // Trust Nginx reverse proxy for X-Forwarded-For

  app.use(helmet());
  // CORS for internal/frontend API routes (same-origin or known origins).
  // SEC-01: replace the echo-any-origin footgun (previously a boolean `origin`)
  // with an ALLOWED_ORIGINS env allowlist. The cors package's origin callback
  // receives ONLY (origin, callback) — NOT req — so /api/internal/widget path
  // exclusion is implemented as a wrapper middleware below (Pitfall 1).
  const corsHandler = cors({
    origin: (origin, cb) => {
      // No Origin header = server-to-server / curl → allow (no ACAO emitted).
      if (!origin) return cb(null, true);
      if (getEnv().ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      // Non-allowlisted origin: return false → cors emits no ACAO header.
      return cb(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Api-Key"],
  });
  // Path-filtering wrapper: skip global cors on widget embed routes so
  // widgetCors (mounted below on /api/internal/widget) remains the sole CORS
  // authority there (no double-CORS / double-set ACAO).
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/internal/widget")) return next();
    corsHandler(req, res, next);
  });
  // D-09 — aligned to 100mb for coherence with multer (100MB) and nginx (100m).
  // NOTE: express.json does NOT gate multipart uploads (multer does) — Pitfall 7.
  app.use(express.json({ limit: "100mb" }));
  app.use(cookieParser(getEnv().JWT_SECRET));
  app.use(apiRateLimiter);

  // Serve avatar files
  app.use("/avatars", express.static("storage/uploads/avatars"));
  // Serve branding assets (app icon) — mirrors /avatars (public static read)
  app.use("/branding", express.static(path.resolve("storage/branding")));

  // Dynamic CORS for widget embed routes — validates origin against widget allowlist
  app.use("/api/internal/widget", widgetCors);

  // Swagger API documentation — JSON endpoint before UI middleware
  app.get("/api-docs/json", (_req, res) => {
    res.json(swaggerSpec);
  });
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

  // Health check (DB, collector, disk) + root uptime + RAG health
  app.use("/", healthRoutes);

  // API routes
  app.use("/api/auth", authRoutes);
  // Phase 143 (EPA-03) Plan 02: samlRoutes + oidcRoutes moved to the
  // enterprise plugin — mounted via ctx.mountPublic("/api/auth", ...) in
  // register(ctx). scimRoutes moved too (ctx.mountPublic("/scim/v2", ...)).
  app.use("/api/users", userRoutes);
  app.use("/api/roles", roleRoutes);
  app.use("/api/projects", projectRoutes);
  app.use("/api/workspaces", workspaceRoutes);
  app.use("/api/documents", documentRoutes);
  // Phase 69 — unified upload backend (stage / assign / pending)
  app.use("/api/uploads", uploadRoutes);
  app.use("/api/api-keys", apiKeyRoutes);
  app.use("/api/workspaces", chatRoutes);
  app.use("/api/workspaces", chatListRoutes);
  app.use("/api/workspaces", chatExportRoutes);
  app.use("/api/workspaces", chatImportRoutes);
  app.use("/api/workspaces", chatTokenRoutes);
  app.use("/api/workspaces", chatCrudRoutes);
  app.use("/api/workspaces", chatAgentConfigRoutes);
  app.use("/api/agent", skillsRoutes);
  app.use("/api/mcp-connections", mcpRoutes);
  app.use("/api/mcp-marketplace", marketplaceRoutes);
  // T-DRD-01: the e2eHelpers router is an unauthenticated process-spawn
  // surface (start/stop echo MCP server) — its own doc comment promises
  // dev/test-only, and this gate enforces it. Production boots 404 here.
  // E2E is unaffected: playwright.config.ts boots the server with default
  // NODE_ENV (development); E2E_RUN=1 does not set NODE_ENV.
  if (getEnv().NODE_ENV !== "production") {
    app.use("/api/__tests__", e2eHelperRoutes);
  }
  app.use("/api/chats", mcpPinRoutes);
  // Phase 146 (EPA-06): the 4 backup route groups moved to the enterprise
  // plugin — mounted via ctx.mountProtected in register(ctx). In a community
  // build (no enterprise plugin) all 4 paths 404.
  app.use("/api/system/analytics", analyticsRoutes);
  app.use("/api/archives", archiveRoutes);
  app.use("/api/archives", archivePageRoutes);
  app.use("/api/archives", archiveConfigRoutes);
  app.use("/api/archive-schema-templates", archiveSchemaTemplateRoutes);
  app.use("/api/archives", archiveSearchRoutes);
  app.use("/api/archives", archiveGraphRoutes);
  app.use("/api/archives", archiveExportRoutes);
  app.use("/api/archives", archiveIndexRoutes);
  app.use("/api/archives", archiveImportRoutes);
  app.use("/api/archives", ocrRoutes);
  app.use("/api/ocr", ocrCatalogRouter);
  app.use("/api/synthesis", synthesisRoutes);
  app.use("/api/webhooks", webhookRoutes);
  app.use("/api/system/push", pushRoutes);
   app.use("/api/license", licenseRoutes);
  // Phase 143 (EPA-03): ssoRoutes + samlRoutes + oidcRoutes + scimRoutes moved
  // to the enterprise plugin — mounted via ctx.mountProtected("/api/sso", ...)
  // + ctx.mountPublic("/api/auth", ...) + ctx.mountPublic("/scim/v2", ...) in
  // register(ctx).
  app.use("/api/templates", templateRoutes);
  app.use("/api/system/settings", settingsRoutes);
  app.use("/api/system", systemRoutes);
  // Quick 260829-ony — DLP pattern configuration CRUD + test (admin:settings).
  app.use("/api/system/dlp", dlpPatternsRoutes);
  // Phase 84 — dedicated audited write path for chat_message_retention_days
  // (D-08: confirmDataLoss sibling-field contract; sole writer per D-09).
  app.use("/api/system", chatRetentionRoutes);
  app.use("/api/internal/widget", internalWidgetRoutes);
  app.use("/api/widgets", widgetRoutes);
  // Phase 97 (MEM-01 D-03): per-user-per-workspace Memory CRUD + GDPR export/erase.
  app.use("/api/memories", memoryRoutes);
  app.use("/api/providers", providerRoutes);
  app.use("/api/provider-presets", providerPresetRoutes);
  app.use("/api/wiki-write", wikiChatRoutes);
  app.use("/api/wikilinks", wikilinkRoutes);
  app.use("/api/wiki-edits", wikilinkRoutes);
  app.use("/api/filters", filtersRoutes);

  // Phase 143 (EPA-03) Plan 02: SCIM routes moved to the enterprise plugin —
  // mounted via ctx.mountPublic("/scim/v2", scimFactory(ctx)) in register(ctx).

  // Mount MCP server (SSE + message endpoints)
  mountMCPServer(app);

  // NOTE: The 404 + error catch-all handlers are NOT mounted here. They are
  // mounted by mountCatchAlls(app) AFTER the enterprise plugin loader in the
  // boot sequence, so enterprise routes (added by the plugin after createApp()
  // returns) are registered BEFORE the catch-all and are actually reachable.
  // Tests that need the catch-all (e.g. asserting 404 on unknown routes) must
  // call mountCatchAlls(app) explicitly after the plugin loader.

  return app;
}

/**
 * Mount the 404 + error catch-all handlers on the app. MUST be called AFTER
 * the enterprise plugin loader so enterprise routes are registered before the
 * catch-all. Exported for tests that use createApp() + the plugin loader and
 * need the catch-all (e.g. the enterprise integration test).
 */
export function mountCatchAlls(app: Express): void {
  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error("Unhandled error", { error: err.message, stack: err.stack });
    res.status(500).json({ error: "Internal server error" });
  });
}

// Only start the server when run directly (not imported by tests)
const isMainModule = typeof require !== "undefined" && require.main === module;
if (isMainModule) {
  const env = getEnv();
  const PORT = env.SERVER_PORT;
  const app = createApp();

  app.listen(PORT, async () => {
    logger.info(`[server] Listening on port ${PORT}`);

    // Phase 162 (ENC-01, D-01): ENCRYPTION_KEY is REQUIRED in production.
    // Replaces the Phase 157 advisory logger.warn with a hard fail-loud
    // (logger.error + process.exit(1)), matching the DB-connection convention
    // (index.ts:537-538). Fires BEFORE prisma.$connect() so the failure surfaces
    // even if the DB is unreachable. The legacy scryptSync(JWT_SECRET) fallback
    // is disabled in production (rotating JWT_SECRET would silently invalidate
    // every encrypted blob); dev/test (NODE_ENV !== "production") keeps it.
    // The service-level gate in encryptionService.ts:getEncryptionKey() is
    // defense-in-depth for CLI callers (rotate/verify run via tsx, bypass
    // index.ts). Uses env.ENCRYPTION_KEY (getEnv() Zod-validated cached path),
    // NOT process.env.ENCRYPTION_KEY (Pitfall 3: index.ts is the validated
    // entry point). No grace-period flag (D-04 — a flag would silently
    // fail-open, defeating the security contract).
    if (env.NODE_ENV === "production" && !env.ENCRYPTION_KEY) {
      logger.error(
        `[server] ENCRYPTION_KEY is required in production — refusing to boot. ` +
          `The legacy scryptSync(JWT_SECRET) fallback is disabled in production ` +
          `(rotating JWT_SECRET would silently invalidate every encrypted blob). ` +
          `Generate a key: openssl rand -base64 32, set ENCRYPTION_KEY in ` +
          `the root .env, and restart. ` +
          `See docs/ENCRYPTION_KEY_ROTATION.md (Phase 162 hard-default cutover).`,
      );
      process.exit(1);
    }

    // Phase 161 (DR-04): single-instance advisory. Fires when the cached
    // env config has no REDIS_URL and we are running in the prod tier. Uses
    // getEnv().REDIS_URL (Zod-validated, cached) not process.env (matches
    // redisService.ts consumption path). Advisory only — non-blocking. Logs
    // the key NAME, never the value (V7 Logging).
    if (env.NODE_ENV === "production" && !env.REDIS_URL) {
      logger.warn(
        `[server] REDIS_URL is unset in production — running in single-instance mode. ` +
        `Distributed scheduler locking is disabled; running more than one server ` +
        `instance will double-execute reapers, consistency checks, and vector cleanup. ` +
        `Set REDIS_URL to enable cross-instance lock coordination.`,
      );
    }

    try {
      await prisma.$connect();
      logger.info("[server] Database connected");

      // Auto-seed roles, permissions, and menu sections (idempotent)
      await seedDatabase();

      // Initialize license system
      initLicense();

      // Seed built-in workspace templates
      await seedTemplates();

      // Seed system config defaults
      await seedConfigDefaults();

      // Phase 152 (WIZ-02, D-04): derive setup_wizard_mode — MUST run AFTER
      // seedConfigDefaults() (the row must exist) and BEFORE
      // seedBootstrapAdmin() (the skip guard reads the derived value).
      // Reordering reopens the seed-vs-wizard race (RESEARCH Pitfall 1).
      await ensureSetupWizardMode();

      // Ensure branding assets directory exists (idempotent)
      try {
        fs.mkdirSync(path.resolve("storage/branding"), { recursive: true });
      } catch {
        // ignore — express.static will 404 if missing
      }

      // Seed MCP marketplace catalog entries
      await seedCatalogEntries();

      // Seed widget service account
      await seedServiceAccount();

      // 151-02 (G-151-1a/1b follow-up): mint the api_keys row matching the
      // configured WIDGET_API_KEY so the widget service's outbound calls to
      // /api/internal/widget authenticate (apiKeyMiddleware requires a DB row,
      // the env var alone is not enough — docker 500s without this).
      await seedWidgetApiKey();

      // Seed bootstrap admin (only when no admin exists yet; default admin/admin123, must change at first login)
      await seedBootstrapAdmin();

      // D-11: idempotent backfill of UUID/placeholder ArchivePage titles (mirror seedBootstrapAdmin)
      await backfillArchivePageTitles();

      // D-15: idempotent backfill of ArchiveConfig.config.localLLMOnly from
      // WorkspaceTemplate.constraints.localLLMOnly (strictest-wins across
      // the creator's accessible workspaces). Populates the PHI gate flag for
      // existing archives so the gate is not dead code in production.
      await backfillLocalLLMOnlyPropagation();

      // WIKI-02 D-02: idempotent raw/ -> raw_sources/ rename for existing archives.
      await renameRawToRawSources();

      // Phase 151 (RAG-01): idempotent backfill of the multi-locale
      // searchVectorMulti column. Startup-synchronous (mirrors the existing
      // backfills); a failure is logged and does NOT crash boot — the query
      // cutover ships only after this backfill has completed on a given
      // deployment (D-03 ordering).
      try {
        await backfillSearchVectorMulti();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[server] searchVectorMulti backfill failed (non-fatal): ${message}`);
      }

      // D-02: Initialize PostgreSQL FTS extensions
      await initPostgreSQLFTS();

      // Phase 143 (EPA-03) Plan 02: initSamlStrategy() moved to the enterprise
      // plugin's register(ctx) — called after ctx.prisma is available. The
      // community boot no longer initializes SAML.

      // Phase 100-01: discover and register filter plugins (DLP at priority -1).
      // Runs BEFORE the HTTP listener so plugins are registered before any request.
      await initFilters();

      // D-08, D-09: Auto-detect Docker Ollama service (zero-config deployments)
      await autoDetectOllama();
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[server] Database connection failed", { error: message });
      process.exit(1);
    }

    // Phase 164 (SCALE-04, Q-01, D-03/D-05): start pg-boss AFTER
    // prisma.$connect() (line 464) and BEFORE loadEnterprisePlugin + the
    // NODE_ENV==="production" scheduler block. startJobQueue has its OWN
    // internal try/catch (D-05: PG-unavailable degrades to null, never throws,
    // never process.exit) — it is deliberately placed OUTSIDE the prisma
    // try/catch above (which calls process.exit(1) on failure). Boot-order
    // invariant enforced by src/__tests__/bootOrder.test.ts.
    await startJobQueue();

    // Phase 140 (EPA-01, D-08): load the enterprise plugin AFTER
    // prisma.$connect() + initLicense() and BEFORE the NODE_ENV==="production"
    // scheduler block. Community builds (no @simmetric-chat/enterprise
    // installed) log an info-level no-op and continue. Register-throws is
    // fail-loud (process.exit(1), D-07) — never fail-open. Boot order is
    // enforced by src/__tests__/bootOrder.test.ts.
    await loadEnterprisePlugin(app);

    // Mount the 404 + error catch-all handlers AFTER loadEnterprisePlugin so
    // enterprise routes are registered before the catch-all and are reachable.
    // (createApp() deliberately omits the catch-all — see its comment.)
    mountCatchAlls(app);

    // Refresh all Ollama provider models so the model list matches the current runtime
    // environment (host Ollama for dev, Docker Ollama for container deployment).
    try {
      const ollamaProviders = await prisma.provider.findMany({ where: { type: "ollama" } });
      for (const p of ollamaProviders) {
        try {
          const count = await refreshModels(p.id);
          logger.info(`[server] Startup model refresh: ${count} models for Ollama provider "${p.name}"`);
        } catch (err) {
          logger.warn(`[server] Startup model refresh failed for Ollama provider "${p.name}"`, { error: (err as Error).message });
        }
      }
      logger.info(`[server] Startup model refresh complete (${ollamaProviders.length} Ollama providers)`);
    } catch (err) {
      logger.warn("[server] Startup model refresh skipped", { error: (err as Error).message });
    }

    // Start MCP health-check scheduler + fidelity sampling
    if (env.NODE_ENV === "production") {
      // Phase 165 (Q-02/Q-03): the 4 interval schedulers migrated to pg-boss
      // cron jobs. init is async (createQueue + schedule + boss.work
      // registration); await each so boot order is deterministic and a
      // registration error surfaces at boot. pg-boss stopJobQueue drains the
      // workers (no per-scheduler shutdown).
      await initMCPHealthCheckScheduler();
      // Phase 165 (Q-02): mcpReaper is now a pg-boss cron job. init is async
      // (createQueue + schedule + boss.work registration); await it so boot
      // order is deterministic and a registration error surfaces at boot.
      await initMCPReaperScheduler(); // D-07: 5-min reaper probes listTools, disconnects stale
      await initSynthesisReaperScheduler(); // D-14: 15-min reaper flips orphaned PROCESSING -> FAILED
      await initFidelitySamplingScheduler(); // Phase 165 (Q-02, Plan 04): weekly Sunday 03:00 fidelity sampling
      await initVectorCleanupScheduler();
      // Phase 165 (Q-02/Q-03): the 2 daily reapers are now pg-boss cron jobs.
      // init is async (createQueue + schedule + boss.work registration); await
      // each so boot order is deterministic and a registration error surfaces
      // at boot. pg-boss stopJobQueue drains the workers (no per-scheduler
      // shutdown). The `0 3 * * *` cron handles the 03:00 UTC alignment
      // natively (Pattern 2 — no msUntilNext3AM initial-delay timer).
      await initUploadDraftReaperScheduler(); // Phase 69 D-69-07: daily 03:00 reaper for expired UploadDrafts
      await initChatMessageReaperScheduler(); // Phase 84: daily 03:00 chat-message retention reaper (D-10/D-12)
      // D-18 (Pitfall 1): wire initializeMCPConnections so enabled MCP servers
      // connect at boot. Fire-and-forget so a failing external MCP server does
      // not block server startup.
      initializeMCPConnections().catch((err: unknown) => {
        logger.warn("[server] MCP connections init failed", {
          error: (err as Error).message,
        });
      });
    }

    // Clean up orphaned raw/ files from failed/interrupted pipelines
    const { cleanupOrphanedRawFiles } = await import("./services/ocrJobService");
    cleanupOrphanedRawFiles().catch((err: Error) =>
      logger.warn("[server] Orphan file cleanup failed, continuing", { error: err.message })
    );

    // Start OCR pipeline scheduler + synthesis pipeline scheduler (runs in both dev and production)
    initOcrPipelineScheduler();
    initSynthesisPipelineScheduler();
    await initWikiConsistencyScheduler();

    // Graceful shutdown — stop backup jobs before disconnecting.
    // WR-02: race the shutdown sequence against a 5s hard timeout so a hanging
    // `client.close()` on an unresponsive external MCP server cannot keep the
    // process alive past the container runtime's grace period. On timeout we
    // force-exit rather than waiting indefinitely for the SDK to settle.
    const gracefulShutdown = async (signal: string): Promise<void> => {
      logger.info(`[server] ${signal} received — shutting down gracefully`);
      const shutdownSequence = (async () => {
        // Phase 146 (EPA-06): the backup scheduler stop moved to the enterprise
        // plugin — invoked via shutdownEnterprisePlugin()'s schedulers.stop().
        // Phase 165 (Q-02/Q-03): all 7 per-scheduler shutdown calls (mcpReaper
        // + synthesisReaper + vectorCleanup + mcpHealthCheck + wikiConsistency
        // + uploadDraftReaper + chatMessageReaper) were removed — pg-boss
        // stopJobQueue (called below) drains all workers across the 7 cron
        // queues.
        await shutdownMCPConnections(); // D-08: close all activeConnections delete-first
        // Phase 164 (SCALE-04, Q-04, D-04): drain pg-boss in-flight jobs (4.5s
        // cap) AFTER the scheduler shutdowns and BEFORE
        // shutdownEnterprisePlugin() + prisma.$disconnect() so the queue can
        // drain while the DB is still up. stopJobQueue is null-safe (no-op when
        // the queue never started / already stopped). Phase 165 (Q-02/Q-03)
        // removed all 7 per-scheduler shutdowns (mcpReaper + 4 interval
        // schedulers + 2 daily reapers) — pg-boss stopJobQueue drains all their
        // workers. Boot-order invariant enforced by src/__tests__/bootOrder.test.ts.
        await stopJobQueue();
        // Phase 140 (EPA-01): stop plugin schedulers + invoke onShutdown
        // callbacks BEFORE prisma.$disconnect() so plugin teardown can
        // still hit the DB. Enforced by bootOrder.test.ts.
        await shutdownEnterprisePlugin();
        await prisma.$disconnect();
      })();
      const timeout = new Promise<void>((resolve) => setTimeout(() => resolve(), 5000));
      await Promise.race([shutdownSequence, timeout]);
      process.exit(0);
    };

    process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
    process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
  });
}

export default createApp;