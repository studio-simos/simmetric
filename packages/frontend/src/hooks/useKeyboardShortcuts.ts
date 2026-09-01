// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useEffect, useEffectEvent } from "react";

export function useKeyboardShortcuts(options: {
  onOpenPalette: () => void;
  onOpenComparison: () => void;
}) {
  const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.repeat || e.altKey) return;

    // Palette shortcut: Cmd+K (Mac) / Ctrl+K (Win/Linux)
    if (e.key === "k" && !e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      options.onOpenPalette();
    }

    // Comparison shortcut: Cmd+Shift+M (Mac) / Ctrl+Shift+M (Win/Linux)
    if (e.key === "m" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      options.onOpenComparison();
    }
  });

  useEffect(() => {
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
