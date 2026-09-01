// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { Plus, Trash2, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Header editor — matches server mcpHeadersSchema (packages/shared/src/schemas/mcpConnection.schema.ts):
// names must match ^[A-Za-z0-9-]+$, max 20 entries, values <= 4096 chars, hop-by-hop blocked server-side.
const HEADER_NAME_REGEX = /^[A-Za-z0-9-]+$/;
const MAX_HEADERS = 20;
const MAX_HEADER_VALUE = 4096;
const SENSITIVE_NAME_RE = /auth|key|secret|token|password/i;

// Common auth header presets — click to add a pre-filled row (value left blank for the user to fill).
const HEADER_PRESETS = [
  "Authorization",
  "X-API-Key",
  "CF-Access-Client-Id",
  "CF-Access-Client-Secret",
  "X-Auth-Token",
] as const;

export interface HeaderRow {
  id: string;
  name: string;
  value: string;
  masked: boolean;
}

let headerRowSeq = 0;
const newHeaderRow = (name = "", value = "", masked?: boolean): HeaderRow => ({
  id: `hdr-${++headerRowSeq}`,
  name,
  value,
  masked: masked ?? SENSITIVE_NAME_RE.test(name),
});

export const headersToRows = (headers: Record<string, string> | null | undefined): HeaderRow[] => {
  if (!headers) return [];
  return Object.entries(headers).map(([name, value]) => newHeaderRow(name, value));
};

export type HeadersBuildError = "errorInvalidHeaderName" | "errorTooManyHeaders" | null;

/**
 * Convert editor rows into the headers object to send to the API.
 * - Rows with an empty name are ignored (not an error).
 * - Invalid name (non-empty but not matching the regex) or oversize value → error.
 * - Duplicate names: last wins (mirrors Object.fromEntries).
 * Returns { headers, error } where `error` is an i18n key suffix under
 * `settings.mcpConnections.*` (or null). When error is non-null, headers is null.
 */
export const rowsToHeaders = (
  rows: HeaderRow[],
): { headers: Record<string, string> | null; error: HeadersBuildError } => {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue; // empty-name rows are ignored, not an error
    if (!HEADER_NAME_REGEX.test(name) || row.value.length > MAX_HEADER_VALUE) {
      return { headers: null, error: "errorInvalidHeaderName" };
    }
    out[name] = row.value;
  }
  if (Object.keys(out).length > MAX_HEADERS) {
    return { headers: null, error: "errorTooManyHeaders" };
  }
  return { headers: out, error: null };
};

interface McpHeadersEditorProps {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  error?: string;
  /** i18n namespace prefix for the keys; defaults to settings.mcpConnections. */
  ns?: string;
}

/**
 * Controlled structured key/value header editor with auth presets, masked
 * sensitive values, and a read-only JSON preview. Reused by the MCP connection
 * form (create/edit) and the marketplace install dialog.
 */
export default function McpHeadersEditor({ rows, onChange, error, ns = "settings.mcpConnections" }: McpHeadersEditorProps) {
  const { t } = useTranslation();
  const k = (key: string) => `${ns}.${key}`;

  const addRow = (name = "", value = "") => {
    if (rows.length >= MAX_HEADERS) return;
    onChange([...rows, newHeaderRow(name, value)]);
  };
  const removeRow = (id: string) => onChange(rows.filter((r) => r.id !== id));
  const updateRow = (id: string, patch: Partial<Omit<HeaderRow, "id">>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const toggleMask = (id: string) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, masked: !r.masked } : r)));
  const applyPreset = (name: string) => {
    if (rows.some((r) => r.name === name)) return; // idempotent: no duplicate
    addRow(name, "");
  };

  const previewHeaders = (() => {
    const out: Record<string, string> = {};
    for (const row of rows) {
      const name = row.name.trim();
      if (!name) continue;
      out[name] = row.value;
    }
    return out;
  })();

  return (
    <div className="space-y-1">
      <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
        {t(k("headersLabel"))}
      </label>
      <p className="text-xs text-muted-foreground mb-2">{t(k("headersHint"))}</p>

      {/* Common auth header presets */}
      <div className="flex flex-wrap gap-1.5 mb-2">
        {HEADER_PRESETS.map((name) => (
          <Button
            key={name}
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => applyPreset(name)}
          >
            + {name}
          </Button>
        ))}
      </div>

      {/* Rows */}
      <div className="space-y-2">
        {rows.length === 0 && (
          <p className="text-xs text-muted-foreground py-1">{t(k("headersEmpty"))}</p>
        )}
        {rows.map((row) => (
          <div key={row.id} className="flex items-center gap-2">
            <Input
              type="text"
              className="flex-1 font-mono text-sm"
              placeholder={t(k("headersNamePlaceholder"))}
              value={row.name}
              onChange={(e) => updateRow(row.id, { name: e.target.value })}
            />
            <div className="relative flex-1">
              <Input
                type={row.masked ? "password" : "text"}
                className="font-mono text-sm pr-9"
                placeholder={t(k("headersValuePlaceholder"))}
                value={row.value}
                onChange={(e) => updateRow(row.id, { value: e.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0 top-0 h-9 w-9"
                aria-label={row.masked ? t(k("headersShow")) : t(k("headersHide"))}
                onClick={() => toggleMask(row.id)}
              >
                {row.masked ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-destructive"
              aria-label={t(k("headersRemove"))}
              onClick={() => removeRow(row.id)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => addRow()}>
        <Plus className="h-4 w-4 mr-1" />
        {t(k("headersAdd"))}
      </Button>

      {error && <p className="text-sm text-destructive mt-1">{error}</p>}

      {/* Read-only JSON preview of what will be sent */}
      {Object.keys(previewHeaders).length > 0 && (
        <div className="mt-2">
          <p className="text-xs text-muted-foreground mb-1">{t(k("headersPreview"))}</p>
          <pre className="text-xs font-mono bg-[var(--code-bg)] text-[var(--code-text)] rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
            {JSON.stringify(previewHeaders, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}