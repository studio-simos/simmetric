// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";

interface ChatBadgeMenuProps {
  chatId: string;
  isPinned: boolean;
  folders: { id: string; name: string }[];
  onRename: () => void;
  onDelete: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onMoveToFolder: (folderId: string | null) => void;
  onDownload: () => void;
}

export default function ChatBadgeMenu({
  isPinned,
  folders,
  onRename,
  onDelete,
  onPin,
  onUnpin,
  onMoveToFolder,
  onDownload,
}: ChatBadgeMenuProps) {
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="p-1 rounded hover:bg-muted min-h-[44px] min-w-[44px] flex items-center justify-center"
          aria-label={t("sidebar.badgeMenu")}
        >
          <svg className="w-4 h-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v.01M12 12v.01M12 18v.01" />
          </svg>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onRename}>{t("sidebar.menuRename")}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => { if (isPinned) onUnpin(); else onPin(); }}>
          {isPinned ? t("sidebar.menuUnpin") : t("sidebar.menuPin")}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger onSelect={(e) => { e.preventDefault(); }}>{t("sidebar.menuMoveToFolder")}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {folders.map((folder) => (
              <DropdownMenuItem key={folder.id} onClick={() => onMoveToFolder(folder.id)}>
                {folder.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onClick={() => onMoveToFolder(null)}>
              {t("sidebar.unfiledHeader")}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onClick={onDownload}>{t("sidebar.menuDownload")}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive" onClick={onDelete}>{t("sidebar.menuDelete")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}