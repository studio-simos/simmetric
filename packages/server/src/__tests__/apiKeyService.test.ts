// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Unit tests for apiKeyService — Phase 163 (Keyed-HMAC API Keys).
 *
 * Replaces the bcrypt-loop coverage (Phase 159-01/CSW-15) with HMAC-SHA256
 * digest assertions. crypto is REAL (Node built-in, not mocked); the tests
 * set a real test `API_KEY_HMAC_SECRET` (base64 32-byte). The prisma mock
 * factory exposes `findUnique` (the O(1) lookup that replaces findMany +
 * bcrypt.compare). bcryptjs is NOT mocked (no longer imported by the service).
 *
 * Covers: createApiKey writes `key_hash` (64-char hex HMAC digest, deterministic);
 * validateApiKey does ONE findUnique({key_hash}) — no findMany, no bcrypt.compare;
 * wrong key → null; expired key → null; missing API_KEY_HMAC_SECRET → throws
 * /API_KEY_HMAC_SECRET/ (fail-loud, T-163-02).
 */

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    apiKey: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

// NOTE: no bcryptjs mock — the service no longer imports bcryptjs. crypto is real.

jest.mock("../utils/logger", () => ({
  __esModule: true,
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Hoist-safe stateful uuid mock: the factory below runs before module scope,
// so it references the mock through the jest object (available at factory time).
jest.mock("uuid", () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  v4: (jest as any).mockUuidV4 ?? ((jest as any).mockUuidV4 = jest.fn(() => "test-uuid-1234")),
}));

const mockUuidV4 = (jest as any).mockUuidV4 as jest.Mock;

import crypto from "crypto";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { createApiKey, validateApiKey, listApiKeys, revokeApiKey } from "../services/apiKeyService";

const mockPrisma = prisma as unknown as {
  apiKey: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
};
const mockLogger = logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock };

// uuidv4() returns "test-uuid-1234"; apiKeyService does `sk-${uuidv4().replace(/-/g, "")}`.
// After dash removal: "testuuid1234" → rawKey = "sk-testuuid1234", prefix = "sk-testu".
const RAW_KEY = "sk-testuuid1234";
const PREFIX = "sk-testu";

// Real test secret — base64-encoded 32 bytes (44 chars with padding). Decodes to
// 32 zero bytes (valid for HMAC; tests need a real secret because crypto is real).
const SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function expectedDigest(rawKey: string): string {
  return crypto.createHmac("sha256", Buffer.from(SECRET, "base64")).update(rawKey).digest("hex");
}

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks preserves implementations, but re-establish the default
  // uuid return so retry tests' mockReturnValueOnce queues don't leak.
  mockUuidV4.mockReturnValue("test-uuid-1234");
  process.env.API_KEY_HMAC_SECRET = SECRET;
});

describe("createApiKey", () => {
  it("writes key_hash (64-char HMAC-SHA256 hex digest, deterministic), NOT hashedKey", async () => {
    mockPrisma.apiKey.create.mockResolvedValue({
      id: "key-1",
      name: "My Key",
      createdBy: "user-1",
      expiresAt: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    const result = await createApiKey("My Key", "user-1");

    const args = mockPrisma.apiKey.create.mock.calls[0][0];
    // key_hash is defined, is a 64-char hex string (HMAC-SHA256 digest)
    expect(args.data.key_hash).toBeDefined();
    expect(args.data.key_hash).toHaveLength(64);
    // Deterministic: same secret + same raw key → same digest
    expect(args.data.key_hash).toBe(expectedDigest(RAW_KEY));
    // Old bcrypt column is gone
    expect(args.data.hashedKey).toBeUndefined();
    // prefix is still written (display only, D-03)
    expect(args.data.prefix).toBe(PREFIX);
    expect(args.data.name).toBe("My Key");
    expect(args.data.createdBy).toBe("user-1");
    expect(args.data.expiresAt).toBeNull();
    // plainKey is the raw key — exposed only here, never retrievable later
    expect(result.plainKey).toBe(RAW_KEY);
    expect(result.id).toBe("key-1");
    expect(result.name).toBe("My Key");
    expect(result.createdBy).toBe("user-1");
  });

  it("passes through expiresAt when provided", async () => {
    const exp = new Date("2027-01-01T00:00:00Z");
    mockPrisma.apiKey.create.mockResolvedValue({
      id: "key-2",
      name: "Expiring",
      createdBy: "user-2",
      expiresAt: exp,
      createdAt: new Date(),
    });

    await createApiKey("Expiring", "user-2", exp);

    const createArgs = mockPrisma.apiKey.create.mock.calls[0][0];
    expect(createArgs.data.expiresAt).toBe(exp);
    // key_hash still written
    expect(createArgs.data.key_hash).toHaveLength(64);
  });

  it("P2002 on first create → retries with a FRESH uuid; plainKey comes from the second attempt (T-OG8-03)", async () => {
    // First uuid → colliding key; second uuid → the successful retry key.
    mockUuidV4.mockReturnValueOnce("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").mockReturnValueOnce("11111111-2222-3333-4444-555555555555");
    mockPrisma.apiKey.create
      .mockRejectedValueOnce({ code: "P2002" })
      .mockResolvedValueOnce({
        id: "key-2nd",
        name: "My Key",
        createdBy: "user-1",
        expiresAt: null,
        createdAt: new Date(),
      });

    const result = await createApiKey("My Key", "user-1");

    expect(result.plainKey).toBe("sk-11111111222233334444555555555555");
    // key_hash/prefix recomputed from the SECOND attempt's uuid
    const secondArgs = mockPrisma.apiKey.create.mock.calls[1][0];
    expect(secondArgs.data.prefix).toBe("sk-11111");
    expect(secondArgs.data.key_hash).toBe(expectedDigest("sk-11111111222233334444555555555555"));
    expect(mockPrisma.apiKey.create).toHaveBeenCalledTimes(2);
  });

  it("P2002 three times → throws a clear error after 3 attempts (create ×3, warn logged per attempt)", async () => {
    mockPrisma.apiKey.create.mockRejectedValue({ code: "P2002" });

    await expect(createApiKey("My Key", "user-1")).rejects.toThrow(/prefix collision.*3 attempts|3 attempts.*prefix collision/i);

    expect(mockPrisma.apiKey.create).toHaveBeenCalledTimes(3);
    expect(mockLogger.warn).toHaveBeenCalledTimes(3);
  });

  it("non-P2002 error → propagates immediately (no retry, create called once)", async () => {
    mockPrisma.apiKey.create.mockRejectedValue(new Error("db down"));

    await expect(createApiKey("My Key", "user-1")).rejects.toThrow("db down");
    expect(mockPrisma.apiKey.create).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

describe("validateApiKey", () => {
  it("valid key: findUnique returns row, not expired → updates lastUsed, returns createdBy; NO findMany, NO bcrypt", async () => {
    const row = { id: "k1", createdBy: "user-1", key_hash: expectedDigest(RAW_KEY), expiresAt: null };
    mockPrisma.apiKey.findUnique.mockResolvedValue(row);
    mockPrisma.apiKey.update.mockResolvedValue({});

    const result = await validateApiKey(RAW_KEY);

    expect(result).toBe("user-1");
    // ONE findUnique call with where.key_hash (64 chars)
    expect(mockPrisma.apiKey.findUnique).toHaveBeenCalledTimes(1);
    const args = mockPrisma.apiKey.findUnique.mock.calls[0][0];
    expect(args.where.key_hash).toHaveLength(64);
    expect(args.where.key_hash).toBe(expectedDigest(RAW_KEY));
    // No take property (CSW-05 cap removed — no loop to cap)
    expect(args.take).toBeUndefined();
    // findMany is NEVER called
    expect(mockPrisma.apiKey.findMany).not.toHaveBeenCalled();
    // lastUsed updated
    expect(mockPrisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: "k1" },
      data: { lastUsed: expect.any(Date) },
    });
  });

  it("wrong key: findUnique returns null → returns null, NO update, NO findMany", async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue(null);

    const result = await validateApiKey(RAW_KEY);

    expect(result).toBeNull();
    expect(mockPrisma.apiKey.update).not.toHaveBeenCalled();
    expect(mockPrisma.apiKey.findMany).not.toHaveBeenCalled();
  });

  it("expired key: findUnique returns row with past expiresAt → returns null, NO update", async () => {
    const past = new Date("2020-01-01T00:00:00Z");
    mockPrisma.apiKey.findUnique.mockResolvedValue({
      id: "k1",
      createdBy: "u",
      key_hash: expectedDigest(RAW_KEY),
      expiresAt: past,
    });

    const result = await validateApiKey(RAW_KEY);

    expect(result).toBeNull();
    expect(mockPrisma.apiKey.update).not.toHaveBeenCalled();
  });

  it("missing API_KEY_HMAC_SECRET → throws Error naming the env var (fail-loud, T-163-02)", async () => {
    delete process.env.API_KEY_HMAC_SECRET;

    await expect(validateApiKey(RAW_KEY)).rejects.toThrow(/API_KEY_HMAC_SECRET/);
    // No DB call reached when the secret is missing
    expect(mockPrisma.apiKey.findUnique).not.toHaveBeenCalled();
  });
});

describe("listApiKeys", () => {
  it("findMany with where {createdBy}, select excludes key_hash, orderBy createdAt desc", async () => {
    mockPrisma.apiKey.findMany.mockResolvedValue([
      { id: "k1", name: "n", prefix: PREFIX, createdBy: "user-1", lastUsed: null, expiresAt: null, createdAt: new Date() },
    ]);

    await listApiKeys("user-1");

    const args = mockPrisma.apiKey.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ createdBy: "user-1" });
    expect(args.orderBy).toEqual({ createdAt: "desc" });
    // key_hash must NOT be in select (never expose digests)
    expect(args.select.key_hash).toBeUndefined();
    expect(args.select.hashedKey).toBeUndefined();
    expect(args.select.id).toBe(true);
    expect(args.select.name).toBe(true);
    expect(args.select.prefix).toBe(true);
    expect(args.select.createdBy).toBe(true);
    expect(args.select.lastUsed).toBe(true);
    expect(args.select.expiresAt).toBe(true);
    expect(args.select.createdAt).toBe(true);
  });
});

describe("revokeApiKey", () => {
  it("existing key: findFirst returns key → delete called, logger.info called", async () => {
    mockPrisma.apiKey.findFirst.mockResolvedValue({ id: "k1", createdBy: "user-1" });

    await revokeApiKey("k1", "user-1");

    expect(mockPrisma.apiKey.findFirst).toHaveBeenCalledWith({ where: { id: "k1", createdBy: "user-1" } });
    expect(mockPrisma.apiKey.delete).toHaveBeenCalledWith({ where: { id: "k1" } });
    expect(mockLogger.info).toHaveBeenCalled();
  });

  it("not found: findFirst returns null → throws Error('API key not found'), delete NOT called", async () => {
    mockPrisma.apiKey.findFirst.mockResolvedValue(null);

    await expect(revokeApiKey("missing", "user-1")).rejects.toThrow("API key not found");
    expect(mockPrisma.apiKey.delete).not.toHaveBeenCalled();
  });
});