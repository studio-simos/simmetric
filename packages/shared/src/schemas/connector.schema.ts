// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 198 (ECCO-01, D-03) — external chat-connector contracts.
// Follows the repo no-.partial() pattern (widget.schema.ts :335 precedent):
// the update schema is its own z.object with ALL-optional fields, so a
// .default() on pollMode would inject a value into parsed.data on every
// update and overwrite the stored column via the route's data spread
// (widget :376-379 rationale) — plain .optional() instead.
//
// WRITE-ONLY SECRET DISCIPLINE (D-03/D-05): botToken is an INPUT-ONLY field
// on createConnectorSchema and validateTokenSchema. It is NEVER a field of
// updateConnectorSchema (token rotation rides the dedicated validate/token
// route in 198-01b, which re-validates then persists). Responses carry
// hasBotToken: boolean, never the token itself.

import { z } from "zod";

// ===== Platform / pollMode enums (D-01/D-03) =====

// Closed set per spec §7.3. v1 accepts the FULL union at type level; the
// adapter registry (198-01b) fails closed for unimplemented platforms
// (telegram ships in 198; discord/slack/whatsapp land in Phases 199/200).
// NOT on the barrel (no route imports it directly); the module-level export
// exists for the connectorSchema.test.ts D-03 contract suite.
export const connectorPlatformSchema = z.enum(["telegram", "discord", "slack", "whatsapp"]);

// Telegram-only semantics in Phase 198 ("polling" default; D-15 shared
// scheduler). Discord adds its own WS path in 199, Slack/WhatsApp theirs in
// 200 — the enum does not widen.
export const connectorPollModeSchema = z.enum(["polling", "webhook"]);

// ===== Create (admin) =====

export const createConnectorSchema = z.object({
  platform: connectorPlatformSchema,
  name: z.string().min(1).max(200),
  // KB binding — hard FK on the connector row (server resolves the workspace
  // row; never accepted as a transitive org source).
  workspaceId: z.string().uuid("Invalid workspace ID"),
  // Optional knowledge-archive binding (pseudo-workspace "archive:<id>" mirror
  // of widget.archiveId). Nullable write contract: null = clear, undefined =
  // not provided on create (column stays NULL).
  archiveId: z.string().uuid("Invalid archive ID").nullable().optional(),
  // WRITE-ONLY (D-03/D-05): never echoed back; encrypted via
  // encryptionService into botTokenEncrypted before any persistence.
  botToken: z.string().min(1),
  welcomeMessage: z.string().max(4000).optional(),
  fallbackMessage: z.string().max(4000).optional(),
  fallbackLocale: z.string().min(2).max(8).optional(),
  // Per-connector overrides (Widget G-151-1b mirror). Tri-state on update:
  // null = clear (use global default), positive int = custom limit. The
  // schema accepts 0 (schema/limiter split per widget precedent) — the
  // messageRouter limiter (198-01b) is what translates 0 → unlimited.
  rateLimitPerMinute: z.number().int().min(0).nullable().optional(),
  sessionLimitPerDay: z.number().int().min(0).nullable().optional(),
  // Per-connector response model pin (Widget 260831-hgy mirror). Server-
  // resolved from the connector row — NEVER client-trusted at chat time.
  // Nullable write contract: null clears (SQL NULL), undefined = unchanged.
  responseProviderId: z.string().uuid("Invalid provider ID").nullable().optional(),
  responseModel: z.string().min(1).max(200).nullable().optional(),
  // Phase 200 (ECCO-06, D-16 blob-carried / BLOCKER-1 wiring): per-platform
  // config fields, persisted INSIDE configEncrypted at create time
  // (encrypt(JSON.stringify(config))). ALL optional so telegram/discord
  // payloads stay byte-identical. NEVER echoed back (D-03/D-15 — responses
  // carry hasSigningSecret/hasVerifyToken booleans only). WhatsApp fields
  // are declared NOW so Plan 02 consumes the same shape without a second
  // shared edit.
  signingSecret: z.string().min(1).optional(),
  phoneNumberId: z.string().min(1).optional(),
  appSecret: z.string().min(1).optional(),
  verifyToken: z.string().min(1).optional(),
  whatsappBusinessAccountId: z.string().min(1).optional(),
});

// ===== Update (admin) — own z.object, NO .partial() =====
//
// All fields optional; nullable write contract for clear-by-null fields
// (widget.schema.ts precedent). botToken and platform config are NEVER
// accepted here (write-only discipline — D-03/D-05): the bot token rotates
// through the dedicated validate route, which re-verifies against the
// platform before persisting; unknown keys are stripped by Zod's default
// object behavior, so a stray botToken in an update body never persists.
export const updateConnectorSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  // Plain .optional() — NOT .default("polling"): a default would inject
  // "polling" into parsed.data on every update and overwrite the stored
  // pollMode via the route's data spread (widget fallbackLocale rationale,
  // widget.schema.ts :376-379).
  pollMode: connectorPollModeSchema.optional(),
  isEnabled: z.boolean().optional(),
  archiveId: z.string().uuid("Invalid archive ID").nullable().optional(),
  welcomeMessage: z.string().max(4000).nullable().optional(),
  fallbackMessage: z.string().max(4000).nullable().optional(),
  fallbackLocale: z.string().min(2).max(8).optional(),
  rateLimitPerMinute: z.number().int().min(0).nullable().optional(),
  sessionLimitPerDay: z.number().int().min(0).nullable().optional(),
  responseProviderId: z.string().uuid("Invalid provider ID").nullable().optional(),
  responseModel: z.string().min(1).max(200).nullable().optional(),
});

// ===== Token validation (dedicated route — the ONLY botToken re-entry) =====

export const validateTokenSchema = z.object({
  platform: connectorPlatformSchema,
  botToken: z.string().min(1),
  // Phase 200: identically-optional platform config passthrough — the
  // validate route forwards these to the adapter probe and NEVER persists
  // them (D-05 write-only discipline at the validate seam).
  signingSecret: z.string().min(1).optional(),
  phoneNumberId: z.string().min(1).optional(),
  appSecret: z.string().min(1).optional(),
  verifyToken: z.string().min(1).optional(),
  whatsappBusinessAccountId: z.string().min(1).optional(),
});

// ===== Webhook setup (public base URL for the platform's setWebhook call) =====

export const webhookSetupSchema = z.object({
  url: z.string().url(),
});

// ===== Route param =====

export const connectorIdParamSchema = z.object({
  id: z.string().uuid("Invalid connector ID"),
});