// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { AlertTriangle } from "lucide-react";

interface ContradictionClaim {
  text: string;
  source: string;
  date: string;
}

interface SynthesisContradiction {
  pageSlug: string;
  claimA: ContradictionClaim;
  claimB: ContradictionClaim;
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

interface SynthesisContradictionCardProps {
  contradiction: SynthesisContradiction;
}

function confidenceBadgeVariant(confidence: "HIGH" | "MEDIUM" | "LOW"): {
  variant: "destructive" | "secondary" | "outline";
  className: string;
} {
  switch (confidence) {
    case "HIGH":
      return { variant: "destructive", className: "" };
    case "MEDIUM":
      return { variant: "secondary", className: "text-accent-foreground" };
    case "LOW":
      return { variant: "outline", className: "text-muted-foreground" };
  }
}

function ClaimColumn({
  label,
  claim,
}: {
  label: string;
  claim: ContradictionClaim;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-semibold text-muted-foreground" style={{ fontSize: "12px", fontWeight: 600, lineHeight: 1.2 }}>
        {label}
      </p>
      <p className="text-xs text-muted-foreground">
        {claim.source}
      </p>
      <p className="text-xs text-secondary-foreground">
        {claim.date}
      </p>
      <p className="text-sm mt-1" style={{ fontSize: "14px", fontWeight: 400, lineHeight: 1.5 }}>
        {claim.text}
      </p>
    </div>
  );
}

export default function SynthesisContradictionCard({
  contradiction,
}: SynthesisContradictionCardProps) {
  const { t } = useTranslation();
  const badgeStyle = confidenceBadgeVariant(contradiction.confidence);

  return (
    <Card className="w-full">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-accent-foreground" />
          <span className="text-accent-foreground font-semibold uppercase" style={{ fontSize: "12px", fontWeight: 600, lineHeight: 1.2 }}>
            CONTRADICTION DETECTED
          </span>
          <Badge variant={badgeStyle.variant} className={badgeStyle.className}>
            {t("synthesis.contradictions.confidence", { level: contradiction.confidence })}
          </Badge>
        </div>
        <CardTitle className="text-sm" style={{ fontSize: "14px", fontWeight: 400, lineHeight: 1.5 }}>
          {contradiction.pageSlug}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ClaimColumn
            label={t("synthesis.contradictions.sourceA")}
            claim={contradiction.claimA}
          />
          <Separator className="md:hidden" />
          <div className="hidden md:block">
            <Separator orientation="vertical" className="h-full mx-auto" />
          </div>
          <ClaimColumn
            label={t("synthesis.contradictions.sourceB")}
            claim={contradiction.claimB}
          />
        </div>
      </CardContent>
    </Card>
  );
}
