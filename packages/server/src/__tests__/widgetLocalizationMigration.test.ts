// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Widget localization migration tests — I18N-01/02, QST-01/02, CRD-01/02/04, D-04/D-08
 *
 * Tests the per-widget localization data model end-to-end at the route boundary:
 *  1. Prisma schema fields exist (localizedTexts/suggestedQuestions/credits Json?,
 *     fallbackLocale String @default("en"))
 *  2. POST /api/widgets tri-state passthrough — populated blobs → raw jsonb objects,
 *     null → Prisma.DbNull (SQL NULL), fallbackLocale passes through
 *  3. PUT /api/widgets/:id tri-state passthrough — populated blob → raw object,
 *     null → Prisma.DbNull, omitted blobs → undefined (partial-update semantics)
 *  4. Migration is additive (ALTER TABLE ADD COLUMN x4, Json columns nullable, no default)
 *  5. audit:migrations report shows 20/20/0 (additive, 0 destructive)
 */
import "./helpers/setupEnv";

import fs from "fs";
import path from "path";
import { Prisma } from "@prisma/client";

// ── Prisma mock (shared factory) ──────────────────────────────────
jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
  })),
}));

jest.mock("../services/licenseService", () => ({
  initLicense: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  getLicenseInfo: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  isFeatureEnabled: jest.fn(() => false),
  getFeatureLimit: jest.fn(() => 1),
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({ seedConfigDefaults: jest.fn() }));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
// internalWidget.ts imports hybridSearchWithRerank at module load — mock to avoid
// pulling in the full hybrid search service chain (LanceDB, embeddings, etc.).
jest.mock("../services/hybridSearchService", () => ({
  hybridSearchWithRerank: jest.fn(),
}));
jest.mock("../services/widgetCacheBustService", () => ({ fireWidgetCacheBust: jest.fn() }));

// Mock auth middleware: admin Bearer + widget API-key paths
jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    req.userId = "admin-001";
    req.user = {
      id: "admin-001",
      roles: [{ role: { name: "admin", permissions: [{ permissionName: "admin:settings" }] } }],
    };
    next();
  },
  apiKeyMiddleware: (req: any, res: any, next: any) => {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) {
      res.status(401).json({ error: "Missing API key" });
      return;
    }
    req.userId = "service-account-001";
    req.user = { id: "service-account-001", username: "widget-service", roles: [] };
    next();
  },
}));

import request from "supertest";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { isFeatureEnabled } from "../services/licenseService";
import { generateTestToken } from "./helpers/mockAuth";

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

// Base mock widget — includes all fields the route reads, plus the 4 new
// localization fields (D-02..D-05): blobs null (not configured), fallbackLocale "en".
const mockWidget: Record<string, unknown> = {
  id: "widget-001",
  name: "Test Widget",
  welcomeMessage: "Hello!",
  fallbackMessage: "Sorry, I can't help with that.",
  position: "bottom-right",
  isActive: true,
  primaryColor: "#4c6ef5",
  botName: "AI Assistant",
  logoUrl: null,
  avatarUrl: null,
  autoOpenDelay: null,
  autoOpenUrlPatterns: null,
  exitIntentEnabled: false,
  exitIntentCooldownMs: 1800000,
  leadCaptureEnabled: false,
  leadCapturePrompt: null,
  rateLimitPerMinute: null,
  localizedTexts: null,
  suggestedQuestions: null,
  credits: null,
  fallbackLocale: "en",
  createdBy: "admin-001",
  deletedAt: null,
  createdAt: new Date("2025-01-01"),
  updatedAt: new Date("2025-01-01"),
  workspaces: [{ workspaceId: "workspace-001" }],
  _count: { sessions: 0 },
};

// ─── Test 1: Widget model in schema.prisma includes the 4 new fields ─────────

describe("Widget localization Prisma schema fields", () => {
  it("schema.prisma Widget model includes localizedTexts/suggestedQuestions/credits Json? and fallbackLocale String @default(\"en\")", () => {
    const schemaPath = path.resolve(__dirname, "../../prisma/schema.prisma");
    const schema = fs.readFileSync(schemaPath, "utf-8");
    // Extract the Widget model block (from "model Widget {" to the closing "}")
    const widgetModelMatch = schema.match(/model Widget \{[\s\S]*?^\}/m);
    expect(widgetModelMatch).not.toBeNull();
    const widgetModel = widgetModelMatch![0];
    // Three nullable Json (jsonb) blobs (D-02)
    expect(widgetModel).toMatch(/localizedTexts\s+Json\?/);
    expect(widgetModel).toMatch(/suggestedQuestions\s+Json\?/);
    expect(widgetModel).toMatch(/credits\s+Json\?/);
    // fallbackLocale String with "en" default (D-08)
    expect(widgetModel).toMatch(/fallbackLocale\s+String\s+@default\("en"\)/);
  });
});

// ─── Test 2: POST /api/widgets tri-state passthrough ─────────────────────────

describe("POST /api/widgets localization tri-state passthrough", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isFeatureEnabled as jest.Mock).mockReturnValue(true);
    (prisma.widget.count as jest.Mock).mockResolvedValue(0);
    (prisma.widget.create as jest.Mock).mockImplementation(({ data }: any) => ({
      ...mockWidget,
      ...data,
    }));
  });

  it("passes populated blobs through as raw jsonb objects and fallbackLocale through the spread", async () => {
    const res = await request(app)
      .post("/api/widgets")
      .set(adminAuth())
      .send({
        name: "Localized Widget",
        localizedTexts: { en: { welcomeMessage: "Hi" } },
        suggestedQuestions: { en: ["Q1"] },
        credits: { enabled: true, label: "Simmetric", url: "https://simmetric.chat" },
        fallbackLocale: "de",
      });

    expect(res.status).toBe(201);
    expect(prisma.widget.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          localizedTexts: { en: { welcomeMessage: "Hi" } },
          suggestedQuestions: { en: ["Q1"] },
          credits: { enabled: true, label: "Simmetric", url: "https://simmetric.chat" },
          fallbackLocale: "de",
        }),
      })
    );
  });

  it("translates null blobs to Prisma.DbNull (SQL NULL = not configured, D-04)", async () => {
    const res = await request(app)
      .post("/api/widgets")
      .set(adminAuth())
      .send({ name: "Null Blob Widget", suggestedQuestions: null });

    expect(res.status).toBe(201);
    // Identity check against the real sentinel — the route must write SQL NULL,
    // not JSON null (Prisma.DbNull is a class instance; toEqual works on identity).
    expect(prisma.widget.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ suggestedQuestions: Prisma.DbNull }),
      })
    );
  });
});

// ─── Test 3: PUT /api/widgets/:id tri-state passthrough ──────────────────────

describe("PUT /api/widgets/:id localization tri-state passthrough", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (prisma.widget.update as jest.Mock).mockImplementation(({ data }: any) => ({
      ...mockWidget,
      ...data,
    }));
  });

  it("passes a populated blob through as a raw jsonb object", async () => {
    const res = await request(app)
      .put("/api/widgets/widget-001")
      .set(adminAuth())
      .send({ localizedTexts: { it: { welcomeMessage: "Ciao" } } });

    expect(res.status).toBe(200);
    expect(prisma.widget.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ localizedTexts: { it: { welcomeMessage: "Ciao" } } }),
      })
    );
  });

  it("translates null blobs to Prisma.DbNull on update", async () => {
    const res = await request(app)
      .put("/api/widgets/widget-001")
      .set(adminAuth())
      .send({ suggestedQuestions: null });

    expect(res.status).toBe(200);
    expect(prisma.widget.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ suggestedQuestions: Prisma.DbNull }),
      })
    );
  });

  it("omits blob values entirely when not sent (undefined passthrough — partial-update semantics)", async () => {
    const res = await request(app)
      .put("/api/widgets/widget-001")
      .set(adminAuth())
      .send({ name: "Renamed Widget" });

    expect(res.status).toBe(200);
    const updateCall = (prisma.widget.update as jest.Mock).mock.calls[0][0];
    // The route's data object carries the blob keys with value `undefined`
    // (toJsonWriteValue(undefined) → undefined) — Prisma ignores undefined
    // values in data objects, so the stored blobs are left unchanged. The
    // contract to prove is "no default injection": the value must be
    // undefined, NOT Prisma.DbNull and NOT a blob object.
    expect(updateCall.data.localizedTexts).toBeUndefined();
    expect(updateCall.data.suggestedQuestions).toBeUndefined();
    expect(updateCall.data.credits).toBeUndefined();
    // The actual update still flows through
    expect(updateCall.data.name).toBe("Renamed Widget");
  });

  it("accepts the full-form edit payload (empty legacy scalars omitted + localizedTexts blob + fallbackLocale) through updateWidgetSchema (G-128-3 round-trip)", async () => {
    // This is the EXACT payload shape WidgetForm.handleSubmit now produces in
    // edit mode when the legacy textareas are empty and only the IT
    // localization is filled (G-128-3 root cause: the old form sent
    // welcomeMessage: null / fallbackMessage: null, which
    // updateWidgetSchema — z.string().optional(), NOT nullable — rejected
    // with 400, aborting the ENTIRE PUT so the blob never reached Prisma).
    const res = await request(app)
      .put("/api/widgets/widget-001")
      .set(adminAuth())
      .send({
        name: "Localized Widget",
        position: "bottom-right",
        isActive: true,
        primaryColor: "#4c6ef5",
        // Empty legacy scalars are OMITTED (fixed form) — the fields below
        // are the nullable ones the form still sends as null (schema accepts
        // null for these: autoOpenDelay/leadCapturePrompt/allowedOrigins are
        // .nullable().optional()).
        autoOpenDelay: null,
        exitIntentEnabled: false,
        exitIntentCooldownMs: 1800000,
        leadCaptureEnabled: false,
        leadCapturePrompt: null,
        allowedOrigins: null,
        fallbackLocale: "it",
        localizedTexts: { it: { welcomeMessage: "Benvenuto" } },
      });

    expect(res.status).toBe(200);
    // The localizedTexts blob must reach the Prisma update (raw jsonb object)
    expect(prisma.widget.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          localizedTexts: { it: { welcomeMessage: "Benvenuto" } },
          fallbackLocale: "it",
          name: "Localized Widget",
        }),
      })
    );
  });
});

// ─── Test 4: Additive migration (nullable Json columns, no default) ──────────

describe("widget localization migration is additive", () => {
  // Phase 138 squashed all 25 migrations into 00000000000000_init. The
  // localization columns now live in the squashed baseline's CREATE TABLE.
  it("squashed baseline contains the widget localization columns", () => {
    const migrationsDir = path.resolve(__dirname, "../../prisma/migrations");
    const dirs = fs.readdirSync(migrationsDir);
    const migrationDir = dirs.find((d) => d.includes("00000000000000_init"));
    expect(migrationDir).toBeDefined();
  });

  it("squashed baseline SQL contains all 4 localization columns and is additive (no destructive patterns)", () => {
    const migrationsDir = path.resolve(__dirname, "../../prisma/migrations");
    const baselineSqlPath = path.join(migrationsDir, "00000000000000_init", "migration.sql");
    const sql = fs.readFileSync(baselineSqlPath, "utf-8");
    // In the squashed baseline the columns appear in CREATE TABLE (not ALTER TABLE ADD COLUMN).
    // Search for the column definitions in the widgets table DDL.
    expect(sql).toMatch(/"localizedTexts"\s+JSONB/);
    expect(sql).toMatch(/"suggestedQuestions"\s+JSONB/);
    expect(sql).toMatch(/"credits"\s+JSONB/);
    expect(sql).toMatch(/"fallbackLocale"\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'en'/);
    // No destructive patterns (D-08: audit must classify additive)
    expect(sql).not.toMatch(/DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM/i);
  });
});

// ─── Test 5: audit:migrations report (10/9/1 post-260829-xb1) ─────────────

describe("audit:migrations classification", () => {
  // Phase 138 squashed 25 migrations into 1 additive baseline.
  // Phase 143 (Plan 03) added the idempotent enterprise_add_sso_models
  // migration (CREATE TABLE IF NOT EXISTS — additive). Phases 146/151 added
  // the enterprise backup models + searchVectorMulti migrations (all
  // additive). 151-02 (Task 5) added
  // 20260820120000_add_widget_session_limit_per_day (ADD COLUMN — additive).
  // Phase 163-01 (SCALE-03, CC-02 documented exception) added
  // 20260827120000_api_keys_key_hash_hmac (DROP COLUMN + DELETE + ADD COLUMN
  // — destructive by design: bcrypt hashes cannot convert to HMAC digests).
  // Quick 260829-ony added 20260829120000_add_dlp_patterns (CREATE TABLE +
  // built-in seed INSERTs — all additive).
  // Quick 260829-xb1 added 20260829215854_add_dlp_patterns_eu (data-only
  // seed INSERTs for the EU/IT DLP built-ins — additive).
  // Phase 181 flattened the 11-migration trail to a SINGLE additive init
  // (00000000000000_init — 53 tables, byte-identical to the live schema;
  // the destructive bcrypt→HMAC api_keys history is gone from the tree,
  // preserved in the private repo history).
  // Phase 182 (M1-M4, 182-02) added the four tenancy-substrate migrations
  // on top of the flattened init — all classified additive (Organization +
  // OrganizationMember tables, 26-table organizationId backfill, NOT NULL
  // + defaults). The audit now reports 5 migrations, 5 additive,
  // 0 destructive.
  // Phase 183 (M5, 183-03) added the SystemConfig composite-unique swap
  // (DROP INDEX scalar unique + CREATE UNIQUE INDEX composite + partial
  // unique — all additive per the audit gate's pattern-4 DROP INDEX
  // whitelist). The audit now reports 6 migrations, 6 additive,
  // 0 destructive.
  // Phase 184 (M6, 184-01) added the additive storageKey columns on
  // documents + upload_drafts with the null-guarded backfill
  // (storageKey = filePath — path-as-key, no file moves). The audit now
  // reports 7 migrations, 7 additive, 0 destructive.
  // Phase 189 (D-24) added the wsis_workspace_access_roles batch (5 additive
  // columns, role backfill pinned ADD-before-UPDATE). Phase 190 (SKIL-01)
  // added the skil_agent_skills_custom batch (10 additive columns + partial
  // unique slug + org index + 3 FKs). The audit now reports 9 migrations,
  // 9 additive, 0 destructive.
  // quick 260918-p3h: +3 migration batches (qoh widget prompt, oa9 ocr mode,
  // p3h ingest progress/cancelledAt) → 12 total, still all-additive.
  // Phase 191 (KNOW-02 D-05): the know_chat_attached_archive_ids batch adds
  // the additive Chat.attachedArchiveIds scalar-list column → 14 total,
  // still all-additive.
  // 191-07 (IN-04 review fix): the pin asserts the INVARIANT (the committed
  // audit is self-consistent and all-additive — Additive === Total &&
  // Destructive === 0) instead of a magic count. The literal "Total: 14"
  // line had already drifted once at the phase's diff base (a migration
  // landed without bumping the pin — the 4th such breakage); deriving the
  // expectation from the audit's own counts removes the recurring breakage
  // while still failing the suite when a DESTRUCTIVE migration lands
  // (Additive < Total) or the audit drifts from disk (see audit:migrations
  // CI drift-check).
  it("committed MIGRATION_AUDIT.md is all-additive (Additive === Total, Destructive === 0)", () => {
    const auditPath = path.resolve(__dirname, "../../../../docs/MIGRATION_AUDIT.md");
    const audit = fs.readFileSync(auditPath, "utf-8");
    const totalLine = audit
      .split("\n")
      .find((l) => l.includes("**Total:**"));
    expect(totalLine).toBeDefined();
    const total = Number((totalLine as string).match(/\*\*Total:\*\* (\d+)/)?.[1]);
    const additive = Number((totalLine as string).match(/\*\*Additive:\*\* (\d+)/)?.[1]);
    const destructive = Number((totalLine as string).match(/\*\*Destructive:\*\* (\d+)/)?.[1]);
    expect(Number.isFinite(total)).toBe(true);
    expect(Number.isFinite(additive)).toBe(true);
    expect(Number.isFinite(destructive)).toBe(true);
    expect(total).toBeGreaterThan(0);
    // The invariant that actually matters: every migration on the books is
    // additive (the additive-only policy), regardless of the count.
    expect(additive).toBe(total);
    expect(destructive).toBe(0);
  });
});
