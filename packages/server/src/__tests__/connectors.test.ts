// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 196 (MCPO-04 D-04/D-07) connector unit tests — Postgres-free
 * (prisma mocked like oauthProviderRegistry.test.ts / resolveSkillsForChat
 * structure; provider HTTP stubbed via global fetch). Covers: token
 * resolution gating (authorized / missing / unauthorized / decrypt failure),
 * scope-coverage error, providerFetch backoff arms (429+Retry-After, 429
 * without header, 503, exhaustion, immediate pass-through), gdrive_search
 * populated + empty arms, and the palette gate include/exclude.
 */

import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import prisma from "../utils/prisma";
import {
  resolveConnectorConnection,
  hasAuthorizedProviderConnection,
  assertScopesGranted,
} from "../agent/connectors/tokenResolver";
import { providerFetch } from "../agent/connectors/providerFetch";
import { searchDriveFiles, readDriveFile } from "../agent/connectors/googleDrive";
import {
  searchGmailMessages,
  getGmailThread,
  extractGmailText,
  composeGmailThreadText,
  GMAIL_READONLY_SCOPE,
} from "../agent/connectors/gmail";
import { createAndDispatchConnectorDocument } from "../agent/connectors/ingestBridge";
import {
  searchGraphMail,
  searchSharepointSites,
  searchSiteDriveItems,
  downloadOneDriveItem,
} from "../agent/connectors/microsoftGraph";
import {
  CONNECTOR_SKILL_PROVIDERS,
  CONNECTOR_SKILL_NAMES,
} from "../agent/connectors/registry";
import { encryptTokenBlob } from "../services/oauthTokenLifecycle";
import { _clearAllSkills, registerSkill, getSkill } from "../agent/skills";
import {
  resolveSkillsForChat,
} from "../agent/skills";

const WS_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ORG_ID = "org-connector-test";

const AUTHORIZED_ROW = {
  id: "cccccccc-0000-0000-0000-000000000001",
  name: "Google Drive",
  oauthProvider: "google",
  organizationId: ORG_ID,
  credentialsEncrypted: null as string | null,
};

function authorizedRowWithBlob(scope: string): typeof AUTHORIZED_ROW {
  return {
    ...AUTHORIZED_ROW,
    credentialsEncrypted: encryptTokenBlob({
      accessToken: "at-connector-test-token",
      scope,
      obtainedAt: new Date().toISOString(),
    }),
  };
}

// ─── tokenResolver — resolveConnectorConnection gating (D-04) ──────────

describe("resolveConnectorConnection — token resolution gating", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ organizationId: ORG_ID });
  });

  it("authorized row → ok with connection + decrypted blob (no ciphertext leak in error paths)", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(
      authorizedRowWithBlob("https://www.googleapis.com/auth/drive.readonly"),
    );

    const res = await resolveConnectorConnection(WS_ID, "google");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.connection.id).toBe(AUTHORIZED_ROW.id);
      expect(res.blob.accessToken).toBe("at-connector-test-token");
      expect(res.blob.scope).toBe("https://www.googleapis.com/auth/drive.readonly");
    }
  });

  it("missing workspace → fail 'Workspace not found'", async () => {
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await resolveConnectorConnection(WS_ID, "google");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("Workspace not found");
      expect(res.error).not.toContain("token");
    }
  });

  it("no row (unauthorized/missing) → fail with the connect-first guidance", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await resolveConnectorConnection(WS_ID, "google");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("No authorized google connection");
      expect(res.error).toContain("Settings → MCP Connections");
    }
  });

  it("row without credentialsEncrypted → same connect-first failure (never a token error)", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue({
      ...AUTHORIZED_ROW,
      credentialsEncrypted: null,
    });

    const res = await resolveConnectorConnection(WS_ID, "google");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("No authorized google connection");
  });

  it("decrypt failure → fail with the lifecycle errorDescription (no token material)", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue({
      ...AUTHORIZED_ROW,
      credentialsEncrypted: "not-a-valid-blob",
    });

    const res = await resolveConnectorConnection(WS_ID, "google");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.toLowerCase()).toContain("decrypt");
    }
  });

  it("wrong-org row is unreachable — the org filter rides the where clause (T-196-02)", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(null);

    await resolveConnectorConnection(WS_ID, "google");

    // The findFirst args must carry the workspace's org (scopeToOrg merged
    // into the where — tenancy holds even when the tenant ALS is absent).
    expect(prisma.mCPConnection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG_ID, oauthStatus: "authorized" }),
      }),
    );
  });
});

describe("hasAuthorizedProviderConnection — palette-gate resolver", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ organizationId: ORG_ID });
  });

  it("returns true when an authorized row exists", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue({ id: AUTHORIZED_ROW.id });
    expect(await hasAuthorizedProviderConnection(WS_ID, "google")).toBe(true);
  });

  it("returns false when the workspace is missing (fail-closed)", async () => {
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue(null);
    expect(await hasAuthorizedProviderConnection(WS_ID, "google")).toBe(false);
    expect(prisma.mCPConnection.findFirst).not.toHaveBeenCalled();
  });

  it("returns false when no authorized row exists", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(null);
    expect(await hasAuthorizedProviderConnection(WS_ID, "google")).toBe(false);
  });
});

// ─── assertScopesGranted (D-08 fail-closed) ─────────────────────────────

describe("assertScopesGranted — scope coverage", () => {
  const DRIVE = "https://www.googleapis.com/auth/drive.readonly";

  it("returns null when every required scope is granted", () => {
    expect(assertScopesGranted(`${DRIVE} https://www.googleapis.com/auth/gmail.readonly`, [DRIVE])).toBeNull();
  });

  it("returns a missing-scope error naming the missing scope", () => {
    const err = assertScopesGranted("https://www.googleapis.com/auth/gmail.readonly", [DRIVE]);
    expect(err).toContain("missing required scope");
    expect(err).toContain(DRIVE);
  });

  it("names ALL missing scopes when several are absent", () => {
    const err = assertScopesGranted("", ["scope-a", "scope-b"]);
    expect(err).toContain("scope-a");
    expect(err).toContain("scope-b");
  });
});

// ─── providerFetch — backoff arms (D-07 / SC-3) ─────────────────────────

describe("providerFetch — 429/503 backoff", () => {
  const originalFetch = globalThis.fetch;
  let delays: number[];
  let realSetTimeout: typeof setTimeout;

  beforeAll(() => {
    // Collapse real backoff waits to 0ms so the suite stays fast; delays are
    // still observable via the recorded wait durations.
    realSetTimeout = globalThis.setTimeout;
    jest.spyOn(globalThis, "setTimeout").mockImplementation(((fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, 0, ...(rest as []));
    }) as unknown as typeof setTimeout);
  });

  afterAll(() => {
    (globalThis.setTimeout as unknown as jest.SpyInstance).mockRestore();
  });

  beforeEach(() => {
    delays = [];
    jest.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function jsonResponse(status: number, headers?: Record<string, string>): Response {
    return new Response(JSON.stringify({ ok: true }), { status, headers });
  }

  it("passes the response through untouched on first-attempt success (200)", async () => {
    const expected = jsonResponse(200);
    globalThis.fetch = jest.fn().mockResolvedValue(expected) as unknown as typeof fetch;

    const res = await providerFetch("https://provider.example/x", {
      provider: "google",
      headers: { Authorization: "Bearer t" },
    });
    expect(res).toBe(expected);
    expect(delays).toHaveLength(0);
  });

  it("returns immediately on non-throttle statuses (404, 401, 500) without retry", async () => {
    const expected = jsonResponse(404);
    globalThis.fetch = jest.fn().mockResolvedValue(expected) as unknown as typeof fetch;

    const res = await providerFetch("https://provider.example/x", { provider: "google" });
    expect(res).toBe(expected);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(delays).toHaveLength(0);
  });

  it("honors Retry-After (seconds → ms, capped at 60s) on 429", async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { "Retry-After": "2" }))
      .mockResolvedValueOnce(jsonResponse(200)) as unknown as typeof fetch;

    const res = await providerFetch("https://provider.example/x", { provider: "google" });
    expect(res.status).toBe(200);
    expect(delays).toEqual([2000]);
  });

  it("caps a huge Retry-After at 60_000ms", async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { "Retry-After": "3600" }))
      .mockResolvedValueOnce(jsonResponse(200)) as unknown as typeof fetch;

    await providerFetch("https://provider.example/x", { provider: "google" });
    expect(delays[0]).toBe(60_000);
  });

  it("falls back to the exponential arm when Retry-After is absent", async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(200)) as unknown as typeof fetch;

    await providerFetch("https://provider.example/x", { provider: "google" });
    // attempt 1: 2^1*1000 + jitter[0..999] → in [2000, 2999]
    expect(delays[0]).toBeGreaterThanOrEqual(2000);
    expect(delays[0]).toBeLessThanOrEqual(2999);
  });

  it("Retry-After of 0 / garbage falls through to the exponential arm", async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { "Retry-After": "0" }))
      .mockResolvedValueOnce(jsonResponse(429, { "Retry-After": "soon" }))
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(200)) as unknown as typeof fetch;

    await providerFetch("https://provider.example/x", { provider: "google" });
    expect(delays).toHaveLength(3);
    // attempt 1: [2000,2999]; attempt 2: [4000,4999]; attempt 3: [8000,8999]
    expect(delays[0]).toBeGreaterThanOrEqual(2000);
    expect(delays[1]).toBeGreaterThanOrEqual(4000);
    expect(delays[2]).toBeGreaterThanOrEqual(8000);
  });

  it("retries on 503 and honors its Retry-After", async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { "Retry-After": "1" }))
      .mockResolvedValueOnce(jsonResponse(200)) as unknown as typeof fetch;

    const res = await providerFetch("https://provider.example/x", { provider: "microsoft" });
    expect(res.status).toBe(200);
    expect(delays).toEqual([1000]);
  });

  it("exhausts ≤3 retries on persistent 429 and throws the fixed error", async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse(429, { "Retry-After": "1" })) as unknown as typeof fetch;

    await expect(
      providerFetch("https://provider.example/x", { provider: "google" }),
    ).rejects.toThrow("provider rate limit: retries exhausted");
    expect(globalThis.fetch).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    expect(delays).toHaveLength(3);
    // Every honored delay stays ≤ the 60s cap.
    expect(delays.every((d) => d <= 60_000)).toBe(true);
  });

  it("logs provider + status only (never the URL, headers, or token)", async () => {
    const { logger } = await import("../utils/logger");
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { "Retry-After": "1" }))
      .mockResolvedValueOnce(jsonResponse(200)) as unknown as typeof fetch;

    await providerFetch("https://provider.example/secret-path", {
      provider: "google",
      headers: { Authorization: "Bearer super-secret-token" },
    });

    const allArgs = JSON.stringify((logger.warn as jest.Mock).mock.calls);
    expect(allArgs).not.toContain("secret-path");
    expect(allArgs).not.toContain("super-secret-token");
  });

  // ── Task 2 hardening pins (D-07 regression wall) ──

  it("Retry-After of 'now'-like garbage never produces a NaN or negative delay", async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { "Retry-After": "-5" }))
      .mockResolvedValueOnce(jsonResponse(429, { "Retry-After": "NaN" }))
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(200)) as unknown as typeof fetch;

    await providerFetch("https://provider.example/x", { provider: "google" });
    // All three arms fell through to the exponential band (positive, bounded).
    expect(delays.every((d) => d > 0 && d <= 64_000)).toBe(true);
    expect(Number.isFinite(delays[0])).toBe(true);
    expect(Number.isFinite(delays[1])).toBe(true);
  });

  it("Retry-After 0 explicitly falls through to the exponential arm (not a 0ms tight loop)", async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { "Retry-After": "0" }))
      .mockResolvedValueOnce(jsonResponse(200)) as unknown as typeof fetch;

    await providerFetch("https://provider.example/x", { provider: "google" });
    // The exponential arm for attempt 1 is ≥2000ms — never the 0ms garbage echo.
    expect(delays[0]).toBeGreaterThanOrEqual(2000);
  });

  it("delay never exceeds the 60s cap with Retry-After present across repeated retries", async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse(429, { "Retry-After": "86400" })) as unknown as typeof fetch;

    await expect(
      providerFetch("https://provider.example/x", { provider: "google" }),
    ).rejects.toThrow("provider rate limit: retries exhausted");
    expect(delays).toHaveLength(3);
    expect(delays.every((d) => d === 60_000)).toBe(true);
  });

  it("2xx/4xx-except-429 statuses return the SAME Response object untouched (single call)", async () => {
    for (const status of [200, 201, 400, 401, 403, 404, 500, 502]) {
      jest.clearAllMocks();
      delays = [];
      const expected = jsonResponse(status);
      globalThis.fetch = jest.fn().mockResolvedValue(expected) as unknown as typeof fetch;

      const res = await providerFetch("https://provider.example/x", { provider: "google" });
      expect(res).toBe(expected);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(delays).toHaveLength(0);
    }
  });
});

// ─── searchDriveFiles + gdrive_search skill arms ────────────────────────

describe("searchDriveFiles — Drive v3 files.list", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds the files.list request (q/spaces/fields/pageSize) and maps the metadata", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string | URL) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({
          files: [
            { id: "f1", name: "Report", mimeType: "application/pdf", size: "123", modifiedTime: "2026-01-02T00:00:00Z", webViewLink: "https://link" },
          ],
          nextPageToken: "tok2",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const { files, nextPageToken } = await searchDriveFiles("tok", "name contains 'Report'", { pageSize: 10 });
    expect(capturedUrl).toContain("https://www.googleapis.com/drive/v3/files");
    expect(capturedUrl).toContain("spaces=drive");
    expect(capturedUrl).toContain("pageSize=10"); // explicit pageSize passed through
    expect(capturedUrl).toContain("q=name+contains");
    expect(files).toHaveLength(1);
    expect(files[0]!.id).toBe("f1");
    expect(files[0]!.webViewLink).toBe("https://link");
    expect(nextPageToken).toBe("tok2");
  });

  it("propagates the non-ok status error (no body echo)", async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(new Response("forbidden", { status: 403 })) as unknown as typeof fetch;

    await expect(searchDriveFiles("tok", "x")).rejects.toThrow("HTTP 403");
  });
});

describe("gdrive_search skill — execute arms", () => {
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    // Side-effect-import the skill module exactly like builtinSkills.ts does.
    await import("../agent/connectors/skills");
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ organizationId: ORG_ID });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("registers gdrive_search as a builtin skill", () => {
    const skill = getSkill("gdrive_search");
    expect(skill).toBeDefined();
    expect(skill!.type).toBe("builtin");
    expect(skill!.inputSchema).toEqual(
      expect.objectContaining({
        type: "object",
        required: ["query"],
      }),
    );
  });

  it("the registered name is in CONNECTOR_SKILL_NAMES + provider map", () => {
    expect(CONNECTOR_SKILL_NAMES.has("gdrive_search")).toBe(true);
    expect(CONNECTOR_SKILL_PROVIDERS["gdrive_search"]).toBe("google");
  });

  it("missing connection → structured 'connect it first' error (never throws)", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(null);

    const skill = getSkill("gdrive_search")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { query: "x" } });
    expect(res.success).toBe(false);
    expect(res.error).toContain("No authorized google connection");
  });

  it("missing scope → fail-closed 'missing scope' error (D-08)", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(
      authorizedRowWithBlob("https://www.googleapis.com/auth/gmail.readonly"),
    );

    const skill = getSkill("gdrive_search")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { query: "x" } });
    expect(res.success).toBe(false);
    expect(res.error).toContain("missing required scope");
  });

  it("populated results → formatted success list (Bearer inside execute, token never in data/error)", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(
      authorizedRowWithBlob("https://www.googleapis.com/auth/drive.readonly"),
    );
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer at-connector-test-token");
      return new Response(
        JSON.stringify({
          files: [{ id: "f1", name: "Spec", mimeType: "application/pdf", size: "55", modifiedTime: "2026-01-02T00:00:00Z" }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const skill = getSkill("gdrive_search")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { query: "name contains 'Spec'" } });
    expect(res.success).toBe(true);
    const data = String(res.data);
    expect(data).toContain("Spec");
    expect(data).toContain("f1");
    expect(data).not.toContain("at-connector-test-token");
    expect(String(res.error ?? "")).not.toContain("at-connector-test-token");
  });

  it("empty result set → success with an explicit no-results message (MCPO-04/empty)", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(
      authorizedRowWithBlob("https://www.googleapis.com/auth/drive.readonly"),
    );
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ files: [] }), { status: 200 })) as unknown as typeof fetch;

    const skill = getSkill("gdrive_search")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { query: "nothing" } });
    expect(res.success).toBe(true);
    expect(String(res.data)).toContain("No files matched");
  });

  it("missing query param → structured param error", async () => {
    const skill = getSkill("gdrive_search")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: {} });
    expect(res.success).toBe(false);
    expect(res.error).toContain("query parameter is required");
  });
});

// ─── Task 1 (plan 02): readDriveFile — export/alt=media branch (Pitfall 1) ──

describe("readDriveFile — Pitfall-1 export branch", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("Docs Editors mimeType hits /export with the mapped MIME (Docs → text/markdown)", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url));
      if (String(url).includes("/export?")) {
        return new Response("# Hello Doc", { status: 200 });
      }
      return new Response(
        JSON.stringify({ id: "doc1", name: "Hello Doc", mimeType: "application/vnd.google-apps.document" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const res = await readDriveFile("tok", "doc1");
    expect(urls.some((u) => u.includes("/drive/v3/files/doc1/export?mimeType=text%2Fmarkdown"))).toBe(true);
    expect(res.text).toContain("Hello Doc");
    expect(res.mimeType).toBe("text/markdown");
    expect(res.truncated).toBe(false);
  });

  it("binary mimeType hits ?alt=media (no export)", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url));
      if (String(url).includes("alt=media")) {
        return new Response("PDFBYTES", { status: 200 });
      }
      return new Response(
        JSON.stringify({ id: "bin1", name: "report.pdf", mimeType: "application/pdf" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const res = await readDriveFile("tok", "bin1");
    expect(urls.some((u) => u.includes("alt=media"))).toBe(true);
    expect(urls.some((u) => u.includes("/export?"))).toBe(false);
    expect(res.text).toBe("PDFBYTES");
  });

  it("truncates text at 50_000 chars with the truncation marker", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("/export?")) {
        return new Response("x".repeat(60_000), { status: 200 });
      }
      return new Response(
        JSON.stringify({ id: "big1", name: "Big Doc", mimeType: "application/vnd.google-apps.document" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const res = await readDriveFile("tok", "big1");
    expect(res.truncated).toBe(true);
    expect(res.text.length).toBeLessThanOrEqual(50_500);
    expect(res.text).toContain("[Content truncated at 50000 characters");
  });

  it("403 fileNotDownloadable → structured not-downloadable error", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("/export?")) {
        return new Response(JSON.stringify({ error: { reason: "fileNotDownloadable" } }), { status: 403 });
      }
      return new Response(
        JSON.stringify({ id: "form1", name: "Form", mimeType: "application/vnd.google-apps.form" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await expect(readDriveFile("tok", "form1")).rejects.toThrow("not downloadable in this format");
  });

  it("unmapped Workspace mimetype falls back to the application/pdf export", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url));
      if (String(url).includes("/export?")) {
        return new Response("PDFBYTES", { status: 200 });
      }
      return new Response(
        JSON.stringify({ id: "vid1", name: "Clip", mimeType: "application/vnd.google-apps.video" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await readDriveFile("tok", "vid1");
    expect(urls.some((u) => u.includes("export?mimeType=application%2Fpdf"))).toBe(true);
  });
});

// ─── Task 1 (plan 02): ingest bridge — Document row + multipart contract ──

describe("createAndDispatchConnectorDocument — Document row + collector multipart", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ name: "Ops Workspace" });
    (prisma.document.create as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "doc-row-1",
      ...data,
    }));
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function okCollectorResponse(): Response {
    return new Response(JSON.stringify({ chunkCount: 4 }), { status: 200 });
  }

  it("creates the Document row BEFORE dispatch (pending, filePath '', run-suffixed cacheKey)", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      calls.push(String(url));
      return okCollectorResponse();
    }) as unknown as typeof fetch;

    const res = await createAndDispatchConnectorDocument({
      workspaceId: WS_ID,
      fileName: "Report.pdf",
      fileBytes: Buffer.from("pdf-bytes"),
      fileId: "file1",
      provider: "google",
      docType: "pdf",
      embeddingModel: "Xenova/all-MiniLM-L6-v2",
    });

    expect(res.ok).toBe(true);
    // Row exists with the connector contract fields…
    expect(prisma.document.create).toHaveBeenCalledTimes(1);
    const createData = (prisma.document.create as jest.Mock).mock.calls[0][0].data;
    expect(createData).toEqual(
      expect.objectContaining({
        workspaceId: WS_ID,
        name: "Report.pdf",
        status: "pending",
        filePath: "",
        storageKey: null,
        chunkCount: 0,
        fileSize: Buffer.from("pdf-bytes").byteLength,
      }),
    );
    // cacheKey carries the run suffix (the @unique collision guard)
    expect(createData.cacheKey).toMatch(/^connector-google-file1-\d+$/);
    // …and dispatch happened AFTER the create.
    expect(calls).toHaveLength(1);
    expect(String(calls[0])).toContain("/api/ingest");
  });

  it("multipart payload fields are EXACT (documentId/workspaceId/workspaceName/embeddingModel/docType) + X-Collector-Secret header", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      capturedInit = init;
      return okCollectorResponse();
    }) as unknown as typeof fetch;

    await createAndDispatchConnectorDocument({
      workspaceId: WS_ID,
      fileName: "Notes.txt",
      fileBytes: Buffer.from("hello"),
      fileId: "file2",
      provider: "google",
      docType: "txt",
      embeddingModel: "embed-x",
    });

    // documentId must be the PRE-CREATED row id (Pitfall 3)
    expect((prisma.document.create as jest.Mock).mock.calls[0][0].data.status).toBe("pending");

    expect(capturedInit).toBeDefined();
    expect(capturedInit!.method).toBe("POST");
    // X-Collector-Secret header present
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers["X-Collector-Secret"]).toBe("test-collector-secret-for-unit-tests");

    // FormData fields EXACT
    const formData = capturedInit!.body as FormData;
    expect(formData.get("documentId")).toBe("doc-row-1");
    expect(formData.get("workspaceId")).toBe(WS_ID);
    expect(formData.get("workspaceName")).toBe("Ops Workspace"); // Pitfall 2 — server-side resolved
    expect(formData.get("embeddingModel")).toBe("embed-x");
    expect(formData.get("docType")).toBe("txt");
    const file = formData.get("file") as File;
    expect(file.name).toBe("Notes.txt");
  });

  it("missing workspace → structured error, no row, no dispatch", async () => {
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await createAndDispatchConnectorDocument({
      workspaceId: WS_ID,
      fileName: "a.txt",
      fileBytes: Buffer.from("x"),
      fileId: "f",
      provider: "google",
      docType: "txt",
      embeddingModel: "e",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Workspace not found");
    expect(prisma.document.create).not.toHaveBeenCalled();
  });

  it("size cap rejects oversized payloads BEFORE any row write", async () => {
    const res = await createAndDispatchConnectorDocument({
      workspaceId: WS_ID,
      fileName: "huge.bin",
      fileBytes: Buffer.alloc(101 * 1024 * 1024),
      fileId: "big",
      provider: "google",
      docType: "txt",
      embeddingModel: "e",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("too large");
      expect(res.error).toContain("100 MB");
    }
    expect(prisma.document.create).not.toHaveBeenCalled();
  });

  it("timeout message convention on abort (never a bare timeout error)", async () => {
    // Configure the operator cap via the real env path.
    const { clearEnvCache } = await import("../config/env");
    process.env.COLLECTOR_INGEST_TIMEOUT_MS = "2000";
    clearEnvCache();

    globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
      // Honor the AbortController signal — when it fires, reject the way
      // undici does (the bridge's catch reads controller.signal.aborted).
      const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (signal) {
          signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
        }
      });
    }) as unknown as typeof fetch;

    const res = await createAndDispatchConnectorDocument({
      workspaceId: WS_ID,
      fileName: "a.txt",
      fileBytes: Buffer.from("x"),
      fileId: "f",
      provider: "google",
      docType: "txt",
      embeddingModel: "e",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("Collector ingest timed out after 2s");
      expect(res.error).toContain("raise COLLECTOR_INGEST_TIMEOUT_MS");
      expect(res.error).not.toContain("The operation was aborted");
    }

    delete process.env.COLLECTOR_INGEST_TIMEOUT_MS;
    clearEnvCache();
  });

  it("collector non-ok → structured error carrying the collector status", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Embedding failed" }), { status: 500 })) as unknown as typeof fetch;

    const res = await createAndDispatchConnectorDocument({
      workspaceId: WS_ID,
      fileName: "a.txt",
      fileBytes: Buffer.from("x"),
      fileId: "f",
      provider: "google",
      docType: "txt",
      embeddingModel: "e",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Collector error (500)");
  });
});

// ─── Task 1 (plan 02): gdrive_read / gdrive_ingest skill arms ───────────

describe("gdrive_read + gdrive_ingest skills", () => {
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    // Re-register the module skills — the palette-gate describe above calls
    // _clearAllSkills() in its beforeEach (jest runs beforeEach of THAT
    // describe only within it, but module load order means the import
    // already happened; registerSkill is idempotent Map.set).
    await import("../agent/connectors/skills");
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ organizationId: ORG_ID, name: "Ops Workspace" });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function authorizedGoogle() {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(
      authorizedRowWithBlob("https://www.googleapis.com/auth/drive.readonly"),
    );
  }

  it("gdrive_read populated arm returns the file text (token never in data)", async () => {
    authorizedGoogle();
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("/export?")) {
        return new Response("# Doc body", { status: 200 });
      }
      return new Response(
        JSON.stringify({ id: "doc1", name: "Doc", mimeType: "application/vnd.google-apps.document" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const skill = getSkill("gdrive_read")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { fileId: "doc1" } });
    expect(res.success).toBe(true);
    expect(String(res.data)).toContain("Doc body");
    expect(String(res.data)).not.toContain("at-connector-test-token");
  });

  it("gdrive_read missing fileId → structured param error", async () => {
    const skill = getSkill("gdrive_read")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: {} });
    expect(res.success).toBe(false);
    expect(res.error).toContain("fileId parameter is required");
  });

  it("gdrive_ingest end-to-end: row created + collector dispatched + structured success", async () => {
    authorizedGoogle();
    (prisma.document.create as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "doc-row-9",
      ...data,
    }));
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/drive/v3/files/")) {
        if (String(url).includes("/export?")) {
          return new Response("# Ingest body", { status: 200 });
        }
        return new Response(
          JSON.stringify({
            id: "doc9",
            name: "Quarterly",
            mimeType: "application/vnd.google-apps.document",
          }),
          { status: 200 },
        );
      }
      // collector /api/ingest
      void init;
      return new Response(JSON.stringify({ chunkCount: 2 }), { status: 200 });
    }) as unknown as typeof fetch;

    const skill = getSkill("gdrive_ingest")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { fileId: "doc9" } });
    expect(res.success).toBe(true);
    expect(String(res.data)).toContain("doc-row-9");
    expect(String(res.data)).toContain("rag_search");
  });

  it("gdrive_ingest rejects an LLM fileId with URL-hostile characters BEFORE any fetch", async () => {
    authorizedGoogle();
    const fetchSpy = jest.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const skill = getSkill("gdrive_ingest")!;
    const res = await skill.execute({
      workspaceId: WS_ID,
      userId: "u",
      metadata: { fileId: "../secrets?x=1" },
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("characters that are not allowed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─── Task 2 (plan 02): Graph tools — mail/sharepoint/onedrive ───────────

describe("searchGraphMail — two-mode query shaping (Pitfall 6)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("search mode (default): $search present, $orderby absent, $select set", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string | URL) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ value: [{ subject: "Hi", from: { emailAddress: { name: "A", address: "a@b.c" } }, receivedDateTime: "2026-01-01T00:00:00Z", bodyPreview: "p", hasAttachments: true }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { messages } = await searchGraphMail("tok", { query: "quarterly" });
    const decoded = decodeURIComponent(capturedUrl);
    expect(decoded).toContain("$search=");
    expect(decoded).toContain('"quarterly"');
    expect(decoded).not.toContain("$orderby");
    expect(decoded).toContain("$select=subject");
    expect(decoded).toContain("$top=25");
    expect(messages).toHaveLength(1);
  });

  it("filter mode: $filter contains(subject,'…') present, $search absent", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string | URL) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await searchGraphMail("tok", { query: "invoice", mode: "filter" });
    const decoded = decodeURIComponent(capturedUrl);
    expect(decoded).toContain("$filter=contains(subject,'invoice')");
    expect(decoded).not.toContain("$search");
  });

  it("nextLink continuation follows the provider cursor verbatim (no $skip construction)", async () => {
    const NEXT = "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=abc";
    let capturedUrl = "";
    globalThis.fetch = (async (url: string | URL) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ value: [{ subject: "p2" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { messages } = await searchGraphMail("tok", { query: "x", nextLink: NEXT });
    expect(capturedUrl).toBe(NEXT); // followed verbatim
    expect(capturedUrl).not.toContain("$skip=");
    expect(messages[0]!.subject).toBe("p2");
  });

  it("surfaces the provider @odata.nextLink verbatim", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ value: [], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=zz" }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const { nextLink } = await searchGraphMail("tok", { query: "x" });
    expect(nextLink).toBe("https://graph.microsoft.com/v1.0/me/messages?$skiptoken=zz");
  });
});

describe("searchSharepointSites / searchSiteDriveItems — URL shapes", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("tenant site search hits /v1.0/sites?search=", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string | URL) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ value: [{ id: "site1", displayName: "Contoso", webUrl: "https://contoso.sharepoint.com/sites/contoso" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { sites } = await searchSharepointSites("tok", "contoso");
    expect(capturedUrl).toContain("/v1.0/sites");
    expect(capturedUrl).toContain("search=contoso");
    expect(sites[0]!.id).toBe("site1");
  });

  it("site-scoped drive search hits /v1.0/sites/{siteId}/drive/root/search(q=…)", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string | URL) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ value: [{ id: "item1", name: "Deck.pptx", size: 42 }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { items } = await searchSiteDriveItems("tok", "site1", "deck");
    expect(capturedUrl).toContain("/v1.0/sites/site1/drive/root/search");
    expect(items[0]!.name).toBe("Deck.pptx");
  });
});

describe("downloadOneDriveItem — redirect-follow pin (Pitfall 4 / T-196-10)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("content GET is sent WITHOUT redirect:manual (default follow) and never re-attaches a Bearer", async () => {
    const inits: (RequestInit | undefined)[] = [];
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      inits.push(init);
      if (String(_url).includes("/content")) {
        return new Response("FILEBYTES", { status: 200 });
      }
      return new Response(JSON.stringify({ id: "od1", name: "Book.xlsx", size: 9 }), { status: 200 });
    }) as unknown as typeof fetch;

    const { bytes, fileName } = await downloadOneDriveItem("tok", "od1");
    expect(bytes.toString()).toBe("FILEBYTES");
    expect(fileName).toBe("Book.xlsx");
    // The content request must not carry redirect: "manual".
    const contentInit = inits.find((i) => i);
    expect(contentInit).toBeDefined();
    expect((contentInit as { redirect?: string }).redirect).not.toBe("manual");
  });

  it("non-ok content status → structured error", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("/content")) {
        return new Response("denied", { status: 403 });
      }
      return new Response(JSON.stringify({ id: "od1", name: "Book.xlsx" }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(downloadOneDriveItem("tok", "od1")).rejects.toThrow("Microsoft Graph download failed (HTTP 403)");
  });
});

describe("graph_* skills — execute arms + scope gates (D-08)", () => {
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    await import("../agent/connectors/skills");
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ organizationId: ORG_ID, name: "Ops Workspace" });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function authorizedMicrosoft(scope: string) {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(
      authorizedRowWithBlob(scope),
    );
  }

  const MAIL = "https://graph.microsoft.com/Mail.Read";
  const SITES = "https://graph.microsoft.com/Sites.Read.All";
  const FILES = "https://graph.microsoft.com/Files.Read";

  it("graph_mail_search missing scope → fail-closed error naming Mail.Read", async () => {
    authorizedMicrosoft(FILES);
    const skill = getSkill("graph_mail_search")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { query: "x" } });
    expect(res.success).toBe(false);
    expect(res.error).toContain("missing required scope");
    expect(res.error).toContain(MAIL);
  });

  it("graph_sharepoint_search missing scope → fail-closed error naming Sites.Read.All", async () => {
    authorizedMicrosoft(FILES);
    const skill = getSkill("graph_sharepoint_search")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { query: "x" } });
    expect(res.success).toBe(false);
    expect(res.error).toContain(SITES);
  });

  it("graph_onedrive_ingest missing scope → fail-closed error naming Files.Read", async () => {
    authorizedMicrosoft(MAIL);
    const skill = getSkill("graph_onedrive_ingest")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { fileId: "od1" } });
    expect(res.success).toBe(false);
    expect(res.error).toContain(FILES);
  });

  it("graph_mail_search populated arm: formatted list, no connection missing error, token never in data", async () => {
    authorizedMicrosoft(`${FILES} ${MAIL} ${SITES}`);
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          value: [{ subject: "Budget", from: { emailAddress: { name: "Fin", address: "fin@x.com" } }, receivedDateTime: "2026-05-01T00:00:00Z", bodyPreview: "numbers", hasAttachments: false }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const skill = getSkill("graph_mail_search")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { query: "budget" } });
    expect(res.success).toBe(true);
    expect(String(res.data)).toContain("Budget");
    expect(String(res.data)).toContain("fin@x.com");
    expect(String(res.data)).not.toContain("at-connector-test-token");
  });

  it("graph_mail_search empty arm → success with explicit no-results message", async () => {
    authorizedMicrosoft(MAIL);
    globalThis.fetch = (async () => new Response(JSON.stringify({ value: [] }), { status: 200 })) as unknown as typeof fetch;

    const skill = getSkill("graph_mail_search")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { query: "nothing" } });
    expect(res.success).toBe(true);
    expect(String(res.data)).toContain("No messages matched");
  });

  it("graph_onedrive_ingest end-to-end: metadata + redirect-followed download + row + dispatch (bridge contract unchanged)", async () => {
    authorizedMicrosoft(FILES);
    (prisma.document.create as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "doc-row-m1",
      ...data,
    }));
    const collectorInits: (RequestInit | undefined)[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/ingest")) {
        collectorInits.push(init);
        return new Response(JSON.stringify({ chunkCount: 3 }), { status: 200 });
      }
      if (u.includes("/content")) {
        return new Response("M365BYTES", { status: 200 });
      }
      return new Response(JSON.stringify({ id: "od1", name: "Report.docx", size: 9 }), { status: 200 });
    }) as unknown as typeof fetch;

    const skill = getSkill("graph_onedrive_ingest")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { fileId: "od1" } });
    expect(res.success).toBe(true);
    expect(String(res.data)).toContain("doc-row-m1");

    // The multipart contract is UNCHANGED for the Graph path — same fields,
    // same secret header, same timeout convention; only the byte source differs.
    expect(collectorInits).toHaveLength(1);
    const fd = collectorInits[0]!.body as FormData;
    expect(fd.get("documentId")).toBe("doc-row-m1");
    expect(fd.get("workspaceName")).toBe("Ops Workspace");
    expect((collectorInits[0]!.headers as Record<string, string>)["X-Collector-Secret"]).toBeDefined();
  });

  it("graph_sharepoint_search siteId with URL-hostile characters → structured V5 error, no fetch", async () => {
    authorizedMicrosoft(SITES);
    const fetchSpy = jest.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const skill = getSkill("graph_sharepoint_search")!;
    const res = await skill.execute({
      workspaceId: WS_ID,
      userId: "u",
      metadata: { query: "x", siteId: "a/b?c" },
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("characters that are not allowed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("graph_onedrive_ingest missing fileId → structured param error", async () => {
    authorizedMicrosoft(FILES);
    const skill = getSkill("graph_onedrive_ingest")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: {} });
    expect(res.success).toBe(false);
    expect(res.error).toContain("fileId parameter is required");
  });

  it("graph_mail_search: registry maps all three graph skills to the microsoft provider", () => {
    expect(CONNECTOR_SKILL_PROVIDERS["graph_mail_search"]).toBe("microsoft");
    expect(CONNECTOR_SKILL_PROVIDERS["graph_sharepoint_search"]).toBe("microsoft");
    expect(CONNECTOR_SKILL_PROVIDERS["graph_onedrive_ingest"]).toBe("microsoft");
  });
});

// ─── Palette gate (D-04) — connector skills include/exclude ─────────────

describe("resolveSkillsForChat — connector palette gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _clearAllSkills();
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ organizationId: ORG_ID });
    (prisma.chatMCPPin.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.workspaceAgentConfig.findFirst as jest.Mock).mockResolvedValue(null);
  });

  function makeBuiltin(name: string) {
    return {
      name,
      displayName: name,
      description: `desc:${name}`,
      type: "builtin" as const,
      inputSchema: { type: "object", properties: {}, required: [] },
      execute: async () => ({ success: true }),
    };
  }

  it("connector skill INCLUDED when an authorized provider connection exists", async () => {
    registerSkill(makeBuiltin("rag_search"));
    registerSkill(makeBuiltin("gdrive_search"));
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue({ id: "c1" });

    const result = await resolveSkillsForChat(WS_ID, "chat-1", ["rag_search", "gdrive_search"]);
    const names = result.map((s) => s.name);
    expect(names).toContain("gdrive_search");
    expect(names).toContain("rag_search");
  });

  it("connector skill EXCLUDED when no authorized provider connection exists (non-connector skills kept)", async () => {
    registerSkill(makeBuiltin("rag_search"));
    registerSkill(makeBuiltin("gdrive_search"));
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await resolveSkillsForChat(WS_ID, "chat-1", ["rag_search", "gdrive_search"]);
    const names = result.map((s) => s.name);
    expect(names).toContain("rag_search");
    expect(names).not.toContain("gdrive_search");
  });

  it("the availability resolution is batched (one findFirst per distinct provider per call)", async () => {
    registerSkill(makeBuiltin("gdrive_search"));
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue({ id: "c1" });

    await resolveSkillsForChat(WS_ID, "chat-1", ["gdrive_search"]);
    expect(prisma.mCPConnection.findFirst).toHaveBeenCalledTimes(1);
  });

  it("palette gate covers ALL SIX connector skills per-provider (plan 02 Task 3 registry sync)", async () => {
    const SIX = [
      "gdrive_search", "gdrive_read", "gdrive_ingest",
      "graph_mail_search", "graph_sharepoint_search", "graph_onedrive_ingest",
    ];
    for (const name of SIX) {
      expect(CONNECTOR_SKILL_NAMES.has(name)).toBe(true);
    }
    // Phase 197 (MCPO-05 D-01): the three gmail_* tools grow the registry —
    // the palette gate rides registry data growth only (no gate code change).
    expect(CONNECTOR_SKILL_NAMES.size).toBe(9);
    expect(CONNECTOR_SKILL_PROVIDERS["gmail_search"]).toBe("google");
    expect(CONNECTOR_SKILL_PROVIDERS["gmail_get_thread"]).toBe("google");
    expect(CONNECTOR_SKILL_PROVIDERS["gmail_ingest_thread"]).toBe("google");
    expect(CONNECTOR_SKILL_PROVIDERS["gdrive_search"]).toBe("google");
    expect(CONNECTOR_SKILL_PROVIDERS["gdrive_read"]).toBe("google");
    expect(CONNECTOR_SKILL_PROVIDERS["gdrive_ingest"]).toBe("google");
    expect(CONNECTOR_SKILL_PROVIDERS["graph_mail_search"]).toBe("microsoft");
    expect(CONNECTOR_SKILL_PROVIDERS["graph_sharepoint_search"]).toBe("microsoft");
    expect(CONNECTOR_SKILL_PROVIDERS["graph_onedrive_ingest"]).toBe("microsoft");
  });

  it("palette gate: each connector skill is EXCLUDED without an authorized connection and INCLUDED with one (both providers)", async () => {
    const SIX = [
      "gdrive_search", "gdrive_read", "gdrive_ingest",
      "graph_mail_search", "graph_sharepoint_search", "graph_onedrive_ingest",
    ];
    const skillSet = new Set(SIX);
    for (const name of SIX) {
      registerSkill(makeBuiltin(name));
    }
    registerSkill(makeBuiltin("rag_search"));

    // Without ANY authorized connection: every connector skill excluded,
    // non-connector skills kept.
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(null);
    const excluded = await resolveSkillsForChat(WS_ID, "chat-1", [...SIX, "rag_search"]);
    const excludedNames = excluded.map((s) => s.name);
    for (const name of SIX) {
      expect(excludedNames).not.toContain(name);
    }
    expect(excludedNames).toContain("rag_search");

    // With an authorized connection (find resolves): connector skills whose
    // provider resolves are included. One authorized google row → the three
    // gdrive_* skills appear; the graph_* skills stay out (microsoft not
    // connected — batched per-provider resolution decides each).
    (prisma.mCPConnection.findFirst as jest.Mock).mockImplementation(
      async (args: { where: { oauthProvider?: string } }) =>
        args.where.oauthProvider === "google" ? { id: "g1" } : null,
    );
    const included = await resolveSkillsForChat(WS_ID, "chat-1", [...SIX, "rag_search"]);
    const includedNames = included.map((s) => s.name);
    expect(includedNames).toContain("gdrive_search");
    expect(includedNames).toContain("gdrive_read");
    expect(includedNames).toContain("gdrive_ingest");
    expect(includedNames).toContain("rag_search");
    expect(includedNames).not.toContain("graph_mail_search");
    expect(includedNames).not.toContain("graph_sharepoint_search");
    expect(includedNames).not.toContain("graph_onedrive_ingest");
    void skillSet;
  });

  it("empty/null input arms for the remaining skills — structured errors, never thrown", async () => {
    // The real connector skills were registered by the module side-effect
    // import, but the registry-mutation tests in THIS describe overwrote
    // some with stubs — and describe-local `_clearAllSkills()` ran in
    // beforeEach. resetModules re-runs the connectors/skills module against
    // a FRESH agent/skills instance; the reloaded getSkill must be imported
    // from that same fresh instance (the static top-level binding points at
    // the old cleared Map).
    jest.resetModules();
    jest.doMock("../utils/prisma", () => ({ __esModule: true, default: prisma }));
    jest.doMock("../utils/logger", () => ({
      __esModule: true,
      default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));
    await import("../agent/connectors/skills");
    const { getSkill: freshGetSkill } = await import("../agent/skills");

    // gdrive_read: null/empty fileId
    const read = freshGetSkill("gdrive_read")!;
    let res = await read.execute({ workspaceId: WS_ID, userId: "u", metadata: {} });
    expect(res.success).toBe(false);
    expect(res.error).toContain("fileId parameter is required");
    res = await read.execute({ workspaceId: WS_ID, userId: "u", metadata: { fileId: "" } });
    expect(res.success).toBe(false);

    // graph_mail_search: null/empty query
    const mail = freshGetSkill("graph_mail_search")!;
    res = await mail.execute({ workspaceId: WS_ID, userId: "u", metadata: {} });
    expect(res.success).toBe(false);
    expect(res.error).toContain("query parameter is required");

    // graph_sharepoint_search: null/empty query
    const sp = freshGetSkill("graph_sharepoint_search")!;
    res = await sp.execute({ workspaceId: WS_ID, userId: "u", metadata: {} });
    expect(res.success).toBe(false);
    expect(res.error).toContain("query parameter is required");

    // graph_onedrive_ingest: null fileId
    const ingest = freshGetSkill("graph_onedrive_ingest")!;
    res = await ingest.execute({ workspaceId: WS_ID, userId: "u", metadata: {} });
    expect(res.success).toBe(false);
    expect(res.error).toContain("fileId parameter is required");

    // null workspaceId → structured error (never throw) — mirrors rag_search guard
    const readWs = await read.execute({ workspaceId: "", userId: "u", metadata: { fileId: "f" } });
    expect(readWs.success).toBe(false);
    const mailWs = await mail.execute({ workspaceId: "", userId: "u", metadata: { query: "q" } });
    expect(mailWs.success).toBe(false);
    const spWs = await sp.execute({ workspaceId: "", userId: "u", metadata: { query: "q" } });
    expect(spWs.success).toBe(false);
    const ingestWs = await ingest.execute({ workspaceId: "", userId: "u", metadata: { fileId: "f" } });
    expect(ingestWs.success).toBe(false);
  });
});

// ─── Phase 197 (MCPO-05): Gmail REST client + skills ───────────────────

describe("searchGmailMessages — Gmail v1 messages.list + metadata enrichment", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds the messages.list request (q verbatim + maxResults + pageToken) and maps metadata", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          messages: [{ id: "m1", threadId: "t1" }],
          resultSizeEstimate: 1,
          nextPageToken: "tok2",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const { messages, nextPageToken } = await searchGmailMessages("tok", "subject:invoice", {
      pageSize: 10,
      pageToken: "tok2",
    });
    const listUrl = urls[0]!;
    // q passed VERBATIM (Gmail search syntax is the documented contract).
    expect(listUrl).toContain("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    expect(listUrl).toContain("q=subject%3Ainvoice");
    expect(listUrl).toContain("maxResults=10");
    expect(listUrl).toContain("pageToken=tok2");
    expect(nextPageToken).toBe("tok2");
    // The ids-only list is enriched by the N+1 metadata-get (Pitfall 4).
    expect(messages).toHaveLength(1);
    expect(urls.some((u) => /\/gmail\/v1\/users\/me\/messages\/m1\?/.test(u))).toBe(true);
  });

  it("enriches each listed id with ONE metadata get (format=metadata + metadataHeaders) — snippet pinned", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/gmail/v1/users/me/messages?")) {
        return new Response(JSON.stringify({ messages: [{ id: "m1", threadId: "t1" }] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          id: "m1",
          threadId: "t1",
          snippet: "Q3 budget numbers inside",
          payload: {
            headers: [
              { name: "Subject", value: "Q3 Budget" },
              { name: "From", value: "Finance <fin@x.com>" },
              { name: "Date", value: "Mon, 1 Jan 2026 10:00:00 +0000" },
            ],
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const { messages } = await searchGmailMessages("tok", "budget");
    // The N+1 metadata-get URL shape (Pitfall 4).
    expect(urls.some((u) => /\/gmail\/v1\/users\/me\/messages\/m1\?/.test(u))).toBe(true);
    expect(urls.some((u) => u.includes("format=metadata"))).toBe(true);
    // Repeated query keys survive (URLSearchParams.set would overwrite them).
    expect(urls.some((u) => u.includes("metadataHeaders=Subject") && u.includes("metadataHeaders=From") && u.includes("metadataHeaders=Date"))).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.subject).toBe("Q3 Budget");
    expect(messages[0]!.from).toBe("Finance <fin@x.com>");
    expect(messages[0]!.date).toContain("2026");
    // snippet is the top-level Message field (present in metadata format).
    expect(messages[0]!.snippet).toBe("Q3 budget numbers inside");
  });

  it("maxResults clamps at 25 (N+1 budget — T-197-05) and honors the list cap", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string | URL) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await searchGmailMessages("tok", "x", { pageSize: 500 });
    expect(capturedUrl).toContain("maxResults=25");
  });

  it("propagates the non-ok status error (no body echo)", async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    await expect(searchGmailMessages("tok", "x")).rejects.toThrow("HTTP 403");
  });

  it("GMAIL_READONLY_SCOPE is the gmail.readonly scope string", () => {
    expect(GMAIL_READONLY_SCOPE).toBe("https://www.googleapis.com/auth/gmail.readonly");
  });
});

describe("extractGmailText — base64url MIME-tree extraction (Pitfall 3)", () => {
  it("decodes base64url body.data — multi-byte fixture round-trip (NEVER plain base64)", () => {
    const fixture = "héllo wörld 📧 — multi-byte";
    const encoded = Buffer.from(fixture, "utf8").toString("base64url");
    const text = extractGmailText({ mimeType: "text/plain", body: { data: encoded } });
    expect(text).toBe(fixture);
  });

  it("prefers text/plain in a multipart/alternative tree (depth-first)", () => {
    const encoded = (s: string) => Buffer.from(s, "utf8").toString("base64url");
    const part = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: encoded("plain wins") } },
        { mimeType: "text/html", body: { data: encoded("<p>html ignored</p>") } },
      ],
    };
    expect(extractGmailText(part)).toBe("plain wins");
  });

  it("falls back to text/html with tag-strip + [HTML content] note when no text/plain exists", () => {
    const encoded = (s: string) => Buffer.from(s, "utf8").toString("base64url");
    const part = {
      mimeType: "multipart/alternative",
      parts: [{ mimeType: "text/html", body: { data: encoded("<p>Only <b>HTML</b></p><script>alert(1)</script>") } }],
    };
    const text = extractGmailText(part);
    expect(text).toContain("[HTML content]");
    expect(text).toContain("Only HTML");
    expect(text).not.toContain("<p>");
    expect(text).not.toContain("alert(1)");
  });

  it("returns null when the subtree carries no decodable text", () => {
    expect(extractGmailText({ mimeType: "multipart/mixed", parts: [] })).toBeNull();
    expect(extractGmailText({ mimeType: "application/pdf", body: { data: "AAAA" } })).toBeNull();
  });
});

describe("composeGmailThreadText — 50k bound + truncation marker", () => {
  it("composes per-message headers + text and marks truncation beyond 50k chars", () => {
    const thread = {
      id: "t1",
      messages: [
        { id: "m1", threadId: "t1", snippet: "s", subject: "S1", from: "a@x.com", date: "2026-01-01", text: "First" },
        { id: "m2", threadId: "t1", snippet: "s", subject: "S1", from: "b@x.com", date: "2026-01-02", text: "Second" },
      ],
    };
    const text = composeGmailThreadText(thread);
    expect(text).toContain("--- Message 1 — 2026-01-01 — a@x.com ---");
    expect(text).toContain("First");
    expect(text).toContain("--- Message 2 — 2026-01-02 — b@x.com ---");
    expect(text).toContain("Second");

    const bigMessageText = "x".repeat(60_000);
    const bigThread = {
      id: "t1",
      messages: [{ id: "m1", threadId: "t1", snippet: "", subject: "S", from: "a", date: "d", text: bigMessageText }],
    };
    const bounded = composeGmailThreadText(bigThread);
    expect(bounded.length).toBeLessThanOrEqual(50_000 + 200); // bound + marker
    expect(bounded).toContain("[Content truncated at 50000 characters");
  });
});

describe("getGmailThread — threads.get format=full (Pitfall 5)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds the threads.get URL (format=full, encodeURIComponent path) and extracts body text", async () => {
    const urls: string[] = [];
    const encoded = (s: string) => Buffer.from(s, "utf8").toString("base64url");
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          id: "th1",
          messages: [
            {
              id: "m1",
              threadId: "th1",
              snippet: "snip",
              payload: {
                headers: [{ name: "Subject", value: "Thread" }, { name: "From", value: "a@x.com" }, { name: "Date", value: "Mon, 1 Jan 2026" }],
                parts: [{ mimeType: "text/plain", body: { data: encoded("Thread body") } }],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const thread = await getGmailThread("tok", "th1");
    expect(urls[0]).toContain("/gmail/v1/users/me/threads/th1?format=full");
    expect(thread.id).toBe("th1");
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]!.subject).toBe("Thread");
    expect(thread.messages[0]!.text).toBe("Thread body");
  });

  it("propagates the 404 thread-not-found as a status error", async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(new Response("not found", { status: 404 })) as unknown as typeof fetch;
    await expect(getGmailThread("tok", "th-missing")).rejects.toThrow("HTTP 404");
  });
});

describe("gmail_search skill — execute arms (Phase 197 MCPO-05)", () => {
  const originalFetch = globalThis.fetch;

  // The palette-gate describe above runs jest.resetModules() in its last
  // test — the static getSkill binding points at a CLEARED skills Map from
  // the old module instance. Re-import the skill module + a FRESH getSkill
  // from the reloaded agent/skills instance (same seam the existing
  // "empty/null input arms" test uses).
  let freshGetSkill: (name: string) => import("../agent/skills").AgentSkillDefinition | undefined;

  beforeAll(async () => {
    jest.resetModules();
    jest.doMock("../utils/prisma", () => ({ __esModule: true, default: prisma }));
    jest.doMock("../utils/logger", () => ({
      __esModule: true,
      default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));
    // Side-effect-import the skill module exactly like builtinSkills.ts does.
    await import("../agent/connectors/skills");
    // getSkill must come from the RELOADED agent/skills instance (the static
    // top-level binding points at the old cleared Map after resetModules).
    const fresh = await import("../agent/skills");
    freshGetSkill = fresh.getSkill as typeof freshGetSkill;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ organizationId: ORG_ID });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("registers gmail_search as a builtin skill", () => {
    const skill = freshGetSkill("gmail_search");
    expect(skill).toBeDefined();
    expect(skill!.type).toBe("builtin");
    expect(skill!.inputSchema).toEqual(
      expect.objectContaining({
        type: "object",
        required: ["query"],
      }),
    );
  });

  it("missing connection → structured 'connect it first' error naming the settings surface", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(null);

    const skill = freshGetSkill("gmail_search")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { query: "x" } });
    expect(res.success).toBe(false);
    expect(res.error).toContain("No authorized google connection");
    expect(res.error).toContain("Settings → MCP Connections");
  });

  it("missing scope → fail-closed error naming gmail.readonly (D-08)", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(
      authorizedRowWithBlob("https://www.googleapis.com/auth/drive.readonly"),
    );

    const skill = freshGetSkill("gmail_search")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { query: "x" } });
    expect(res.success).toBe(false);
    expect(res.error).toContain("missing required scope");
    expect(res.error).toContain(GMAIL_READONLY_SCOPE);
  });

  it("populated arm → formatted listing; Bearer inside execute; token never in data/error", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(
      authorizedRowWithBlob(GMAIL_READONLY_SCOPE),
    );
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          messages: [{ id: "m1", threadId: "t1" }],
          nextPageToken: "npt-1",
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    // The messages.list arm returns ids only — the per-id metadata GET rides
    // the same fetch stub chain; provide it on a second URL family.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/gmail/v1/users/me/messages?")) {
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer at-connector-test-token");
        return realFetch(url, init);
      }
      return new Response(
        JSON.stringify({
          id: "m1",
          threadId: "t1",
          snippet: "Hello from the mailbox",
          payload: { headers: [{ name: "Subject", value: "Hi" }, { name: "From", value: "a@x.com" }, { name: "Date", value: "Mon, 1 Jan 2026" }] },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const skill = freshGetSkill("gmail_search")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { query: "hi" } });
    expect(res.success).toBe(true);
    const data = String(res.data);
    expect(data).toContain("Hi");
    expect(data).toContain("a@x.com");
    expect(data).toContain("m1");
    expect(data).toContain("pageToken \"npt-1\"");
    expect(data).not.toContain("at-connector-test-token");
    expect(String(res.error ?? "")).not.toContain("at-connector-test-token");
  });

  it("empty arm → success with an explicit no-results message (MCPO-05/empty)", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(
      authorizedRowWithBlob(GMAIL_READONLY_SCOPE),
    );
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ messages: [] }), { status: 200 })) as unknown as typeof fetch;

    const skill = freshGetSkill("gmail_search")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { query: "nothing" } });
    expect(res.success).toBe(true);
    expect(String(res.data)).toContain("No messages matched the search query");
  });

  it("missing query param → structured param error", async () => {
    const skill = freshGetSkill("gmail_search")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: {} });
    expect(res.success).toBe(false);
    expect(res.error).toContain("query parameter is required");
  });

  it("the three gmail names are registered in the palette registry → provider google (D-01)", () => {
    expect(CONNECTOR_SKILL_NAMES.has("gmail_search")).toBe(true);
    expect(CONNECTOR_SKILL_NAMES.has("gmail_get_thread")).toBe(true);
    expect(CONNECTOR_SKILL_NAMES.has("gmail_ingest_thread")).toBe(true);
    expect(CONNECTOR_SKILL_PROVIDERS["gmail_search"]).toBe("google");
    expect(CONNECTOR_SKILL_PROVIDERS["gmail_get_thread"]).toBe("google");
    expect(CONNECTOR_SKILL_PROVIDERS["gmail_ingest_thread"]).toBe("google");
  });
});

describe("gmail_get_thread + gmail_ingest_thread skills — execute arms (Phase 197 MCPO-05)", () => {
  const originalFetch = globalThis.fetch;

  let freshGetSkill2: (name: string) => import("../agent/skills").AgentSkillDefinition | undefined;

  beforeAll(async () => {
    // The gmail_search describe above ran jest.resetModules() — reload the
    // skill module and resolve getSkill from the SAME fresh instance.
    jest.resetModules();
    jest.doMock("../utils/prisma", () => ({ __esModule: true, default: prisma }));
    jest.doMock("../utils/logger", () => ({
      __esModule: true,
      default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));
    await import("../agent/connectors/skills");
    const fresh = await import("../agent/skills");
    freshGetSkill2 = fresh.getSkill as typeof freshGetSkill2;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ organizationId: ORG_ID, name: "Ops Workspace" });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function authorizedGoogle(scope: string) {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(authorizedRowWithBlob(scope));
  }

  const encoded = (s: string) => Buffer.from(s, "utf8").toString("base64url");

  function fakeThreadFetch() {
    return (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/ingest")) {
        return new Response(JSON.stringify({ chunkCount: 5 }), { status: 200 });
      }
      if (u.includes("/gmail/v1/users/me/threads/th1")) {
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer at-connector-test-token");
        return new Response(
          JSON.stringify({
            id: "th1",
            messages: [
              {
                id: "m1",
                threadId: "th1",
                snippet: "first snip",
                payload: {
                  headers: [
                    { name: "Subject", value: "Invoice thread" },
                    { name: "From", value: "billing@x.com" },
                    { name: "Date", value: "Mon, 1 Jan 2026" },
                  ],
                  parts: [{ mimeType: "text/plain", body: { data: encoded("First body") } }],
                },
              },
              {
                id: "m2",
                threadId: "th1",
                snippet: "second snip",
                payload: {
                  headers: [
                    { name: "Subject", value: "Re: Invoice thread" },
                    { name: "From", value: "me@x.com" },
                    { name: "Date", value: "Tue, 2 Jan 2026" },
                  ],
                  parts: [{ mimeType: "text/html", body: { data: encoded("<p>Second <b>body</b></p>") } }],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("gmail_get_thread populated arm → readable transcript (header + subject + text); token never in data", async () => {
    authorizedGoogle(GMAIL_READONLY_SCOPE);
    globalThis.fetch = fakeThreadFetch();

    const skill = freshGetSkill2("gmail_get_thread")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { threadId: "th1" } });
    expect(res.success).toBe(true);
    const data = String(res.data);
    expect(data).toContain("Gmail thread th1 (2 messages)");
    expect(data).toContain("--- Message 1 — Mon, 1 Jan 2026 — billing@x.com ---");
    expect(data).toContain("First body");
    // HTML fallback labeled + stripped (no raw tags in the excerpt).
    expect(data).toContain("[HTML content]");
    expect(data).toContain("Second body");
    expect(data).not.toContain("<p>");
    expect(data).not.toContain("at-connector-test-token");
    expect(String(res.error ?? "")).not.toContain("at-connector-test-token");
  });

  it("gmail_get_thread 404 → structured 'Thread not found' error", async () => {
    authorizedGoogle(GMAIL_READONLY_SCOPE);
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(new Response("not found", { status: 404 })) as unknown as typeof fetch;

    const skill = freshGetSkill2("gmail_get_thread")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { threadId: "th-missing" } });
    expect(res.success).toBe(false);
    expect(res.error).toContain("Thread not found");
  });

  it("gmail_get_thread threadId with URL-hostile characters → structured V5 error, no fetch", async () => {
    authorizedGoogle(GMAIL_READONLY_SCOPE);
    const fetchSpy = jest.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const skill = freshGetSkill2("gmail_get_thread")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { threadId: "a/b?c" } });
    expect(res.success).toBe(false);
    expect(res.error).toContain("characters that are not allowed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gmail_get_thread missing threadId → structured param error", async () => {
    const skill = freshGetSkill2("gmail_get_thread")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: {} });
    expect(res.success).toBe(false);
    expect(res.error).toContain("threadId parameter is required");
  });

  it("gmail_get_thread missing scope → fail-closed error naming gmail.readonly", async () => {
    authorizedGoogle("https://www.googleapis.com/auth/drive.readonly");
    const skill = freshGetSkill2("gmail_get_thread")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { threadId: "th1" } });
    expect(res.success).toBe(false);
    expect(res.error).toContain(GMAIL_READONLY_SCOPE);
  });

  it("gmail_ingest_thread → composed ONE text document: bridge multipart contract + cacheKey prefix + Document row before dispatch", async () => {
    authorizedGoogle(GMAIL_READONLY_SCOPE);
    (prisma.document.create as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "doc-row-g1",
      ...data,
    }));
    const collectorInits: (RequestInit | undefined)[] = [];
    const documentCreates: Record<string, unknown>[] = [];
    (prisma.document.create as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      documentCreates.push(data);
      return { id: "doc-row-g1", ...data };
    });
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/ingest")) {
        collectorInits.push(init);
        return new Response(JSON.stringify({ chunkCount: 5 }), { status: 200 });
      }
      return (fakeThreadFetch() as unknown as (u: string | URL, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    const skill = freshGetSkill2("gmail_ingest_thread")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { threadId: "th1" } });
    expect(res.success).toBe(true);
    expect(String(res.data)).toContain("doc-row-g1");
    expect(String(res.data)).toContain("rag_search");

    // ONE composed document dispatched (research A3 — single collector call).
    expect(collectorInits).toHaveLength(1);
    const fd = collectorInits[0]!.body as FormData;
    expect(fd.get("documentId")).toBe("doc-row-g1");
    expect(fd.get("workspaceName")).toBe("Ops Workspace");
    expect(fd.get("docType")).toBe("txt");
    expect((collectorInits[0]!.headers as Record<string, string>)["X-Collector-Secret"]).toBeDefined();

    // Document row created BEFORE dispatch with the composed thread bytes.
    expect(documentCreates).toHaveLength(1);
    const row = documentCreates[0]!;
    expect(row.status).toBe("pending");
    expect(row.cacheKey).toMatch(/^connector-google-th1-\d+$/);
    // fileName is ASCII-safe (subject slug sanitized to dashes).
    expect(String(row.name)).toMatch(/^gmail-thread-Invoice-thread-th1\.txt$/);
    const bytes = fd.get("file") as Blob;
    const text = await bytes.text();
    expect(text).toContain("First body");
    expect(text).toContain("[HTML content]");
    expect(text).toContain("--- Message 2");
  });

  it("gmail_ingest_thread missing scope → fail-closed error naming gmail.readonly", async () => {
    authorizedGoogle("https://www.googleapis.com/auth/drive.readonly");
    const skill = freshGetSkill2("gmail_ingest_thread")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { threadId: "th1" } });
    expect(res.success).toBe(false);
    expect(res.error).toContain(GMAIL_READONLY_SCOPE);
  });

  it("gmail_ingest_thread missing connection → structured connect-first error", async () => {
    (prisma.mCPConnection.findFirst as jest.Mock).mockResolvedValue(null);
    const skill = freshGetSkill2("gmail_ingest_thread")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { threadId: "th1" } });
    expect(res.success).toBe(false);
    expect(res.error).toContain("No authorized google connection");
  });

  it("gmail_ingest_thread 404 thread → structured 'Thread not found' error (byteSource throw surfaces)", async () => {
    authorizedGoogle(GMAIL_READONLY_SCOPE);
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(new Response("not found", { status: 404 })) as unknown as typeof fetch;

    const skill = freshGetSkill2("gmail_ingest_thread")!;
    const res = await skill.execute({ workspaceId: WS_ID, userId: "u", metadata: { threadId: "th-missing" } });
    expect(res.success).toBe(false);
    expect(res.error).toContain("Thread not found");
  });
});
