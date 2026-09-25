// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * @fileoverview Public CONNECTOR OAuth callback router (Phase 200, ECCO-06,
 * research Option A) — the "Add to Slack" install completing arm.
 *
 * Clones the mcpOAuthCallback.ts fail-closed shape (:39-193) for the
 * ChatConnector row: this router contains ONLY `GET /oauth/callback` and
 * carries NO auth, tenant-context, or RBAC middleware ANYWHERE — the Slack
 * browser redirect carries no JWT. Mounted in createApp() at
 * `/api/connectors` BEFORE connectorsWebhookRouter/connectorsRoutes so it
 * precedes the JWT catch-all (mcpOAuthCallbackRouter mount-order precedent,
 * index.ts:757).
 *
 * Security (all fail-closed, D-10 discipline inherited):
 * - CSRF: HMAC-signed state (HS256 JWT_SECRET, 10-min exp) verified with the
 *   CONNECTOR audience (WR-03 purpose separation — a connector-minted state
 *   is rejected by the MCP callback and an MCP-audience state is rejected
 *   HERE; pinned cross-audience both ways in connectorOAuthCallback.test.ts).
 * - Code replay: the callback is single-use via consumeVerifier (deleted on
 *   read — a replayed callback with the same state finds the verifier gone)
 *   AND the row-presence check (missing row → failClosed). ChatConnector has
 *   NO oauthStatus column, so there is no pending CAS — the verifier
 *   consumption IS the single-use arbiter.
 * - Multi-tenant IDOR: the callback is public, so it trusts the STATE
 *   payload's connectionId only to FIND the row — org is asserted FROM THE
 *   ROW (org-from-the-ROW doctrine, 185 D-09; no tenantContextMiddleware —
 *   a fail-closed 404 without a JWT would kill the browser redirect).
 * - Provider pin: the connector flow authorizes EXACTLY the provider the
 *   state-authorized def resolves to (slack) — a row on another platform is
 *   fail-closed before any exchange.
 * - NO token/secret material is ever logged or carried in a redirect target
 *   (T-195-05/T-198-03 posture): logEvent metadata carries { platform } only.
 * - NO tokenExpiresAt write (A2 — Slack tokens do not expire; the
 *   mcpOAuthCallback.ts 1h-default expiry write is deliberately NOT copied).
 * - The A-11 static-field coexistence: the OAuth write MERGES into the
 *   existing configEncrypted blob (decrypt → spread → re-encrypt), so a
 *   previously-stored signingSecret survives the OAuth install.
 */

import { Router, type Request, type Response } from "express";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { getEnv } from "../config/env";
import { verifyOAuthState, consumeVerifier, CONNECTOR_OAUTH_STATE_AUDIENCE } from "../services/oauthStateService";
import {
  resolveProvider,
  hasClientConfigured,
  resolveScopes,
  resolveConnectorRedirectUri,
  type OAuthProviderDef,
} from "../services/oauthProviderRegistry";
import { exchangeAuthorizationCode } from "../services/oauthTokenLifecycle";
import { encrypt, decrypt } from "../services/encryptionService";
import { logEvent } from "../services/eventLogService";

const router = Router();

/**
 * Resolve the env-carried client credentials for the connector OAuth flow
 * (D-06 posture — env-only in v1; mcpOAuthCallback/mcp.ts local-helper
 * precedent, extended with the slack arm; kept module-local to avoid
 * widening mcpOAuthCallback's export surface). Values flow ONLY into the
 * exchange body — never logged, never echoed.
 */
function clientCredentials(providerId: string): { clientId: string; clientSecret: string } {
  const env = getEnv();
  if (providerId === "slack") {
    return { clientId: env.SLACK_CLIENT_ID ?? "", clientSecret: env.SLACK_CLIENT_SECRET ?? "" };
  }
  if (providerId === "google") {
    return { clientId: env.GOOGLE_CLIENT_ID ?? "", clientSecret: env.GOOGLE_CLIENT_SECRET ?? "" };
  }
  if (providerId === "microsoft") {
    return { clientId: env.MICROSOFT_CLIENT_ID ?? "", clientSecret: env.MICROSOFT_CLIENT_SECRET ?? "" };
  }
  return { clientId: "", clientSecret: "" };
}

/**
 * The post-callback redirect target (196 D-09 contract shape): the frontend
 * settings surface — `?tab=connectors` deep-links to the connectors
 * sub-section (SettingsPage LEGACY_TAB_MAP "connectors" → "advanced");
 * the `?oauth=<status>` param contract is kept verbatim (Phase 196 pattern —
 * the frontend reads it to surface the badge/toast, consumption is Plan 04).
 */
const SETTINGS_REDIRECT_BASE = "/settings?tab=connectors";

/** Build the redirect target with the oauth status query param (D-09). */
function redirectTarget(status: "authorized" | "error"): string {
  return `${SETTINGS_REDIRECT_BASE}&oauth=${status}`;
}

// D-10: every failure arm funnels through one redirect — signature/expiry/
// unknown-row are never distinguished in the redirect target.
function failClosed(res: Response, context: string, platform?: string): void {
  logger.warn("[connector-oauth-callback] fail-closed", { context, platform });
  res.redirect(redirectTarget("error"));
}

/**
 * Decrypt-merge-reencrypt the connector's config blob (A-11 static-field
 * coexistence): the OAuth fields are spread over the EXISTING decrypted
 * config so a prior signingSecret/verifyToken survives the install. A corrupt
 * or absent blob degrades to an empty base (create-path parity — the fresh
 * encrypt then carries only the OAuth fields).
 */
function mergeConfig(existingRaw: string | null, oauthFields: Record<string, unknown>): string {
  let existing: Record<string, unknown> = {};
  if (existingRaw) {
    try {
      const parsed = JSON.parse(decrypt(existingRaw)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Fail-open to an empty base — the OAuth fields still persist.
    }
  }
  return encrypt(JSON.stringify({ ...existing, ...oauthFields }));
}

router.get("/oauth/callback", async (req: Request, res: Response) => {
  // (a) Read state + code from the query — non-string/missing → error
  // redirect (T-195-06 shape). Never log the values themselves.
  const state = req.query.state;
  const code = req.query.code;
  if (typeof state !== "string" || state.length === 0 || typeof code !== "string" || code.length === 0) {
    failClosed(res, "missing or malformed state/code query params");
    return;
  }

  // (b) Verify the signed state WITH THE CONNECTOR AUDIENCE (WR-03) — bad
  // signature OR expiry OR mcp-audience state → null → error redirect. The
  // failure modes are never distinguished.
  const verified = verifyOAuthState(state, CONNECTOR_OAUTH_STATE_AUDIENCE);
  if (!verified) {
    failClosed(res, "state verification failed (signature, expiry, or audience)");
    return;
  }
  const connectorId = verified.connectionId;
  // WR-01: the verifier is keyed by the state's nonce — the pairing is bound
  // to THIS state.
  const stateNonce = verified.nonce;

  // (c) Load the ChatConnector row the state authorizes. Row missing → error
  // redirect (replay + unknown-state share the arm: a replayed callback's
  // verifier is consumed, and this row-presence check is the replay guard —
  // ChatConnector has no oauthStatus column). NO tenantContextMiddleware —
  // org is asserted FROM THE ROW (org-from-the-ROW doctrine).
  const connector = await prisma.chatConnector.findUnique({ where: { id: connectorId } });
  if (!connector || connector.deletedAt !== null) {
    failClosed(res, "connector missing (replay or unknown state)");
    return;
  }

  // (d) The connector flow authorizes ONLY slack (the def the start route
  // minted the state for) — any other platform is fail-closed before any
  // exchange. Client must be configured (D-06 posture).
  const platform = connector.platform;
  if (platform !== "slack") {
    failClosed(res, "connector platform does not support OAuth", platform);
    return;
  }
  const def: OAuthProviderDef | null = resolveProvider("slack");
  if (!def || !hasClientConfigured("slack")) {
    failClosed(res, "provider def missing or client not configured", platform);
    return;
  }

  // (e) Single-use PKCE verifier consumption (D-08) — expired/missing pair →
  // error redirect. consumeVerifier deletes on read, so a second valid-state
  // callback (replay) always lands here.
  const verifier = consumeVerifier(stateNonce);
  if (!verifier) {
    failClosed(res, "PKCE verifier missing or expired (replay or expired pairing)", platform);
    return;
  }

  // (f) Code exchange → encrypt into the row → redirect. The exchange rides
  // the SAME generic registry/lifecycle path as MCP (D-05 — zero Slack
  // branches in the flow code; Slack's access_token IS the standard field).
  try {
    const result = await exchangeAuthorizationCode(def, {
      code,
      ...clientCredentials("slack"),
      // BLOCKER-2: the SAME connector-specific redirect constant the start
      // route's authorize URL carried — Slack validates redirect_uri
      // consistency between the authorize and token calls.
      redirectUri: resolveConnectorRedirectUri(),
      verifier,
      // Scope-reduce-only (T-195-02): the defaults are the maximum grantable
      // set — the callback never accepts a scope input, so no route here can
      // amplify.
      scopes: resolveScopes(def),
    });

    if (!result.ok) {
      // Exchange error arm: log provider-only context (T-195-05 — message
      // text only, never token material), fail-closed redirect.
      logger.warn("[connector-oauth-callback] token exchange failed", {
        platform,
        error: result.errorDescription,
      });
      try {
        await logEvent("chat_connector", connectorId, "chat_connector.oauth_error", null, { platform });
      } catch {
        // Audit write failure never masks the redirect.
      }
      failClosed(res, "token exchange failed", platform);
      return;
    }

    // Row write: the exchanged BOT token lands in botTokenEncrypted; the
    // OAuth metadata merges into configEncrypted (A-11 coexistence — a prior
    // signingSecret survives). Slack's team identity + bot_user_id ride the
    // exchange's raw response (Phase 200 Rule 2 — the normalized blob drops
    // them); botUserId seeds the adapter's echo guard (slack.ts parse
    // boundary). NO tokenExpiresAt write (A2 — Slack tokens do not expire).
    const team = result.raw.team;
    const rawBotUserId = result.raw.bot_user_id;
    const configEncrypted = mergeConfig(connector.configEncrypted, {
      slackScope: result.blob.scope,
      ...(team && typeof team === "object" && typeof (team as { id?: unknown }).id === "string"
        ? { slackTeamId: (team as { id: string }).id }
        : {}),
      ...(team && typeof team === "object" && typeof (team as { name?: unknown }).name === "string"
        ? { slackTeamName: (team as { name: string }).name }
        : {}),
      ...(typeof rawBotUserId === "string" && rawBotUserId.length > 0 ? { botUserId: rawBotUserId } : {}),
    });

    await prisma.chatConnector.update({
      where: { id: connectorId },
      data: {
        botTokenEncrypted: encrypt(result.blob.accessToken),
        configEncrypted,
        lastError: null,
      },
    });

    // Audit trail (T-195-10 shape): action + platform only — no code/state/
    // token in metadata. The callback has no request principal (public
    // surface), so userId is null.
    await logEvent("chat_connector", connectorId, "chat_connector.oauth_authorized", null, { platform });

    res.redirect(redirectTarget("authorized"));
  } catch (err: unknown) {
    // Unexpected error (network/DB) — same fail-closed shape. Message text
    // only, never token material (T-195-05).
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[connector-oauth-callback] unexpected callback error", {
      platform,
      error: message,
    });
    try {
      await logEvent("chat_connector", connectorId, "chat_connector.oauth_error", null, { platform });
    } catch {
      // Audit write failure never masks the redirect.
    }
    failClosed(res, "unexpected callback error", platform);
  }
});

export default router;