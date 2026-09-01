// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import prisma from "../utils/prisma";
import { getSetting } from "./systemConfigService";
import { callNonStreamingLLM, resolveProviderConfig } from "./providerService";
import { logger } from "../utils/logger";
import { autoTagsSchema, batchedPostProcessingSchema } from "@simmetric-chat/shared";
import { parseMetadata } from "../utils/parseMetadata";

const TITLE_TIMEOUT_MS = 10_000;
const TITLE_MAX_CHARS = 80;
const TITLE_SYSTEM_PROMPT =
  "Generate a concise title (max 6 words) for this conversation. Return only the title, no quotes, no explanation.";

interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function sanitizeTitle(raw: string): string {
  return raw
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim()
    .substring(0, TITLE_MAX_CHARS);
}

export async function generateAutoTitle(
  chatId: string,
  firstUserMessage: string,
  firstAssistantMessage: string,
): Promise<void> {
  try {
    // D-05: SystemConfig gate — check BEFORE count query (cost control).
    const enabled = (await getSetting("auto_title_enabled")).value;
    if (enabled !== "true") return;

    // Phase 140 (EPA-02): the auto_title_enabled LICENSE gate is removed —
    // auto-title is always-ON by license. The SystemConfig gate above stays
    // (admins can still disable auto-title at runtime — Pitfall 4).

    // D-01: titleSource gate — skip if user renamed (Pitfall 10 no overwrite).
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      select: { titleSource: true },
    });
    if (!chat || chat.titleSource === "user") return;

    // D-03: First-exchange check — post-commit, current assistant message is
    // already saved, so count === 1 means exactly one assistant message (the
    // one just saved = first exchange). count > 1 → not first exchange → skip.
    const assistantCount = await prisma.chatMessage.count({
      where: { chatId, role: "assistant" },
    });
    if (assistantCount !== 1) return;

    // D-04: Resolve cheap model (auto_title_model SystemConfig or workspace default).
    const autoTitleModel = (await getSetting("auto_title_model")).value;
    const providerConfig = await resolveProviderConfig(
      undefined,
      autoTitleModel || undefined,
    );
    if (!providerConfig) {
      logger.warn("[post-proc] No provider config resolved for auto title", { chatId });
      return;
    }

    // D-04: LLM call with 10s timeout, user + assistant as input.
    const messages: LLMMessage[] = [
      { role: "system", content: TITLE_SYSTEM_PROMPT },
      {
        role: "user",
        content: `${firstUserMessage}\n\n${firstAssistantMessage}`,
      },
    ];
    const result = await callNonStreamingLLM(
      providerConfig,
      messages,
      TITLE_TIMEOUT_MS,
    );

    const title = sanitizeTitle(result.content);
    if (!title) return;

    // D-01/Pitfall 10: Conditional update — only if titleSource is still "auto"
    // (prevents race with concurrent rename between check and update).
    const updated = await prisma.chat.updateMany({
      where: { id: chatId, titleSource: "auto" },
      data: { name: title },
    });
    if (updated.count === 0) {
      // titleSource changed to "user" between check and update — silent skip.
      return;
    }

    logger.info("[post-proc] Auto title generated", { chatId, title });
  } catch (err: unknown) {
    // D-02: Fire-and-forget silent failure — log + skip, no retry, no surface.
    logger.warn("[post-proc] Auto title generation failed", {
      chatId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const TAGS_TIMEOUT_MS = 10_000;
const TAGS_SYSTEM_PROMPT =
  'Analyze this conversation and generate tags and follow-up questions. Return JSON: {"tags": ["tag1", "tag2"], "followUps": ["question1", "question2"]}. Tags: max 5, max 20 chars each. Follow-ups: max 3, max 100 chars each. Return only JSON, no explanation.';

export async function generateTagsAndFollowUps(
  chatId: string,
  messageId: string,
  firstUserMessage: string,
  firstAssistantMessage: string,
): Promise<void> {
  try {
    // D-06: SystemConfig gate — opt-in (default false).
    const tagsEnabled = (await getSetting("auto_tags_enabled")).value;
    if (tagsEnabled !== "true") return;

    // Phase 140 (EPA-02): the auto_title_enabled LICENSE gate is removed —
    // tags (a sub-feature of auto-title) are always-ON by license. The
    // SystemConfig auto_tags_enabled gate above stays (admin opt-in).

    // D-03: First-exchange only (coerenza con title gen, cost-effective).
    const assistantCount = await prisma.chatMessage.count({
      where: { chatId, role: "assistant" },
    });
    if (assistantCount !== 1) return;

    // D-04/D-06: Reuse auto_title_model (same config key is simpler).
    const autoTitleModel = (await getSetting("auto_title_model")).value;
    const providerConfig = await resolveProviderConfig(
      undefined,
      autoTitleModel || undefined,
    );
    if (!providerConfig) {
      logger.warn("[post-proc] No provider config resolved for tag gen", { chatId });
      return;
    }

    const messages: LLMMessage[] = [
      { role: "system", content: TAGS_SYSTEM_PROMPT },
      {
        role: "user",
        content: `${firstUserMessage}\n\n${firstAssistantMessage}`,
      },
    ];
    const result = await callNonStreamingLLM(
      providerConfig,
      messages,
      TAGS_TIMEOUT_MS,
    );

    // D-06: Parse + validate JSON (Zod autoTagsSchema). Silent skip on failure.
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(result.content);
    } catch {
      logger.warn("[post-proc] Tag gen JSON parse failed", { chatId });
      return;
    }
    const parsed = autoTagsSchema.safeParse(parsedJson);
    if (!parsed.success) {
      logger.warn("[post-proc] Tag gen Zod validation failed", { chatId });
      return;
    }

    // D-06: Merge with existing metadata (preserve sources/toolCalls/etc.).
    // CSW-04: parseMetadata returns {} for null/undefined/malformed JSON,
    // codifying the previous `try { ... } catch { /* start fresh */ }` block.
    const existing = await prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { metadata: true },
    });
    const existingMeta = parseMetadata(existing?.metadata);
    const mergedMetadata = {
      ...existingMeta,
      tags: parsed.data.tags,
      followUps: parsed.data.followUps,
    };

    await prisma.chatMessage.update({
      where: { id: messageId },
      data: { metadata: JSON.stringify(mergedMetadata) },
    });

    logger.info("[post-proc] Tags + follow-ups generated", {
      chatId,
      tagsCount: parsed.data.tags.length,
      followUpsCount: parsed.data.followUps.length,
    });
  } catch (err: unknown) {
    // D-06: Fire-and-forget silent failure.
    logger.warn("[post-proc] Tag/follow-up generation failed", {
      chatId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Phase 157 (CSW-12 D-07): combined system prompt — one LLM call returns
// {title, tags, followUps} JSON, halving the round-trip cost on first exchanges.
const BATCHED_SYSTEM_PROMPT =
  'Analyze this conversation. Return JSON: {"title": "concise title max 6 words", "tags": ["tag1", "tag2"], "followUps": ["question1", "question2"]}. Title: max 6 words, no quotes. Tags: max 5, max 20 chars each. Follow-ups: max 3, max 100 chars each. Return only JSON, no explanation.';

// Phase 157 (CSW-12 D-09): Batched post-processing — single LLM call producing
// title + tags + follow-ups. Additive path gated behind auto_batch_title_tags
// (default false). Existing generateAutoTitle + generateTagsAndFollowUps stay
// as the default + fallback (D-12).
export async function generateBatchedTitleTagsAndFollowUps(
  chatId: string,
  messageId: string,
  firstUserMessage: string,
  firstAssistantMessage: string,
): Promise<void> {
  try {
    // D-06: SystemConfig gate — the new batch flag (default unset = false).
    const batchEnabled = (await getSetting("auto_batch_title_tags")).value;
    if (batchEnabled !== "true") return;

    // D-06: Both sub-feature gates must be on; if only one is on, the caller's
    // existing single-function path handles it — batched path skips.
    const titleEnabled = (await getSetting("auto_title_enabled")).value;
    const tagsEnabled = (await getSetting("auto_tags_enabled")).value;
    if (titleEnabled !== "true" || tagsEnabled !== "true") return;

    // D-09: titleSource gate — skip if user renamed (Pitfall 10, no overwrite).
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      select: { titleSource: true },
    });
    if (!chat || chat.titleSource === "user") return;

    // D-03: First-exchange check — post-commit, current assistant message is
    // already saved, so count === 1 means exactly one assistant message.
    const assistantCount = await prisma.chatMessage.count({
      where: { chatId, role: "assistant" },
    });
    if (assistantCount !== 1) return;

    // D-09/D-11: Reuse auto_title_model + resolveProviderConfig (same as the
    // existing two functions). Single call is cheaper than two.
    const autoTitleModel = (await getSetting("auto_title_model")).value;
    const providerConfig = await resolveProviderConfig(
      undefined,
      autoTitleModel || undefined,
    );
    if (!providerConfig) {
      logger.warn("[post-proc] No provider config resolved for batched gen", { chatId });
      return;
    }

    const messages: LLMMessage[] = [
      { role: "system", content: BATCHED_SYSTEM_PROMPT },
      {
        role: "user",
        content: `${firstUserMessage}\n\n${firstAssistantMessage}`,
      },
    ];
    const result = await callNonStreamingLLM(
      providerConfig,
      messages,
      TITLE_TIMEOUT_MS,
    );

    // D-08: Parse + Zod validate the batched JSON. Silent skip on failure.
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(result.content);
    } catch {
      logger.warn("[post-proc] Batched gen JSON parse failed", { chatId });
      return;
    }
    const parsed = batchedPostProcessingSchema.safeParse(parsedJson);
    if (!parsed.success) {
      logger.warn("[post-proc] Batched gen Zod validation failed", { chatId });
      return;
    }

    // D-09: Title update — conditional on titleSource="auto" (race prevention,
    // same as generateAutoTitle :85-92).
    const title = sanitizeTitle(parsed.data.title);
    if (!title) return;
    const updated = await prisma.chat.updateMany({
      where: { id: chatId, titleSource: "auto" },
      data: { name: title },
    });
    if (updated.count === 0) {
      // titleSource changed to "user" between check and update — silent skip.
      // Skip the metadata update too (consistent with "don't overwrite user actions").
      return;
    }

    // D-09/T-157-07: Metadata merge — preserve existing sources/toolCalls/etc.
    // (same merge pattern as generateTagsAndFollowUps :170-184).
    const existing = await prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { metadata: true },
    });
    const existingMeta = parseMetadata(existing?.metadata);
    const mergedMetadata = {
      ...existingMeta,
      tags: parsed.data.tags,
      followUps: parsed.data.followUps,
    };

    await prisma.chatMessage.update({
      where: { id: messageId },
      data: { metadata: JSON.stringify(mergedMetadata) },
    });

    logger.info("[post-proc] Batched title + tags + follow-ups generated", {
      chatId,
      title,
      tagsCount: parsed.data.tags.length,
      followUpsCount: parsed.data.followUps.length,
    });
  } catch (err: unknown) {
    // D-09: Fire-and-forget silent failure (same as existing functions).
    logger.warn("[post-proc] Batched generation failed", {
      chatId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}