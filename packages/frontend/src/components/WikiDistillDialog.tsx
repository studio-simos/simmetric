// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen } from "lucide-react";
import { apiPost } from "../utils/api";
import { useArchives } from "../queries/useArchives";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getErrorMessage } from "../utils/errorUtils";

interface WikiDistillDialogProps {
  open: boolean;
  onClose: () => void;
  chatId: string;
  selectedMessageIds: Set<string>;
  totalMessageCount: number;
}

export function WikiDistillDialog({
  open,
  onClose,
  chatId,
  selectedMessageIds,
  totalMessageCount,
}: WikiDistillDialogProps) {
  const { t } = useTranslation();
  const { data: archives = [] } = useArchives();
  const [archiveId, setArchiveId] = useState("");
  const [title, setTitle] = useState(`Chat ${chatId.slice(0, 8)}`);
  const [category, setCategory] = useState<"entities" | "concepts" | "decisions">(
    "entities",
  );
  const [distilling, setDistilling] = useState(false);

  const hasSelection = selectedMessageIds.size > 0;
  const canDistill = !!archiveId && title.trim().length > 0 && !distilling;

  const handleDistill = async () => {
    if (!canDistill) return;
    setDistilling(true);
    try {
      const body: Record<string, unknown> = {
        archiveId,
        title: title.trim(),
        category,
        chatId,
      };
      if (hasSelection) {
        body.messageIds = Array.from(selectedMessageIds);
      }
      await apiPost("/wiki-write/distill", body);
      onClose();
      alert(t("wiki.distillSuccess"));
    } catch (err: unknown) {
      alert(t("wiki.distillFailed") + ": " + getErrorMessage(err));
    } finally {
      setDistilling(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("wiki.distillDialogTitle")}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 mt-2">
          <p className="text-sm text-[var(--text-muted)]">
            {t("wiki.distillDialogDescription")}
          </p>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[var(--text)]">
              {t("wiki.selectArchive")}
            </label>
            <Select value={archiveId} onValueChange={setArchiveId}>
              <SelectTrigger>
                <SelectValue placeholder={t("wiki.selectArchive")} />
              </SelectTrigger>
              <SelectContent>
                {archives.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[var(--text)]">
              {t("wiki.title")}
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("wiki.titlePlaceholder")}
              className="flex h-9 w-full rounded-md border border-[var(--border-input)] bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-[var(--text-muted)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[var(--text)]">
              {t("wiki.selectCategory")}
            </label>
            <Select
              value={category}
              onValueChange={(v) =>
                setCategory(v as "entities" | "concepts" | "decisions")
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="entities">
                  {t("wiki.categories.entities")}
                </SelectItem>
                <SelectItem value="concepts">
                  {t("wiki.categories.concepts")}
                </SelectItem>
                <SelectItem value="decisions">
                  {t("wiki.categories.decisions")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <p className="text-xs text-[var(--text-muted)]">
            {hasSelection
              ? t("wiki.messagesSelected", {
                  selected: selectedMessageIds.size,
                  total: totalMessageCount,
                })
              : t("wiki.allMessagesSelected", { total: totalMessageCount })}
          </p>

          <Button
            onClick={handleDistill}
            disabled={!canDistill}
            className="flex items-center gap-1.5"
          >
            <BookOpen size={14} />
            {distilling ? t("wiki.distilling") : t("wiki.distill")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
