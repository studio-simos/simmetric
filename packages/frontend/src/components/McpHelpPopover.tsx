// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useChatNav } from "../contexts/ChatContext";
import { useMcpConnections } from "../queries/useMcpConnections";
import { apiGet } from "../utils/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Info,
  AlertTriangle,
  ExternalLink,
  ArrowRight,
} from "lucide-react";

interface PinRecord {
  id: string;
  connectionId: string;
}

/**
 * MCP-in-chat help popover (MCP-01 user-facing surface, D-01/D-02/D-04/D-07).
 *
 * Display-only: reuses the cached `useMcpConnections` query + the pinner's
 * `apiGet(/chats/:id/pins)` fetch-on-open pattern. No mutation endpoints, no
 * new query, no server-side `resolveSkillsForChat` call (anti-pattern). The
 * fallback warning is a client-side mirror of `skills.ts:119-130` and is
 * informational only — authoritative enforcement stays server-side.
 */
export default function McpHelpPopover({
  disabled,
}: {
  disabled: boolean;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { currentChatId, currentWorkspaceId } = useChatNav();
  const { data: connections = [] } = useMcpConnections();

  const [open, setOpen] = useState(false);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());

  const fetchPins = useCallback(async () => {
    if (!currentChatId) return;
    try {
      const result = await apiGet<PinRecord[]>(
        `/chats/${currentChatId}/pins`,
      );
      setPinnedIds(new Set(result.map((p) => p.connectionId)));
    } catch {
      // Pins may not exist yet for new chats — silently ignore (pinner :43-44)
    }
  }, [currentChatId]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      fetchPins();
    }
  };

  // Refetch pins when the active chat changes while the popover is open, so
  // the live-status block (D-04) never shows stale pin/tool counts for a
  // previous chat.
  useEffect(() => {
    if (open) {
      fetchPins();
    }
  }, [open, fetchPins]);

  // Filter connections to the current workspace (mirror pinner :92-107)
  const workspaceConns = connections.filter(
    (c) => c.workspaceId === currentWorkspaceId,
  );
  const pinnedCount = pinnedIds.size;
  // Display-only mirror of skills.ts:119-120 (Pitfall 6): active = pinned AND
  // enabled AND workspace-matched. Adds liveStatus==="connected" because the
  // popover shows runtime state (server-side `enabled` is the persisted gate).
  const activePinnedConns = workspaceConns.filter(
    (c) =>
      pinnedIds.has(c.id) &&
      c.enabled &&
      c.liveStatus === "connected",
  );
  const toolCount = activePinnedConns.reduce(
    (sum, c) => sum + (c.toolCount || 0),
    0,
  );
  const allPinnedDisabled =
    pinnedCount > 0 && activePinnedConns.length === 0;

  const conceptSections: Array<{
    labelKey: string;
    bodyKey: string;
  }> = [
    {
      labelKey: "mcpHelp.concept.entry",
      bodyKey: "mcpHelp.concept.entryBody",
    },
    {
      labelKey: "mcpHelp.concept.pinning",
      bodyKey: "mcpHelp.concept.pinningBody",
    },
    {
      labelKey: "mcpHelp.concept.skillResolution",
      bodyKey: "mcpHelp.concept.skillResolutionBody",
    },
    {
      labelKey: "mcpHelp.concept.toolUse",
      bodyKey: "mcpHelp.concept.toolUseBody",
    },
  ];

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              disabled={disabled}
              className={`relative ${
                disabled ? "opacity-50 cursor-not-allowed" : ""
              }`}
              aria-label={t("mcpHelp.title")}
              aria-expanded={open}
            >
              <Info className="w-4 h-4 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          {disabled ? t("mcpHelp.disabledTooltip") : t("mcpHelp.title")}
        </TooltipContent>
      </Tooltip>

      <PopoverContent className="w-80 p-0" align="end">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border text-sm font-semibold text-popover-foreground">
          {t("mcpHelp.title")}
        </div>

        {/* 4 concept sections */}
        {conceptSections.map((section) => (
          <div
            key={section.labelKey}
            className="px-4 py-3 border-b border-border last:border-b-0"
          >
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              {t(section.labelKey)}
            </p>
            <p className="text-sm text-popover-foreground leading-relaxed mt-1">
              {t(section.bodyKey)}
            </p>
          </div>
        ))}

        {/* Live status block (D-04) */}
        <div className="px-4 py-3 border-b border-border">
          {workspaceConns.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("mcpHelp.liveStatus.empty")}
            </p>
          ) : (
            <div className="flex gap-4">
              <Badge variant="secondary">
                {t("mcpHelp.liveStatus.pinned", { count: pinnedCount })}
              </Badge>
              <Badge variant="secondary">
                {t("mcpHelp.liveStatus.toolsAvailable", {
                  count: toolCount,
                })}
              </Badge>
            </div>
          )}
        </div>

        {/* Fallback warning (D-04, display-only mirror of skills.ts:119-130) */}
        {allPinnedDisabled && (
          <div className="flex items-start gap-2 px-4 py-3 border-b border-border bg-destructive/10 text-destructive">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <p className="text-xs leading-relaxed">
              {t("mcpHelp.fallbackWarning")}
            </p>
          </div>
        )}

        {/* Mini troubleshooting (D-07) */}
        <div className="px-4 py-3 border-b border-border">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            {t("mcpHelp.troubleshooting.title")}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {t("mcpHelp.troubleshooting.toolMissing")}
          </p>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navigate("/mcp-marketplace");
            }}
            className="text-xs text-primary hover:underline mt-2 inline-flex items-center gap-1"
          >
            <ExternalLink className="w-3 h-3" />
            {t("mcpHelp.troubleshooting.seeMarketplaceDoc")}
          </button>
        </div>

        {/* Footer deep-link (D-03) */}
        <div className="px-4 py-3 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {t("mcpHelp.deepLinkLabel")}
          </span>
          <Button
            variant="link"
            size="sm"
            className="text-primary p-0 h-auto"
            title={t("mcpHelp.deepLinkTooltip")}
            onClick={() => {
              setOpen(false);
              navigate("/mcp-marketplace");
            }}
          >
            {t("mcpHelp.deepLink")}
            <ArrowRight className="w-3 h-3" />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}