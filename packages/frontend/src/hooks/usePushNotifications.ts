// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * usePushNotifications — hook for subscribing to web push notifications.
 *
 * Flow:
 * 1. Register the service worker (done in main.tsx)
 * 2. Request notification permission from the user
 * 3. Subscribe via the browser PushManager with the server's VAPID public key
 * 4. POST the subscription to /api/system/push/subscribe
 *
 * The hook is opt-in: the user must click a "Enable notifications" button
 * to trigger the permission prompt. We never auto-prompt on page load
 * (bad UX, browsers block repeated permission prompts).
 */
import { useState, useCallback } from "react";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function usePushNotifications() {
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "denied",
  );
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);

  const subscribe = useCallback(async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      return { ok: false, error: "Push notifications not supported in this browser" };
    }

    setLoading(true);
    try {
      // 1. Request permission
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") {
        return { ok: false, error: "Notification permission denied" };
      }

      // 2. Get VAPID public key from server
      const token = localStorage.getItem("token");
      const keyRes = await fetch("/api/system/push/vapid-key", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!keyRes.ok) {
        return { ok: false, error: "Failed to get VAPID key from server" };
      }
      const { publicKey } = await keyRes.json();
      if (!publicKey) {
        return { ok: false, error: "Server returned empty VAPID key" };
      }

      // 3. Subscribe via PushManager
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });

      // 4. Send subscription to server
      const subRes = await fetch("/api/system/push/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(subscription),
      });

      if (!subRes.ok) {
        return { ok: false, error: "Failed to register subscription with server" };
      }

      setSubscribed(true);
      return { ok: true, error: null };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    } finally {
      setLoading(false);
    }
  }, []);

  const unsubscribe = useCallback(async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await sub.unsubscribe();
        const token = localStorage.getItem("token");
        await fetch("/api/system/push/subscribe", {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
      }
      setSubscribed(false);
    } catch {
      // best-effort
    }
  }, []);

  return { permission, subscribed, loading, subscribe, unsubscribe };
}