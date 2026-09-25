// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 198 (198-02 Task 1, D-13) — the PlatformAdapter contract.
//
// Every external chat platform (telegram in 198-03, discord in 199,
// slack/whatsapp in 200) plugs into the messageRouter pipeline through THIS
// interface. The method set is D-13's: webhook parse + poll + send + typing +
// token validation + bot info + webhook lifecycle. Adapters are registered in
// services/connectors/registry.ts and looked up fail-closed (D-03).
//
// No SDK dependency anywhere: adapters talk to the platform Bot APIs with
// direct `fetch` (D-13), with base URLs env-overridable for air-gap installs.

/**
 * One inbound platform message, normalized across platforms (the ONLY shape
 * the messageRouter pipeline sees — platform payloads never leak past the
 * adapter boundary).
 *
 * `platformMessageId` is the platform's own message id — the dedup arbiter
 * rides the DB unique constraint on (connectorId, platformMessageId) (D-11);
 * a null id skips dedup semantics naturally (Postgres NULLs never collide).
 * ADAPTER CONTRACT (CR-02): Telegram composes it as
 * `${chatId}:${message_id}` at the adapter boundary (both inbound and
 * outbound) because the platform id is unique per chat, not per bot — the
 * DB constraint is per CONNECTOR, so the bare per-chat id would collide
 * across different platform users and silently drop their messages (P-9
 * misfire). Later adapters (Discord/Slack/WhatsApp, Phases 199/200) must
 * apply the same chat-scoped composition whenever their message ids are
 * not globally unique per bot.
 * `chatType` drives the D-18 private-only guard (group/supergroup/channel
 * updates are dropped at the pipeline boundary before any DB write).
 * `isCommand` carries the command name when the text is one (e.g. "start").
 */
export interface IncomingMessage {
  platformMessageId: string | null;
  platformUserId: string;
  platformUserName?: string;
  text: string | null;
  chatType: "private" | "group" | "supergroup" | "channel";
  isCommand?: string;
  /**
   * The platform's raw update id (polling arm only — D-15: the poller
   * advances pollOffset to max(updateId) + 1 after the batch). Webhook-parsed
   * messages leave it undefined (the offset cursor is polling-only).
   */
  updateId?: bigint;
}

/**
 * Poll result (WR-06): the normalized messages + the batch-wide max
 * update_id for the caller's offset advance (D-15). `maxUpdateId` is
 * computed over ALL returned update_ids — private or not — so a
 * group-only batch still consumes its update_ids (else getUpdates
 * re-delivers the same non-private update every tick forever). Legacy
 * bare-array returns (test fakes) remain accepted at the poller.
 */
export interface PollBatch {
  messages: (IncomingMessage & { updateId?: bigint })[];
  /** Max update_id over ALL returned updates (null = empty batch). */
  maxUpdateId: bigint | null;
}

/**
 * The connector-row surface the pipeline consumes. Structural (the full
 * Prisma ChatConnector row satisfies it — webhook route's TenantConnector
 * stash casts into it) so the pipeline never needs the full row type and
 * Phase 199/200 adapters stay decoupled from schema drift.
 */
export interface ConnectorPipelineRow {
  id: string;
  platform: string;
  organizationId: string;
  workspaceId: string;
  archiveId: string | null;
  responseProviderId: string | null;
  responseModel: string | null;
  welcomeMessage: string | null;
  fallbackMessage: string | null;
  fallbackLocale: string;
  rateLimitPerMinute: number | null;
  sessionLimitPerDay: number | null;
  healthStatus: string;
  lastError: string | null;
}

/**
 * PlatformAdapter (D-13, spec §2.2): the full per-platform contract. Every
 * method talks to the platform Bot API over `fetch`; failures throw (the
 * pipeline maps them to healthStatus='error' + lastError, D-20 — never an
 * auto-disable).
 */
export interface PlatformAdapter {
  /** Parse an inbound webhook request into an IncomingMessage (or null when the payload is not a processable update — e.g. edited_message). */
  parseIncomingWebhook(req: unknown): IncomingMessage | null;
  /**
   * Poll platform updates (polling mode, D-15) — long-poll against the Bot
   * API, offset cursor on the connector row. Returns a PollBatch (WR-06:
   * batch-wide maxUpdateId computed over ALL returned update_ids); a bare
   * IncomingMessage[] is also accepted for legacy/test fakes.
   */
  pollUpdates(connector: ConnectorPipelineRow): Promise<PollBatch | IncomingMessage[]>;
  /** Send a text message to a platform user. Returns the platform message id when the API provides one (logged on the ConnectorMessage out row, D-11). */
  sendMessage(connector: ConnectorPipelineRow, platformUserId: string, text: string): Promise<{ platformMessageId?: string }>;
  /** Typing indicator (Telegram sendChatAction "typing", 5s TTL — D-19). */
  sendTypingIndicator(connector: ConnectorPipelineRow, platformUserId: string): Promise<void>;
  /** Validate a bot token WITHOUT persisting it (D-05: the validate route never persists). */
  validateBotToken(token: string): Promise<{ valid: boolean; botUsername?: string | null; botDisplayName?: string | null }>;
  /** Bot identity for a stored token (persisted on the connector at validate time, D-13). */
  getBotInfo(connector: ConnectorPipelineRow): Promise<{ botUsername?: string | null; botDisplayName?: string | null }>;
  /** Register the platform webhook with the signing secret (D-14 secret_token). */
  setWebhook(connector: ConnectorPipelineRow, url: string, secret: string): Promise<void>;
  /** Remove the platform webhook (mode switch + best-effort delete arm). */
  removeWebhook(connector: ConnectorPipelineRow): Promise<void>;
}