// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * @fileoverview Public MCP OAuth callback router (Phase 195, MCPO-01 D-07/D-09/D-10).
 *
 * This router contains ONLY `GET /oauth/callback` and carries NO auth,
 * tenant-context, or RBAC middleware ANYWHERE — the IdP browser redirect
 * carries no JWT, and a router-level gate here (or mounting this route inside
 * the admin-gated mcpRoutes, whose `router.use(authMiddleware,
 * tenantContextMiddleware, requireAdmin)` would 401 the browser before any
 * handler ran — Pitfall 2) would kill the flow. It is mounted in createApp()
 * at `/api/mcp-connections` BEFORE mcpRoutes; unmatched paths fall through to
 * the admin router per-path.
 *
 * Security (all fail-closed, D-10):
 * - CSRF: HMAC-signed state (HS256 JWT_SECRET, 10-min exp) — verifyOAuthState
 *   returns null on tamper/expiry, never distinguishing them in the redirect.
 * - Code replay: single-use consumption via `oauthStatus === "pending"` — the
 *   row flips out of pending on the FIRST valid callback, so a replayed
 *   callback hits the error redirect (one valid callback per start).
 * - Multi-tenant IDOR (T-195-10b): the callback is public, so it trusts the
 *   STATE payload's connectionId only to FIND the row, then asserts org and
 *   provider consistency FROM THE ROW (org-from-the-ROW doctrine, Pitfall 8 —
 *   no tenantContextMiddleware here; a fail-closed 404 without a JWT would
 *   kill the browser redirect). A provider mismatch between the row and the
 *   state-authorized def is also fail-closed.
 * - Post-callback response: minimal HTML redirect to the settings MCP surface
 *   with `?oauth=<status>` — never raw JSON in the browser (D-09). The house
 *   redirect primitive `res.redirect(...)` is used (PATTERNS "No Analog
 *   Found" — prefer it over hand-built HTML).
 * - NO token/secret material is ever logged or carried in a redirect target
 *   (T-195-10): logEvent metadata carries { provider } only; redirect targets
 *   carry the status enum value only.
 */

import { Router, type Request, type Response } from "express";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { getEnv } from "../config/env";
import { verifyOAuthState, consumeVerifier } from "../services/oauthStateService";
import { resolveProvider, hasClientConfigured, resolveScopes, resolveRedirectUri } from "../services/oauthProviderRegistry";
import { exchangeAuthorizationCode, encryptTokenBlob } from "../services/oauthTokenLifecycle";
import { connectMCPServer } from "../agent/mcpClient";
import { logEvent } from "../services/eventLogService";

const router = Router();

/**
 * Resolve the env-carried client credentials for a provider (D-06 — client
 * secrets are env-only in v1; the per-org oauthClientId column stays dormant).
 * Values flow ONLY into the exchange body — never logged, never echoed.
 */
function clientCredentials(providerId: string): { clientId: string; clientSecret: string } {
  const env = getEnv();
  if (providerId === "google") {
    return { clientId: env.GOOGLE_CLIENT_ID ?? "", clientSecret: env.GOOGLE_CLIENT_SECRET ?? "" };
  }
  if (providerId === "microsoft") {
    return { clientId: env.MICROSOFT_CLIENT_ID ?? "", clientSecret: env.MICROSOFT_CLIENT_SECRET ?? "" };
  }
  return { clientId: "", clientSecret: "" };
}

/**
 * The post-callback redirect target (D-09 — agent's discretion per
 * 195-CONTEXT "agent's Discretion" bullet 3, resolved at execution time):
 * the live frontend settings surface is a DIALOG opened via /settings deep
 * links; SettingsPage maps ?tab=mcpConnections → the "advanced" tab whose
 * MCP Connections sub-section renders (mapLegacyTab: "mcpconnections" →
 * "advanced"; SectionId "mcpConnections" is the scroll anchor). We keep the
 * `?oauth=<status>` param contract verbatim — Phase 196 reads it to surface
 * the badge/toast.
 */
const SETTINGS_REDIRECT_BASE = "/settings?tab=mcpConnections";

/** Build the redirect target with the oauth status query param (D-09). */
function redirectTarget(status: "authorized" | "error"): string {
  return `${SETTINGS_REDIRECT_BASE}&oauth=${status}`;
}

// T-195-14/D-10: every failure arm funnels through one redirect — signature/
// expiry are never distinguished from each other in the redirect target.
function failClosed(res: Response, context: string, provider?: string): void {
  logger.warn("[mcp-oauth-callback] fail-closed", { context, provider });
  res.redirect(redirectTarget("error"));
}

router.get("/oauth/callback", async (req: Request, res: Response) => {
  // (a) Read state + code from the query — non-string/missing → error
  // redirect (T-195-06). Never log the values themselves.
  const state = req.query.state;
  const code = req.query.code;
  if (typeof state !== "string" || state.length === 0 || typeof code !== "string" || code.length === 0) {
    failClosed(res, "missing or malformed state/code query params");
    return;
  }

  // (b) Verify the signed state — bad signature OR expiry → null → error
  // redirect (D-10 fail-closed; the two cases are never distinguished).
  const verified = verifyOAuthState(state);
  if (!verified) {
    failClosed(res, "state verification failed (signature or expiry)");
    return;
  }
  const connectionId = verified.connectionId;
  // WR-01: the verifier is keyed by the state's nonce — the pairing is bound
  // to THIS state, not to the connection (a second oauth/start issues a new
  // nonce and can never poison an in-flight pairing).
  const stateNonce = verified.nonce;

  // (c) Load the row the state authorizes. Row missing OR oauthStatus !==
  // "pending" → error redirect (single-use replay rejection: one valid
  // callback per start — the first valid callback flips the row out of
  // pending, so a replayed callback lands here, D-10/T-195-07).
  // NO tenantContextMiddleware — org is asserted from the ROW below
  // (org-from-the-ROW doctrine, Pitfall 8; T-195-10b).
  const connection = await prisma.mCPConnection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.oauthStatus !== "pending") {
    failClosed(res, "connection missing or not pending (replay or unknown state)", connection?.oauthProvider ?? undefined);
    return;
  }

  const providerId = connection.oauthProvider ?? "";

  // (d) Provider def must resolve and its client must be configured (D-06).
  // Fail-closed too — a pending row whose provider config vanished cannot
  // complete the exchange.
  const def = resolveProvider(providerId);
  if (!def) {
    await prisma.mCPConnection.update({
      where: { id: connectionId },
      data: { oauthStatus: "error", oauthError: "unknown OAuth provider" },
    });
    failClosed(res, "unknown provider", providerId);
    return;
  }
  if (!hasClientConfigured(providerId)) {
    await prisma.mCPConnection.update({
      where: { id: connectionId },
      data: { oauthStatus: "error", oauthError: "OAuth provider client not configured" },
    });
    failClosed(res, "provider client not configured", providerId);
    return;
  }

  // (e) Single-use PKCE verifier consumption (D-08) — expired/missing pair →
  // error redirect. consumeVerifier deletes on read, so a second valid-state
  // callback also lands here even before the pending check would catch it.
  const verifier = consumeVerifier(stateNonce);
  if (!verifier) {
    await prisma.mCPConnection.update({
      where: { id: connectionId },
      data: { oauthStatus: "error", oauthError: "PKCE verifier expired or missing" },
    });
    failClosed(res, "PKCE verifier missing or expired", providerId);
    return;
  }

  // (f) Code exchange → encrypt → authorized → reconnect kick → redirect.
  try {
    const result = await exchangeAuthorizationCode(def, {
      code,
      ...clientCredentials(providerId),
      redirectUri: resolveRedirectUri(),
      verifier,
      // The state-authorized scopes ride the row (set at start time from the
      // registry reduction) — the callback never accepts a scope input, so no
      // route here can amplify (T-195-02 scope-reduce-only backstop).
      scopes: resolveScopes(def, connection.oauthScopes ?? undefined),
    });

    if (!result.ok) {
      // Exchange/validation error arm (g): flip the row to error + clear the
      // pending marker, log provider only (T-195-10 — message text only,
      // never token material), redirect with ?oauth=error.
      await prisma.mCPConnection.update({
        where: { id: connectionId },
        data: { oauthStatus: "error", oauthError: result.errorDescription },
      });
      // WR-05: best-effort audit write — an audit failure must never replace
      // the fail-closed redirect with a 500 (D-09: never raw JSON in browser).
      try {
        await logEvent("mcp_connection", connectionId, "mcp.oauth_error", null, { provider: providerId });
      } catch {
        // Audit write failure is logged nowhere here — the redirect stands.
      }
      failClosed(res, "token exchange failed", providerId);
      return;
    }

    const obtainedAtMs = Date.parse(result.blob.obtainedAt);
    // WR-02: honor the provider-issued expires_in when present (Graph tokens
    // under Conditional Access can be far shorter than 1h); 1h default only
    // when the provider omits it.
    const expiresInMs =
      (typeof result.blob.expires_in === "number" && result.blob.expires_in > 0
        ? result.blob.expires_in
        : 3600) * 1000;
    const tokenExpiresAt = new Date(obtainedAtMs + expiresInMs);

    // WR-01: compare-and-set on oauthStatus=pending — a replayed callback that
    // lost the single-use race can never overwrite an authorized row (two
    // near-simultaneous valid callbacks otherwise interleave the flips).
    const casResult = await prisma.mCPConnection.updateMany({
      where: { id: connectionId, oauthStatus: "pending" },
      data: {
        credentialsEncrypted: encryptTokenBlob(result.blob),
        tokenExpiresAt,
        oauthStatus: "authorized",
        oauthError: null,
      },
    });
    if (casResult.count === 0) {
      failClosed(res, "connection no longer pending (replay race lost)", providerId);
      return;
    }

    // Audit trail (T-195-10): action + provider only — no code/state/token in
    // metadata. The callback has no request principal (public surface), so
    // userId is null — the connection id itself scopes the audit row.
    await logEvent("mcp_connection", connectionId, "mcp.oauth_authorized", null, { provider: providerId });

    // D-09: fire-and-forget reconnect kick so tools appear without a manual
    // toggle (RESEARCH Open Question 2 — mirrors the create/toggle routes).
    connectMCPServer(connectionId).catch((err: unknown) => {
      logger.error("[mcp-oauth-callback] reconnect kick failed", {
        connectionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    res.redirect(redirectTarget("authorized"));
  } catch (err: unknown) {
    // Unexpected error (network/DB) — same fail-closed shape: error row +
    // error redirect. Message text only, never token material (T-195-10).
    const message = err instanceof Error ? err.message : String(err);
    try {
      await prisma.mCPConnection.update({
        where: { id: connectionId },
        data: { oauthStatus: "error", oauthError: `callback failed: ${message}` },
      });
    } catch {
      // Best-effort error flip — never mask the redirect with a secondary error.
    }
    // WR-05: best-effort audit write (same fail-closed reasoning as above).
    try {
      await logEvent("mcp_connection", connectionId, "mcp.oauth_error", null, { provider: providerId });
    } catch {
      // Audit write failure never masks the redirect.
    }
    failClosed(res, "unexpected callback error", providerId);
  }
});

export default router;