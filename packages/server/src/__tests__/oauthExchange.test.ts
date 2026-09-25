// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 195 (MCPO-01): oauthTokenLifecycle unit tests — exchange/refresh
 * request shapes over a stubbed globalThis.fetch (dlpDocumentMasking pattern;
 * CI runs NETWORK_EGRESS_BLOCKED=1 so no test may touch the network), blob
 * encrypt/decrypt round-trip, and the rotation-chain re-encrypt arm (spec
 * §9-5: refresh decrypts via the LEGACY_PREVIOUS_ENCRYPTION_KEYS chain and
 * the refreshed blob is re-encrypted with the CURRENT key).
 */

import "./helpers/setupEnv";
import {
  exchangeAuthorizationCode,
  refreshAccessToken,
  encryptTokenBlob,
  decryptTokenBlob,
  revokeProviderToken,
  OAuthTokenBlob,
} from "../services/oauthTokenLifecycle";
import { resolveProvider } from "../services/oauthProviderRegistry";
import { encrypt, decrypt, resetEncryptionKeyCache } from "../services/encryptionService";

const googleDef = resolveProvider("google")!;
const microsoftDef = resolveProvider("microsoft")!;

// fetch capture (stub pattern: dlpDocumentMasking.test.ts:38-44,95-99).
let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
const originalFetch = globalThis.fetch;

/** Non-null accessor for the Nth captured call (typecheck-safe in strict TS). */
function callAt(index: number): { url: string; init: RequestInit } {
  const call = fetchCalls[index];
  if (!call) throw new Error(`expected a fetch call at index ${index}`);
  return call;
}

function stubFetch(respond: () => Response): void {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  fetchCalls = [];
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function makeBlob(overrides: Partial<OAuthTokenBlob> = {}): OAuthTokenBlob {
  return {
    accessToken: "at-123",
    refreshToken: "rt-123",
    scope: "https://www.googleapis.com/auth/drive.readonly",
    obtainedAt: new Date("2026-09-22T09:00:00Z").toISOString(),
    ...overrides,
  };
}

describe("oauthTokenLifecycle — exchangeAuthorizationCode", () => {
  it("POSTs the exchange shape (form body keys, code_verifier present) to the token URL", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          access_token: "google-at",
          refresh_token: "google-rt",
          token_type: "Bearer",
          expires_in: 3920,
          scope: "https://www.googleapis.com/auth/drive.readonly",
        }),
        { status: 200 },
      ),
    );
    const result = await exchangeAuthorizationCode(googleDef, {
      code: "the-code",
      clientId: "cid",
      clientSecret: "csec",
      redirectUri: "https://app.example.com/callback",
      verifier: "the-verifier",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blob.accessToken).toBe("google-at");
      expect(result.blob.refreshToken).toBe("google-rt");
      expect(result.blob.obtainedAt).toBeTruthy();
    }
    expect(fetchCalls).toHaveLength(1);
    expect(callAt(0).url).toBe("https://oauth2.googleapis.com/token");
    expect(callAt(0).init.method).toBe("POST");
    const body = String(callAt(0).init.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=the-code");
    expect(body).toContain("client_id=cid");
    expect(body).toContain("client_secret=csec");
    expect(body).toContain("code_verifier=the-verifier");
    expect(body).toContain("redirect_uri=");
  });

  it("carries scope for microsoft on the exchange (Pitfall 4) and the MS secret is URL-encoded", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({ access_token: "ms-at", refresh_token: "ms-rt", scope: "offline_access" }),
        { status: 200 },
      ),
    );
    await exchangeAuthorizationCode(microsoftDef, {
      code: "the-code",
      clientId: "cid",
      clientSecret: "sec+/=",
      redirectUri: "https://app.example.com/callback",
      verifier: "the-verifier",
      scopes: microsoftDef.defaultScopes,
    });
    const body = String(callAt(0).init.body);
    expect(body).toContain("scope=offline_access");
    // URLSearchParams auto-encoding of the secret (RESEARCH Microsoft gotcha):
    expect(body).toContain("client_secret=sec%2B%2F%3D");
  });

  it("returns a structured failure carrying error_description (no token fields) on provider 400", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "Code was already redeemed." }),
        { status: 400 },
      ),
    );
    const result = await exchangeAuthorizationCode(googleDef, {
      code: "the-code",
      clientId: "cid",
      clientSecret: "csec",
      redirectUri: "https://app.example.com/callback",
      verifier: "v",
      scopes: ["x"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorDescription).toBe("Code was already redeemed.");
      expect(JSON.stringify(result)).not.toContain("access_token");
      expect(JSON.stringify(result)).not.toContain("accessToken");
    }
  });

  it("returns a structured failure on network throw (never throws)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await exchangeAuthorizationCode(googleDef, {
      code: "c",
      clientId: "cid",
      clientSecret: "csec",
      redirectUri: "r",
      verifier: "v",
      scopes: ["x"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorDescription).toContain("unreachable");
  });

  it("treats a 200 response without access_token as a failure", async () => {
    stubFetch(() => new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 }));
    const result = await exchangeAuthorizationCode(googleDef, {
      code: "c",
      clientId: "cid",
      clientSecret: "csec",
      redirectUri: "r",
      verifier: "v",
      scopes: ["x"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorDescription).toContain("missing access_token");
  });
});

describe("oauthTokenLifecycle — refreshAccessToken", () => {
  it("POSTs grant_type=refresh_token (+ scope for microsoft) and keeps the existing refreshToken when the provider omits one", async () => {
    stubFetch(() =>
      new Response(
        // Google refresh: refresh_token OMITTED in the response.
        JSON.stringify({ access_token: "google-at2", expires_in: 3920, scope: "https://www.googleapis.com/auth/drive.readonly" }),
        { status: 200 },
      ),
    );
    const result = await refreshAccessToken(googleDef, {
      refreshToken: "google-rt-old",
      clientId: "cid",
      clientSecret: "csec",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blob.accessToken).toBe("google-at2");
      // The existing refreshToken rides forward (RESEARCH refresh example):
      expect(result.blob.refreshToken).toBe("google-rt-old");
    }
    const body = String(callAt(0).init.body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=google-rt-old");
    // Google does not require scope on refresh; the body omits it here:
    expect(body).not.toContain("scope=");
  });

  it("sends scope for microsoft on refresh (Pitfall 4)", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ access_token: "ms-at2", refresh_token: "ms-rt2", scope: "offline_access" }), { status: 200 }),
    );
    await refreshAccessToken(microsoftDef, {
      refreshToken: "ms-rt-old",
      clientId: "cid",
      clientSecret: "csec",
      scopes: microsoftDef.defaultScopes,
    });
    const body = String(callAt(0).init.body);
    expect(body).toContain("scope=");
    expect(body).toContain("grant_type=refresh_token");
  });

  it("returns a structured failure on provider error", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "token expired" }), { status: 400 }),
    );
    const result = await refreshAccessToken(googleDef, {
      refreshToken: "rt",
      clientId: "cid",
      clientSecret: "csec",
      scopes: ["x"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorDescription).toContain("expired");
    }
  });
});

describe("oauthTokenLifecycle — blob encrypt/decrypt round-trip (T-195-01)", () => {
  afterEach(() => {
    // Restore the .env.test posture for later suites.
    delete process.env.ENCRYPTION_KEY;
    delete process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS;
    resetEncryptionKeyCache();
  });

  it("encryptTokenBlob → decryptTokenBlob round-trips the blob fields exactly", () => {
    const blob = makeBlob();
    const encoded = encryptTokenBlob(blob);
    expect(encoded).not.toContain("at-123"); // ciphertext, not plaintext
    const decoded = decryptTokenBlob(encoded);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.blob).toEqual(blob);
    }
  });

  it("round-trips a blob without refreshToken (optional field)", () => {
    const blob = makeBlob({ refreshToken: undefined });
    const decoded = decryptTokenBlob(encryptTokenBlob(blob));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.blob.refreshToken).toBeUndefined();
  });

  it("decrypt failure discloses only that decryption failed (never the blob)", () => {
    // Encrypt under explicit key A, then rotate to key B with a DIFFERENT key
    // in the legacy chain — the chain [B, C, scrypt-tail] contains neither A,
    // so GCM auth fails on every candidate.
    const KEY_A = Buffer.alloc(32, 0xaa).toString("base64");
    const KEY_B = Buffer.alloc(32, 0xbb).toString("base64");
    const KEY_C = Buffer.alloc(32, 0xcc).toString("base64");
    process.env.ENCRYPTION_KEY = KEY_A;
    resetEncryptionKeyCache();
    const encoded = encryptTokenBlob(makeBlob());
    process.env.ENCRYPTION_KEY = KEY_B;
    process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS = KEY_C;
    resetEncryptionKeyCache();
    const decoded = decryptTokenBlob(encoded);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.errorDescription).toBe("OAuth credential blob could not be decrypted");
    }
  });

  it("rotation arm (spec §9-5): refresh decrypts via the LEGACY chain and re-encrypts with the CURRENT key", async () => {
    // Phase 1: encrypt under key A.
    const KEY_A = Buffer.alloc(32, 0xaa).toString("base64");
    const KEY_B = Buffer.alloc(32, 0xbb).toString("base64");
    process.env.ENCRYPTION_KEY = KEY_A;
    resetEncryptionKeyCache();
    const original = {
      accessToken: "rt-old-at",
      refreshToken: "rt-old",
      scope: "s",
      obtainedAt: new Date("2026-09-22T08:00:00Z").toISOString(),
    };
    const encodedOld = encryptTokenBlob(original);
    expect(decryptTokenBlob(encodedOld)).toMatchObject({ ok: true, blob: original });

    // Phase 2: rotate to key B, old key A in the legacy chain.
    process.env.ENCRYPTION_KEY = KEY_B;
    process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS = KEY_A;
    resetEncryptionKeyCache();
    expect(decryptTokenBlob(encodedOld).ok).toBe(true); // chain decrypt works

    // Phase 3: refresh → re-encrypt with the CURRENT key (B).
    stubFetch(() =>
      new Response(JSON.stringify({ access_token: "new-at", expires_in: 3920, scope: "s" }), { status: 200 }),
    );
    const refreshed = await refreshAccessToken(googleDef, {
      refreshToken: "rt-old",
      clientId: "cid",
      clientSecret: "csec",
      scopes: ["s"],
    });
    expect(refreshed.ok).toBe(true);
    if (refreshed.ok) {
      const encodedNew = encryptTokenBlob(refreshed.blob);
      // Decrypting WITHOUT the legacy chain (only B set) must succeed — the
      // refreshed blob was re-encrypted with the current key.
      delete process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS;
      resetEncryptionKeyCache();
      const decodedNew = decryptTokenBlob(encodedNew);
      expect(decodedNew.ok).toBe(true);
      if (decodedNew.ok) expect(decodedNew.blob.refreshToken).toBe("rt-old");
    }
  });
});

describe("oauthTokenLifecycle — revokeProviderToken (D-14)", () => {
  it("skips microsoft (no revokeUrl) with ok+skipped, no fetch", async () => {
    const result = await revokeProviderToken(microsoftDef, "any-token");
    expect(result).toEqual({ ok: true, skipped: true });
    expect(fetchCalls).toHaveLength(0);
  });

  it("POSTs the google revoke endpoint with the encoded token", async () => {
    stubFetch(() => new Response("", { status: 200 }));
    const result = await revokeProviderToken(googleDef, "tok en&special");
    expect(result.ok).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(callAt(0).url).toBe("https://oauth2.googleapis.com/revoke?token=tok%20en%26special");
    expect(callAt(0).init.method).toBe("POST");
  });

  it("never throws on network failure (best-effort; local wipe is primary)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("unreachable");
    }) as unknown as typeof fetch;
    const result = await revokeProviderToken(googleDef, "token");
    expect(result.ok).toBe(true);
  });

  it("treats a non-200 revoke as a warn (ok: true — local wipe still stands)", async () => {
    stubFetch(() => new Response("", { status: 400 }));
    const result = await revokeProviderToken(googleDef, "token");
    expect(result.ok).toBe(true);
  });
});

describe("oauthTokenLifecycle — encryptionService integration", () => {
  it("blob rides the raw encrypt/decrypt primitives (AES-256-GCM iv:tag:ct)", () => {
    const blob = makeBlob();
    const encoded = encrypt(JSON.stringify(blob));
    expect(encoded.split(":")).toHaveLength(3);
    expect(decrypt(encoded)).toBe(JSON.stringify(blob));
  });
});