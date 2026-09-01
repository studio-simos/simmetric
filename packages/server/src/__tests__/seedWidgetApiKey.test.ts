// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Unit tests for seedWidgetApiKey() — Phase 163 (Keyed-HMAC API Keys).
 *
 * Updated from the Phase 151-02 bcrypt version: the seeder now writes an
 * HMAC-SHA256 digest (key_hash) and checks idempotency via findUnique({key_hash})
 * instead of a prefix findMany + bcrypt.compare loop. crypto is real (Node
 * built-in); the test sets a real API_KEY_HMAC_SECRET.
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma, withSoftDelete: (w: unknown) => w };
});

jest.mock("../utils/logger", () => ({
  __esModule: true,
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import crypto from "crypto";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { seedWidgetApiKey } from "../services/seedService";
import { clearEnvCache } from "../config/env";

const mockLogger = logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock };

const SERVICE_ACCOUNT_ID = "svc-account-1";
const RAW_KEY = "sk-default-widget-key";
const SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function expectedDigest(rawKey: string): string {
  return crypto.createHmac("sha256", Buffer.from(SECRET, "base64")).update(rawKey).digest("hex");
}

describe("seedWidgetApiKey", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.API_KEY_HMAC_SECRET = SECRET;
    // Default: service account exists, no existing api_keys row.
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: SERVICE_ACCOUNT_ID });
    (prisma.apiKey.findUnique as jest.Mock).mockResolvedValue(null);
  });

  afterEach(() => {
    // Restore the .env.test value (WIDGET_API_KEY=test-key) and drop the
    // getEnv() cache so later tests see the original env.
    delete process.env.WIDGET_API_KEY;
    delete process.env.API_KEY_HMAC_SECRET;
    clearEnvCache();
  });

  it("is a no-op when WIDGET_API_KEY is unset", async () => {
    delete process.env.WIDGET_API_KEY;
    clearEnvCache();
    await seedWidgetApiKey();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  it("is a no-op when the widget-service account is missing", async () => {
    process.env.WIDGET_API_KEY = RAW_KEY;
    clearEnvCache();
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    await seedWidgetApiKey();
    expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  it("is a no-op when an existing row already has the matching key_hash (idempotent)", async () => {
    process.env.WIDGET_API_KEY = RAW_KEY;
    clearEnvCache();
    (prisma.apiKey.findUnique as jest.Mock).mockResolvedValue({
      id: "key-1",
      key_hash: expectedDigest(RAW_KEY),
    });

    await seedWidgetApiKey();

    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  it("mints a new row with the HMAC digest (key_hash) when no match exists", async () => {
    process.env.WIDGET_API_KEY = RAW_KEY;
    clearEnvCache();
    (prisma.apiKey.create as jest.Mock).mockResolvedValue({ id: "key-new" });

    await seedWidgetApiKey();

    expect(prisma.apiKey.create).toHaveBeenCalledTimes(1);
    const createArgs = (prisma.apiKey.create as jest.Mock).mock.calls[0][0];
    expect(createArgs.data.name).toBe("widget-service (auto-seeded)");
    // Prefix is derived from the HMAC digest (keyHash.substring(0, 8)) — display-only
    // and idempotent per (WIDGET_API_KEY, API_KEY_HMAC_SECRET) pair; zero raw-key
    // material is exposed (quick 260830-og8 D-01).
    expect(createArgs.data.prefix).toBe(expectedDigest(RAW_KEY).substring(0, 8));
    expect(createArgs.data.createdBy).toBe(SERVICE_ACCOUNT_ID);
    // The stored key_hash is the HMAC-SHA256 digest of the raw key (validateApiKey
    // recomputes this same digest and findUnique-looks it up).
    expect(createArgs.data.key_hash).toBeDefined();
    expect(createArgs.data.key_hash).toHaveLength(64);
    expect(createArgs.data.key_hash).toBe(expectedDigest(RAW_KEY));
    // Old bcrypt column is gone
    expect(createArgs.data.hashedKey).toBeUndefined();
  });

  it("P2002 on create with the key_hash row present (concurrent boot won) → resolves, create once, info logged (T-OG8-01)", async () => {
    process.env.WIDGET_API_KEY = RAW_KEY;
    clearEnvCache();
    // Bounded-queue emulation: idempotency check saw null (beforeEach default),
    // create throws P2002, then the post-P2002 re-check finds the race winner's row.
    (prisma.apiKey.findUnique as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "key-winner",
      key_hash: expectedDigest(RAW_KEY),
    });
    (prisma.apiKey.create as jest.Mock).mockRejectedValue({ code: "P2002" });

    await expect(seedWidgetApiKey()).resolves.toBeUndefined();

    // No second create — the loser must not stomp the race winner's row
    expect(prisma.apiKey.create).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("already seeded"));
  });

  it("P2002 on create with key_hash re-check null (rare 8-hex digest-prefix collision) → resolves, warn logged, NO throw (T-OG8-01)", async () => {
    process.env.WIDGET_API_KEY = RAW_KEY;
    clearEnvCache();
    // Idempotency check AND post-P2002 re-check both return null
    (prisma.apiKey.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.apiKey.create as jest.Mock).mockRejectedValue({ code: "P2002" });

    await expect(seedWidgetApiKey()).resolves.toBeUndefined();

    expect(prisma.apiKey.create).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("non-P2002 create error → rethrown (catch swallows ONLY the unique-constraint code)", async () => {
    process.env.WIDGET_API_KEY = RAW_KEY;
    clearEnvCache();
    (prisma.apiKey.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.apiKey.create as jest.Mock).mockRejectedValue({ code: "P9999" });

    await expect(seedWidgetApiKey()).rejects.toMatchObject({ code: "P9999" });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});