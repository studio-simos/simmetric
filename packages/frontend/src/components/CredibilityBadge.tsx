// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { ShieldCheck, ShieldAlert, ShieldQuestion } from "lucide-react";
import { Badge } from "./ui/badge";

import { cn } from "@/lib/utils"
interface CredibilitySignal {
  name: string;
  present: boolean;
  label: string;
}

interface Props {
  score: number;
  signals?: CredibilitySignal[];
  autoSuggested?: boolean;
}

export default function CredibilityBadge({ score, signals, autoSuggested }: Props) {
  // Determine color and icon based on score range
  const getConfig = () => {
    if (score >= 4) {
      return {
        icon: ShieldCheck,
        bgClass: "bg-secondary",
        textClass: "text-secondary-foreground",
        label: "High",
      };
    }
    if (score >= 3) {
      return {
        icon: ShieldQuestion,
        bgClass: "bg-accent",
        textClass: "text-accent-foreground",
        label: "Medium",
      };
    }
    return {
      icon: ShieldAlert,
      bgClass: "bg-destructive",
      textClass: "text-destructive-foreground",
      label: "Low",
    };
  };

  const config = getConfig();
  const Icon = config.icon;

  // Build tooltip from signals
  const buildTooltip = (): string => {
    if (!signals || signals.length === 0) {
      return `Credibility Score: ${score}/5`;
    }
    const parts = signals.map((s) => {
      const indicator = s.present ? "[x]" : "[ ]";
      return `${indicator} ${s.label}`;
    });
    return `Credibility Score: ${score}/5\n\nSignals:\n${parts.join("\n")}`;
  };

  return (
    <span title={buildTooltip()}>
      <Badge
        variant="outline"
        className={cn("inline-flex items-center gap-1", config.bgClass, config.textClass, "border-0")}
      >
        <Icon className="h-3 w-3" />
        <span>Score: {score}/5</span>
        {autoSuggested && (
          <span className="text-xs opacity-70 italic ml-0.5">(auto)</span>
        )}
      </Badge>
    </span>
  );
}
