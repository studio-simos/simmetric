// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { FileText, Search, Trash2, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import type { ArchivePage } from "../queries/useArchives";
import { useUpdatePage, useDeletePage } from "../queries/useArchives";
import { showSuccess, showError } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";

interface Props {
  className?: string;
  archiveId: string;
  pages: ArchivePage[];
  onPageClick: (slug: string) => void;
  onDeletePage?: (slug: string) => void;
  selectedSlug?: string;
  selectedCategory: string;
  onCategoryChange: (category: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

export default function ArchiveSidebar({
  className,
  archiveId,
  pages,
  onPageClick,
  // onDeletePage prop kept in interface for API stability but per-row delete
  // is removed — deletion is now bulk-only via the toolbar.
  selectedSlug,
  selectedCategory,
  onCategoryChange,
  searchQuery,
  onSearchChange,
}: Props) {
  const { t } = useTranslation();
  const updatePageMutation = useUpdatePage();
  const deletePageMutation = useDeletePage();

  // Inline rename state (mirrors ChatSidebar.tsx:105-106, 198-208, 320-336)
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");

  // Bulk selection state
  const [selectedPages, setSelectedPages] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const handleRename = async (slug: string) => {
    const title = renameInput.trim();
    if (!title) { setRenamingId(null); return; } // D-02: empty rejected
    try {
      await updatePageMutation.mutateAsync({ archiveId, slug, data: { title } });
      showSuccess(t("archives.page.renamed"));
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("archives.page.renameFailed")));
    } finally {
      setRenamingId(null);
    }
  };

  const categories = ["all", "entities", "concepts", "decisions"];

  // Debounced search (300ms)
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => onSearchChange(debouncedQuery), 300);
    return () => clearTimeout(timer);
  }, [debouncedQuery, onSearchChange]);

  // Filter pages client-side by category + search
  const categoryFiltered = selectedCategory === "all"
    ? pages
    : pages.filter((p) => p.category === selectedCategory);

  const filteredPages = useMemo(() => {
    if (!searchQuery) return categoryFiltered;
    const q = searchQuery.toLowerCase();
    return categoryFiltered.filter(
      (p) => p.title.toLowerCase().includes(q) || p.bodyText?.toLowerCase().includes(q)
    );
  }, [categoryFiltered, searchQuery]);

  // Clear stale selection when filtered list changes
  useEffect(() => {
    setSelectedPages((prev) => {
      const validSlugs = new Set(filteredPages.map((p) => p.slug));
      const next = new Set<string>();
      prev.forEach((s) => { if (validSlugs.has(s)) next.add(s); });
      return next.size === prev.size ? prev : next;
    });
  }, [filteredPages]);

  const selectedCount = selectedPages.size;
  const allSelected = filteredPages.length > 0 && selectedPages.size === filteredPages.length;

  function toggleSelect(slug: string) {
    setSelectedPages((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedPages(() => {
      if (allSelected) return new Set();
      return new Set(filteredPages.map((p) => p.slug));
    });
  }

  async function handleBulkDelete() {
    setBulkDeleting(true);
    let ok = 0;
    const failed: string[] = [];
    try {
      for (const slug of selectedPages) {
        try {
          await deletePageMutation.mutateAsync({ archiveId, slug });
          ok++;
        } catch {
          const page = filteredPages.find((p) => p.slug === slug);
          failed.push(page?.title ?? slug);
        }
      }
      if (failed.length === 0) {
        showSuccess(t("archives.bulkDelete.success", { count: ok }));
      } else {
        showError(
          t("archives.bulkDelete.partialError", {
            ok,
            failed: failed.length,
            message: failed.join(", "),
          }),
        );
      }
      setSelectedPages(new Set());
    } finally {
      setBulkDeleting(false);
    }
  }

  return (
    <div className={cn(
      "w-64 flex-shrink-0 flex flex-col border-r border-border min-h-0 overflow-hidden",
      className
    )}>
      {/* Search */}
      <div className="p-4">
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t("archiveDetail.searchPlaceholder")}
            className="pl-8"
            value={debouncedQuery}
            onChange={(e) => setDebouncedQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Category badges */}
      <div className="flex flex-wrap gap-2 px-4 pb-4">
        {categories.map((cat) => (
          <Badge
            key={cat}
            variant={selectedCategory === cat ? "default" : "secondary"}
            className="cursor-pointer capitalize"
            onClick={() => onCategoryChange(cat)}
          >
            {t(`archiveDetail.categories.${cat}`)}
          </Badge>
        ))}
      </div>

      {/* Bulk action toolbar — select-all + delete selected */}
      {filteredPages.length > 0 && (
        <div className="flex items-center gap-2 px-4 pb-2">
          <div className="flex items-center gap-2 mr-auto">
            <Checkbox
              checked={allSelected}
              onCheckedChange={toggleSelectAll}
              aria-label={t("archives.bulkSelect.selectAll")}
            />
            <span className="text-xs font-medium text-muted-foreground">
              {selectedCount > 0
                ? t("archives.bulkSelect.selectedCount", { count: selectedCount })
                : t("archives.bulkSelect.selectAll")}
            </span>
          </div>
          {selectedCount > 0 && (
            <Button
              variant="destructive"
              size="sm"
              className="h-7 text-xs"
              disabled={bulkDeleting}
              onClick={handleBulkDelete}
            >
              <Trash2 className="mr-1 h-3 w-3" />
              {bulkDeleting
                ? t("archives.bulkSelect.deleting")
                : t("archives.bulkSelect.deleteSelected")}
            </Button>
          )}
        </div>
      )}

      {/* Page list */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-4 pb-4">
          {filteredPages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <FileText className="h-10 w-10 text-muted-foreground/50 mb-3" />
              <p className="text-muted-foreground">
                {selectedCategory === "all"
                  ? t("archives.emptyPages")
                  : t("archives.emptyCategory", { category: selectedCategory })}
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {filteredPages.map((page) => (
                <div
                  key={page.slug}
                  className={cn(
                    "flex flex-col gap-1 p-2 rounded-md hover:bg-secondary/30 transition-colors cursor-pointer",
                    selectedSlug === page.slug && "bg-secondary/50"
                  )}
                  onClick={() => onPageClick(page.slug)}
                >
                  {renamingId === page.slug ? (
                    <form
                      onSubmit={(e) => { e.preventDefault(); handleRename(page.slug); }}
                      className="w-full"
                    >
                      <Input
                        type="text"
                        value={renameInput}
                        onChange={(e) => setRenameInput(e.target.value)}
                        className="w-full px-1 py-0.5 h-auto text-sm"
                        autoFocus
                        onBlur={() => handleRename(page.slug)}
                        onKeyDown={(e) => { if (e.key === "Escape") setRenamingId(null); }}
                      />
                    </form>
                  ) : (
                    <div className="flex items-start gap-2">
                      <Checkbox
                        checked={selectedPages.has(page.slug)}
                        onCheckedChange={() => toggleSelect(page.slug)}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-0.5 flex-shrink-0"
                        aria-label={`select ${page.title}`}
                      />
                      <p className="text-sm font-medium text-foreground break-words whitespace-normal flex-1 min-w-0">
                        {page.title}
                      </p>
                    </div>
                  )}
                  {renamingId !== page.slug && (
                    <div className="flex items-center gap-1 pl-6">
                      <p className="text-xs text-muted-foreground mr-1">
                        {t("archives.page.relatedPages", { count: page.relatedCount ?? 0 })}
                      </p>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 text-muted-foreground hover:text-foreground flex-shrink-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenamingId(page.slug);
                          setRenameInput(page.title);
                        }}
                        aria-label={t("archives.page.rename")}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}