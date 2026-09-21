// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useRef, useEffect } from "react";
import { useDroppable } from "@dnd-kit/core";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils"
interface FolderAccordionProps {
  folder: { id: string; name: string };
  chatCount: number;
  children: React.ReactNode;
  onToggle?: () => void;
  defaultExpanded?: boolean;
  onRename?: () => void;
  onDelete?: () => void;
}

export default function FolderAccordion({
  folder,
  chatCount,
  children,
  onToggle,
  defaultExpanded = true,
  onRename,
  onDelete,
}: FolderAccordionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [menuOpen, setMenuOpen] = useState(false);
  const { setNodeRef, isOver } = useDroppable({ id: `folder-${folder.id}`, data: { folderId: folder.id } });
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const toggle = () => {
    setExpanded((e) => !e);
    onToggle?.();
  };

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "border rounded-lg transition-colors",
        isOver
          ? "border-2 border-primary/50 bg-primary/50/10"
          : "border-border",
      )}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        onDoubleClick={() => onRename?.()}
        className="w-full justify-between h-auto px-3 py-2 text-sm font-medium inline-flex items-center cursor-pointer rounded-md hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-all duration-150"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          <svg
            className={cn(
              "w-4 h-4 text-secondary-foreground transition-transform",
              expanded && "rotate-180",
            )}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
          <span>{folder.name}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-xs text-secondary-foreground bg-primary/10 dark:bg-primary/90/30 text-primary/70 dark:text-primary/30 px-1.5 py-0.5 rounded">
            {t("sidebar.folderChatCount", { count: chatCount })}
          </span>
          <div className="relative" ref={menuRef}>
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((o) => !o);
              }}
              className="min-h-[44px] min-w-[44px]"
              aria-label={t("sidebar.folderActions")}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <svg
                className="w-4 h-4 text-muted-foreground"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 6v.01M12 12v.01M12 18v.01"
                />
              </svg>
            </Button>
            {menuOpen && (
              <div className="absolute right-0 mt-1 w-48 bg-card border border-border rounded-lg shadow-lg z-50 py-1">
                <Button
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRename?.();
                    setMenuOpen(false);
                  }}
                  className="w-full justify-start h-auto px-3 py-2 text-sm"
                >
                  {t("sidebar.renameFolder")}
                </Button>
                <div className="border-t border-border my-1" />
                <Button
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete?.();
                    setMenuOpen(false);
                  }}
                  className="w-full justify-start h-auto px-3 py-2 text-sm text-destructive-foreground"
                >
                  {t("sidebar.deleteFolder")}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
      {expanded && (
        <div className="overflow-hidden transition-all duration-150 space-y-1">
          {children}
        </div>
      )}
    </div>
  );
}