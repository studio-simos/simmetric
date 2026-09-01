// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TanStack Query hooks for archive operations.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut, apiDelete } from "./api";
import { queryKeys } from "./keys";
import { showError } from "../lib/toast";
import type { ArchiveConfigInput } from "@simmetric-chat/shared";

export interface Archive {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  createdBy: string;
  creator?: { id: string; username: string };
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  autoIndex?: boolean;
  /**
   * Filtered page count from Prisma (getArchives only).
   * Reflects non-deleted ArchivePage rows (deletedAt: null).
   * Optional: absent on legacy responses or detail endpoints.
   */
  _count?: { pages: number };
}

export interface ArchivePage {
  id: string;
  archiveId: string;
  slug: string;
  title: string;
  category: string;
  frontmatter: Record<string, unknown> | null;
  bodyText: string;
  contentHash: string;
  vectorContentHash?: string | null;
  wikilinks: string[];
  /**
   * Computed (read-only) number of OTHER pages in the archive on the same
   * topic (token-overlap Jaccard ≥ 0.10). Added by getPages server-side
   * (quick 260723-ke9). Optional: absent if the related-count computation
   * failed or the endpoint predates the field — render as 0.
   */
  relatedCount?: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

export function useArchives(enabled = true) {
  return useQuery<Archive[], Error>({
    queryKey: queryKeys.archive.list,
    queryFn: () => apiGet<Archive[]>("/archives"),
    enabled,
    staleTime: 30_000,
  });
}

export function useArchive(id: string | undefined) {
  return useQuery<Archive, Error>({
    queryKey: queryKeys.archive.detail(id ?? ""),
    queryFn: () => apiGet<Archive>(`/archives/${id}`),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useArchivePages(archiveId: string | undefined, category?: string) {
  return useQuery<ArchivePage[], Error>({
    queryKey: [...queryKeys.archive.pages(archiveId ?? ""), category ?? "all"],
    queryFn: () => {
      const query = category ? `?category=${encodeURIComponent(category)}` : "";
      return apiGet<ArchivePage[]>(`/archives/${archiveId}/pages${query}`);
    },
    enabled: !!archiveId,
    staleTime: 30_000,
  });
}

export function useArchivePage(archiveId: string | undefined, slug: string | undefined) {
  return useQuery<ArchivePage, Error>({
    queryKey: queryKeys.archive.page(archiveId ?? "", slug ?? ""),
    queryFn: () => apiGet<ArchivePage>(`/archives/${archiveId}/pages/${slug}`),
    enabled: !!archiveId && !!slug,
    staleTime: 30_000,
  });
}

export function useArchiveConfig(archiveId: string | undefined) {
  return useQuery<ArchiveConfigInput, Error>({
    queryKey: queryKeys.archive.config(archiveId ?? ""),
    queryFn: () => apiGet<ArchiveConfigInput>(`/archives/${archiveId}/config`),
    enabled: !!archiveId,
    staleTime: 30_000,
  });
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

export function useCreateArchive() {
  const queryClient = useQueryClient();

  return useMutation<Archive, Error, { name: string; description?: string }>({
    mutationFn: ({ name, description }) =>
      apiPost<Archive>("/archives", { name, description }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.archive.list });
    },
  });
}

export function useUpdateArchive() {
  const queryClient = useQueryClient();

  return useMutation<
    Archive,
    Error,
    { id: string; data: { name?: string; description?: string | null } }
  >({
    mutationFn: ({ id, data }) => apiPut<Archive>(`/archives/${id}`, data),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.archive.list });
      queryClient.invalidateQueries({ queryKey: queryKeys.archive.detail(id) });
    },
  });
}

export function useDeleteArchive() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (id) => apiDelete(`/archives/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.archive.list });
    },
  });
}

export function useCreatePage() {
  const queryClient = useQueryClient();

  return useMutation<
    ArchivePage,
    Error,
    { archiveId: string; title: string; content: string; category: string }
  >({
    mutationFn: ({ archiveId, title, content, category }) =>
      apiPost<ArchivePage>(`/archives/${archiveId}/pages`, { title, content, category }),
    onSuccess: (_, { archiveId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.archive.pages(archiveId) });
    },
  });
}

export function useUpdatePage() {
  const queryClient = useQueryClient();

  return useMutation<
    ArchivePage & { warnings?: string[] },
    Error,
    {
      archiveId: string;
      slug: string;
      data: { title?: string; content?: string; category?: string; body?: string };
    }
  >({
    mutationFn: ({ archiveId, slug, data }) =>
      apiPut<ArchivePage & { warnings?: string[] }>(
        `/archives/${archiveId}/pages/${slug}`,
        data,
      ),
    onSuccess: (_, { archiveId, slug }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.archive.pages(archiveId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.archive.page(archiveId, slug) });
    },
  });
}

export function useDeletePage() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, { archiveId: string; slug: string }>({
    mutationFn: ({ archiveId, slug }) => apiDelete(`/archives/${archiveId}/pages/${slug}`),
    onSuccess: (_, { archiveId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.archive.pages(archiveId) });
    },
  });
}

export function useExportArchive() {
  return useMutation<void, Error, { archiveId: string; format: "zip" | "pdf" }>({
    mutationFn: async ({ archiveId, format }) => {
      const token = localStorage.getItem("token");
      const response = await fetch(`/api/archives/${archiveId}/export?format=${format}`, {
        headers: { Authorization: `Bearer ${token || ""}` },
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: "Export failed" }));
        throw new Error(err.error || "Export failed");
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `archive-${archiveId}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    },
    onError: (err) => {
      showError(err.message || "Export failed");
    },
  });
}

export function useUpdateArchiveConfig() {
  const queryClient = useQueryClient();

  return useMutation<
    void,
    Error,
    { archiveId: string; config: Partial<ArchiveConfigInput> }
  >({
    mutationFn: ({ archiveId, config }) => apiPut(`/archives/${archiveId}/config`, config),
    onSuccess: (_, { archiveId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.archive.config(archiveId) });
    },
  });
}

export function useTriggerIndexing() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (archiveId) => apiPost(`/archives/${archiveId}/index`, {}),
    onSuccess: (_, archiveId) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.archive.pages(archiveId) });
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Phase 180 dead-code sweep                                          */
/* ------------------------------------------------------------------ */
// The KB-05/KB-06 copy-doc-to-archive client pipeline was REMOVED — zero
// callers: useCopyDocToArchive() + CopyDocToArchiveVars +
// ArchiveImportJobStatus + pollArchiveImportJob() + the POLL_* constants
// (the server endpoint /archives/:id/copy-from-doc stays; nothing in the
// community frontend invokes it).

