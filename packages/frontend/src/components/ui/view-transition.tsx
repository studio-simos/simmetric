// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useCallback, useEffect, useRef, type CSSProperties, type ReactNode } from "react";

/**
 * Lightweight wrapper around the browser-native CSS View Transitions API
 * (`document.startViewTransition`).
 *
 * React 19.2 forward-declares `<ViewTransition>` in `@types/react/canary`,
 * but the runtime export is not yet shipped in `react@19.2.6`. This
 * component provides equivalent UX using the browser-native API which is
 * supported in Chrome 111+ / Edge 111+ (graceful no-op elsewhere).
 *
 * Usage:
 *   <ViewTransition name="settings-tab">
 *     <ActiveTab key={activeTab} />
 *   </ViewTransition>
 *
 * The `name` prop maps to CSS `view-transition-name`, allowing a crossfade
 * between same-named elements when they swap. To make the animation
 * visible, add CSS such as:
 *
 *   ::view-transition-old(root), ::view-transition-new(root) {
 *     animation-duration: 200ms;
 *   }
 */
export interface ViewTransitionProps {
  children: ReactNode;
  /** CSS view-transition-name. Optional. */
  name?: string;
  /** Optional className applied to the wrapper. */
  className?: string;
}

function supportsViewTransition(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof (document as Document & {
      startViewTransition?: unknown;
    }).startViewTransition === "function"
  );
}

export function ViewTransition({ children, name, className }: ViewTransitionProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Set the view-transition-name via inline style so it is matched in CSS
  // without requiring a separate stylesheet.
  const style: CSSProperties | undefined = name
    ? { viewTransitionName: name }
    : undefined;

  return (
    <div ref={wrapperRef} className={className} style={style}>
      {children}
    </div>
  );
}

/**
 * Hook variant: returns an updater that wraps a state change in
 * `document.startViewTransition` when supported by the browser.
 *
 *   const [tab, setTab] = useState("a");
 *   const transitionTo = useViewTransition();
 *   transitionTo(() => setTab("b"));
 *
 * On browsers without view-transition support, the updater runs
 * synchronously (graceful no-op).
 */
export function useViewTransition() {
  const isSupportedRef = useRef(supportsViewTransition());

  // Re-evaluate on mount in case document became available
  useEffect(() => {
    isSupportedRef.current = supportsViewTransition();
  }, []);

  return useCallback((updater: () => void) => {
    if (!isSupportedRef.current) {
      updater();
      return;
    }
    const start = (
      document as Document & {
        startViewTransition?: (cb: () => void) => unknown;
      }
    ).startViewTransition;
    if (typeof start !== "function") {
      updater();
      return;
    }
    // The browser throws `AbortError: Transition was skipped` when a
    // newer transition supersedes an in-flight one (e.g. react-router's
    // setSearchParams starts a second transition while ours is still
    // pending). The state update has already been enqueued, so the
    // skipped transition is purely cosmetic — swallow the abort so it
    // doesn't pollute the console.
    try {
      start.call(document, updater);
    } catch {
      // Intentionally ignored: view transition cancellation is non-fatal.
    }
  }, []);
}

/**
 * Re-export a feature-flag for code that wants to introspect support
 * synchronously.
 */
export function isViewTransitionSupported(): boolean {
  return supportsViewTransition();
}
