// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * @fileoverview Gmail v1 REST calls for the connector skills
 * (Phase 197, MCPO-05 D-02). Raw fetch only — googleapis is deliberately
 * rejected (zero-new-deps posture, 195 D-04 / 196 Package Legitimacy
 * Audit; this phase adds no dependency either).
 *
 * Base URL is env-overridable (GMAIL_API_BASE_URL via getEnv(), default
 * https://gmail.googleapis.com — the canonical host per the official REST
 * reference) — no hardcoded provider URL beyond the default constant
 * (air-gap posture, same lever as GDRIVE_API_BASE_URL).
 *
 * Read-only v1 (spec §4.4 / D-02): search + thread read + ingest — there is
 * NO write operation anywhere in this module (no send, no draft create/send,
 * no modify/trash/untrash). Only GET requests against the Gmail API.
 *
 * Gmail search q syntax is passed through verbatim from the LLM tool input
 * — Gmail's own search language is the documented contract; no filter
 * construction happens server-side beyond the fixed param set.
 *
 * messages.list returns IDs ONLY (Pitfall 4): each search result is
 * enriched with one per-id messages.get?format=metadata follow-up
 * (bounded at ≤25 — the N+1 budget is capped at the list's own
 * maxResults clamp).
 *
 * Body decoding: Gmail body.data is base64url (RFC 4648 §5, `-`/`_`,
 * unpadded — Pitfall 3). Decode with Buffer.from(data, "base64url") —
 * NEVER plain "base64" (corrupts non-ASCII bodies).
 */

import { getEnv } from "../../config/env";
import { providerFetch } from "./providerFetch";

/**
 * The fail-closed scope for every Gmail tool (assertScopesGranted). It is
 * ALREADY part of the google provider def's defaultScopes
 * (oauthProviderRegistry.ts) — no registry change needed or permitted.
 */
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** Text budget for composed thread text (gdrive_read idiom — 50k chars). */
const MAX_TEXT_CHARS = 50_000;

/** Gmail search/list page size ceiling (N+1 metadata-get budget). */
const MAX_SEARCH_RESULTS = 25;

/** A Gmail message metadata item (search enrichment result). */
export interface GmailMessageMeta {
  id: string;
  threadId: string;
  snippet: string;
  subject: string;
  from: string;
  date: string;
}

/** A Gmail thread message with extracted body text. */
interface GmailThreadMessage {
  id: string;
  threadId: string;
  snippet: string;
  subject: string;
  from: string;
  date: string;
  text: string | null;
}

export interface GmailThread {
  id: string;
  messages: GmailThreadMessage[];
}

/* Minimal Gmail API wire shapes (fields the code touches only). */

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailBody {
  data?: string;
}

interface GmailPart {
  mimeType?: string;
  body?: GmailBody;
  parts?: GmailPart[];
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  payload?: {
    headers?: GmailHeader[];
    parts?: GmailPart[];
    body?: GmailBody;
    mimeType?: string;
  };
}

interface GmailListResponse {
  messages?: Array<{ id?: string; threadId?: string }>;
  nextPageToken?: string;
}

interface GmailThreadResponse {
  id?: string;
  messages?: GmailMessage[];
}

/** Resolve the Gmail API base (air-gap lever — env override, default constant). */
function gmailBase(): string {
  return getEnv().GMAIL_API_BASE_URL ?? "https://gmail.googleapis.com";
}

/** Pull a named header value out of the payload.headers list. */
function headerValue(message: GmailMessage, name: string): string {
  const headers = message.payload?.headers ?? [];
  const hit = headers.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase());
  return hit?.value ?? "";
}

/**
 * Search the connected mailbox via users.messages.list (q = Gmail search
 * syntax, verbatim) and enrich each returned id with ONE
 * users.messages.get?format=metadata follow-up (Pitfall 4 — the list
 * response carries ids only; snippet/subject/from/date need the per-id
 * metadata get). The Bearer is built HERE inside the caller's execute
 * closure — the token never leaves the server (T-196-01 posture).
 */
export async function searchGmailMessages(
  token: string,
  query: string,
  opts?: { pageSize?: number; pageToken?: string },
): Promise<{ messages: GmailMessageMeta[]; nextPageToken?: string }> {
  // ≤25 per tool call (Pitfall 4 — the N+1 metadata-get budget; API caps
  // maxResults at 500, the tool clamps far below it).
  const pageSize = Math.max(1, Math.min(opts?.pageSize ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS));

  const url = new URL(`${gmailBase()}/gmail/v1/users/me/messages`);
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", String(pageSize));
  if (opts?.pageToken) url.searchParams.set("pageToken", opts.pageToken);

  const listRes = await providerFetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    provider: "google",
  });
  if (!listRes.ok) {
    // Status-only error (no body echo — the body can carry provider prose;
    // keep the provider+status-only log/return posture of providerFetch).
    throw new Error(`Gmail search failed (HTTP ${listRes.status})`);
  }

  const listBody = (await listRes.json()) as GmailListResponse;
  const refs = (listBody.messages ?? []).filter(
    (m): m is { id: string; threadId?: string } => typeof m.id === "string",
  );
  const nextPageToken = listBody.nextPageToken;

  // N+1 enrichment: one metadata-get per id (bounded at ≤25 by pageSize).
  const messages: GmailMessageMeta[] = [];
  for (const ref of refs) {
    const metaUrl = new URL(`${gmailBase()}/gmail/v1/users/me/messages/${encodeURIComponent(ref.id)}`);
    metaUrl.searchParams.set("format", "metadata");
    // Repeated query keys — URLSearchParams.set would overwrite; append keeps
    // all three header filters (metadataHeaders=Subject&metadataHeaders=From&...).
    metaUrl.searchParams.append("metadataHeaders", "Subject");
    metaUrl.searchParams.append("metadataHeaders", "From");
    metaUrl.searchParams.append("metadataHeaders", "Date");

    const metaRes = await providerFetch(metaUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      provider: "google",
    });
    if (!metaRes.ok) {
      throw new Error(`Gmail search failed (HTTP ${metaRes.status})`);
    }
    const meta = (await metaRes.json()) as GmailMessage;
    messages.push({
      id: meta.id ?? ref.id,
      threadId: meta.threadId ?? ref.threadId ?? "",
      // snippet is a TOP-LEVEL Message field (present in metadata format —
      // pinned by the connectors.test.ts fixture arm).
      snippet: meta.snippet ?? "",
      subject: headerValue(meta, "Subject"),
      from: headerValue(meta, "From"),
      date: headerValue(meta, "Date"),
    });
  }

  return { messages, nextPageToken };
}

/**
 * Decode a Gmail body.data value: base64url (RFC 4648 §5 — `-`/`_`
 * alphabet, Pitfall 3). NEVER plain "base64".
 */
function decodeGmailBodyData(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

/**
 * Strip HTML tags naively (research A4 — the text/html fallback is cosmetic
 * and bounded by the 50k truncation). Entities stay as-is except the
 * dangerous/likely ones the naive pass can handle safely.
 */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Depth-first MIME-tree walk (Pitfall 3 / research A4): prefer text/plain;
 * fall back to text/html with a naive tag-strip + "[HTML content]" note.
 * Returns null when the subtree carries no decodable text.
 */
export function extractGmailText(part: GmailPart): string | null {
  // text/plain wins outright.
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeGmailBodyData(part.body.data);
  }
  // multipart: recurse depth-first, prefer text/plain.
  const parts = part.parts ?? [];
  for (const child of parts) {
    const plain = extractGmailText(child);
    if (plain !== null && plain.length > 0) return plain;
  }
  // text/html fallback — tag-strip + label the origin.
  if (part.mimeType === "text/html" && part.body?.data) {
    const decoded = decodeGmailBodyData(part.body.data);
    return `[HTML content]\n${stripHtmlTags(decoded)}`;
  }
  // Nested html-only alternative inside a deeper multipart.
  for (const child of parts) {
    const fallback = extractGmailText(child);
    if (fallback !== null && fallback.length > 0) return fallback;
  }
  return null;
}

/**
 * Fetch a full thread via users.threads.get?format=full (Pitfall 5 —
 * format=full needs gmail.readonly, which is the tool's fail-closed
 * required scope; the gmail.metadata scope would block it entirely).
 * Each message's body text is extracted from the MIME tree (text/plain
 * preferred, base64url-decoded).
 */
export async function getGmailThread(token: string, threadId: string): Promise<GmailThread> {
  const url = `${gmailBase()}/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`;
  const res = await providerFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    provider: "google",
  });
  if (!res.ok) {
    throw new Error(`Gmail thread fetch failed (HTTP ${res.status})`);
  }
  const body = (await res.json()) as GmailThreadResponse;
  const messages: GmailThreadMessage[] = (body.messages ?? []).map((m) => {
    const text = extractGmailText(
      m.payload ?? { mimeType: "text/plain", body: undefined, parts: [] },
    );
    return {
      id: m.id ?? "",
      threadId: m.threadId ?? "",
      snippet: m.snippet ?? "",
      subject: headerValue(m, "Subject"),
      from: headerValue(m, "From"),
      date: headerValue(m, "Date"),
      text: text ?? null,
    };
  });
  return { id: body.id ?? threadId, messages };
}

/**
 * Compose the thread's messages into ONE text document (research A3 — a
 * single composed document per thread, one collector dispatch):
 * a "--- Message <n> — <date> — <from> ---" header per message + extracted
 * text, joined with blank lines, bounded at 50_000 chars with a visible
 * truncation marker (gdrive_read idiom).
 */
export function composeGmailThreadText(thread: GmailThread): string {
  const sections = thread.messages.map(
    (m, i) =>
      `--- Message ${i + 1} — ${m.date || "unknown date"} — ${m.from || "unknown sender"} ---\n${m.text ?? ""}`,
  );
  const joined = sections.join("\n\n");
  const truncated = joined.length > MAX_TEXT_CHARS;
  return truncated
    ? `${joined.slice(0, MAX_TEXT_CHARS)}\n\n[Content truncated at ${MAX_TEXT_CHARS} characters — the full thread is available via gmail_get_thread]`
    : joined;
}