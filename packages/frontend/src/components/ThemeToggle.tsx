// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { type ReactElement } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { Button } from "@/components/ui/button";

import { cn } from "@/lib/utils"
import type { Theme } from "../contexts/ThemeContext";

const themes: Theme[] = ["light", "dark", "hacker", "system"];

const themeIcons: Record<Theme, ReactElement> = {
  light: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  ),
  dark: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
    </svg>
  ),
  hacker: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 18h16M8 10l-3 2 3 2M12 14h4" />
    </svg>
  ),
  system: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  ),
};

const themeLabels: Record<Theme, string> = {
  light: "Pearl",
  dark: "Dark",
  hacker: "Hacker",
  system: "System",
};

export default function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  const cycle = () => {
    const currentIndex = themes.indexOf(theme);
    const next = themes[(currentIndex + 1) % themes.length] ?? "light";
    setTheme(next);
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={cycle}
      className={cn("rounded-lg", className)}
      title={`Theme: ${themeLabels[theme]}`}
      aria-label={`Switch theme, current: ${themeLabels[theme]}`}
    >
      {themeIcons[theme]}
    </Button>
  );
}

export { themeLabels };
// Phase 180 dead-code sweep: `themes` unexported — zero external consumers
// (ThemeContext exports ALL_THEMES as the canonical list).