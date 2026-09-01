// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../queries/keys";

export interface ModelAvailabilityState {
  isPolling: boolean;
  lastChecked: Date | null;
  isStale: boolean;
}

export function useModelAvailability(active: boolean): ModelAvailabilityState {
  const queryClient = useQueryClient();
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastCheckedRef = useRef<Date | null>(null);

  const poll = async () => {
    try {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.providers.available,
      });
      const now = new Date();
      lastCheckedRef.current = now;
      setLastChecked(now);
    } catch {
      // Silently fail -- polling is best-effort
    }
  };

  // Main polling effect
  useEffect(() => {
    if (!active) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Initial fetch
    poll();

    // Start interval
    intervalRef.current = setInterval(poll, 30000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [active]);

  // Visibility pause/resume effect
  useEffect(() => {
    function handleVisibility() {
      if (document.hidden) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } else if (active) {
        poll(); // immediate refresh on return
        intervalRef.current = setInterval(poll, 30000);
      }
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [active]);

  const isStale = lastChecked
    ? Date.now() - lastChecked.getTime() > 60000
    : true;

  return {
    isPolling: active && intervalRef.current !== null,
    lastChecked,
    isStale,
  };
}
