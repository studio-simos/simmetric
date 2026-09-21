// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Boot-offline banner state (critique 2026-09-21 #2, item on App.tsx).
 *
 * While the App `initializing` skeleton is up, the boot queries
 * (/auth/me, /system/is-initialized, /workspaces, …) normally settle in
 * well under a second. Two grace layers precede this banner:
 *
 *   1. the Vite dev-proxy ECONNREFUSED retry hook (~4s, GET/HEAD only) —
 *      kept intact; it covers the backend's slower `tsx watch` boot;
 *   2. TanStack Query's own retry (1 retry, network errors included).
 *
 * Past the timeout the backend is genuinely unreachable, so the skeleton
 * stops being silent: `bootOffline` flips and the banner names the problem
 * and the recovery. `retry()` invalidates ALL queries so TanStack Query
 * refires the boot probes from scratch, hides the banner, and re-arms the
 * timer for a fresh window (bootCycle bumps the effect deps — a retry click
 * while still initializing would otherwise not restart the countdown).
 */
import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

/** The dev-proxy retry window is ~4s; double it before declaring the backend unreachable. */
export const BOOT_OFFLINE_TIMEOUT_MS = 8_000;

export function useBootOffline(initializing: boolean) {
  const [bootOffline, setBootOffline] = useState(false);
  const [bootCycle, setBootCycle] = useState(0);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!initializing) {
      setBootOffline(false);
      return;
    }
    const timer = window.setTimeout(() => setBootOffline(true), BOOT_OFFLINE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [initializing, bootCycle]);

  const retry = useCallback(() => {
    void queryClient.invalidateQueries();
    setBootOffline(false);
    setBootCycle((c) => c + 1);
  }, [queryClient]);

  return { bootOffline, retry };
}