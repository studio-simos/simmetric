// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useRef, useState, useEffect, useMemo, type KeyboardEvent, type ChangeEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Send, Square, Paperclip, Mic, X, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { KbdHint } from "../KbdHint";

/**
 * ChatInputArea — "Simmetric Native" message composer (Feature 4.3).
 *
 * 4.3.1: glass-panel container sticky at the bottom, `--chat-input-bg` + a
 *   top border in `--chat-border`; under `.theme-hacker` a faint grid + a
 *   focus-within accent glow (driven by `.chat-input-panel` in chat-theme.css).
 * 4.3.3: the placeholder rotates softly across 3 i18n strings (~4s) while the
 *   input is empty; rotation stops as soon as the user types.
 * 4.3.4: a visible mono hint row `⏎ Send · ⇧⏎ New line · ⌘K Models` fades out
 *   ~3s after the user starts typing; the sr-only hint stays for SR users.
 *
 * The model selector, MCP toggles, and wiki history button previously rendered
 * here were relocated to the RightPanel console (quick 260723-nnr). The `actions`
 * slot now carries only the compare-models button (plus attachment + mic owned
 * here). Cmd+K still opens the palette via the global shortcut.
 *
 * Also owns the pre-existing concerns: auto-expand textarea (4.10.1), send
 * button micro-interactions (4.7.3), 44px touch targets (4.8.1), ARIA (4.9.1).
 */
export interface ChatInputAreaProps {
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  isStreaming: boolean;
  onAbort: () => void;
  disabled?: boolean;
  placeholder?: string;
  // Attachment
  attachedDocName?: string | null;
  onRemoveAttachment?: () => void;
  onFileSelect?: (files: File[]) => void;
  uploading?: boolean;
  accept?: string;
  // Microphone
  micSupported?: boolean;
  micListening?: boolean;
  onToggleMic?: () => void;
  // Theme
  isHackerTheme?: boolean;
  /**
   * Extra action buttons rendered in the actions row (left of the textarea on
   * desktop, above the input row on mobile). Owned/composed by the parent
   * (ChatPanel) so state, handlers, and permission gating stay there.
   * As of quick 260723-nnr this carries only the compare-models button; the
   * model badge, MCP toggles, and wiki history button moved to RightPanel.
   */
  actions?: ReactNode;
  /**
   * Quick 260829-spj: admin-gated "Show/Hide DLP texts" menu item, rendered
   * after `actions` in the more-actions Popover. Owned/composed by the parent
   * for the same reason as `actions` (state + gating stay in ChatPanel); the
   * item hides itself for non-admins via its own `visible` gate.
   */
  dlpToggle?: ReactNode;
}

const PLACEHOLDER_ROTATION_MS = 4000;
const HINT_FADE_MS = 3000;

export function ChatInputArea({
  value,
  onChange,
  onKeyDown,
  onSend,
  isStreaming,
  onAbort,
  disabled,
  placeholder,
  attachedDocName,
  onRemoveAttachment,
  onFileSelect,
  uploading,
  accept = ".pdf,.md,.txt,.csv,.docx,.xlsx",
  micSupported,
  micListening,
  onToggleMic,
  isHackerTheme,
  actions,
  dlpToggle,
}: ChatInputAreaProps) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pulse, setPulse] = useState(false);
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 4.3.3: rotating placeholder. Index 0 is the canonical "Type a message..."
  // so callers/tests that look up that exact text still match at initial render.
  const placeholders = useMemo(
    () => [
      placeholder ?? t("chat.placeholder", "Type a message..."),
      t("chat.input.placeholder.2", "Ask about your documents…"),
      t("chat.input.placeholder.3", "Search the knowledge base…"),
    ],
    [t, placeholder],
  );
  const [phIndex, setPhIndex] = useState(0);
  const [hintVisible, setHintVisible] = useState(true);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-expand textarea (Feature 4.10.1).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  // 4.3.3: rotate placeholder only while the input is empty & idle.
  useEffect(() => {
    if (value.trim().length > 0) {
      setPhIndex(0);
      return;
    }
    const id = setInterval(() => {
      setPhIndex((i) => (i + 1) % placeholders.length);
    }, PLACEHOLDER_ROTATION_MS);
    return () => clearInterval(id);
  }, [value, placeholders]);

  // 4.3.4: fade the visible hint out shortly after the user starts typing;
  // bring it back when the input is cleared.
  useEffect(() => {
    if (value.trim().length === 0) {
      setHintVisible(true);
      if (hintTimer.current) clearTimeout(hintTimer.current);
      return;
    }
    if (!hintTimer.current) {
      hintTimer.current = setTimeout(() => setHintVisible(false), HINT_FADE_MS);
    }
    return () => {
      if (hintTimer.current) {
        clearTimeout(hintTimer.current);
        hintTimer.current = null;
      }
    };
  }, [value]);

  useEffect(() => {
    return () => {
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
      if (hintTimer.current) clearTimeout(hintTimer.current);
    };
  }, []);

  const trimmed = value.trim();
  const canSend = !isStreaming && !disabled && trimmed.length > 0;

  const handleSendClick = () => {
    if (!canSend) return;
    // Feature 4.7.3: glow pulse (+ glitch flash in hacker theme).
    setPulse(true);
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    pulseTimer.current = setTimeout(() => setPulse(false), 360);
    onSend();
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0 && onFileSelect) {
      onFileSelect(Array.from(files));
    }
    e.target.value = "";
  };

  return (
    <div
      className={cn(
        "chat-input-panel border-t border-[var(--chat-border)] p-3 sm:p-4",
        "bg-[var(--chat-input-bg)] transition-theme",
      )}
    >
      {attachedDocName && (
        <div className="mb-2 flex items-center gap-2">
          <Badge variant="secondary" className="truncate">
            {attachedDocName}
          </Badge>
          {onRemoveAttachment && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onRemoveAttachment}
              title={t("chat.removeAttachment", "Remove attachment")}
              aria-label={t("chat.removeAttachment", "Remove attachment")}
            >
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>
      )}

      <div className="flex items-end gap-2">
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholders[phIndex]}
          className="flex-1 resize-none min-h-[44px] max-h-[200px]"
          rows={1}
          disabled={isStreaming}
          autoFocus
          aria-label={t("chat.input.label", "Message input")}
          aria-describedby="chat-input-hint"
        />

        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 size-9 rounded-lg border bg-card border-input text-muted-foreground hover:bg-muted"
              title={t("chat.input.moreActions", "More actions")}
              aria-label={t("chat.input.moreActions", "More actions")}
            >
              <Plus className="w-5 h-5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={8} className="w-56 p-1">
            <label className={cn(
              "flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer text-sm transition-colors hover:bg-accent/40",
              (uploading || isStreaming) && "opacity-50 pointer-events-none"
            )}>
              <Paperclip className="w-4 h-4 shrink-0 text-muted-foreground" />
              <span>{t("chat.input.attach", "Attach a document")}</span>
              <Input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={handleFileChange}
                accept={accept}
                disabled={uploading || isStreaming}
                aria-label={t("chat.input.attach", "Attach a document")}
              />
            </label>

            {micSupported && onToggleMic && (
              <button
                type="button"
                onClick={onToggleMic}
                aria-label={t("chat.microphone", "Microphone")}
                aria-pressed={micListening}
                className={cn(
                  "flex items-center gap-3 w-full px-3 py-2 rounded-md text-sm transition-colors hover:bg-accent/40",
                  micListening && "text-destructive"
                )}
              >
                <Mic className={cn("w-4 h-4 shrink-0", micListening ? "text-destructive" : "text-muted-foreground")} />
                <span>{t("chat.microphone", "Microphone")}</span>
              </button>
            )}

            {actions}

            {/* Quick 260829-spj: admin-gated global DLP-text reveal toggle.
                Renders nothing when the parent passes no item or gates it off. */}
            {dlpToggle}
          </PopoverContent>
        </Popover>

        {isStreaming ? (
          <Button
            variant="destructive"
            size="icon"
            onClick={onAbort}
            title={t("chat.stopGenerating", "Stop")}
            aria-label={t("chat.stopGenerating", "Stop")}
            className="shrink-0 size-9"
          >
            <Square className="w-4 h-4" />
          </Button>
        ) : (
          <Button
            size="icon"
            onClick={handleSendClick}
            disabled={!canSend}
            title={t("chat.send", "Send")}
            aria-label={t("chat.sendLabel", "Send message")}
            className={cn(
              "shrink-0 size-9 send-press",
              pulse && "send-glow",
              isHackerTheme && pulse && "send-glitch"
            )}
          >
            <Send className="w-4 h-4" />
          </Button>
        )}
      </div>

      <div className="hidden lg:block">
        <KbdHint visible={hintVisible}>
          {t("chat.input.shortcuts", "⏎ Send · ⇧⏎ New line · ↑↓ History · ⌘K Models")}
        </KbdHint>
      </div>
      <p id="chat-input-hint" className="sr-only">
        {t("chat.input.hint", "Press Enter to send, Shift+Enter for a new line")}
      </p>
    </div>
  );
}

