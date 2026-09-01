// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { fetchEventSource } from "@microsoft/fetch-event-source";
import { queryClient } from "../queries/queryClient";
import { queryKeys } from "../queries/keys";

export async function pullModel(
  providerId: string,
  modelName: string,
  onProgress: (data: { status: string; digest?: string; total?: number; completed?: number }) => void
): Promise<void> {
  const token = localStorage.getItem("token");
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let pullError: string | null = null;
  const IDLE_TIMEOUT = 60000;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      controller.abort();
    }, IDLE_TIMEOUT);
  };

  try {
    await fetchEventSource(`/api/providers/${providerId}/models/pull`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ modelName }),
      signal: controller.signal,

      onopen: async (response) => {
        resetIdleTimer();
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          pullError = (body as { error?: string }).error || `HTTP ${response.status}`;
          controller.abort();
        }
      },

      onmessage(event) {
        resetIdleTimer();
        switch (event.event) {
          case "progress": {
            try {
              const data = JSON.parse(event.data);
              onProgress(data);
            } catch { /* skip */ }
            break;
          }
          case "error": {
            const err = JSON.parse(event.data);
            pullError = err.error || "Model pull failed";
            controller.abort();
            break;
          }
          case "done":
            break;
        }
      },

      onerror() {
        return null;
      },
    });

    if (pullError) {
      throw new Error(pullError);
    }
  } catch (err: unknown) {
    if (pullError) {
      throw new Error(pullError, { cause: err });
    }
    throw err;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    controller.abort();
  }

  queryClient.invalidateQueries({ queryKey: queryKeys.providers.all });
  queryClient.invalidateQueries({ queryKey: queryKeys.providers.available });
}

// Phase 180 dead-code sweep: fetchEmbeddingModels() was REMOVED — zero
// callers (the ingestion UI filters embedding models inline via
// useProviders + ProviderWithModels; AGENTS.md's mention predates the
// Phase-88 facade restructure).
