// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 69 — Plan 69-03 Task 2.
 *
 * Unit tests for `runReaperCycle` covering DST-05:
 *   - soft-deletes expired drafts and unlinks their files (happy path)
 *   - A5 prefix guard rejects path traversal (3 variants):
 *       * `/etc/passwd` (absolute outside BASE)
 *       * `storage/documents/<uuid>` (sibling dir — Invariant 2)
 *       * `storage/uploads/drafts-evil/payload` (sibling prefix, +path.sep rejects)
 *   - skips done drafts (DB-level selector excludes parseStatus=done)
 *   - unlink failure is best-effort (soft-delete persists, no throw)
 *
 * Phase 165 (Q-02/Q-03): the "mutex overlap" test (which asserted the
 * cycle-internal running-flag guard short-circuited a concurrent call) was
 * REMOVED — the guard is gone (Pitfall 8); pg-boss delivers one job at a
 * time and its SKIP LOCKED dedup supersedes the in-process guard. A new
 * `init*Scheduler` describe block asserts pg-boss registration
 * (createQueue + schedule + boss.work) and the D-02 null path. The cycle-
 * body tests (A5 guard, soft-delete, unlink) are UNCHANGED — the reaping
 * logic was not modified by the migration. The mock boundary is at
 * `jobQueue.ts` (Pattern 3 — mock the seam, not pg-boss directly); the
 * `__mocks__/pg-boss.ts` manual mock handles transitive ESM loads.
 *
 * B1 fix propagation (iter-2 plan-checker verified):
 *   - The reaper no longer imports `getEnv` from `../config/env`; do NOT mock
 *     it here (a dead mock would hide the real A5 base resolution).
 *   - Happy-path fixtures are built as `path.join(BASE, "<id>")` so
 *     `path.resolve` inside the reaper yields exactly `BASE + "<id>"` and the
 *     A5 `startsWith(BASE)` check passes. Rejection fixtures use paths that
 *     `path.resolve` maps OUTSIDE `BASE`.
 *
 * `BASE` is computed the same way the reaper computes it:
 *   `path.resolve("storage/uploads/drafts") + path.sep`
 * which resolves relative to `process.cwd()` (the jest cwd is
 * `packages/server`).
 */
import "./helpers/setupEnv";

import path from "path";

// --- Prisma mock ----------------------------------------------------------
// NOTE: mock object lives INSIDE the factory to avoid TDZ under @swc/jest
// (SWC hoists ESM imports above `const`; factory runs at import-time before
// the outer const would initialize). Exposed via require() after jest.mock.
jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    uploadDraft: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
  },
  withSoftDelete: (where: unknown) => where,
}));
const mockPrisma = require("../utils/prisma").default;

// --- fs mock (capture unlinkSync; keep readFileSync etc. from real fs) ----
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    unlinkSync: jest.fn(),
    // readFileSync is unused by runReaperCycle, but keep it available in case
    // module-scope helpers need it.
    readFileSync: actual.readFileSync,
  };
});

// --- logger mock ----------------------------------------------------------
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Phase 165 (Pattern 3): mock the jobQueue seam — getBoss/createQueue/schedule.
// The mock boundary is jobQueue, NOT pg-boss directly. The __mocks__/pg-boss.ts
// manual mock handles transitive ESM loads (Pitfall 6). Under @swc/jest the
// factory cannot reference outer variables, so it creates its own jest.fn()
// handles; tests retrieve them via the mocked imports below.
jest.mock("../services/jobQueue", () => ({
  __esModule: true,
  getBoss: jest.fn(),
  createQueue: jest.fn().mockResolvedValue(undefined),
  schedule: jest.fn().mockResolvedValue(undefined),
}));

// 260829-kkn: mock the systemConfigService seam — the scheduler now reads
// upload_draft_reaper_enabled / upload_draft_reaper_cron via getSetting.
// Same TDZ-safe pattern as the prisma mock above (@swc/jest hoists imports;
// factories cannot reference outer consts) — the handle is grabbed via
// require() after the mock so each describe can programme it.
jest.mock("../services/systemConfigService", () => ({
  __esModule: true,
  getSetting: jest.fn(),
}));
const { getSetting: mockGetSetting } = require("../services/systemConfigService") as {
  getSetting: jest.Mock;
};

// INTENTIONALLY NOT mocking `../config/env` — the reaper (after B1) no longer
// imports getEnv. A dead mock here would hide the real A5 base resolution.

import fs from "fs";
import { logger } from "../utils/logger";
import { getBoss, createQueue, schedule } from "../services/jobQueue";
import { runReaperCycle, initUploadDraftReaperScheduler } from "../services/uploadDraftReaperJob";

// BASE mirrors the reaper's `path.resolve("storage/uploads/drafts") + path.sep`.
const BASE = path.resolve("storage/uploads/drafts") + path.sep;

const mockGetBoss = getBoss as jest.Mock;
const mockCreateQueue = createQueue as jest.Mock;
const mockSchedule = schedule as jest.Mock;
const mockedLogger = logger as unknown as {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no expired drafts
  mockPrisma.uploadDraft.findMany.mockResolvedValue([]);
  (fs.unlinkSync as unknown as jest.Mock).mockImplementation(() => {});
});

describe("runReaperCycle", () => {
  it("soft-deletes expired drafts and unlinks their files", async () => {
    const filePath = path.join(BASE, "d1");
    mockPrisma.uploadDraft.findMany.mockResolvedValue([
      { id: "d1", filePath },
    ]);
    (mockPrisma.uploadDraft.update as jest.Mock).mockResolvedValue({});

    const result = await runReaperCycle();

    expect(result).toEqual({ reaped: 1, skipped: 0, errors: 0 });
    // Soft-delete FIRST (T-69-05e)
    expect(mockPrisma.uploadDraft.update).toHaveBeenCalledWith({
      where: { id: "d1" },
      data: { deletedAt: expect.any(Date) },
    });
    // Unlink the resolved path
    expect(fs.unlinkSync).toHaveBeenCalledWith(filePath);
  });

  it("A5 prefix guard rejects path traversal /etc/passwd", async () => {
    // Absolute path outside BASE — path.resolve("/etc/passwd") returns
    // "/etc/passwd" which does NOT start with BASE (deterministic regardless
    // of process.cwd() depth).
    mockPrisma.uploadDraft.findMany.mockResolvedValue([
      { id: "d2", filePath: "/etc/passwd" },
    ]);

    const result = await runReaperCycle();

    expect(result).toEqual({ reaped: 0, skipped: 1, errors: 0 });
    // A5 guard is a hard stop before any mutation — NO soft-delete, NO unlink
    expect(mockPrisma.uploadDraft.update).not.toHaveBeenCalled();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it("A5 prefix guard rejects storage/documents/<uuid> (already-indexed RAG file)", async () => {
    // Under `storage/` but NOT under `storage/uploads/drafts/` (Invariant 2:
    // RAG-indexed files live in `storage/documents/`).
    const siblingDir = path.resolve(process.cwd(), "storage/documents", "abc-uuid");
    mockPrisma.uploadDraft.findMany.mockResolvedValue([
      { id: "d3", filePath: siblingDir },
    ]);

    const result = await runReaperCycle();

    expect(result).toEqual({ reaped: 0, skipped: 1, errors: 0 });
    expect(mockPrisma.uploadDraft.update).not.toHaveBeenCalled();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it("A5 prefix guard rejects drafts-evil sibling prefix (no path.sep match)", async () => {
    // Sibling-prefix edge: `drafts-evil/payload` does NOT start with `drafts/`
    // because the A5 guard appends `path.sep` to BASE.
    const evilPath = path.resolve(process.cwd(), "storage/uploads/drafts-evil", "payload");
    mockPrisma.uploadDraft.findMany.mockResolvedValue([
      { id: "d4", filePath: evilPath },
    ]);

    const result = await runReaperCycle();

    expect(result).toEqual({ reaped: 0, skipped: 1, errors: 0 });
    expect(mockPrisma.uploadDraft.update).not.toHaveBeenCalled();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it("skips done drafts (selector excludes parseStatus=done)", async () => {
    let capturedWhere: any = null;
    mockPrisma.uploadDraft.findMany.mockImplementation((args: any) => {
      capturedWhere = args.where;
      return [];
    });

    await runReaperCycle();

    // D-69-07 selector — done drafts are excluded at the DB level, not
    // post-filtered.
    expect(capturedWhere).not.toBeNull();
    expect(capturedWhere.parseStatus).toEqual({ not: "done" });
    expect(capturedWhere.deletedAt).toBeNull();
    expect(capturedWhere.expiresAt).toEqual({ lt: expect.any(Date) });
  });

  it("unlink failure is best-effort: soft-delete persists, error logged, no throw", async () => {
    const filePath = path.join(BASE, "d5");
    mockPrisma.uploadDraft.findMany.mockResolvedValue([
      { id: "d5", filePath },
    ]);
    (mockPrisma.uploadDraft.update as jest.Mock).mockResolvedValue({});
    // Unlink throws — soft-delete already happened (T-69-05e idempotency)
    (fs.unlinkSync as unknown as jest.Mock).mockImplementation(() => {
      throw new Error("EACCES");
    });

    // No throw — cycle resolves
    const result = await runReaperCycle();

    expect(result).toEqual({ reaped: 0, skipped: 0, errors: 1 });
    // Soft-delete happened BEFORE the unlink attempt
    expect(mockPrisma.uploadDraft.update).toHaveBeenCalledWith({
      where: { id: "d5" },
      data: { deletedAt: expect.any(Date) },
    });
  });
});

describe("initUploadDraftReaperScheduler pg-boss registration (Phase 165, Q-02)", () => {
  // Default boss instance with a work stub whose calls the tests inspect.
  const bossWork = jest.fn().mockResolvedValue("worker-id-1");
  // 260829-kkn: stale schedule-row cleanup handle (disabled path calls it).
  const bossUnschedule = jest.fn().mockResolvedValue(undefined);
  // 260829-kkn: helper to programme the getSetting mock for both keys.
  const setReaperSettings = (enabled: string, cron: string) => {
    mockGetSetting.mockImplementation((key: string) => {
      if (key === "upload_draft_reaper_enabled") {
        return Promise.resolve({ key, value: enabled, readOnly: false });
      }
      if (key === "upload_draft_reaper_cron") {
        return Promise.resolve({ key, value: cron, readOnly: false });
      }
      return Promise.resolve({ key, value: "", readOnly: false });
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateQueue.mockResolvedValue(undefined);
    mockSchedule.mockResolvedValue(undefined);
    bossWork.mockClear();
    bossWork.mockResolvedValue("worker-id-1");
    bossUnschedule.mockClear();
    bossUnschedule.mockResolvedValue(undefined);
    mockGetBoss.mockReturnValue({ work: bossWork, unschedule: bossUnschedule });
    // Default config: enabled "true", cadence "0 3 * * *" (CONFIG_DEFAULTS
    // values) — existing tests exercise the enabled default path.
    setReaperSettings("true", "0 3 * * *");
    // Default: no expired drafts so the work handler's runReaperCycle is a no-op.
    mockPrisma.uploadDraft.findMany.mockResolvedValue([]);
  });

  it("registers queue + cron schedule + work handler", async () => {
    await initUploadDraftReaperScheduler();

    // D-04: queue name matches the Phase 161 lock resource key.
    expect(mockCreateQueue).toHaveBeenCalledWith("reaper_upload-draft");
    // D-05: daily 03:00 cron expression.
    expect(mockSchedule).toHaveBeenCalledWith("reaper_upload-draft", "0 3 * * *");
    // boss.work registered with the queue name and a handler function.
    expect(bossWork).toHaveBeenCalledTimes(1);
    expect(bossWork.mock.calls[0][0]).toBe("reaper_upload-draft");
    expect(typeof bossWork.mock.calls[0][1]).toBe("function");
    // createQueue precedes schedule (Pitfall 1 — foreign-key constraint).
    expect(mockCreateQueue.mock.invocationCallOrder[0]!).toBeLessThan(
      mockSchedule.mock.invocationCallOrder[0]!,
    );
  });

  it("D-02: getBoss() === null → logs warn + returns early (no createQueue/schedule/work)", async () => {
    mockGetBoss.mockReturnValue(null);

    await initUploadDraftReaperScheduler();

    expect(mockCreateQueue).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(bossWork).not.toHaveBeenCalled();
    // D-02: warn log mentions pg-boss unavailable.
    const warnCalls = mockedLogger.warn.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes("pg-boss unavailable"))).toBe(true);
  });

  it("work handler calls runReaperCycle on each job (Pitfall 2 — Job[] array)", async () => {
    await initUploadDraftReaperScheduler();
    const handler = bossWork.mock.calls[0][1];

    // Stage an expired draft inside BASE so runReaperCycle soft-deletes +
    // unlinks it — proves the cycle actually ran inside the work handler.
    const filePath = path.join(BASE, "w1");
    mockPrisma.uploadDraft.findMany.mockResolvedValue([{ id: "w1", filePath }]);
    (mockPrisma.uploadDraft.update as jest.Mock).mockResolvedValue({});
    (fs.unlinkSync as unknown as jest.Mock).mockImplementation(() => {});

    // pg-boss passes a Job[] array (Pitfall 2). The handler iterates with
    // for...of and runs the cycle once per job.
    const job = {
      id: "j1",
      data: {},
      name: "reaper_upload-draft",
      expireInSeconds: 300,
      heartbeatSeconds: null,
      signal: new AbortController().signal,
    };
    await expect(handler([job])).resolves.toBeUndefined();

    // The cycle ran → soft-delete + unlink called for the staged draft.
    expect(mockPrisma.uploadDraft.update).toHaveBeenCalledWith({
      where: { id: "w1" },
      data: { deletedAt: expect.any(Date) },
    });
    expect(fs.unlinkSync).toHaveBeenCalledWith(filePath);
  });

  it("Pitfall 3: work handler catches cycle errors and resolves (no re-throw → no retry storm)", async () => {
    await initUploadDraftReaperScheduler();
    const handler = bossWork.mock.calls[0][1];

    // Force runReaperCycle to throw by making findMany reject.
    mockPrisma.uploadDraft.findMany.mockRejectedValue(new Error("cycle boom"));

    // Handler must NOT re-throw — it logs and resolves (pg-boss sees success).
    await expect(handler([{ id: "j1", data: {}, name: "reaper_upload-draft" }])).resolves.toBeUndefined();
    expect(mockedLogger.error).toHaveBeenCalled();
  });

  // ─── 260829-kkn: config-driven scheduler paths ───────────────────────

  it("260829-kkn: disabled toggle → no queue/schedule/work, unschedules stale row, logs info", async () => {
    setReaperSettings("false", "0 3 * * *");

    await initUploadDraftReaperScheduler();

    expect(mockCreateQueue).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(bossWork).not.toHaveBeenCalled();
    // T-KKN-03: stale schedule-row cleanup from a prior enabled boot.
    expect(bossUnschedule).toHaveBeenCalledTimes(1);
    expect(bossUnschedule).toHaveBeenCalledWith("reaper_upload-draft");
    const infoCalls = mockedLogger.info.mock.calls.map((c) => String(c[0]));
    expect(infoCalls.some((m) => m.includes("disabled"))).toBe(true);
  });

  it("260829-kkn: fail-closed enabled parse — only the literal \"true\" enables", async () => {
    for (const disabled of ["FALSE", "1", "", " True"]) {
      setReaperSettings(disabled, "0 3 * * *");

      await initUploadDraftReaperScheduler();

      expect(mockSchedule).not.toHaveBeenCalled();
    }
  });

  it("260829-kkn: custom cron passes through to schedule; work handler still registered", async () => {
    setReaperSettings("true", "*/30 * * * *");

    await initUploadDraftReaperScheduler();

    expect(mockSchedule).toHaveBeenCalledWith("reaper_upload-draft", "*/30 * * * *");
    expect(bossWork).toHaveBeenCalledTimes(1);
    // Final log names the effective (requested) cadence.
    const infoCalls = mockedLogger.info.mock.calls.map((c) => String(c[0]));
    expect(infoCalls.some((m) => m.includes("*/30 * * * *"))).toBe(true);
  });

  it("260829-kkn: invalid cron → schedule called with it, warn on rejection, fallback to default, boot survives", async () => {
    setReaperSettings("true", "not a cron");
    mockSchedule.mockRejectedValueOnce(new Error("Validation error for cron"));
    mockSchedule.mockResolvedValue(undefined);

    await initUploadDraftReaperScheduler();

    // First attempt used the configured value, second used the default.
    expect(mockSchedule).toHaveBeenNthCalledWith(1, "reaper_upload-draft", "not a cron");
    expect(mockSchedule).toHaveBeenNthCalledWith(2, "reaper_upload-draft", "0 3 * * *");
    // Warn names the fallback so operators can find the bad value.
    const warnCalls = mockedLogger.warn.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes("not a cron") && m.includes("0 3 * * *"))).toBe(true);
    // Boot continues — work handler still registered on the fallback cadence.
    expect(bossWork).toHaveBeenCalledTimes(1);
  });

  it("260829-kkn: empty/whitespace cron falls back to the default", async () => {
    setReaperSettings("true", "   ");

    await initUploadDraftReaperScheduler();

    expect(mockSchedule).toHaveBeenCalledWith("reaper_upload-draft", "0 3 * * *");
  });

  it("260829-kkn: toggle flipped to disabled after registration → per-job skip without runReaperCycle", async () => {
    await initUploadDraftReaperScheduler();
    const handler = bossWork.mock.calls[0][1];

    // The toggle flipped "false" between boot and this tick: getSetting now
    // reports disabled (only the enabled read path is consulted per job).
    mockGetSetting.mockImplementation((key: string) =>
      Promise.resolve({ key, value: "false", readOnly: false }),
    );

    await expect(
      handler([{ id: "j1", data: {}, name: "reaper_upload-draft" }]),
    ).resolves.toBeUndefined();

    // Per-job re-read (chatMessageReaperJob D-15 pattern) skips the cycle —
    // no prisma call, info logged, resolves undefined (Pitfall 3 unchanged).
    expect(mockPrisma.uploadDraft.findMany).not.toHaveBeenCalled();
    const infoCalls = mockedLogger.info.mock.calls.map((c) => String(c[0]));
    expect(infoCalls.some((m) => m.includes("disabled"))).toBe(true);
  });

  it("260829-kkn: enabled path does NOT unschedule (only the disabled path cleans up)", async () => {
    await initUploadDraftReaperScheduler();

    expect(bossUnschedule).not.toHaveBeenCalled();
  });
});