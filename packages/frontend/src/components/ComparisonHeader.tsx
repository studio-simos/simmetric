// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

interface ComparisonHeaderProps {
  onClose: () => void;
}

export default function ComparisonHeader({ onClose }: ComparisonHeaderProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between px-4 h-10 border-b border-border bg-card">
      <span className="text-sm font-semibold text-foreground">
        {t("chat.comparison.title")}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("chat.comparison.close")}
        onClick={onClose}
        className="text-muted-foreground hover:text-foreground"
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path d="M6 18L18 6M6 6l12 12" />
        </svg>
      </Button>
    </div>
  );
}
