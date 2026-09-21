// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ArchiveAttachPicker (Phase 191 D-06, restructured by quick 260919-qjg) —
 * org-archive picker + removable chips for the chat composer.
 *
 * Data source: `useArchives()` (org-scoped GET /api/archives — soft-deleted
 * rows never appear; the route already filters). Chips resolve their name
 * from the same query data, falling back to the raw id before hydration.
 * Multi-select with a max cap (chatRequestSchema .max(5) — the UI mirrors
 * the wire cap so the send never 400s).
 *
 * Chip styling mirrors the attached-document chip so document vs archive
 * chips are distinguishable: archive chips carry a Library icon.
 *
 * Render surfaces (`mode`, quick 260919-qjg) — ONE component, ONE selection
 * source (the `selectedIds`/`onToggle` props; no duplicated state):
 * - "full" (default, backwards compatible): chips row + bordered picker
 *   panel — the legacy Phase 191 D-06 output, unchanged.
 * - "chips": chips row only. Composed by ChatPanel above the input; the
 *   archive list itself lives inside the "+" popover submenu, so nothing
 *   but the chips may overlay the chat area above the input.
 * - "panel": popover-submenu body only (picker title, archive rows, empty
 *   state, max-reached notice on a max-h-56 scroll region). No chips row
 *   and no outer border/background wrapper — the PopoverContent already
 *   provides the surface.
 */

import { useTranslation } from "react-i18next";
import { Library, X, Check, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { useArchives } from "@/queries/useArchives";

export interface ArchiveAttachPickerProps {
  selectedIds: string[];
  onToggle: (id: string) => void;
  /** Max selectable archives (mirrors chatRequestSchema .max(5)). Default 5. */
  max?: number;
  /** Render surface — see the component JSDoc. Default "full". */
  mode?: "full" | "chips" | "panel";
}

export default function ArchiveAttachPicker({
  selectedIds,
  onToggle,
  max = 5,
  mode = "full",
}: ArchiveAttachPickerProps) {
  const { t } = useTranslation();
  const { data: archives = [] } = useArchives();
  const maxReached = selectedIds.length >= max;

  const nameOf = (id: string): string =>
    archives.find((a) => a.id === id)?.name ?? id;

  const pageCountOf = (id: string): number =>
    archives.find((a) => a.id === id)?._count?.pages ?? 0;

  const chipsRow =
    selectedIds.length > 0 ? (
      <div className="flex flex-wrap items-center gap-2">
        {selectedIds.map((id) => (
          <span
            key={id}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
              "bg-[var(--surface)] text-[var(--text)] border-[var(--chat-border)] transition-theme",
            )}
          >
            <Library className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
            <span className="max-w-[200px] truncate">{nameOf(id)}</span>
            <button
              type="button"
              onClick={() => onToggle(id)}
              aria-label={t("chat.attach.remove", "Remove attached archive")}
              className="rounded-full p-0.5 hover:bg-accent/40 transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>
    ) : null;

  const listBody = (
    <>
      <div className="px-2 py-1.5 text-xs font-medium text-[var(--text-muted)]">
        {t("chat.attach.pickerTitle", "Attach archive knowledge")}
      </div>

      {archives.length === 0 ? (
        <div className="flex items-center gap-2 px-2 py-3 text-sm text-[var(--text-muted)]">
          <Inbox className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{t("chat.attach.empty", "No archives available to attach.")}</span>
        </div>
      ) : (
        <ul className="flex flex-col">
          {archives.map((archive) => {
            const isSelected = selectedIds.includes(archive.id);
            const disabled = !isSelected && maxReached;
            return (
              <li key={archive.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (!disabled) onToggle(archive.id);
                  }}
                  disabled={disabled}
                  aria-pressed={isSelected}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm transition-colors",
                    disabled
                      ? "cursor-not-allowed opacity-50"
                      : "cursor-pointer hover:bg-accent/40",
                  )}
                >
                  {/* Checkbox-style toggle */}
                  <span
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                      isSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-[var(--chat-border)] bg-transparent",
                    )}
                    aria-hidden="true"
                  >
                    {isSelected && <Check className="w-3 h-3" />}
                  </span>
                  <Library className="w-4 h-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{archive.name}</span>
                    <span className="block text-xs text-[var(--text-muted)]">
                      {t("chat.attach.pageCount", "{{count}} pages", { count: pageCountOf(archive.id) })}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Max-reached notice */}
      {maxReached && (
        <div className="px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400" role="status">
          {t("chat.attach.maxReached", "You can attach up to {{max}} archives.", { max })}
        </div>
      )}
    </>
  );

  if (mode === "chips") {
    return (
      <div className="mb-2 flex flex-col gap-2" data-testid="archive-attach-picker">
        {chipsRow}
      </div>
    );
  }

  if (mode === "panel") {
    // Popover-submenu body: no outer border/background wrapper (the
    // PopoverContent provides the surface), no chips row.
    return (
      <div
        data-testid="archive-attach-picker-panel"
        role="group"
        aria-label={t("chat.attach.pickerTitle", "Attach archive knowledge")}
        className="max-h-56 overflow-y-auto p-1.5"
      >
        {listBody}
      </div>
    );
  }

  return (
    <div className="mb-2 flex flex-col gap-2" data-testid="archive-attach-picker">
      {/* Chips row — one chip per selected archive */}
      {chipsRow}

      {/* Picker panel */}
      <div
        className={cn(
          "rounded-lg border border-[var(--chat-border)] bg-[var(--surface)] transition-theme",
          "max-h-56 overflow-y-auto p-1.5",
        )}
        role="group"
        aria-label={t("chat.attach.pickerTitle", "Attach archive knowledge")}
      >
        {listBody}
      </div>
    </div>
  );
}