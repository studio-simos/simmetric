// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { useSynthesisPendingCount } from "../queries/useSynthesis";

export default function SynthesisBadge() {
  const { t } = useTranslation();
  const { data: pendingCountData } = useSynthesisPendingCount();
  const pendingCount = pendingCountData?.count ?? 0;

  if (pendingCount <= 0) {
    return null;
  }

  const displayCount = pendingCount > 99 ? "99+" : pendingCount;

  return (
    <Badge
      variant="secondary"
      className="inline-flex text-accent-foreground border-accent-foreground ml-1.5"
    >
      {t("synthesis.sidebar.badge", { count: displayCount })}
    </Badge>
  );
}
