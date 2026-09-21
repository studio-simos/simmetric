// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DocumentViewerPage — read-only markdown body in a single vertical scroll.
 *
 * Phase 192 (DLP-04, D-10, UI-SPEC surface 2): the DLP preview arm —
 *  - The text ALWAYS loads masked by default on every visit; the show/hide
 *    unmask toggle is per-view and NEVER persisted (no localStorage, no
 *    URL param in shareable links — interaction rule 2).
 *  - The toggle renders ONLY when the user holds `dlp:unmask` AND the
 *    document carries DLP entities (placeholder tokens in the served
 *    masked text) — otherwise it is ABSENT from the DOM, not
 *    disabled-hidden (interaction rule 2 / T-192-37 defense-in-depth;
 *    the server remains the gate).
 *  - The amber masked notice (DLPNotice convention: text-amber-700
 *    dark:text-amber-300 on bg-amber-50/10 dark:bg-amber-950/20) renders
 *    above the text when entities exist; placeholder tokens render
 *    visually distinct via a lightweight inline tokenizer (React
 *    elements, never dangerouslySetInnerHTML).
 *  - Unmask fetch error: masked text stays rendered + documents.dlp.
 *    unmaskError inline message with a retry ghost button (error arm).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Copy,
  Eye,
  EyeOff,
  FileText,
  FileWarning,
  Loader2,
  ShieldAlert,
} from "lucide-react";
import { Button } from "./ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "./ui/card";
import { Badge } from "./ui/badge";
import { Skeleton } from "./ui/skeleton";
import { hasDlpPlaceholders, useDocumentText } from "../queries/useDocuments";
import { useMe } from "../queries/useAuth";
import { renderMarkdown } from "../utils/markdown";
import { showSuccess, showError } from "../lib/toast";

/**
 * Status → Badge variant + accent class. Uses CSS custom properties so the
 * colors stay consistent across light/dark themes.
 */
function statusBadge(status: string) {
  if (status === "completed") {
    return (
      <Badge
        variant="secondary"
        className="text-[var(--success-text)] bg-[var(--success-bg)]"
      >
        {status}
      </Badge>
    );
  }
  if (status === "processing" || status === "pending") {
    return (
      <Badge
        variant="secondary"
        className="text-[var(--warning-text)] bg-[var(--warning-bg)]"
      >
        {status}
      </Badge>
    );
  }
  return (
    <Badge
      variant="secondary"
      className="text-[var(--error-text)] bg-[var(--error-bg)]"
    >
      {status}
    </Badge>
  );
}

/**
 * Phase 192 (UI-SPEC surface 2): lightweight inline tokenizer that splits
 * text into plain segments and bracketed placeholder tokens
 * (`[PERSON_1]`, `[GOV_ID_2]`, …). Placeholders render in `--font-mono`
 * (JetBrains Mono, UI-SPEC typography) so tokens are visually distinct in
 * the masked body — plain React elements, NEVER dangerouslySetInnerHTML.
 */
function renderTextWithPlaceholders(text: string): Array<string | { token: string }> {
  const parts: Array<string | { token: string }> = [];
  const regex = /\[\s*[A-Z][A-Z_]*\s*_\s*\d+\s*\]/g;
  let last = 0;
  for (const match of text.matchAll(regex)) {
    const idx = match.index ?? 0;
    if (idx > last) parts.push(text.slice(last, idx));
    parts.push({ token: match[0] });
    last = idx + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export default function DocumentViewerPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: meData } = useMe();
  // D-10: the viewer fetches MASKED by default on every mount; `unmask` is
  // per-view React state only — no localStorage, no URL param write
  // (interaction rule 2). Navigating away and back remounts → masked again.
  const [unmasked, setUnmasked] = useState(false);
  // The masked text stays in cache under its own query entry; the unmask
  // variant is a separate entry. We keep the masked query mounted so an
  // unmask fetch error can fall back to the already-rendered masked text.
  // The unmask query is disabled while not opted in (no extra fetch); an
  // unmask fetch ERROR degrades to the masked text + retry banner — never
  // the not-found card, never a blank page (UI-SPEC error arm).
  const maskedQuery = useDocumentText(id, false);
  const unmaskQuery = useDocumentText(unmasked ? id : undefined, unmasked);
  const unmaskFailed = unmasked && unmaskQuery.isError && maskedQuery.data != null;
  const activeQuery = unmasked && unmaskQuery.data != null ? unmaskQuery : maskedQuery;
  const { data, isLoading, error } = activeQuery;

  const back = () => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate("/documents");
    }
  };

  async function copyText() {
    try {
      await navigator.clipboard.writeText(data?.text ?? "");
      showSuccess(t("documents.copySuccess"));
    } catch {
      showError(t("documents.copyError"));
    }
  }

  // 1. Loading — skeleton placeholder (mirrors ArchivePageFullView).
  if (isLoading) {
    return (
      <Card className="h-full flex flex-col overflow-hidden">
        <CardHeader className="pb-4">
          <Skeleton className="h-6 w-48" />
        </CardHeader>
        <CardContent className="flex-1">
          <Skeleton className="h-4 w-full mb-2" />
          <Skeleton className="h-4 w-3/4 mb-2" />
          <Skeleton className="h-4 w-5/6" />
        </CardContent>
      </Card>
    );
  }

  // 2. Error / not found — centered Card with FileWarning + back button.
  if (error || !data) {
    return (
      <Card className="flex flex-col items-center justify-center h-64 gap-4">
        <CardContent className="flex flex-col items-center gap-4 text-center">
          <FileWarning className="h-10 w-10 text-[var(--text-muted)]" />
          <p className="text-[var(--text-muted)]">{t("documents.notFound")}</p>
          <Button
            variant="ghost"
            size="sm"
            className="min-h-[44px]"
            onClick={back}
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            {t("documents.backToList")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // 3. Processing — status !== "completed" → spinner + processing copy.
  if (data.status !== "completed") {
    return (
      <Card className="flex flex-col items-center justify-center h-64 gap-4">
        <CardContent className="flex flex-col items-center gap-4 text-center">
          <Loader2 className="h-10 w-10 animate-spin text-[var(--text-muted)]" />
          <p className="text-[var(--text-muted)]">{t("documents.processing")}</p>
          <Button
            variant="ghost"
            size="sm"
            className="min-h-[44px]"
            onClick={back}
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            {t("documents.backToList")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // 4. Empty text — no extracted text yet.
  if (!data.text) {
    return (
      <Card className="flex flex-col items-center justify-center h-64 gap-4">
        <CardContent className="flex flex-col items-center gap-4 text-center">
          <FileText className="h-10 w-10 text-[var(--text-muted)]" />
          <div className="space-y-1">
            <p className="font-semibold text-[var(--text)]">
              {t("documents.emptyTextTitle")}
            </p>
            <p className="text-sm text-[var(--text-muted)]">
              {t("documents.emptyTextBody")}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="min-h-[44px]"
            onClick={back}
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            {t("documents.backToList")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // 5. Success — read-only markdown body in a single vertical scroll.
  // Phase 192 (D-10, UI-SPEC surface 2): the DLP arms attach here —
  // hasEntities derives from the SERVED MASKED text (placeholder tokens
  // are server truth that entities exist; zero contract change), the
  // toggle is DOM-present only for dlp:unmask holders on such documents,
  // and the amber masked notice renders above the text. hasEntities reads
  // the MASKED arm (maskedQuery), not the currently-served variant — the
  // unmasked text contains the original values, so re-deriving from it
  // after Show would drop the toggle and trap the user in the unmasked
  // view (Hide unreachable).
  const hasEntities = hasDlpPlaceholders(maskedQuery.data?.text);
  const canUnmask = (meData?.permissions?.includes("dlp:unmask") ?? false) && hasEntities;
  const showUnmaskFetchError = unmaskFailed && Boolean(maskedQuery.data?.text);
  const text = data.text;

  return (
    <Card className="h-full flex flex-col overflow-hidden">
      <CardHeader className="flex flex-row items-center gap-2 pb-4">
        <Button
          variant="ghost"
          size="sm"
          className="min-h-[44px]"
          onClick={back}
          aria-label={t("documents.backToList")}
        >
          <ArrowLeft className="mr-1 h-4 w-4" />
          {t("documents.backToList")}
        </Button>
        <CardTitle className="flex-1 truncate text-xl font-semibold">
          {data.name}
        </CardTitle>
        <Badge variant="secondary" className="capitalize">
          {data.type}
        </Badge>
        {statusBadge(data.status)}
        {/* D-10 per-view unmask toggle — ghost (neutral, never accent),
            Eye/EyeOff + label, aria-pressed; DOM-present ONLY for entitled
            users on entity-carrying documents (UI-SPEC rule 2). */}
        {canUnmask && (
          <Button
            variant="ghost"
            size="sm"
            className="min-h-[44px]"
            onClick={() => setUnmasked((prev) => !prev)}
            aria-pressed={unmasked}
          >
            {unmasked ? (
              <EyeOff className="mr-1 h-4 w-4" />
            ) : (
              <Eye className="mr-1 h-4 w-4" />
            )}
            {unmasked ? t("documents.dlp.hide") : t("documents.dlp.show")}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="min-h-[44px]"
          onClick={copyText}
        >
          <Copy className="mr-1 h-4 w-4 text-[var(--primary)]" />
          {t("documents.copyText")}
        </Button>
      </CardHeader>
      <CardContent
        className="flex-1 min-h-0 overflow-y-auto"
        style={{
          scrollbarColor: "var(--scrollbar-thumb) var(--scrollbar-track)",
        }}
      >
        {hasEntities && (
          <div
            className="mb-3 flex items-start gap-2 rounded-lg border border-[var(--border)] bg-amber-50/10 dark:bg-amber-950/20 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300"
            role="status"
            data-testid="dlp-masked-notice"
          >
            <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{t("documents.dlp.maskedNotice")}</span>
          </div>
        )}
        {showUnmaskFetchError && (
          <div
            className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-amber-50/10 dark:bg-amber-950/20 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300"
            role="alert"
            data-testid="dlp-unmask-error"
          >
            <span>{t("documents.dlp.unmaskError")}</span>
            <Button
              variant="ghost"
              size="sm"
              className="min-h-[44px] h-auto py-0.5 px-2 text-xs"
              onClick={() => unmaskQuery.refetch()}
            >
              {t("documents.dlp.show")}
            </Button>
          </div>
        )}
        {hasEntities ? (
          // D-10 masked-text rendering: placeholder tokens stay LITERAL and
          // render in --font-mono (JetBrains Mono) via the inline tokenizer —
          // plain React elements, no dangerouslySetInnerHTML on the masked
          // body (UI-SPEC surface 2 + held-out backstop: long masked text
          // wraps/reflows inside the scroll container, pre-wrap).
          <div
            className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap break-words"
            data-testid="dlp-masked-text"
          >
            {renderTextWithPlaceholders(text).map((part, i) =>
              typeof part === "string" ? (
                <span key={i}>{part}</span>
              ) : (
                <code
                  key={i}
                  className="font-mono text-[0.9em] bg-[var(--surface-alt)] rounded px-1 py-0.5"
                >
                  {part.token}
                </code>
              ),
            )}
          </div>
        ) : (
          <div
            className="prose prose-sm dark:prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
          />
        )}
      </CardContent>
    </Card>
  );
}