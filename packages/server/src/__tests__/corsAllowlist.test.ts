// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SEC-01 — CORS allowlist preflight tests (supertest, no app.listen).
 *
 * Verifies:
 *  - allowlisted Origin preflight returns Access-Control-Allow-Origin: <origin>
 *  - non-allowlisted Origin preflight returns no ACAO header
 *  - /api/internal/widget paths are excluded from the global cors (widgetCors
 *    remains sole authority; with no DB widget match it returns 403 + no ACAO)
 *  - unset ALLOWED_ORIGINS falls back to the dev-friendly default (contains localhost:5173)
 */
import "./helpers/setupEnv";

// Mock prisma so widgetCors's DB lookup returns no match without a live DB.
// The global cors callback consumes getEnv().ALLOWED_ORIGINS (real env), so env
// is NOT mocked — clearEnvCache() between tests re-parses process.env.
jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  const mock = createMockPrisma();
  return { __esModule: true, default: mock.prisma };
});

import { createApp } from "../index";
import { clearEnvCache } from "../config/env";
import prisma from "../utils/prisma";
import request from "supertest";

const app = createApp();

const TEST_ALLOWLIST = "http://localhost:5173,http://127.0.0.1:5173";

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  process.env.ALLOWED_ORIGINS = TEST_ALLOWLIST;
  clearEnvCache();
  // widgetCors DB lookup returns no widgets → origin not allowed → 403, no ACAO.
  (prisma.widget.findMany as jest.Mock).mockResolvedValue([]);
});

afterEach(() => {
  delete process.env.ALLOWED_ORIGINS;
  clearEnvCache();
  (prisma.widget.findMany as jest.Mock).mockReset();
});

describe("SEC-01 CORS allowlist preflight", () => {
  it("allowlisted origin preflight returns ACAO: <origin>", async () => {
    const res = await request(app)
      .options("/api/health")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "POST")
      .expect(204);

    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5173",
    );
  });

  it("non-allowlisted origin preflight returns no ACAO header", async () => {
    const res = await request(app)
      .options("/api/health")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "POST");

    // Non-allowlisted → cors origin callback returns false → next() falls
    // through to the 404 catch-all (no OPTIONS handler on /api/health).
    // The security gate is the absence of an ACAO header regardless of status.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("widget path excluded from global cors (no double-CORS, widgetCors sole authority)", async () => {
    const res = await request(app)
      .options("/api/internal/widget/anything")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "POST");

    // Global cors wrapper skipped this path → no ACAO from global cors.
    // widgetCors found no DB widget match → 403 + no ACAO.
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("unset ALLOWED_ORIGINS falls back to default (contains localhost:5173)", async () => {
    delete process.env.ALLOWED_ORIGINS;
    clearEnvCache();

    const res = await request(app)
      .options("/api/health")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "POST")
      .expect(204);

    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5173",
    );
  });
});