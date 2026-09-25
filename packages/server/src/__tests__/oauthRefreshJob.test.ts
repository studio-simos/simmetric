// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 195 (MCPO-01 D-12/D-13) — OAuth refresh job tests.
 *
 * Pattern: mcpReaper.test.ts — mock the jobQueue SEAM (getBoss/createQueue/
 * schedule), transparent withConnectionLock, mocked prisma. fetch is stubbed
 * globally (Pitfall 10 — CI runs NETWORK_EGRESS_BLOCKED=1; the fake token
 * endpoint is a stub, never a real network call).
 *
 * Covers:
 *  - initMCPOAuthRefreshScheduler: getBoss null → returns without
 *    createQueue/schedule/work calls, warn logged (D-12 no-fallback-timer).
 *  - scheduler happy path: createQueue → schedule → boss.work registered.
 *  - runOAuthRefreshCycle: expiring row refreshed (blob re-encrypted,
 *    tokenExpiresAt advanced, oauthStatus stays authorized, connectMCPServer
 *    kicked); refresh-provider-error row flips oauthStatus=error + oauthError
 *    set and the cycle CONTINUES to the next row (per-connection isolation);
 *    missing-refreshToken row flips error without a fetch call.
 *  - withConnectionLock WRAPS every refresh (the lock mock records the wrap —
 *    serialization guarantee, D-12).
 *  - Column-predicate-only selection (org-from-the-ROW, Pitfall 8): the
 *    findMany where clause carries authType + tokenExpiresAt only.
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../services/jobQueue", () => ({
  __esModule: true,
  getBoss: jest.fn(),
  createQueue: jest.fn().mockResolvedValue(undefined),
  schedule: jest.fn().mockResolvedValue(undefined),
}));

// Transparent withConnectionLock (mcpReaper.test.ts:60-63 pattern) + mocked
// connectMCPServer — the lock mock RECORDS each wrap so tests assert the
// serialization contract against it.
jest.mock("../agent/mcpClient", () => ({
  disconnectMCPServer: jest.fn(),
  connectMCPServer: jest.fn().mockResolvedValue({ tools: [] }),
  withConnectionLock: jest.fn(async (id: string, fn: () => Promise<unknown>) => {
    (globalThis as unknown as { __lockWraps?: string[] }).__lockWraps?.push(id);
    return fn();
  }),
}));

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
    GOOGLE_CLIENT_ID: "test-google-id",
    GOOGLE_CLIENT_SECRET: "test-google-secret",
  })),
}));

// The Plan 01 OAuth service seams are mocked at the module boundary — the
// job tests assert the job-side logic (selection, lock wrap, row flips,
// kick), not the crypto (covered by oauthExchange.test.ts).
jest.mock("../services/oauthTokenLifecycle", () => ({
  decryptTokenBlob: jest.fn(),
  encryptTokenBlob: jest.fn(),
  refreshAccessToken: jest.fn(),
}));
jest.mock("../services/oauthProviderRegistry", () => ({
  resolveProvider: jest.fn(),
  hasClientConfigured: jest.fn(),
  resolveScopes: jest.fn((_def: unknown, requested?: string) => (requested ? requested.split(/\s+/) : ["default-scope"])),
}));

const lockWraps: string[] = [];
beforeAll(() => {
  (globalThis as unknown as { __lockWraps?: string[] }).__lockWraps = lockWraps;
});
afterAll(() => {
  delete (globalThis as unknown as { __lockWraps?: string[] }).__lockWraps;
});

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { getBoss, createQueue, schedule } from "../services/jobQueue";
import { connectMCPServer, withConnectionLock } from "../agent/mcpClient";
import { refreshAccessToken, decryptTokenBlob, encryptTokenBlob } from "../services/oauthTokenLifecycle";
import { resolveProvider, hasClientConfigured } from "../services/oauthProviderRegistry";
import { runOAuthRefreshCycle, initMCPOAuthRefreshScheduler } from "../services/mcpOAuthRefreshJob";

const mockedFindMany = (prisma as unknown as { mCPConnection: { findMany: jest.Mock } }).mCPConnection.findMany;
const mockedUpdate = (prisma as unknown as { mCPConnection: { update: jest.Mock } }).mCPConnection.update;
const mockGetBoss = getBoss as jest.Mock;
const mockCreateQueue = createQueue as jest.Mock;
const mockSchedule = schedule as jest.Mock;
const mockedConnect = connectMCPServer as jest.Mock;
const mockedWithLock = withConnectionLock as jest.Mock;
const mockedRefresh = refreshAccessToken as jest.Mock;
const mockedDecrypt = decryptTokenBlob as jest.Mock;
const mockedEncrypt = encryptTokenBlob as jest.Mock;
const mockedResolveProvider = resolveProvider as jest.Mock;
const mockedHasClient = hasClientConfigured as jest.Mock;
const mockedLogger = logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock };

const originalFetch = globalThis.fetch;

function expiringRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-expiring",
    authType: "oauth",
    oauthProvider: "google",
    oauthScopes: null,
    credentialsEncrypted: "iv:tag:ct",
    tokenExpiresAt: new Date(Date.now() + 60_000), // 1 min away — inside the window
    oauthStatus: "authorized",
    oauthError: null,
    ...overrides,
  };
}

describe("mcpOAuthRefreshJob (D-12/D-13)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lockWraps.length = 0;
    mockedUpdate.mockResolvedValue({});
    mockedDecrypt.mockReturnValue({
      ok: true,
      blob: { accessToken: "at", refreshToken: "rt", scope: "s", obtainedAt: new Date().toISOString() },
    });
    mockedEncrypt.mockReturnValue("iv:tag:reencrypted");
    mockedResolveProvider.mockReturnValue({ id: "google", tokenUrl: "https://fake/token" });
    mockedHasClient.mockReturnValue(true);
    mockedRefresh.mockResolvedValue({
      ok: true,
      blob: { accessToken: "at2", refreshToken: "rt", scope: "s", obtainedAt: new Date().toISOString() },
    });
    globalThis.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ access_token: "at2", refresh_token: "rt", expires_in: 3600 }),
      } as unknown as Response)
    );
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("initMCPOAuthRefreshScheduler — getBoss null → warn + return, NO createQueue/schedule/work (D-12)", async () => {
    mockGetBoss.mockReturnValue(null);

    await initMCPOAuthRefreshScheduler();

    expect(mockedLogger.warn).toHaveBeenCalledWith(expect.stringContaining("pg-boss unavailable"));
    expect(mockCreateQueue).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
    // No fallback timer — nothing else was scheduled.
    expect(mockGetBoss).toHaveBeenCalledTimes(1);
  });

  it("initMCPOAuthRefreshScheduler — happy path registers createQueue → schedule → work", async () => {
    const workFn = jest.fn().mockResolvedValue(undefined);
    mockGetBoss.mockReturnValue({ work: workFn });

    await initMCPOAuthRefreshScheduler();

    expect(mockCreateQueue).toHaveBeenCalledWith("mcp-oauth-refresh");
    expect(mockSchedule).toHaveBeenCalledWith("mcp-oauth-refresh", "*/5 * * * *");
    expect(workFn).toHaveBeenCalledWith("mcp-oauth-refresh", expect.any(Function));
  });

  it("initMCPOAuthRefreshScheduler — work handler catches cycle errors and never re-throws (retry-storm guard)", async () => {
    const workFn = jest.fn((_queue: string, handler: (jobs: unknown[]) => Promise<void>) => {
      // Invoke the handler synchronously with one fake job — a throwing
      // cycle must be swallowed (resolve = success), never re-thrown.
      handler([{}]).catch(() => {
        throw new Error("handler re-threw — retry storm!");
      });
      return Promise.resolve();
    });
    mockGetBoss.mockReturnValue({ work: workFn });
    mockedFindMany.mockRejectedValue(new Error("db down"));

    await initMCPOAuthRefreshScheduler();

    expect(mockedLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("cycle failed"),
      expect.objectContaining({ error: expect.stringContaining("db") })
    );
  });

  it("runOAuthRefreshCycle — expiring row refreshed: blob re-encrypted, tokenExpiresAt advanced, reconnect kicked", async () => {
    mockedFindMany.mockResolvedValue([expiringRow()]);

    const summary = await runOAuthRefreshCycle();

    expect(summary).toEqual({ candidates: 1, refreshed: 1, failed: 0 });
    // Blob re-encrypted + status kept authorized + error cleared.
    expect(mockedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "conn-expiring" },
        data: expect.objectContaining({
          credentialsEncrypted: "iv:tag:reencrypted",
          oauthStatus: "authorized",
          oauthError: null,
        }),
      })
    );
    const data = mockedUpdate.mock.calls[0][0].data;
    expect(data.tokenExpiresAt).toBeInstanceOf(Date);
    expect((data.tokenExpiresAt as Date).getTime()).toBeGreaterThan(Date.now());
    // Reconnect kick fired.
    expect(mockedConnect).toHaveBeenCalledWith("conn-expiring");
  });

  it("runOAuthRefreshCycle — every refresh wrapped in withConnectionLock (D-12 serialization)", async () => {
    mockedFindMany.mockResolvedValue([expiringRow({ id: "conn-a" }), expiringRow({ id: "conn-b" })]);

    await runOAuthRefreshCycle();

    expect(mockedWithLock).toHaveBeenCalledTimes(2);
    expect(lockWraps).toEqual(expect.arrayContaining(["conn-a", "conn-b"]));
    // The lock mock is transparent — the row's refresh ran THROUGH the wrapper.
    expect(mockedUpdate).toHaveBeenCalledTimes(2);
  });

  it("runOAuthRefreshCycle — selects rows by column predicates ONLY (Pitfall 8, org-from-the-ROW)", async () => {
    mockedFindMany.mockResolvedValue([]);

    await runOAuthRefreshCycle();

    expect(mockedFindMany).toHaveBeenCalledWith({
      where: {
        authType: "oauth",
        tokenExpiresAt: { lt: expect.any(Date) },
      },
    });
  });

  it("runOAuthRefreshCycle — failing refresh flips oauthStatus=error + cycle CONTINUES (per-connection isolation)", async () => {
    mockedRefresh
      .mockResolvedValueOnce({ ok: false, errorDescription: "provider rejected the grant" })
      .mockResolvedValueOnce({
        ok: true,
        blob: { accessToken: "ok", refreshToken: "rt", scope: "s", obtainedAt: new Date().toISOString() },
      });
    mockedFindMany.mockResolvedValue([
      expiringRow({ id: "conn-bad" }),
      expiringRow({ id: "conn-good", tokenExpiresAt: new Date(Date.now() + 60_000) }),
    ]);

    const summary = await runOAuthRefreshCycle();

    expect(summary).toEqual({ candidates: 2, refreshed: 1, failed: 1 });
    // The bad row flipped to error with the provider message.
    expect(mockedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "conn-bad" },
        data: expect.objectContaining({ oauthStatus: "error", oauthError: "provider rejected the grant" }),
      })
    );
    // The good row still refreshed (cycle did not abort).
    expect(mockedConnect).toHaveBeenCalledWith("conn-good");
  });

  it("runOAuthRefreshCycle — missing refreshToken flips error WITHOUT a fetch call", async () => {
    mockedDecrypt.mockReturnValue({
      ok: true,
      blob: { accessToken: "at", refreshToken: undefined, scope: "s", obtainedAt: new Date().toISOString() },
    });
    mockedFindMany.mockResolvedValue([expiringRow()]);

    const summary = await runOAuthRefreshCycle();

    expect(summary).toEqual({ candidates: 1, refreshed: 0, failed: 1 });
    expect(mockedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "conn-expiring" },
        data: expect.objectContaining({ oauthStatus: "error" }),
      })
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockedRefresh).not.toHaveBeenCalled();
  });

  it("runOAuthRefreshCycle — unconfigured provider client flips error without a refresh call (D-06)", async () => {
    mockedHasClient.mockReturnValue(false);
    mockedFindMany.mockResolvedValue([expiringRow()]);

    const summary = await runOAuthRefreshCycle();

    expect(summary).toEqual({ candidates: 1, refreshed: 0, failed: 1 });
    expect(mockedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ oauthStatus: "error", oauthError: "provider client not configured" }),
      })
    );
    expect(mockedRefresh).not.toHaveBeenCalled();
  });
});