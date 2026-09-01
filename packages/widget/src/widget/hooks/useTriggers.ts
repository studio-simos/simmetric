// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useEffect, useRef } from "preact/hooks";
import { matchUrlPattern } from "../../utils/matchUrlPattern";

export interface TriggerConfig {
  autoOpenDelay: number | null;
  autoOpenUrlPatterns: string | null;
  exitIntentEnabled: boolean;
  exitIntentCooldownMs: number;
}

export function useTriggers(config: TriggerConfig, onTrigger: () => void) {
  const triggeredRef = useRef(false);
  const cooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // URL pattern trigger -- listens for simmetric:urlChange postMessage from parent page.
  // triggeredRef is a one-shot trigger guard: once triggered, never re-trigger.
  // Preact ref-mirror pattern — react-compiler's purity rule is stricter than
  // Preact's actual ref semantics here.
  /* eslint-disable react-compiler/react-compiler */
  useEffect(() => {
    const patterns = config.autoOpenUrlPatterns;
    if (!patterns || patterns.trim() === "") return;

    const handler = (event: MessageEvent) => {
      if (triggeredRef.current) return;
      if (event.data?.type !== "simmetric:urlChange") return;

      const pathname = event.data.pathname;
      if (!pathname) return;

      if (matchUrlPattern(patterns, pathname)) {
        triggeredRef.current = true;
        onTrigger();
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [config.autoOpenUrlPatterns, onTrigger]);
  /* eslint-enable react-compiler/react-compiler */

  // Time-on-page trigger -- auto-open after configurable seconds
  useEffect(() => {
    if (config.autoOpenDelay === null || config.autoOpenDelay <= 0) return;
    if (triggeredRef.current) return;

    const timer = setTimeout(() => {
      if (!triggeredRef.current) {
        triggeredRef.current = true;
        onTrigger();
      }
    }, config.autoOpenDelay * 1000);

    return () => clearTimeout(timer);
  }, [config.autoOpenDelay, onTrigger]);

  // Exit intent trigger -- listens for simmetric:exitIntent postMessage from parent page
  useEffect(() => {
    if (!config.exitIntentEnabled) return;

    const handler = (event: MessageEvent) => {
      if (event.data?.type !== "simmetric:exitIntent") return;

      if (triggeredRef.current) {
        if (cooldownRef.current) return; // Still in cooldown
        return;
      }

      triggeredRef.current = true;
      onTrigger();

      // Re-enable after cooldown (per D-04: fires once, then cooldown resets)
      if (cooldownRef.current) clearTimeout(cooldownRef.current);
      cooldownRef.current = setTimeout(() => {
        triggeredRef.current = false;
      }, config.exitIntentCooldownMs);
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [config.exitIntentEnabled, config.exitIntentCooldownMs, onTrigger]);
}