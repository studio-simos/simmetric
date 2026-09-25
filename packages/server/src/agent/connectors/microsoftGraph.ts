// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * @fileoverview Microsoft Graph v1.0 REST calls for the connector skills
 * (Phase 196, MCPO-04 D-05). Raw fetch only —
 * @microsoft/microsoft-graph-client is deliberately rejected (zero-new-deps
 * posture).
 *
 * Base URL is tenant-configurable (D-03/D-05): getEnv().GRAPH_API_BASE_URL
 * ?? "https://graph.microsoft.com" — no hardcoded provider URL beyond the
 * default constant (T-196-05 air-gap posture; OAUTH_MICROSOFT_TENANT already
 * handles the IdP side).
 *
 * Graph query rules (Pitfall 6): keyword mode uses $search="<term>" and is
 * NEVER combined with $orderby; filter mode uses $filter
 * contains(subject,'<term>'). Pagination follows @odata.nextLink verbatim —
 * never a hand-constructed $skip.
 *
 * Download rule (Pitfall 4): GET /me/drive/items/{id}/content answers 302
 * with a pre-authenticated Location — fetch's default redirect:follow walks
 * the chain and carries the flow; the Bearer is NEVER re-attached manually
 * (the pre-authenticated URL is provider-minted; re-attaching a Bearer to a
 * redirect target would leak the token to the redirect host, T-196-10).
 *
 * Read-only v1 (D-05): GET only — no PATCH/POST/DELETE against Graph.
 */

import { getEnv } from "../../config/env";
import { providerFetch } from "./providerFetch";
import { CONNECTOR_INGEST_MAX_BYTES } from "./ingestBridge";

/** Graph base URL — tenant-configurable via GRAPH_API_BASE_URL (D-03/D-05). */
function graphBase(): string {
  return getEnv().GRAPH_API_BASE_URL ?? "https://graph.microsoft.com";
}

/**
 * CR-01 SSRF guard for provider continuation cursors (shared by every
 * follow-the-cursor site in this module). An LLM-supplied cursor URL is
 * only followed when it is HTTPS and SAME-ORIGIN with the configured Graph
 * base — anything else (attacker host, non-HTTPS downgrade, unparseable
 * string) returns null and the caller refuses to attach the Bearer.
 */
function safeProviderCursor(nextLink: string, base: string): string | null {
  let next: URL;
  let origin: URL;
  try {
    next = new URL(nextLink);
    origin = new URL(base);
  } catch {
    return null;
  }
  if (next.protocol !== "https:" || next.origin !== origin.origin) {
    return null;
  }
  return next.toString();
}

/** Graph message projection — shared by the search + formatter (kept as one constant). */
export const GRAPH_MAIL_LIST_SELECT =
  "subject,from,receivedDateTime,bodyPreview,hasAttachments";

interface GraphMailMessage {
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  receivedDateTime?: string;
  bodyPreview?: string;
  hasAttachments?: boolean;
}

interface GraphListResponse<T> {
  value?: T[];
  "@odata.nextLink"?: string;
}

/**
 * Search the connected mailbox (GET /v1.0/me/messages) in two modes:
 * - mode "search" (default): $search="<term>" — never with $orderby (Pitfall 6).
 * - mode "filter": $filter contains(subject,'<term>').
 * Page 2+ follows the provider's @odata.nextLink verbatim — never a
 * hand-built $skip (MCPO-04/ordering: provider cursor, followed blindly).
 * Provider order is preserved verbatim (no re-sort/dedup).
 */
export async function searchGraphMail(
  token: string,
  params: { query: string; mode?: "search" | "filter"; top?: number; nextLink?: string },
): Promise<{ messages: GraphMailMessage[]; nextLink?: string }> {
  // Continuation: the nextLink is the provider's own cursor URL — followed
  // verbatim, never reconstructed ($skip is hand-built pagination, banned by
  // the ordering truth).
  //
  // CR-01 (SSRF/token-exfiltration guard): the cursor is LLM-SURFACED (the
  // tool result hands @odata.nextLink to the model, and email content is
  // untrusted) — an injected payload can direct the model to call the tool
  // with an arbitrary URL, and the OAuth Bearer would ride along to the
  // attacker's host. Same V5 posture as the fileId allowlist: require a
  // same-origin HTTPS URL before any fetch carries the token.
  if (params.nextLink) {
    const next = safeProviderCursor(params.nextLink, graphBase());
    if (!next) {
      throw new Error("Microsoft Graph mail search failed: invalid continuation link");
    }
    const res = await providerFetch(next, {
      headers: { Authorization: `Bearer ${token}` },
      provider: "microsoft",
    });
    if (!res.ok) {
      throw new Error(`Microsoft Graph mail search failed (HTTP ${res.status})`);
    }
    const body = (await res.json()) as GraphListResponse<GraphMailMessage>;
    return { messages: body.value ?? [], nextLink: body["@odata.nextLink"] };
  }

  const top = params.top ?? 25;
  const mode = params.query === undefined ? undefined : params.mode === "filter" ? "filter" : "search";
  // WR-01 (OData quote injection): the old `"` → `'` substitution MANUFACTURED
  // the quote character that breaks out of the provider's string literal — a
  // query like `it's urgent') or contains(subject,'x` appended attacker-chosen
  // filter clauses. Escape per mode instead:
  // - filter mode: the term rides a single-quoted OData literal → double the
  //   single quotes (the same escaping searchSiteDriveItems already applies).
  // - search mode: the term rides a double-quoted KQL-style $search literal →
  //   escape the double quotes; leave single quotes untouched (they are inert
  //   inside the double-quoted $search expression).
  const term =
    mode === "filter"
      ? params.query.replace(/'/g, "''")
      : params.query.replace(/"/g, '\\"');

  const url = new URL(`${graphBase()}/v1.0/me/messages`);
  url.searchParams.set("$top", String(top));
  url.searchParams.set("$select", GRAPH_MAIL_LIST_SELECT);
  if (mode === "search") {
    url.searchParams.set("$search", `"${term}"`);
  } else {
    url.searchParams.set("$filter", `contains(subject,'${term}')`);
  }

  const res = await providerFetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    provider: "microsoft",
  });
  if (!res.ok) {
    throw new Error(`Microsoft Graph mail search failed (HTTP ${res.status})`);
  }
  const body = (await res.json()) as GraphListResponse<GraphMailMessage>;
  return { messages: body.value ?? [], nextLink: body["@odata.nextLink"] };
}

/** Tenant-wide site search (GET /v1.0/sites?search=) — Pitfall 6/RESEARCH shape. */
export async function searchSharepointSites(
  token: string,
  query: string,
  opts?: { top?: number },
): Promise<{ sites: Array<{ id: string; displayName?: string; webUrl?: string }> }> {
  const url = new URL(`${graphBase()}/v1.0/sites`);
  url.searchParams.set("search", query);
  if (opts?.top) url.searchParams.set("$top", String(opts.top));

  const res = await providerFetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    provider: "microsoft",
  });
  if (!res.ok) {
    throw new Error(`Microsoft Graph site search failed (HTTP ${res.status})`);
  }
  const body = (await res.json()) as GraphListResponse<{
    id?: string;
    displayName?: string;
    webUrl?: string;
  }>;
  return {
    sites: (body.value ?? [])
      .filter((s): s is { id: string; displayName?: string; webUrl?: string } => typeof s.id === "string")
      .map((s) => ({ id: s.id, displayName: s.displayName, webUrl: s.webUrl })),
  };
}

/** Site-scoped drive item search (GET /v1.0/sites/{siteId}/drive/root/search(q='...')). */
export async function searchSiteDriveItems(
  token: string,
  siteId: string,
  query: string,
): Promise<{ items: Array<{ id: string; name: string; webUrl?: string; size?: number }> }> {
  const url = new URL(`${graphBase()}/v1.0/sites/${encodeURIComponent(siteId)}/drive/root/search(q='${query.replace(/'/g, "''")}')`);

  const res = await providerFetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    provider: "microsoft",
  });
  if (!res.ok) {
    throw new Error(`Microsoft Graph drive item search failed (HTTP ${res.status})`);
  }
  const body = (await res.json()) as GraphListResponse<{
    id?: string;
    name?: string;
    webUrl?: string;
    size?: number;
  }>;
  return {
    items: (body.value ?? [])
      .filter(
        (i): i is { id: string; name: string; webUrl?: string; size?: number } =>
          typeof i.id === "string" && typeof i.name === "string",
      )
      .map((i) => ({ id: i.id, name: i.name, webUrl: i.webUrl, size: i.size })),
  };
}

/**
 * Download a OneDrive item's content (GET /v1.0/me/drive/items/{id}/content).
 * Graph answers 302 with a pre-authenticated Location — fetch's DEFAULT
 * redirect:follow walks the chain; the Bearer is never re-attached manually
 * (Pitfall 4 / T-196-10). A 302 with an empty body under redirect:manual
 * would be an error condition, never success — we simply never send
 * redirect: "manual".
 */
export async function downloadOneDriveItem(
  token: string,
  itemId: string,
): Promise<{ bytes: Buffer; fileName: string }> {
  // Item name rides the metadata fetch (the content endpoint returns bare bytes).
  const metaUrl = `${graphBase()}/v1.0/me/drive/items/${encodeURIComponent(itemId)}?select=id,name,size`;
  const metaRes = await providerFetch(metaUrl, {
    headers: { Authorization: `Bearer ${token}` },
    provider: "microsoft",
  });
  if (!metaRes.ok) {
    throw new Error(`Microsoft Graph item metadata fetch failed (HTTP ${metaRes.status})`);
  }
  const meta = (await metaRes.json()) as { id?: string; name?: string; size?: number };
  const fileName = meta.name ?? "onedrive-item";

  // WR-02: the ingest bridge's byte cap fires only AFTER the buffer exists —
  // check Graph's reported size HERE so an oversized item is rejected before
  // any download (the metadata fetch already carries `size` for exactly this
  // gate; the bridge check stays as the backstop).
  if (typeof meta.size === "number" && meta.size > CONNECTOR_INGEST_MAX_BYTES) {
    throw new Error(
      `File is too large to ingest (${Math.round(meta.size / 1048576)} MB — the ingest limit is ${CONNECTOR_INGEST_MAX_BYTES / (1024 * 1024)} MB)`,
    );
  }

  const res = await providerFetch(
    `${graphBase()}/v1.0/me/drive/items/${encodeURIComponent(itemId)}/content`,
    {
      headers: { Authorization: `Bearer ${token}` },
      provider: "microsoft",
      // NO redirect option — fetch defaults to "follow" (Pitfall 4). Never
      // "manual": a manual redirect would surface an empty 302 body and any
      // manual re-attach of the Bearer would leak the token to the
      // pre-authenticated URL host.
    },
  );
  if (!res.ok) {
    throw new Error(`Microsoft Graph download failed (HTTP ${res.status})`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, fileName };
}

// ===== formatters (skill-result text — provider order preserved verbatim) =====

export function formatMailList(messages: GraphMailMessage[]): string {
  return messages
    .map((m) => {
      const from = m.from?.emailAddress
        ? `${m.from.emailAddress.name ?? ""} <${m.from.emailAddress.address ?? ""}>`.trim()
        : "unknown sender";
      return `- "${m.subject ?? "(no subject)"}" from ${from} (${m.receivedDateTime ?? "unknown date"})${m.hasAttachments ? " [attachments]" : ""}`;
    })
    .join("\n");
}

export function formatSiteList(
  sites: Array<{ id: string; displayName?: string; webUrl?: string }>,
): string {
  return sites
    .map((s) => `- ${s.displayName ?? s.id} [id: ${s.id}]${s.webUrl ? ` — ${s.webUrl}` : ""}`)
    .join("\n");
}

export function formatDriveItemList(
  items: Array<{ id: string; name: string; webUrl?: string; size?: number }>,
): string {
  return items
    .map((i) => {
      const size = typeof i.size === "number" ? ` (${i.size} bytes)` : "";
      const link = i.webUrl ? ` — ${i.webUrl}` : "";
      return `- ${i.name} [id: ${i.id}]${size}${link}`;
    })
    .join("\n");
}