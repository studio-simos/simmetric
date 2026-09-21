// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 190 (SKIL-02, D-10) — slash-command skills palette.
 *
 * A SEPARATE surface from the /model palette (Pitfall 9): its own Popover
 * (side="top", align="start") anchored to the chat input, its own open state
 * — never wired into the model palette's CustomEvent dispatch, and
 * ModelPalette.tsx / useModelPalette.ts stay untouched. The Command internals
 * are mirrored from the ModelPalette pattern (D-10) but owned here.
 *
 * UI-SPEC interaction contract: opens when the input's first character is "/",
 * closes on Escape / blur-outside / space-disambiguation; selecting a row
 * inserts "/slug " into the input WITHOUT sending. Renders only from the
 * cached useSkills data (staleTime 5min) — empty copy when nothing matches
 * (no loading spinner).
 *
 * D-10 literal membership: builtin entries render as a DISABLED read-only
 * group (visible, non-selectable — their slugs cannot resolve over the
 * skillCall transport); the 10-row cap counts SELECTABLE custom rows only.
 * MCP tools never render (they are LLM-advertised tools, not slash commands).
 */
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "@/components/ui/command";

/** A palette entry — a row of the custom ∪ accessible union (or a builtin). */
export interface SkillsPaletteItem {
  slug: string;
  name: string;
  description: string;
}

interface SkillsPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Inserts "/slug " into the chat input — NEVER sends (UI-SPEC contract). */
  onSelect: (slug: string) => void;
  /** The chat input's current text — drives the filter (value-driven query). */
  query: string;
  /** Custom ∪ accessible rows (enabled only) — the parser's match set. */
  items: SkillsPaletteItem[];
  /** Builtin registry rows — rendered as a DISABLED read-only group (D-10). */
  builtinItems: SkillsPaletteItem[];
}

/** D-10: 10 rendered SELECTABLE rows + scroll (max-h-[400px]). */
export const SKILLS_PALETTE_MAX_ROWS = 10;

export default function SkillsPalette({
  open,
  onClose,
  onSelect,
  query,
  items,
  builtinItems,
}: SkillsPaletteProps) {
  const { t } = useTranslation();

  // The palette query is the typed text minus the leading "/" (the slug being
  // typed). Filtering mirrors useModelPalette's filter idiom (D-10), computed
  // inline — the component stays presentational (the parent owns open state).
  const paletteQuery = query.startsWith("/") ? query.slice(1) : query;
  const filtered = useMemo(() => {
    const q = paletteQuery.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (s) =>
        s.slug.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }, [items, paletteQuery]);

  // 10-row cap counts SELECTABLE custom rows only (disabled builtin rows do
  // not consume the cap — D-10 literal membership).
  const capped = filtered.slice(0, SKILLS_PALETTE_MAX_ROWS);

  // Escape closes. Radix Popover already closes on outside pointer-down and
  // returns focus to the anchor on close (the anchor wraps the input area);
  // the explicit Escape listener covers key-presses the Command internals
  // don't reach (the user keeps typing in the chat textarea, not Command).
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open, onClose]);

  // Space-disambiguation (UI-SPEC): a space typed after the slug closes the
  // palette — the user is writing args. The parent's open-state effect
  // enforces the same rule on the input; this component-level mirror keeps
  // the contract pinned on the palette surface itself (onClose is idempotent).
  useEffect(() => {
    if (!open) return;
    if (/^\/[a-z0-9-]+\s/.test(query)) {
      onClose();
    }
  }, [open, query, onClose]);

  return (
    <Popover open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      {/* Positioning-only anchor: a zero-size div the parent places at the
          input area's bottom edge (absolute, invisible) — Radix tracks it and
          returns focus to it on close (UI-SPEC focus-return contract). */}
      <PopoverAnchor className="absolute inset-x-3 bottom-1 h-0" />
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-[420px] max-w-[90vw] p-0"
      >
        <Command shouldFilter={false}>
          {/* The user keeps typing in the real chat textarea — the CommandInput
              is a value-driven MIRROR (read-only, never focused) so the
              Command a11y shape stays intact without stealing focus. */}
          <CommandInput
            placeholder={t("chat.skillsPalette.empty", "No matching skills")}
            value={paletteQuery}
            readOnly
            tabIndex={-1}
          />
          <CommandList className="max-h-[400px]">
            {/* Explicit empty arm: cmdk's CommandEmpty only renders when the
                WHOLE list is empty — with the disabled builtin group always
                present it would never show. The D-10 empty copy must appear
                whenever no SELECTABLE row matches, so render it directly. */}
            {capped.length === 0 ? (
              <div
                data-testid="skills-palette-empty"
                className="py-6 text-center text-sm"
              >
                <span>{t("chat.skillsPalette.empty", "No matching skills")}</span>
                <Link
                  to="/skills"
                  className="mt-1 block text-primary underline text-sm"
                  onClick={() => onClose()}
                >
                  {t("chat.skillsPalette.manageLink", "Manage skills")}
                </Link>
              </div>
            ) : (
              <CommandGroup heading={t("chat.skillsPalette.customGroup", "Skills")}>
                {capped.map((skill) => (
                  <CommandItem
                    key={skill.slug}
                    value={skill.slug}
                    data-testid={`skills-palette-item-${skill.slug}`}
                    onSelect={() => {
                      // UI-SPEC: insert "/slug " into the input — never send.
                      onSelect(skill.slug);
                      onClose();
                    }}
                  >
                    <span className="font-mono text-primary shrink-0">/{skill.slug}</span>
                    <span className="truncate">{skill.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground truncate max-w-[40%]">
                      {skill.description}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {builtinItems.length > 0 && (
              <>
                <CommandSeparator />
                {/* D-10 literal membership: builtins are LLM-advertised tools,
                    not slash-invocable over skillCall — rendered as a DISABLED
                    read-only group (no onSelect wiring, aria-disabled). */}
                <CommandGroup heading={t("chat.skillsPalette.builtinGroup", "Built-in (LLM tools — not slash commands)")}>
                  {builtinItems.map((skill) => (
                    <CommandItem
                      key={`builtin-${skill.slug}`}
                      value={`builtin-${skill.slug}`}
                      disabled
                      aria-disabled="true"
                      data-testid={`skills-palette-builtin-${skill.slug}`}
                      className="opacity-50 cursor-default"
                    >
                      <span className="font-mono shrink-0">/{skill.slug}</span>
                      <span className="truncate">{skill.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
          {/* Footer hint row (UI-SPEC palette copy). */}
          <div className="px-4 py-2 flex justify-between items-center bg-card border-t border-border">
            <span className="text-xs text-muted-foreground">
              {t("chat.skillsPalette.hint", "↑↓ to navigate, Enter to insert, Esc to close")}
            </span>
            <Link
              to="/skills"
              className="text-xs text-muted-foreground underline hover:text-foreground"
              onClick={() => onClose()}
            >
              {t("chat.skillsPalette.manageLink", "Manage skills")}
            </Link>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}