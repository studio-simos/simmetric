// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useCallback, useEffect } from "preact/hooks";
import { useWidgetConfig, shouldRenderFab } from "./hooks/useWidgetConfig";
import { useWidgetChat } from "./hooks/useWidgetChat";
import { useTriggers } from "./hooks/useTriggers";
import { notifyOpenState, notifyWidgetConfig } from "../utils/widgetStateBridge";
import ChatFab from "./components/ChatFab";
import ChatPanel from "./components/ChatPanel";

export default function App() {
  const config = useWidgetConfig();
  const [isOpen, setIsOpen] = useState(false);
  // 131-07 (G-131-19): the resolved visitor locale (config.locale) threads
  // into the stream POST body via the hook's locale param — the proxy forwards
  // it upstream so the server can localize the no-results sentence.
  const chat = useWidgetChat(config.widgetId, config.locale);

  // 260808-wtz: propagate open/close to the host page so the loader toggles the
  // container's pointer-events. Every path (ChatFab toggle, auto-open triggers,
  // ChatPanel onClose) funnels through setIsOpen, so this single effect covers
  // all of them. The initial mount render posts simmetric:widgetClose (isOpen=false),
  // idempotent with the snippet's inline pointer-events: none default.
  useEffect(() => {
    notifyOpenState(isOpen);
  }, [isOpen]);

  // 260809-i6b: on real embeds the host page owns the open/close FAB (created
  // by LOADER_JS, painted with the GLOBAL branding color baked into the embed
  // snippet). The iframe knows the widget's effective per-widget primaryColor
  // (route-resolved into the JSON block) — post it to the host once on mount
  // so the loader repaints the FAB. hostFab gate: the admin preview pane has
  // no host FAB to color (its iframe ChatFab already renders the correct
  // color), so posting there is noise. Config is stable (useMemo []), so the
  // effect runs once per mount — exactly the one-time emission needed; the
  // loader's listener is always registered before this iframe mounts (loader
  // script runs synchronously), so no message is lost.
  useEffect(() => {
    if (config.hostFab) notifyWidgetConfig(config.primaryColor);
  }, [config.hostFab, config.primaryColor]);

  // G-128-2 + 260809-ipv: the host FAB (created by LOADER_JS on the host page)
  // posts simmetric:widgetOpen / simmetric:widgetClose to this iframe when clicked —
  // open the panel on open, close it on close. Only the parent window may send
  // these (same sender validation as the storage handshake in useWidgetChat.ts
  // — the sandboxed iframe has an opaque origin, so the sender window is the
  // checkable identity). Closing funnels through setIsOpen(false), so the
  // isOpen effect above posts simmetric:widgetClose back to the parent — the
  // loader relay's close branch resets the FAB there; this round-trip is
  // idempotent with the FAB's own direct close (both end in the same state).
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const msg = event.data as { type?: string } | null;
      if (!msg || !msg.type) return;
      if (msg.type === "simmetric:widgetOpen") {
        setIsOpen(true);
      } else if (msg.type === "simmetric:widgetClose") {
        setIsOpen(false);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Auto-open callback for display triggers (CUST-03)
  const handleTrigger = useCallback(() => {
    setIsOpen(true);
  }, []);

  useTriggers(
    {
      autoOpenDelay: config.autoOpenDelay,
      autoOpenUrlPatterns: config.autoOpenUrlPatterns,
      exitIntentEnabled: config.exitIntentEnabled,
      exitIntentCooldownMs: config.exitIntentCooldownMs,
    },
    handleTrigger
  );

  // G-128-2: the iframe renders its own ChatFab only when the host page does
  // NOT own the FAB (hostFab false — preview pane). Real embeds via LOADER_JS
  // append &hostFab=1 → the host FAB is created host-side and this one is hidden
  // (exactly one FAB on real embeds).
  const renderFab = shouldRenderFab(config.hostFab);

  return (
    <>
      {renderFab && (
        <ChatFab
          isOpen={isOpen}
          position={config.position}
          logoUrl={config.logoUrl}
          onClick={() => setIsOpen(!isOpen)}
        />
      )}
      {isOpen && (
        <ChatPanel
          config={config}
          chat={chat}
          onClose={() => setIsOpen(false)}
        />
      )}
    </>
  );
}