// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for widget operations.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut, apiDelete } from "./api";
import { queryKeys } from "./keys";
import type { Widget, WidgetLead, DailyWidgetAnalytics, TopicDistribution } from "@simmetric-chat/shared";

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

export function useWidgets() {
  return useQuery<Widget[], Error>({
    queryKey: queryKeys.widgets.list,
    queryFn: () => apiGet<Widget[]>("/widgets"),
    staleTime: 30_000,
  });
}

export function useWidgetLeads(widgetId: string | undefined, page = 1, limit = 20) {
  return useQuery<{ leads: WidgetLead[]; total: number; page: number; limit: number }, Error>({
    queryKey: [...queryKeys.widgets.leads(widgetId ?? ""), page, limit],
    queryFn: () =>
      apiGet<{ leads: WidgetLead[]; total: number; page: number; limit: number }>(
        `/widgets/${widgetId}/leads?page=${page}&limit=${limit}`
      ),
    enabled: !!widgetId,
    staleTime: 30_000,
  });
}

export function useWidgetLead(widgetId: string | undefined, leadId: string | undefined) {
  return useQuery<WidgetLead, Error>({
    queryKey: queryKeys.widgets.lead(widgetId ?? "", leadId ?? ""),
    queryFn: () => apiGet<WidgetLead>(`/widgets/${widgetId}/leads/${leadId}`),
    enabled: !!widgetId && !!leadId,
    staleTime: 30_000,
  });
}

export function useWidgetAnalyticsDaily(days: number, widgetId?: string) {
  return useQuery<DailyWidgetAnalytics[], Error>({
    queryKey: [...queryKeys.widgets.analytics(widgetId ?? "global"), "daily", days],
    queryFn: () => {
      const params = new URLSearchParams({ days: String(days) });
      if (widgetId) params.set("widgetId", widgetId);
      return apiGet<DailyWidgetAnalytics[]>(`/widgets/analytics/daily?${params.toString()}`);
    },
    staleTime: 30_000,
  });
}

export function useWidgetTopics(days: number, widgetId?: string) {
  return useQuery<TopicDistribution[], Error>({
    queryKey: [...queryKeys.widgets.analytics(widgetId ?? "global"), "topics", days],
    queryFn: () => {
      const params = new URLSearchParams({ days: String(days) });
      if (widgetId) params.set("widgetId", widgetId);
      return apiGet<TopicDistribution[]>(`/widgets/analytics/topics?${params.toString()}`);
    },
    staleTime: 30_000,
  });
}

export function useWidgetSummary(days: number, widgetId?: string) {
  return useQuery<{ totalConversations: number; unansweredRate: number; qualityRate: number }, Error>({
    queryKey: [...queryKeys.widgets.analytics(widgetId ?? "global"), "summary", days],
    queryFn: () => {
      const params = new URLSearchParams({ days: String(days) });
      if (widgetId) params.set("widgetId", widgetId);
      return apiGet<{ totalConversations: number; unansweredRate: number; qualityRate: number }>(`/widgets/analytics/summary?${params.toString()}`);
    },
    staleTime: 30_000,
  });
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

export function useCreateWidget() {
  const queryClient = useQueryClient();

  return useMutation<Widget, Error, Record<string, unknown>, { snapshot: Widget[] }>({
    mutationFn: (data) => apiPost<Widget>("/widgets", data),
    // Optimistically insert a temp widget so the widget list updates
    // immediately. (Feature 7.3 Slice B — quick task 260714-n3q)
    onMutate: async (data) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.widgets.list });
      const snapshot = queryClient.getQueryData<Widget[]>(queryKeys.widgets.list) ?? [];
      const optimistic: Widget = {
        id: `temp-${Date.now()}`,
        name: (data.name as string) ?? "New widget",
        // Minimal required fields — server response replaces this on onSuccess.
      } as Widget;
      queryClient.setQueryData<Widget[]>(queryKeys.widgets.list, [...snapshot, optimistic]);
      return { snapshot };
    },
    onError: (_err, _data, context) => {
      if (context) {
        queryClient.setQueryData<Widget[]>(queryKeys.widgets.list, context.snapshot);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.widgets.list });
    },
  });
}

export function useUpdateWidget() {
  const queryClient = useQueryClient();

  return useMutation<Widget, Error, { id: string; data: Record<string, unknown> }>({
    mutationFn: ({ id, data }) => apiPut<Widget>(`/widgets/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.widgets.list });
    },
  });
}

export function useDeleteWidget() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (id) => apiDelete(`/widgets/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.widgets.list });
    },
  });
}

export function useUpdateWidgetWorkspaces() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, { widgetId: string; workspaceIds: string[] }>({
    mutationFn: ({ widgetId, workspaceIds }) =>
      apiPut(`/widgets/${widgetId}/workspaces`, { workspaceIds }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.widgets.list });
    },
  });
}

export function useExportLeadsCsv() {
  return useMutation<void, Error, { widgetId: string; from?: string; to?: string; columns?: string }>({
    mutationFn: async ({ widgetId, from, to, columns }) => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (columns) params.set("columns", columns);
      const url = `/widgets/${widgetId}/leads/export${params.toString() ? "?" + params.toString() : ""}`;
      const token = localStorage.getItem("token");
      const response = await fetch(url.startsWith("/") ? `/api${url}` : url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = `leads-${widgetId}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(downloadUrl);
    },
  });
}
