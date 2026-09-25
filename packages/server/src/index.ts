// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import path from "path";
import fs from "fs";
import express, { json, type Express, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import swaggerUi from "swagger-ui-express";
import { AVATAR_SIZES } from "./services/avatarService";
import { getStorageProvider } from "./services/storageProvider";
import { DEFAULT_ORG_ID } from "@simmetric-chat/shared";
import { apiRateLimiter } from "./middleware/rateLimit";
import { getEnv } from "./config/env";
import { swaggerSpec } from "./config/swagger";
import { logger } from "./utils/logger";
import { requestIdMiddleware, sendError } from "./utils/httpError";
import prisma from "./utils/prisma";

// Phase 140 (EPA-01) — enterprise plugin loader + shutdown seam.
import { loadEnterprisePlugin } from "./services/enterpriseLoader";// Phase 186 (SAAS-05, D-08): SaaS plugin loader + shutdown seam — shares the
// pluginLoaderCore machinery (fail-loud semantics verbatim, D-09).
import { loadSaaSPlugin } from "./services/saasLoader";
// Phase 202 (PLGM-02): the managed plugin loader wired into REAL boot
// (the 202-01 tracer skeleton now runs in the actual boot sequence).
import { loadManagedPlugins } from "./services/managedLoader";
import pluginsRoutes from "./routes/plugins";
// Phase 202 (PLGM-03, D-07/Pitfall 1): the enterprise DB→env instance-license
// fallback — an additive ASYNC boot step between initLicense() and the
// enterprise plugin load. NEVER re-declared here — the service is owned
// by 202-05.
import { resolveInstanceLicenseFromDB } from "./services/pluginLicenseService";
// Phase 202 (PLGM-04, D-06): the ONE graceful-shutdown path — extracted to
// shutdownSequence.ts; SIGTERM/SIGINT AND the restart route all call the
// same import (never a second restart-specific variant, T-202-10).
import { gracefulShutdown } from "./services/shutdownSequence";
import { PLUGINS_STORAGE_DIR } from "./services/pluginManagerService";

// Phase 164 (SCALE-04, Q-01/Q-04): pg-boss job-queue singleton lifecycle.
// startJobQueue has its own internal try/catch (D-05 graceful degradation) and
// never throws — it is safe to call unguarded at boot. stopJobQueue is
// null-safe. Only the start/stop functions are imported here; getBoss /
// schedule / createQueue are Phase 165 concerns.
import { startJobQueue } from "./services/jobQueue";
// pg-boss queue-table self-heal guard (debug session pgboss-queue-pkey-duplicate):
// detects + repairs index/heap-diverged duplicate rows in pgboss.queue BEFORE the
// schedulers register. No-op (single aggregate query) on a healthy table. Has its
// own internal try/catch and never throws — same degradation shape as
// startJobQueue.
import { healPgbossQueueDuplicates } from "./services/pgbossQueueHealthService";
// Phase 165 (Q-02, Plan 04): the inline fidelitySampling scheduler registers
// via the pg-boss API directly (it stays inline in index.ts — Pitfall 7).
// getBoss/createQueue/schedule are the same delegators the 7 extracted
// scheduler files use.
import { getBoss, createQueue, schedule } from "./services/jobQueue";

// Routes
import authRoutes from "./routes/auth";
// Phase 193 (D-13): the community composite login route — mounted after the
// plugin loads (see the boot-sequence mount for the defer-then-serve contract).
import { createAuthLdapCompositeRouter } from "./routes/authLdapComposite";
import userRoutes from "./routes/users";
import roleRoutes from "./routes/roles";
import agencyRoutes from "./routes/agency";
import quotaRoutes from "./routes/quota";
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
// Phase 190 (SKIL-01, Pitfall 2): the CRUD + test-preview surface rides its
// own /api/skills mount; GET /api/agent/skills stays byte-identical.
import { skillsCrudRouter } from "./routes/skills";
import mcpRoutes from "./routes/mcp";
// Phase 195 (MCPO-01 D-07): the PUBLIC OAuth callback router — mounted at the
// same path BEFORE mcpRoutes (Pitfall 2 mount-order landmine: inside
// mcpRoutes the router-level requireAdmin would 401 the IdP browser redirect
// before any handler ran). Carries NO auth middleware; its ONLY route is
// GET /oauth/callback — everything else falls through to mcpRoutes per-path.
import mcpOAuthCallbackRouter from "./routes/mcpOAuthCallback";
import mcpPinRoutes from "./routes/mcpPins";
import { connectorsRoutes, connectorsWebhookRouter } from "./routes/connectors";
// Phase 200 (ECCO-06, Option A): the public CONNECTOR OAuth callback router —
// the "Add to Slack" install completing arm. Same public-mount doctrine as
// mcpOAuthCallbackRouter (NO auth middleware; ONLY GET /oauth/callback).
import connectorOAuthCallbackRouter from "./routes/connectorOAuthCallback";
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

// Phase 200 (ECCO-06, D-09): connector health-check — daily pg-boss cron
// sweeping all four platforms via validateBotToken (health flip ONLY, no
// auto-disable per 198 D-20).
import { initConnectorHealthCheckScheduler } from "./services/connectorHealthCheckJob";

// MCP Reaper (D-05/D-07 lifecycle) + MCP connection init/shutdown (D-08/D-18)
import { initMCPReaperScheduler } from "./services/mcpReaperJob";
// Phase 195 (MCPO-01 D-12): proactive OAuth token refresh — 5-min pg-boss
// cron, mcpReaperJob idiom, every refresh wrapped in withConnectionLock.
import { initMCPOAuthRefreshScheduler } from "./services/mcpOAuthRefreshJob";
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
// Phase 207 (CLOUD-06, D-11): hourly recurring token-quota reset sweep.
import { initQuotaResetScheduler } from "./services/quotaResetJob";
import { initializeMCPConnections } from "./agent/mcpClient";
import { initFilters } from "./filters/initFilters";

// Vector Cleanup (D-08)
import { initVectorCleanupScheduler } from "./services/vectorCleanupJob";

// Phase 161 (DR-01): wiki-consistency scheduler extracted to archiveConsistencyService
// (was inline in index.ts:260-288). Phase 165 (Q-02/Q-03): migrated to pg-boss
// cron — pg-boss stopJobQueue drains the worker (no per-scheduler shutdown).
import { initWikiConsistencyScheduler } from "./services/archiveConsistencyService";
// Phase 198 (198-03, D-15/P-10): the connector poll scheduler — ONE shared
// interval ticker for all enabled polling-mode telegram connectors. Init is
// in the dev+prod scheduler cluster below (OUTSIDE the production-only
// pg-boss block); the stop handle rides graceful shutdown (25s long-poll
// safety).
import { initConnectorPollScheduler } from "./services/connectors/connectorPoller";
// Phase 198 (198-04, Rule 3 blocking fix): side-effect import that registers
// the TelegramAdapter in the platform registry at boot — 198-03 shipped the
// module-load registerAdapter("telegram") but NO production module imported
// the file, so the boot registry stayed EMPTY (create/validate/test all
// 400'd "Platform not implemented yet"; the webhook/polling pipelines failed
// closed on getAdapter). The import runs for its registration side effect —
// no symbols are consumed here.
import "./services/connectors/telegram";
// Phase 199 (199-03, Pitfall 5 / D-05): the DISCORD side of the 198-04
// boot-registry lesson — BOTH side-effect imports. discord.ts registers
// the DiscordAdapter (REST outbound) at module load; discordGateway.ts is
// the WS inbound manager whose initDiscordGateway()/closeDiscordGateway()
// are wired in the scheduler cluster + graceful shutdown below.
import "./services/connectors/discord";
// Phase 200 (200-01, Pitfall 5 doctrine — the 198-04 boot-registry lesson
// applies to every adapter): slack.ts registers the SlackAdapter at module
// load; the import runs for its registration side effect — no symbols
// consumed here.
import "./services/connectors/slack";
// Phase 200 (200-02, same doctrine): whatsapp.ts registers the
// WhatsappAdapter at module load — the GET/POST /whatsapp/:connectorId/
// webhook subpaths + the admin create/validate/test routes flip live.
import "./services/connectors/whatsapp";
import { initDiscordGateway } from "./services/connectors/discordGateway";

// Phase 192 (DLP-01/D-12, D-01/D-12): document PII scan + legacy backfill —
// the first one-shot send/work pg-boss consumers in the repo (plan 02).
// Registered after startJobQueue; the init functions null-guard getBoss()
// themselves (pg-boss offline = scan offline, logged at warn).
import { initDlpDocumentScanScheduler, initDlpBackfillScheduler } from "./services/dlpDocumentScanJob";

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
 * Phase 184 (D-03) — shared response arms for the /avatars + /branding
 * download handlers. Cache headers mirror the removed static mounts'
 * default behavior (no cache-control set by the old mounts; ETag via
 * content identity — here a plain ETag on the key) and the 404 shape
 * matches the plain 404 the static mounts served (no JSON body).
 */
function sendAvatarBytes(res: Response, bytes: Buffer, etagSeed: string): void {
  res.status(200);
  res.setHeader("Content-Type", "image/webp");
  res.setHeader("ETag", `"${etagSeed}"`);
  res.send(bytes);
}

function sendNotFound(res: Response): void {
  res.status(404).end();
}

/**
 * Extract the userId from an avatar filename ({userId}-{timestamp}.webp
 * naming — avatarService). User ids are UUIDs (dashes), so the id is
 * everything BEFORE the trailing timestamp segment, mirroring
 * avatarService.extractUserIdFromFilename (Rule 1: a first-dash split
 * would truncate UUID ids). Returns null for foreign name shapes.
 */
function extractUserIdFromAvatarFilename(filename: string): string | null {
  const match = /^(.+)-(\d+)\.webp$/.exec(filename);
  return match?.[1] ?? null;
}

/**
 * Best-effort fs read of a legacy avatar/branding file — the PERMANENT
 * fallback arm (D-03 coexistence + rollback aid). Returns null when the
 * file is missing; never throws.
 */
function readLegacyFile(...segments: string[]): Buffer | null {
  try {
    const resolved = path.resolve(...segments);
    if (!fs.existsSync(resolved)) return null;
    return fs.readFileSync(resolved);
  } catch (err) {
    logger.debug("[static-serving] legacy fs arm failed", {
      target: segments.join("/"),
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Phase 184 (D-03) — GET /avatars/:size/:file
 *
 * Provider-first with a permanent fs fallback:
 *   1. Validate :size against AVATAR_SIZES and :file against basename +
 *      ".."/"/" rejection BEFORE any resolution (T-184-14 traversal defense).
 *   2. Extract the userId from the filename prefix → resolve the org from
 *      the user's LIVE OrganizationMember row (User is identity-pure,
 *      Phase 182 D-01) → key {orgId}/avatars/{size}/{file} — the key prefix
 *      always comes from the LOOKED-UP row, never the request (T-184-15
 *      row's-org rule).
 *   3. provider.exists → provider.get → serve. Provider miss/error OR
 *      provider-resolution failure falls through to the legacy fs arm —
 *      serving NEVER 500s on provider unavailability (T-184-16; the static
 *      mount never 500'd). Both arms miss → 404 (static 404 shape).
 */
async function avatarDownloadHandler(req: Request, res: Response): Promise<void> {
  try {
    const size = Number(req.params.size as string);
    if (!AVATAR_SIZES.includes(size as (typeof AVATAR_SIZES)[number])) {
      res.status(400).json({ error: "Invalid avatar size" });
      return;
    }
    const file = path.basename(req.params.file as string);
    if (file.includes("..") || file.includes("/") || file.includes("\\")) {
      res.status(400).json({ error: "Invalid avatar filename" });
      return;
    }

    const userId = extractUserIdFromAvatarFilename(file);
    // Provider arm: only for recognizable avatar names (URL → key mapping).
    // Anything else falls straight to the legacy fs arm.
    if (userId) {
      try {
        const membership = await prisma.organizationMember.findFirst({
          where: { userId, deletedAt: null },
          select: { organizationId: true },
        });
        const orgId = membership?.organizationId ?? DEFAULT_ORG_ID;
        const key = `${orgId}/avatars/${size}/${file}`;
        const provider = await getStorageProvider(orgId);
        if (await provider.exists(key)) {
          const bytes = await provider.get(key);
          sendAvatarBytes(res, bytes, key);
          return;
        }
      } catch (err) {
        // T-184-16: provider unavailability (s3 configured but down /
        // incomplete config) degrades to the fs arm — never a 500.
        logger.debug("[static-serving] avatar provider arm failed — falling back to fs", {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Legacy fs arm — pre-phase avatars keep serving byte-identically.
    const legacy = readLegacyFile("storage/uploads/avatars", String(size), file);
    if (legacy) {
      sendAvatarBytes(res, legacy, `legacy-${size}-${file}`);
      return;
    }
    sendNotFound(res);
  } catch (err) {
    // Belt-and-braces: this handler never 500s on serving-path failures.
    logger.error("[static-serving] avatar handler unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendNotFound(res);
  }
}

/**
 * Extension-mapped content types for branding files (Rule 1 parity with the
 * removed static mounts — the enterprise upload route writes
 * app-icon.{png,svg,ico,webp}, and the frontend renders them via <img>,
 * which ignores octet-stream payloads). Unknown extensions keep a
 * conservative binary default.
 */
const BRANDING_MIME: Record<string, string> = {
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

function brandingContentType(file: string): string {
  return BRANDING_MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Phase 184 (D-04) — GET /branding/:file
 *
 * Same shape as the avatar handler: key {orgId}/branding/{file} (org from
 * the requesting user's live membership when authenticated, else the
 * default-org global arm — getStorageProvider(undefined)) → provider read;
 * miss/error → legacy fs arm on storage/branding (today's static target);
 * both miss → 404. NO upload endpoint exists (operator-managed per the
 * D-04 runbook — the operator uploads app-icon.png to the bucket when
 * STORAGE_PROVIDER=s3); BRANDING_APP_ICON_URL config stays untouched.
 * :file is validated against basename + ".."/"/" rejection (T-184-14).
 */
async function brandingDownloadHandler(req: Request, res: Response): Promise<void> {
  try {
    const file = path.basename(req.params.file as string);
    if (file.includes("..") || file.includes("/") || file.includes("\\")) {
      res.status(400).json({ error: "Invalid branding filename" });
      return;
    }

    // Org resolution: authenticated requester's live membership, else the
    // default-org global arm (public read before login — the branding icon
    // renders on the login page). A missing/deleted user falls back too.
    let orgId: string | undefined;
    if (req.userId) {
      try {
        const membership = await prisma.organizationMember.findFirst({
          where: { userId: req.userId, deletedAt: null },
          select: { organizationId: true },
        });
        orgId = membership?.organizationId ?? DEFAULT_ORG_ID;
      } catch {
        orgId = DEFAULT_ORG_ID;
      }
    }

    try {
      const provider = await getStorageProvider(orgId);
      const key = `${orgId ?? DEFAULT_ORG_ID}/branding/${file}`;
      if (await provider.exists(key)) {
        const bytes = await provider.get(key);
        res.status(200);
        res.setHeader("ETag", `"${key}"`);
        res.setHeader("Content-Type", brandingContentType(file));
        res.send(bytes);
        return;
      }
    } catch (err) {
      // T-184-16: provider unavailability degrades to the fs arm.
      logger.debug("[static-serving] branding provider arm failed — falling back to fs", {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Legacy fs arm — storage/branding is the operator's physical upload
    // target (stays LocalFS per D-04; only SERVING moved to the provider).
    const legacy = readLegacyFile("storage/branding", file);
    if (legacy) {
      res.status(200);
      res.setHeader("ETag", `"legacy-branding-${file}"`);
      res.setHeader("Content-Type", brandingContentType(file));
      res.send(legacy);
      return;
    }
    sendNotFound(res);
  } catch (err) {
    logger.error("[static-serving] branding handler unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendNotFound(res);
  }
}

/**
 * Creates the Express app with all middleware, routes, and error handlers.
 * Used by supertest in integration tests without triggering app.listen() or DB init.
 */
export function createApp(): Express {
  const app: Express = express();
  app.set("trust proxy", 1); // Trust Nginx reverse proxy for X-Forwarded-For

  app.use(helmet());
  // api-design sweep (2026-09-24): per-request correlation id — honors an
  // inbound X-Request-Id from proxies, mints a UUID otherwise, echoes it as
  // a response header, and stamps req.requestId for sendError() envelopes
  // (utils/httpError.ts). Mounted FIRST so every handler (and the catch-alls)
  // sees it.
  app.use(requestIdMiddleware);
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
  // Phase 200 (P1 correction, T-200-01b): path-filtered raw-body parser for
  // the platform webhook subpaths. WHY the wrapper and not a route-scoped
  // parser variant: body-parser 2.3.0 (bundled with express 5) short-circuits
  // via `onFinished.isFinished(req)` — "body already parsed" — so a
  // route-scoped `json({ verify })` mounted AFTER the global 100mb parser
  // below NEVER RUNS (verified empirically: rawBody stays undefined and the
  // 256kb limit never trips). Slack/WhatsApp HMAC signs the RAW bytes, so
  // these requests must be parsed HERE with the verify capture, before the
  // global parser can consume the stream. The wrapper covers EVERY
  // /api/connectors/*/webhook path including telegram's (its per-route
  // webhookJson becomes a harmless short-circuit under this parser —
  // behavior byte-identical, defense in depth; the telegram route is NOT
  // exempted). WR-07: the 256kb webhook limit is only real because this
  // parser runs FIRST — >256kb webhook bodies 413 here, before the global
  // 100mb parser and every gate could pay for them.
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/connectors/") && req.path.endsWith("/webhook")) {
      return json({
        limit: "256kb",
        verify: (rq: express.Request, _r: express.Response, buf: Buffer) => {
          (rq as express.Request & { rawBody?: Buffer }).rawBody = buf;
        },
      })(req, res, next);
    }
    next();
  });
  // D-09 — aligned to 100mb for coherence with multer (100MB) and nginx (100m).
  // NOTE: express.json does NOT gate multipart uploads (multer does) — Pitfall 7.
  app.use(express.json({ limit: "100mb" }));
  app.use(cookieParser(getEnv().JWT_SECRET));
  app.use(apiRateLimiter);

  // Phase 184 (D-03/D-04): /avatars + /branding serving moved from the
  // removed static mounts to provider-first download handlers with a
  // PERMANENT fs fallback arm. The fallback is both the legacy coexistence
  // mechanism (pre-phase avatar files never break) and the D-03
  // costly-rollback aid — it stays even in steady state (research Pattern 4
  // / OQ-2). These routes were public static reads and REMAIN public reads
  // (URL-is-capability — the auth surface is byte-identical to the old
  // static mounts, T-184-15b).
  app.get("/avatars/:size/:file", avatarDownloadHandler);
  // Serve branding assets (app icon) — mirrors /avatars (public static read);
  // provider-served when the operator uploads app-icon.png to the bucket
  // (D-04 — no branding upload endpoint exists, the runbook documents it).
  app.get("/branding/:file", brandingDownloadHandler);

  // Dynamic CORS for widget embed routes — validates origin against widget allowlist
  app.use("/api/internal/widget", widgetCors);

  // =========================================================================
  // Phase 185 (SAAS-04a) — AUTH-TIER EXCEPTION INVENTORY (D-02/D-05/D-09).
  //
  // Every authenticated JWT router carries tenantContextMiddleware in the
  // chain (auth → tenant → permission, D-09) — enforced per-file by the
  // Plan-02 sweep grep gate. The surfaces BELOW are the documented
  // exceptions that deliberately run OUTSIDE tenant scoping:
  //
  //  1. Health (app.use("/", healthRoutes)) — unauthenticated liveness.
  //  2. /api/auth login/register/sso-status flows — auth tier per D-02
  //     (principal does not exist yet); change-password/set-initial-password/
  //     admin-register/admin-reset-password/GET /users (admin) are JWT
  //     per-route slots INSIDE the auth router, but /me and avatar-self are
  //     the documented auth-tier exceptions (D-02: bootstrap endpoints).
  //  3. /api-docs swagger — documentation surface.
  //  4. /api/__tests__ e2e helpers — dev/test-only process-spawn gate
  //     (404 in production).
  //  5. system.ts wizard-public block (POST /wizard/*, ~:365 comment) —
  //     bootstrap setup, no principal exists yet (D-02).
  //  6. Collector-callback sub-routes (PUT /api/documents/:id/status,
  //     PUT /api/archives/import/:jobId/callback) — X-Collector-Secret
  //     service-to-service, NO principal; run with the bypass sentinel
  //     set (req.tenantBypass, D-05 — citeable in the org-b suite).
  //  7. MCP SSE stream + message (agent/mcpServer.ts mountMCPServer) —
  //     admin/loopback platform surface (D-05 bypass, citeable in the
  //     org-b suite). The /api/mcp-connections CRUD router DOES get the
  //     tenant slot (MCPConnection is Tier-A).
  //  8. ocr.ts imageRouter (GET /:id/jobs/:jobId/pages/:page/image) —
  //     queryTokenAuth (?token= JWT variant for <img> tags) asset-serving;
  //     the ?token= auth tier is the ONLY exception aspect — CR-06 (185-05)
  //     added the explicit org assertion (job.organizationId vs the
  //     requester's D-01 membership org; platform admins keep global
  //     visibility), replacing the pre-185 "mirrors avatar-self D-02"
  //     rationale (which was factually wrong — avatar-self enforces
  //     targetId === requesterId || isAdmin, the image route asserted
  //     nothing). The ocr catalog router carries its own tenant slot.
  //
  // Non-JWT principals (D-08): apiKeyMiddleware seeds req.tenantOrgCandidate
  // from ApiKey.organizationId (validateApiKey extended return — NO
  // membership query); the widget router resolves org from the Widget row
  // via WidgetWorkspace → workspace.organizationId (widgetTenantContext in
  // routes/internalWidget.ts — NEVER the service account's membership).
  // =========================================================================

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
  // Phase 206 (AGENCY-01, D-07): web-agency sub-user management — gated on
  // agency:users:manage (NOT requireAdmin) inside the router.
  app.use("/api/agency", agencyRoutes);
  app.use("/api/quota", quotaRoutes); // Phase 207 (CLOUD-06): reset + usage read
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
  // Phase 190 (SKIL-01 D-21): the custom-skill CRUD + test-preview mount.
  app.use("/api/skills", skillsCrudRouter);
  // Phase 195 (MCPO-01 D-07/Pitfall 2): the public OAuth callback router MUST
  // precede the admin-gated mcpRoutes — Express matches app.use in registration
  // order, and mcpRoutes' router-level authMiddleware+tenant+requireAdmin
  // would 401 the browser redirect. The callback router contains ONLY
  // GET /oauth/callback (no auth); every other /api/mcp-connections path
  // falls through to the admin router below.
  // Phase 202 (PLGM-05): the plugin-manager admin surface — mounted with
  // the other createApp() routes, BEFORE the catch-alls (route registration,
  // not boot wiring: loadManagedPlugins already lives in the boot block).
  app.use("/api/plugins", pluginsRoutes);
  app.use("/api/mcp-connections", mcpOAuthCallbackRouter);
  app.use("/api/mcp-connections", mcpRoutes);
  app.use("/api/mcp-marketplace", marketplaceRoutes);
  // Phase 198 (198-01b, D-06): chat-connector surface — the PUBLIC webhook
  // mini-router mounts FIRST (platform signature is its only auth, NO RBAC),
  // then the admin CRUD router (JWT + tenant + admin + connector:* gates).
  // Both precede the JWT catch-all (widget mount precedent :721).
  // Phase 200 (ECCO-06, Option A): the public CONNECTOR OAuth callback router
  // mounts BEFORE the webhook router — the Slack browser redirect carries no
  // JWT, and only GET /oauth/callback lives there (everything else falls
  // through per-path to the webhook/admin routers below — mcpOAuthCallback
  // mount-order precedent :757).
  app.use("/api/connectors", connectorOAuthCallbackRouter);
  app.use("/api/connectors", connectorsWebhookRouter);
  app.use("/api/connectors", connectorsRoutes);
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
  // 404 handler — canonical envelope (utils/httpError.ts contract).
  app.use((_req, res) => {
    sendError(res, 404, "not_found", "Not found");
  });

  // Error handler — logs the real error server-side WITH the requestId and
  // returns the generic envelope; internal err.message never reaches clients
  // (api-design sweep: never 500-with-leak, never prose-only).
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const requestId = req.requestId;
    logger.error("Unhandled error", { requestId, error: err.message, stack: err.stack });
    res.status(500).json({
      error: {
        code: "internal_error",
        message: "Internal server error",
        requestId,
      },
    });
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

      // Phase 202 (PLGM-03, D-07/Pitfall 1): enterprise DB→env instance-license
      // fallback — an ADDITIVE async boot step between initLicense() and
      // the enterprise plugin load. Without a verified enterprise row the
      // LICENSE_KEY env path is untouched (the cached license stays whatever
      // initLicense() derived); a verified enterprise DB row overrides it via
      // the additive setCachedLicense setter. initLicense() and every sync
      // getLicenseInfo()/getFeatureLimit() call site stay byte-identical —
      // making initLicense async would break the lazy sync call sites
      // (Pitfall 1 warning sign). DB hiccups never kill boot (fail-open to the
      // env fallback, T-202-08).
      await resolveInstanceLicenseFromDB();

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
        // ignore — the /branding download handler's fs arm will 404 if missing
      }

      // Phase 202 (PLGM-01/02, Edge E6): ensure the managed plugin storage
      // dir exists (idempotent, mirrors the branding mkdir precedent) and
      // sweep orphan `.tmp-*` install dirs — an install interrupted by a
      // crash/restart leaves `.tmp-*` staging dirs behind; the boot sweep
      // recovers them (rm dirs older than 10 minutes — a live install is
      // shorter than the cap and the install mutex serializes concurrent
      // installs, so a younger dir is in-flight work, not an orphan).
      try {
        fs.mkdirSync(PLUGINS_STORAGE_DIR, { recursive: true });
        const ORPHAN_TMP_MAX_AGE_MS = 10 * 60 * 1000;
        for (const entry of fs.readdirSync(PLUGINS_STORAGE_DIR)) {
          if (!entry.startsWith(".tmp-")) continue;
          try {
            const stat = fs.statSync(path.join(PLUGINS_STORAGE_DIR, entry));
            if (Date.now() - stat.mtimeMs > ORPHAN_TMP_MAX_AGE_MS) {
              fs.rmSync(path.join(PLUGINS_STORAGE_DIR, entry), { recursive: true, force: true });
              logger.info(`[boot] swept orphan plugin tmp dir: ${entry}`, {});
            }
          } catch {
            // ignore per-entry stat/rm failures — the sweep is best-effort
          }
        }
      } catch {
        // ignore — same fs-arm idiom as the branding mkdir above
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

    // pgboss-queue-pkey-duplicate (2026-09-16): self-heal the queue table BEFORE
    // any scheduler registers. On a healthy table this is a single aggregate
    // query (no-op). When the queue_pkey index/heap divergence produced
    // duplicate queue rows (its failure signature: constant `duplicate key value
    // violates unique constraint "queue_pkey"` warns), it dedups, re-creates the
    // affected queues and REINDEXes the unique index. Never throws (see service
    // contract) — safe to call unguarded here.
    await healPgbossQueueDuplicates();

    // Phase 140 (EPA-01, D-08): load the enterprise plugin AFTER
    // prisma.$connect() + initLicense() and BEFORE the NODE_ENV==="production"
    // scheduler block. Community builds (no @simmetric-chat/enterprise
    // installed) log an info-level no-op and continue. Register-throws is
    // fail-loud (process.exit(1), D-07) — never fail-open. Boot order is
    // enforced by src/__tests__/bootOrder.test.ts.
    await loadEnterprisePlugin(app);

    // Phase 186 (SAAS-05, D-10): SaaS plugin loads AFTER enterprise — boot
    // order pinned by bootOrder.test.ts. Register-throw is fail-loud
    // (process.exit(1), D-09) and CANNOT continue on to the catch-all mount
    // below (sequential awaited step — no half-mounted route surface,
    // T-186-08). Community builds (no @simmetric-chat/saas installed) log an
    // info-level no-op and continue (SC-4).
    await loadSaaSPlugin(app);

    // Phase 202 (PLGM-02, D-09): managed plugins load AFTER SaaS — the
    // pinned chain is loadEnterprisePlugin → loadSaaSPlugin →
    // loadManagedPlugins → authLdapComposite → mountCatchAlls (research
    // Open Q 2). Fail-soft (D-03): a managed register throw records
    // status=failed + lastError and boot CONTINUES to the catch-alls —
    // never process.exit on the managed path. License gate: ONLY
    // licenseMode=platform rows are license-gated (P3 — none/self rows
    // never consult the license service, D6); a platform row without a
    // verified license stays status=installed (never loaded, D4).
    await loadManagedPlugins(app);

    // Phase 193 (LDAP-01, D-13): the community composite login route — the
    // SOLE local-auth fallback arm. Mounted AFTER both plugin loads and
    // BEFORE mountCatchAlls so it receives (a) requests the enterprise LDAP
    // login route deferred via next() on fallback-eligible arms (stage
    // config/unreachable/bindFailure with ldapFallbackToLocal true) and
    // (b) unmatched POST /api/auth/ldap/login requests in community builds
    // (no enterprise plugin installed; serves local auth when the SsoConfig
    // row reports provider "ldap", 404 otherwise). createApp() registers
    // community authRoutes BEFORE the plugins, so exactly one handler owns
    // the response per request — no double-handling is possible. Catch-alls
    // stay last per bootOrder.test.ts.
    app.use("/api/auth", createAuthLdapCompositeRouter());

    // Mount the 404 + error catch-all handlers AFTER loadEnterprisePlugin so
    // enterprise routes are registered before the catch-all and are reachable.
    // (createApp() deliberately omits the catch-all — see its comment.)
    // Phase 186 (D-10/T-186-06): BOTH plugin loads precede the catch-alls —
    // they stay the LAST mount.
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
      await initQuotaResetScheduler(); // Phase 207 (CLOUD-06, D-11): hourly recurring token-quota reset sweep
      // Phase 192 (DLP-01/D-12): document PII scan + legacy backfill consumers
      // (the first one-shot send/work queues). Registered AFTER the cron
      // consumers, mirroring the existing registration order. Each init
      // null-guards getBoss() internally (pg-boss offline = scan offline,
      // logged at warn — never blocks boot).
      await initDlpDocumentScanScheduler();
      await initDlpBackfillScheduler();
      // Phase 195 (MCPO-01 D-12): proactive OAuth token refresh — 5-min cron
      // AFTER initDlpBackfillScheduler() and BEFORE the
      // initializeMCPConnections() fire-and-forget (boot-order invariant,
      // pinned by bootOrder.test.ts). Every refresh is withConnectionLock-
      // wrapped; pg-boss unavailable → warn + no fallback timer (D-12).
      await initMCPOAuthRefreshScheduler();
      // Phase 200 (ECCO-06, D-09): the connector health-check cron — daily
      // sweep of all four platforms (health flip only, NO auto-disable).
      // Awaits inside the PRODUCTION-ONLY block (mcpHealthCheck precedent).
      await initConnectorHealthCheckScheduler();
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
    // Phase 198 (198-03, D-15/P-10): the connector poll scheduler — dev+prod
    // (P-10: the poller must be alive in dev too — outside the pg-boss block
    // above). Long-polls run behind per-connector isRunning guards.
    initConnectorPollScheduler();
    // Phase 199 (199-03, D-05): connect the Discord Gateway clients for every
    // enabled discord connector — dev+prod cluster (beside the poller).
    // FIRE-AND-FORGET with a logged catch: a failing external gateway (or a
    // DB hiccup) must not block server boot — the reconnect ladder owns
    // recovery (the initializeMCPConnections shape above).
    initDiscordGateway().catch((err: unknown) => {
      logger.warn("[server] Discord gateway init failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Graceful shutdown — stop backup jobs before disconnecting.
    // Phase 202 (PLGM-04, D-06): the body lives in services/shutdownSequence.ts
    // (extracted VERBATIM — a move, not a rewrite) so SIGTERM/SIGINT AND the
    // POST /api/plugins/restart route (202-03) share the ONE shutdown path.
    process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
    process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
  });
}

export default createApp;