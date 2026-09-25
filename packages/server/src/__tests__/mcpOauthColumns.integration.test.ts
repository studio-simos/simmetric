// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 195 (MCPO-01 D-01/D-02, T-195-01): real-Postgres integration tests for
 * the 8 new MCPConnection oauth columns — the D-02 default semantics on a live
 * DB and the AES-256-GCM blob carrier round-trip (T-195-01) on real rows.
 *
 * Pattern: chatMessageReaper.integration.test.ts — per-file worker DB cloned
 * from the template by jest.setup.integration.ts; runs only under
 * jest.config.integration.js. NO prisma mocks (real DB — partial mocks are a
 * false-positive risk per the chatMessageReaper header note).
 *
 * Kept lean (≤ 5 test blocks — Pitfall 11 test-count cap headroom).
 */
import "./helpers/setupEnv";
import { encrypt, decrypt } from "../services/encryptionService";
import type { OAuthTokenBlob } from "../services/oauthTokenLifecycle";

let prisma: import("@prisma/client").PrismaClient;

const ORG_ID = "00000000-0000-0000-0000-000000000000";

function makeBlob(overrides: Partial<OAuthTokenBlob> = {}): OAuthTokenBlob {
  return {
    accessToken: "integration-at-123",
    refreshToken: "integration-rt-123",
    scope: "https://www.googleapis.com/auth/drive.readonly",
    obtainedAt: new Date("2026-09-22T09:00:00Z").toISOString(),
    ...overrides,
  };
}

beforeAll(async () => {
  const { default: prismaClient } = await import("../utils/prisma");
  prisma = prismaClient;
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("MCPConnection oauth columns — real Postgres (MCPO-01)", () => {
  it("creates a legacy-shaped row and reads back authType=none / oauthStatus=none defaults (D-02)", async () => {
    const legacy = await prisma.mCPConnection.create({
      data: {
        organizationId: ORG_ID,
        name: "legacy-static",
        url: "http://localhost:9999/mcp",
        transportType: "sse",
        headers: JSON.stringify({ Authorization: "Bearer legacy" }),
      },
    });
    const readBack = await prisma.mCPConnection.findUnique({ where: { id: legacy.id } });
    expect(readBack).not.toBeNull();
    expect(readBack!.authType).toBe("none");
    expect(readBack!.oauthStatus).toBe("none");
    expect(readBack!.oauthProvider).toBeNull();
    expect(readBack!.credentialsEncrypted).toBeNull();
    expect(readBack!.tokenExpiresAt).toBeNull();
    expect(readBack!.oauthError).toBeNull();
    expect(readBack!.oauthClientId).toBeNull();
    // The headers column is untouched by the migration (D-12 path intact):
    expect(readBack!.headers).toBe(JSON.stringify({ Authorization: "Bearer legacy" }));
    await prisma.mCPConnection.delete({ where: { id: legacy.id } });
  });

  it("updates a row to oauth + encrypted blob and decrypts the blob fields exactly (T-195-01)", async () => {
    const row = await prisma.mCPConnection.create({
      data: {
        organizationId: ORG_ID,
        name: "oauth-google",
        url: "https://mcp.example.com/mcp",
        transportType: "streamable-http",
      },
    });
    const blob = makeBlob();
    const expiresAt = new Date("2026-09-22T10:00:00Z");
    await prisma.mCPConnection.update({
      where: { id: row.id },
      data: {
        authType: "oauth",
        oauthProvider: "google",
        oauthScopes: "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/gmail.readonly",
        credentialsEncrypted: encrypt(JSON.stringify(blob)),
        tokenExpiresAt: expiresAt,
        oauthStatus: "authorized",
      },
    });
    const readBack = await prisma.mCPConnection.findUnique({ where: { id: row.id } });
    expect(readBack!.authType).toBe("oauth");
    expect(readBack!.oauthProvider).toBe("google");
    expect(readBack!.oauthStatus).toBe("authorized");
    expect(readBack!.tokenExpiresAt).toEqual(expiresAt);
    // Decrypt round-trip on a real row: the ciphertext column decrypts to the
    // exact blob JSON (AES-256-GCM at-rest carrier verified live).
    expect(readBack!.credentialsEncrypted).not.toBeNull();
    const decrypted = JSON.parse(decrypt(readBack!.credentialsEncrypted!)) as OAuthTokenBlob;
    expect(decrypted).toEqual(blob);
    await prisma.mCPConnection.delete({ where: { id: row.id } });
  });

  it("leaves a second legacy row untouched after an oauth row exists (no cross-row bleed)", async () => {
    const oauthRow = await prisma.mCPConnection.create({
      data: {
        organizationId: ORG_ID,
        name: "oauth-second",
        url: "https://mcp.example.com/mcp",
        authType: "oauth",
        oauthProvider: "google",
        oauthStatus: "authorized",
        credentialsEncrypted: encrypt(JSON.stringify(makeBlob({ accessToken: "second-at" }))),
      },
    });
    const legacyRow = await prisma.mCPConnection.create({
      data: {
        organizationId: ORG_ID,
        name: "legacy-after",
        url: "http://localhost:9998/mcp",
        headers: JSON.stringify({}),
      },
    });
    const readLegacy = await prisma.mCPConnection.findUnique({ where: { id: legacyRow.id } });
    expect(readLegacy).not.toBeNull();
    expect(readLegacy!.authType).toBe("none");
    expect(readLegacy!.oauthStatus).toBe("none");
    expect(readLegacy!.credentialsEncrypted).toBeNull();
    // The oauth row reads back independently:
    const readOauth = await prisma.mCPConnection.findUnique({ where: { id: oauthRow.id } });
    expect(readOauth!.authType).toBe("oauth");
    await prisma.mCPConnection.delete({ where: { id: oauthRow.id } });
    await prisma.mCPConnection.delete({ where: { id: legacyRow.id } });
  });

  it("findMany with the new columns selected does not crash on a null-credential oauth row", async () => {
    const nullCred = await prisma.mCPConnection.create({
      data: {
        organizationId: ORG_ID,
        name: "oauth-null-cred",
        url: "https://mcp.example.com/mcp",
        authType: "oauth",
        oauthProvider: "microsoft",
        oauthStatus: "pending",
      },
    });
    const rows = await prisma.mCPConnection.findMany({
      where: { organizationId: ORG_ID, name: { startsWith: "oauth-null-cred" } },
      select: {
        id: true,
        authType: true,
        oauthProvider: true,
        oauthStatus: true,
        credentialsEncrypted: true,
        tokenExpiresAt: true,
        oauthError: true,
        oauthClientId: true,
        oauthScopes: true,
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.credentialsEncrypted).toBeNull();
    expect(rows[0]!.oauthStatus).toBe("pending");
    await prisma.mCPConnection.delete({ where: { id: nullCred.id } });
  });

  it("round-trips a blob without refreshToken (optional field) and stores oauthError text", async () => {
    const row = await prisma.mCPConnection.create({
      data: {
        organizationId: ORG_ID,
        name: "oauth-error-arm",
        url: "https://mcp.example.com/mcp",
        authType: "oauth",
        oauthProvider: "google",
        oauthStatus: "error",
        oauthError: "provider revoke returned 400",
        credentialsEncrypted: encrypt(JSON.stringify(makeBlob({ refreshToken: undefined }))),
      },
    });
    const readBack = await prisma.mCPConnection.findUnique({ where: { id: row.id } });
    expect(readBack!.oauthStatus).toBe("error");
    expect(readBack!.oauthError).toBe("provider revoke returned 400");
    const decrypted = JSON.parse(decrypt(readBack!.credentialsEncrypted!)) as OAuthTokenBlob;
    expect(decrypted.refreshToken).toBeUndefined();
    expect(decrypted.accessToken).toBe("integration-at-123");
    await prisma.mCPConnection.delete({ where: { id: row.id } });
  });
});