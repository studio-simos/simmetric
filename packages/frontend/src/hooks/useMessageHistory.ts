// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useCallback, useRef } from "react";

/**
 * useMessageHistory — terminal-style input history for the chat composer.
 *
 * Global + persistent: a single history across all chats, stored in
 * localStorage under `chat:history` (capped to MAX entries). Survives reloads.
 *
 * Navigation model (bash-like):
 * - `navigate("up", current)`   → recalls the previous (older) entry.
 * - `navigate("down", current)` → moves forward to the next (newer) entry,
 *   and finally back to the live draft.
 * - The live draft (the un-sent text present when the user first presses Up)
 *   is preserved in `draftRef` and restored when navigating back down past the
 *   newest entry.
 *
 * The hook is ref-based and returns stable callbacks; it does not trigger
 * re-renders. The owning component controls the textarea value, so the caller
 * is responsible for `setInput(next)` and cursor placement on `navigate`.
 *
 * `push(msg)` is called by the composer when a message is actually sent;
 * consecutive duplicates are collapsed (matching shell behavior).
 */
const STORAGE_KEY = "chat:history";
const MAX_HISTORY = 100;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === "string")
      .slice(-MAX_HISTORY);
  } catch {
    return [];
  }
}

function persist(h: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(h));
  } catch {
    // Storage unavailable (private mode / quota) — history stays in-memory only.
  }
}

export interface MessageHistoryApi {
  /** Record a sent message (consecutive dups collapsed). Resets nav to live. */
  push: (msg: string) => void;
  /** Reset navigation back to the live draft (e.g. on send or blur). */
  reset: () => void;
  /** Navigate the history. Returns the string to display, or null if the
   *  navigation is a no-op (already at the boundary) so the caller can let
   *  the default cursor movement proceed. */
  navigate: (dir: "up" | "down", currentInput: string) => string | null;
}

export function useMessageHistory(): MessageHistoryApi {
  const historyRef = useRef<string[]>(loadHistory());
  // indexRef: -1 = live draft position (not in history); 0 = oldest; len-1 = newest.
  const indexRef = useRef(-1);
  // Un-sent text the user had typed before entering history; restored on the way down.
  const draftRef = useRef<string>("");

  const push = useCallback((msg: string) => {
    const trimmed = msg.trim();
    if (!trimmed) return;
    const h = historyRef.current;
    if (h[h.length - 1] !== trimmed) {
      h.push(trimmed);
      if (h.length > MAX_HISTORY) h.shift();
      persist(h);
    }
    indexRef.current = -1;
    draftRef.current = "";
  }, []);

  const reset = useCallback(() => {
    indexRef.current = -1;
    draftRef.current = "";
  }, []);

  const navigate = useCallback(
    (dir: "up" | "down", currentInput: string): string | null => {
      const h = historyRef.current;
      if (h.length === 0) return null;

      if (dir === "up") {
        if (indexRef.current === -1) {
          // Entering history from the live draft: stash the current text.
          draftRef.current = currentInput;
          indexRef.current = h.length - 1;
        } else if (indexRef.current > 0) {
          indexRef.current -= 1;
        } else {
          return null; // already at the oldest entry
        }
        return h[indexRef.current] ?? null;
      }

      // dir === "down"
      if (indexRef.current === -1) return null; // already at the live draft
      if (indexRef.current < h.length - 1) {
        indexRef.current += 1;
        return h[indexRef.current] ?? null;
      }
      // Past the newest entry → restore the live draft.
      indexRef.current = -1;
      return draftRef.current;
    },
    [],
  );

  return { push, reset, navigate };
}