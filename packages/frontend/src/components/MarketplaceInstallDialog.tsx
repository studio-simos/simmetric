// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import McpHeadersEditor, {
  type HeaderRow,
  rowsToHeaders,
} from "./McpHeadersEditor";

interface MarketplaceInstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entryName: string;
  installing: boolean;
  onConfirm: (headers: Record<string, string>) => void;
}

/**
 * Pre-install configuration dialog for marketplace MCP servers.
 * Lets the admin add auth/extra headers (reusing McpHeadersEditor) before the
 * connection is created — needed for servers like Cloudflare Workers/Observability
 * that return 401 without an Authorization header. Headers are optional; an empty
 * editor installs with no headers (catalog defaults apply server-side).
 */
export default function MarketplaceInstallDialog({
  open,
  onOpenChange,
  entryName,
  installing,
  onConfirm,
}: MarketplaceInstallDialogProps) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<HeaderRow[]>([]);
  const [error, setError] = useState("");

  // Reset editor each time the dialog opens
  useEffect(() => {
    if (open) {
      setRows([]);
      setError("");
    }
  }, [open]);

  const handleConfirm = () => {
    const { headers, error: err } = rowsToHeaders(rows);
    if (err) {
      setError(t(`settings.mcpConnections.${err}`));
      return;
    }
    onConfirm(headers ?? {});
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            {t("marketplace.install.dialogTitle", { name: entryName })}
          </DialogTitle>
          <DialogDescription>
            {t("marketplace.install.dialogDescription")}
          </DialogDescription>
        </DialogHeader>

        <McpHeadersEditor rows={rows} onChange={setRows} error={error} />

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={installing}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={handleConfirm} disabled={installing}>
            {installing ? t("marketplace.detail.installing") : t("marketplace.detail.install")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}