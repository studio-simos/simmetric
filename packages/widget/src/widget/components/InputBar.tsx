// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useCallback, useRef, useEffect } from "preact/hooks";
import { t } from "../i18n";

interface InputBarProps {
  onSend: (message: string) => void;
  onAbort: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  onFocus?: () => void;
  /** CONTENT string (D-03): the admin-editable placeholder from the JSON block. */
  placeholder?: string;
}

export default function InputBar({ onSend, onAbort, isStreaming, disabled, onFocus, placeholder }: InputBarProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-expand textarea to fit content (up to 4 rows / ~120px). Direct DOM
  // style mutation — Preact does not reactively track element.style, so
  // imperatively setting height is the standard auto-expand pattern.
  // react-compiler flags this as "mutating a value returned from a function"
  // (the ref's .current DOM node), but the mutation is local to this effect
  // and the node is not React-managed state.
  /* eslint-disable react-compiler/react-compiler */
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
    }
  }, [value]);
  /* eslint-enable react-compiler/react-compiler */

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isStreaming || disabled) return;
    onSend(trimmed);
    setValue("");
    // Reset height after clearing
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, isStreaming, disabled, onSend]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  const canSend = value.trim().length > 0 && !isStreaming && !disabled;

  return (
    <div className="border-t border-[#e5e7eb] px-4 py-3 bg-white shrink-0 min-h-[52px]">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onInput={(e) => setValue((e.target as HTMLTextAreaElement).value)}
          onKeyDown={handleKeyDown}
          onFocus={onFocus}
          placeholder={placeholder || t("input.placeholderFallback")}
          disabled={isStreaming}
          maxLength={4000}
          rows={1}
          className="flex-1 resize-none border border-[#d1d5db] rounded-lg px-3 py-2 text-sm leading-normal min-h-[44px] focus:outline-none focus:border-[var(--widget-primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--widget-primary)_20%,transparent)] disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ maxHeight: "120px" }}
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={onAbort}
            aria-label={t("input.stopLabel")}
            className="w-11 h-11 rounded-lg flex items-center justify-center bg-[#dc2626] text-white shrink-0 border-none cursor-pointer hover:opacity-90"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="white" xmlns="http://www.w3.org/2000/svg">
              <rect x="2" y="2" width="10" height="10" rx="1" />
            </svg>
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            aria-label={t("input.sendLabel")}
            disabled={!canSend}
            className="w-11 h-11 rounded-lg flex items-center justify-center shrink-0 text-white border-none disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer hover:opacity-90"
            style={{ backgroundColor: "var(--widget-primary)" }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M8 2v12M4 6l4-4 4 4" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}