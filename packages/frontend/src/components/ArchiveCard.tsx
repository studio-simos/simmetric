// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MoreVertical, Pencil, Trash2, FileText } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { useMe } from "../queries/useAuth";
import { useDeleteArchive, type Archive } from "../queries/useArchives";
import { showSuccess, showError } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";
import ArchiveRenameDialog from "./ArchiveRenameDialog";

interface ArchiveCardProps {
  archive: Archive;
}

export default function ArchiveCard({ archive }: ArchiveCardProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { data: user } = useMe();
  const deleteArchive = useDeleteArchive();

  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const canRename = (user?.permissions ?? []).includes("archive:write");
  const canDelete = (user?.permissions ?? []).includes("archive:delete");
  const showMenu = canRename || canDelete;

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteArchive.mutateAsync(archive.id);
      showSuccess(t("archives.deletedToast"));
      setDeleteOpen(false);
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("archives.deleteError")));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card
      className="relative cursor-pointer hover:bg-secondary/50 transition-colors"
      onClick={() => navigate(`/archives/${archive.id}`)}
    >
      {showMenu && (
        <div className="absolute top-2 right-2 z-10">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => e.stopPropagation()}
                aria-label={t("archives.menu.actions")}
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              // Radix portals the content to <body>, but React synthetic events
              // still bubble through the React tree — i.e. up to this Card's
              // onClick(navigate). Without stopPropagation, clicking a menu
              // item navigates to the detail page and the dialog never opens.
              onClick={(e) => e.stopPropagation()}
            >
              <DropdownMenuItem
                className="cursor-pointer"
                disabled={!canRename}
                onSelect={() => setRenameOpen(true)}
              >
                <Pencil className="mr-2 h-4 w-4" />
                {t("archives.menu.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer text-destructive"
                disabled={!canDelete}
                onSelect={() => setDeleteOpen(true)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t("archives.menu.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <CardHeader>
        <CardTitle className="text-[20px] font-semibold">{archive.name}</CardTitle>
        <CardDescription className="line-clamp-2">
          {archive.description || " "}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground flex items-center gap-1.5">
          <FileText className="h-4 w-4" aria-hidden="true" />
          {t("archives.pageCount", { count: archive._count?.pages ?? 0 })}
        </p>
        <p className="text-sm text-muted-foreground">
          {new Date(archive.updatedAt).toLocaleDateString()}
        </p>
      </CardContent>

      <ArchiveRenameDialog
        archive={archive}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent
          // Radix portals the content to <body>, but React synthetic events
          // still bubble through the React tree up to the Card's onClick.
          onClick={(e) => e.stopPropagation()}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{t("archives.deleteConfirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("archives.deleteConfirm.body")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t("archives.deleteConfirm.keepButton")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("archives.deleteArchive")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}