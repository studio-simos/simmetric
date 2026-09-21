// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Boot-offline banner (critique 2026-09-21 #2) — rendered inside the App
 * `initializing` skeleton when the backend has not been reachable within
 * the useBootOffline timeout window. Names the problem and the recovery
 * instead of an indefinite silent skeleton. role="alert" announces it for
 * screen readers the moment it appears.
 */
import { useTranslation } from "react-i18next";
import { ServerOff, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BootOfflineBannerProps {
  appName: string;
  onRetry: () => void;
}

export default function BootOfflineBanner({ appName, onRetry }: BootOfflineBannerProps) {
  const { t } = useTranslation();

  return (
    <div
      role="alert"
      className="mt-6 w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-center"
    >
      <div className="flex flex-col items-center gap-2">
        <ServerOff className="h-5 w-5 text-destructive shrink-0" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">
          {t("login.offline.title", { appName })}
        </p>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t("login.offline.body")}
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={onRetry}
          autoFocus
          className="mt-1 min-h-[44px] gap-1.5"
        >
          <RotateCcw aria-hidden="true" />
          {t("login.offline.retry")}
        </Button>
      </div>
    </div>
  );
}