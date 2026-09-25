// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * @fileoverview Google Drive v3 REST calls for the connector skills
 * (Phase 196, MCPO-04 D-04). Raw fetch only — googleapis is deliberately
 * rejected (zero-new-deps posture, 195 D-04 / 196 Package Legitimacy Audit).
 *
 * Base URL is env-overridable (GDRIVE_API_BASE_URL via getEnv(), default
 * https://www.googleapis.com) — no hardcoded provider URL beyond the default
 * constant (T-196-05 air-gap posture).
 *
 * Read-only v1 (D-05): search + read this plan; ingest rides the
 * ingestBridge. Drive files.list q syntax is passed through verbatim from
 * the LLM tool input — Drive's own q language is the documented contract;
 * no filter construction happens server-side beyond the fixed param set.
 *
 * readDriveFile implements the Pitfall-1 branch (Google Workspace files are
 * NOT downloadable with alt=media): Docs Editors mimetypes route to
 * /drive/v3/files/{id}/export?mimeType=<mapped export mime>, binary files
 * to ?alt=media. Export responses are text-bounded at 50_000 chars
 * (urlFetcher MAX_MARKDOWN_LENGTH idiom — never raw megabytes to the LLM).
 */

import { getEnv } from "../../config/env";
import { providerFetch } from "./providerFetch";

/**
 * Export MIME map for Docs Editors files (Pitfall 1 — Context7-verified
 * export table). Docs prefer markdown (current export table; plain-text/docx
 * fallback), Sheets prefer first-sheet csv, Slides prefer plain text.
 * Unmapped Workspace mimetypes fall back to application/pdf.
 */
const EXPORT_MAP: Record<string, string> = {
  "application/vnd.google-apps.document": "text/markdown",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.drawing": "application/pdf",
};

/** Text read budget for gdrive_read (RESEARCH Open Question 3 — 50k chars). */
const MAX_TEXT_CHARS = 50_000;

/** A Drive files.list metadata item (fields set fixed below). */
export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: string | null | undefined;
  modifiedTime: string;
  webViewLink?: string;
}

interface DriveListResponse {
  nextPageToken?: string;
  files?: Array<{
    id?: string;
    name?: string;
    mimeType?: string;
    size?: string;
    modifiedTime?: string;
    webViewLink?: string;
  }>;
}

/**
 * Search the connected Drive (spaces=drive) via files.list.
 * `query` is the raw Drive q string (name contains 'x', mimeType='…',
 * '<folderId>' in parents, …). `pageToken` continues a previous page.
 *
 * The Bearer is built HERE inside the caller's execute closure — the token
 * never leaves the server (T-196-01).
 */
export async function searchDriveFiles(
  token: string,
  query: string,
  opts?: { pageSize?: number; pageToken?: string },
): Promise<{ files: DriveFileMetadata[]; nextPageToken?: string }> {
  const gdriveBase = getEnv().GDRIVE_API_BASE_URL ?? "https://www.googleapis.com";
  const url = new URL(`${gdriveBase}/drive/v3/files`);
  url.searchParams.set("q", query);
  url.searchParams.set("spaces", "drive");
  url.searchParams.set("fields", "nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink)");
  url.searchParams.set("pageSize", String(opts?.pageSize ?? 25));
  if (opts?.pageToken) url.searchParams.set("pageToken", opts.pageToken);

  const res = await providerFetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    provider: "google",
  });

  if (!res.ok) {
    // Status-only error (no body echo — the body can carry provider prose;
    // keep the same provider+status-only log/return posture).
    throw new Error(`Google Drive search failed (HTTP ${res.status})`);
  }

  const body = (await res.json()) as DriveListResponse;
  const files = (body.files ?? [])
    .filter((f): f is { id: string; name: string; mimeType: string; size?: string; modifiedTime: string; webViewLink?: string } =>
      typeof f.id === "string" && typeof f.name === "string")
    .map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType ?? "application/octet-stream",
      size: f.size ?? null,
      modifiedTime: f.modifiedTime ?? "",
      webViewLink: f.webViewLink,
    }));
  return { files, nextPageToken: body.nextPageToken };
}

/**
 * Fetch a single Drive file's metadata (id/name/mimeType/size) — the
 * ingest path resolves name + size BEFORE any download (the size cap and
 * the Document row's fileName both come from here).
 */
export async function getDriveFileMetadata(
  token: string,
  fileId: string,
): Promise<{ id: string; name: string; mimeType: string; size: number | null }> {
  const gdriveBase = getEnv().GDRIVE_API_BASE_URL ?? "https://www.googleapis.com";
  const url = `${gdriveBase}/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`;
  const res = await providerFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    provider: "google",
  });
  if (!res.ok) {
    throw new Error(`Google Drive metadata fetch failed (HTTP ${res.status})`);
  }
  const body = (await res.json()) as {
    id?: string;
    name?: string;
    mimeType?: string;
    size?: string;
  };
  return {
    id: body.id ?? fileId,
    name: body.name ?? "drive-file",
    mimeType: body.mimeType ?? "application/octet-stream",
    size: body.size ? Number(body.size) : null,
  };
}

/**
 * Read a Drive file's CONTENT (D-05 gdrive_read): Docs Editors types export
 * via /drive/v3/files/{id}/export?mimeType=<map>, binaries download via
 * ?alt=media. Returns the text (truncated at 50_000 chars with a visible
 * truncation marker) plus the mimeType the bytes were delivered in.
 *
 * The Bearer rides the caller's execute closure (T-196-01). A 403 with
 * Drive's fileNotDownloadable reason surfaces as a structured, LLM-actionable
 * error — never a bare status.
 */
export async function readDriveFile(
  token: string,
  fileId: string,
  opts?: { maxBytes?: number },
): Promise<{ text: string; truncated: boolean; mimeType: string }> {
  const gdriveBase = getEnv().GDRIVE_API_BASE_URL ?? "https://www.googleapis.com";

  // 1. Metadata first — mimeType decides the branch (and the ingest size cap
  // reads `size` from the same shape).
  const metaUrl = `${gdriveBase}/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`;
  const metaRes = await providerFetch(metaUrl, {
    headers: { Authorization: `Bearer ${token}` },
    provider: "google",
  });
  if (!metaRes.ok) {
    throw new Error(`Google Drive metadata fetch failed (HTTP ${metaRes.status})`);
  }
  const meta = (await metaRes.json()) as {
    id?: string;
    name?: string;
    mimeType?: string;
    size?: string;
  };
  const mimeType = meta.mimeType ?? "application/octet-stream";

  // 2. Pitfall-1 branch: Docs Editors files are not downloadable with
  // alt=media — they export. Binaries download directly.
  let bytes: Buffer;
  let deliveredMime = mimeType;
  if (mimeType.startsWith("application/vnd.google-apps.")) {
    const exportMime = EXPORT_MAP[mimeType] ?? "application/pdf";
    const exportUrl = `${gdriveBase}/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`;
    const res = await providerFetch(exportUrl, {
      headers: { Authorization: `Bearer ${token}` },
      provider: "google",
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      if (res.status === 403 && bodyText.includes("fileNotDownloadable")) {
        throw new Error(
          `Google Drive file is not downloadable in this format (${mimeType}); export failed (HTTP 403 fileNotDownloadable)`,
        );
      }
      throw new Error(`Google Drive export failed (HTTP ${res.status})`);
    }
    deliveredMime = exportMime;
    bytes = Buffer.from(await res.arrayBuffer());
  } else {
    const res = await providerFetch(
      `${gdriveBase}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      {
        headers: { Authorization: `Bearer ${token}` },
        provider: "google",
      },
    );
    if (!res.ok) {
      throw new Error(`Google Drive download failed (HTTP ${res.status})`);
    }
    bytes = Buffer.from(await res.arrayBuffer());
  }

  // 3. Byte-cap for binary deliverables (DoS posture — never raw megabytes
  // to the LLM). Text budgets apply below; this caps binary payloads too.
  const maxBytes = opts?.maxBytes ?? 10 * 1024 * 1024; // 10 MB default read budget
  if (bytes.byteLength > maxBytes) {
    throw new Error(
      `Google Drive file is too large to read (${Math.round(bytes.byteLength / (1024 * 1024))} MB exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB read budget)`,
    );
  }

  // 4. Text bound (50_000 chars + truncation marker — urlFetcher
  // MAX_MARKDOWN_LENGTH idiom).
  const text = bytes.toString("utf8");
  const truncated = text.length > MAX_TEXT_CHARS;
  return {
    text: truncated
      ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[Content truncated at ${MAX_TEXT_CHARS} characters — the full file is available via gdrive_ingest]`
      : text,
    truncated,
    mimeType: deliveredMime,
  };
}

/**
 * CR-03: byte-oriented download for the ingest path (gdrive_ingest).
 * readDriveFile is a TEXT reader — its `bytes.toString("utf8")` round-trip
 * is lossy for binary payloads (invalid UTF-8 sequences become U+FFFD and
 * `Buffer.from(text, "utf8")` cannot recover them), so routing a PDF/DOCX/
 * XLSX download through it dispatches mojibake to the collector.
 *
 * This function returns the RAW bytes both branches deliver:
 * - Binaries (non-Workspace mimetypes): the ?alt=media response body
 *   verbatim — no text decode anywhere.
 * - Docs Editors files (application/vnd.google-apps.*): the export response
 *   (text-shaped by construction) — exported whole, NOT clamped at the
 *   50_000-char read budget (that bound is an LLM-context posture for
 *   gdrive_read; the collector pipeline is sized for full documents).
 *
 * The size cap is the caller's job (ingestBridge CONNECTOR_INGEST_MAX_BYTES
 * via the skill layer's pre-download metadata size check — WR-02).
 */
export async function downloadDriveFileBytes(
  token: string,
  fileId: string,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const gdriveBase = getEnv().GDRIVE_API_BASE_URL ?? "https://www.googleapis.com";

  // Metadata first — mimeType decides the branch (same Pitfall-1 shape as
  // readDriveFile; name comes from the caller's getDriveFileMetadata call).
  const metaUrl = `${gdriveBase}/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`;
  const metaRes = await providerFetch(metaUrl, {
    headers: { Authorization: `Bearer ${token}` },
    provider: "google",
  });
  if (!metaRes.ok) {
    throw new Error(`Google Drive metadata fetch failed (HTTP ${metaRes.status})`);
  }
  const meta = (await metaRes.json()) as {
    id?: string;
    name?: string;
    mimeType?: string;
    size?: string;
  };
  const mimeType = meta.mimeType ?? "application/octet-stream";

  if (mimeType.startsWith("application/vnd.google-apps.")) {
    // Workspace docs are text-shaped exports — deliver the export bytes
    // directly (no UTF-8 round-trip, no 50k clamp — the collector parses the
    // full export).
    const exportMime = EXPORT_MAP[mimeType] ?? "application/pdf";
    const exportUrl = `${gdriveBase}/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`;
    const res = await providerFetch(exportUrl, {
      headers: { Authorization: `Bearer ${token}` },
      provider: "google",
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      if (res.status === 403 && bodyText.includes("fileNotDownloadable")) {
        throw new Error(
          `Google Drive file is not downloadable in this format (${mimeType}); export failed (HTTP 403 fileNotDownloadable)`,
        );
      }
      throw new Error(`Google Drive export failed (HTTP ${res.status})`);
    }
    return { bytes: Buffer.from(await res.arrayBuffer()), mimeType: exportMime };
  }

  // Binaries: the ?alt=media body VERBATIM as bytes — the CR-03 fix. Never
  // decoded to text; the collector's parse pipeline receives the exact
  // provider bytes.
  const res = await providerFetch(
    `${gdriveBase}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    {
      headers: { Authorization: `Bearer ${token}` },
      provider: "google",
    },
  );
  if (!res.ok) {
    throw new Error(`Google Drive download failed (HTTP ${res.status})`);
  }
  return { bytes: Buffer.from(await res.arrayBuffer()), mimeType };
}