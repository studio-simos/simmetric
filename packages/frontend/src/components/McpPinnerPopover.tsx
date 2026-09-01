// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useChatNav } from "../contexts/ChatContext";
import { useMcpConnections } from "../queries/useMcpConnections";
import { showError, showSuccess } from "../lib/toast";
import { apiGet, apiPost, apiDelete } from "../utils/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import type { McpConnection } from "../queries/useMcpConnections";

interface PinRecord {
  id: string;
  connectionId: string;
}

// Staged pins for the no-chat state: keyed per workspace so pins survive
// navigation and are flushed to the chat that becomes active (typically a
// brand-new chat after the first message creates it).
function stagedKey(workspaceId: string | null): string {
  return `mcp-pending-pins:${workspaceId ?? "none"}`;
}

function readStaged(workspaceId: string | null): Set<string> {
  try {
    const raw = localStorage.getItem(stagedKey(workspaceId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeStaged(workspaceId: string | null, ids: Set<string>): void {
  try {
    localStorage.setItem(stagedKey(workspaceId), JSON.stringify(Array.from(ids)));
  } catch {
    // best-effort — staging is a convenience, never a hard dependency
  }
}

// Global connections (both workspaceId and projectId null) are admin-configured
// tools usable from any workspace — D-14 semantics, mirrored from
// getMCPToolsForWorkspace. Project-scoped connections (workspaceId null,
// projectId set) are NOT shown here: the pin route rejects them (cross-
// workspace prevention requires workspaceId === chat.workspaceId).
function isGlobal(conn: McpConnection): boolean {
  return !conn.workspaceId && !conn.projectId;
}

function isScopedToWorkspace(conn: McpConnection, workspaceId: string | null): boolean {
  return !!workspaceId && conn.workspaceId === workspaceId;
}

export default function McpPinnerPopover({ disabled }: { disabled: boolean }) {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const { currentChatId, currentWorkspaceId } = useChatNav();

  const { data: connections = [] } = useMcpConnections();

  const [open, setOpen] = useState(false);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [pins, setPins] = useState<PinRecord[]>([]);
  // Connections staged while no chat is active — flushed when a chat appears.
  const [stagedIds, setStagedIds] = useState<Set<string>>(() => readStaged(currentWorkspaceId));

  const fetchPins = async () => {
    if (!currentChatId) return;
    try {
      const result = await apiGet<PinRecord[]>(`/chats/${currentChatId}/pins`);
      setPins(result);
      setPinnedIds(new Set(result.map((p) => p.connectionId)));
    } catch {
      // Pins may not exist yet for new chats — silently ignore
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      fetchPins();
    }
  };

  // Flush staged pins when a chat becomes active (null → id). This covers
  // brand-new chats (first message creates the chat and ChatPanel syncs the id
  // into ChatContext) and switching to an existing chat.
  const flushStaged = async (chatId: string, workspaceId: string | null) => {
    const pending = readStaged(workspaceId);
    if (pending.size === 0) return;
    const newPins: PinRecord[] = [];
    for (const connectionId of pending) {
      try {
        const result = await apiPost<{ id: string }>(`/chats/${chatId}/pins`, { connectionId });
        newPins.push({ id: result.id, connectionId });
      } catch {
        showError(t("mcpPinner.toast.pinFailedGeneric"));
      }
    }
    if (newPins.length > 0) {
      setPins((prev) => [...prev, ...newPins]);
      setPinnedIds((prev) => {
        const next = new Set(prev);
        newPins.forEach((p) => next.add(p.connectionId));
        return next;
      });
    }
    writeStaged(workspaceId, new Set());
    setStagedIds(new Set());
  };

  const prevChatIdRef = useRef(currentChatId);

  useEffect(() => {
    if (prevChatIdRef.current === null && currentChatId !== null) {
      prevChatIdRef.current = currentChatId;
      void flushStaged(currentChatId, currentWorkspaceId);
    } else if (prevChatIdRef.current !== currentChatId) {
      prevChatIdRef.current = currentChatId;
    }
    // `flushStaged` is intentionally NOT in deps — it must capture the staged
    // state at the moment the chat appears, not re-run on re-renders. It is
    // defined in the component body (closes over current state) and would
    // change identity every render; listing it would fire the effect far
    // more often than the intended null→id transition. (D-05 pattern 3 —
    // intentional, documented.)
  }, [currentChatId, currentWorkspaceId]);

  const togglePin = async (connectionId: string) => {
    // No chat yet → stage the pin for the chat that becomes active.
    if (!currentChatId) {
      setStagedIds((prev) => {
        const next = new Set(prev);
        if (next.has(connectionId)) {
          next.delete(connectionId);
        } else {
          next.add(connectionId);
        }
        writeStaged(currentWorkspaceId, next);
        return next;
      });
      return;
    }

    if (pinnedIds.has(connectionId)) {
      // Unpinning — optimistic remove
      const prevPinnedIds = new Set(pinnedIds);
      prevPinnedIds.delete(connectionId);
      setPinnedIds(prevPinnedIds);

      const pin = pins.find((p) => p.connectionId === connectionId);
      if (!pin) {
        // Pin record not found — revert
        setPinnedIds(new Set(pinnedIds));
        return;
      }

      try {
        await apiDelete(`/chats/${currentChatId}/pins/${pin.id}`);
      } catch {
        setPinnedIds(new Set(pinnedIds)); // revert
        showError(t("mcpPinner.toast.unpinFailedGeneric"));
      }
    } else {
      // Pinning — optimistic add
      const prevPinnedIds = new Set(pinnedIds);
      prevPinnedIds.add(connectionId);
      setPinnedIds(prevPinnedIds);

      try {
        const result = await apiPost<{ id: string }>(`/chats/${currentChatId}/pins`, { connectionId });
        setPins((prev) => [...prev, { id: result.id, connectionId }]);
        const connName = connections.find((c) => c.id === connectionId)?.name ?? "";
        showSuccess(t("mcpPinner.toast.pinSuccess", { name: connName }));
      } catch {
        setPinnedIds(new Set(pinnedIds)); // revert
        showError(t("mcpPinner.toast.pinFailedGeneric"));
      }
    }
  };

  // Connections of the active workspace + global ones (D-14).
  const workspaceConns = connections.filter(
    (c) => isScopedToWorkspace(c, currentWorkspaceId) || isGlobal(c),
  );

  const pinCount = pinnedIds.size + stagedIds.size;

  const getStatusVariant = (conn: McpConnection): "default" | "secondary" | "destructive" => {
    switch (conn.liveStatus) {
      case "connected":
        return "default";
      case "error":
        return "destructive";
      case "disconnected":
      default:
        return "secondary";
    }
  };

  const isOn = (conn: McpConnection) => (currentChatId ? pinnedIds.has(conn.id) : stagedIds.has(conn.id));

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      {/* Trigger button */}
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
              aria-label={t("mcpPinner.title")}
              aria-expanded={open}
            >
              <svg className="w-4 h-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              {pinCount > 0 && (
                <Badge
                  variant="secondary"
                  className="absolute -top-1 -right-1 h-4 w-4 p-0 text-[10px] flex items-center justify-center"
                >
                  {pinCount}
                </Badge>
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          {disabled
            ? t("mcpPinner.disabledTooltip")
            : currentChatId
              ? t("mcpPinner.title")
              : t("mcpPinner.noChatTooltip")}
        </TooltipContent>
      </Tooltip>

      <PopoverContent className="w-72 p-0" align="end">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border text-sm font-semibold text-popover-foreground">
          {t("mcpPinner.title")}
        </div>

        {/* Empty state */}
        {workspaceConns.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-sm font-medium text-popover-foreground">
              {t("mcpPinner.empty.noConnections")}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {t("mcpPinner.empty.noConnectionsBody")}
            </p>
            <Button
              variant="link"
              size="sm"
              onClick={() => {
                setOpen(false);
                navigate("/mcp-marketplace");
              }}
              className="mt-2"
            >
              {t("mcpPinner.browseMarketplace")}
            </Button>
          </div>
        ) : (
          <>
            {/* Connection rows */}
            {workspaceConns.map((conn) => {
              const isChecked = isOn(conn);
              return (
                <div
                  key={conn.id}
                  className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-b-0 hover:bg-accent"
                >
                  {/* Status indicator */}
                  <Badge
                    variant={getStatusVariant(conn)}
                    className="h-2 w-2 rounded-full p-0 flex-shrink-0"
                  />

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-popover-foreground truncate">
                      {conn.name}
                      {isGlobal(conn) && (
                        <span className="ml-1.5 text-[10px] text-muted-foreground uppercase tracking-wide">
                          {t("mcpPinner.globalBadge")}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {conn.liveStatus === "connected"
                        ? t("mcpPinner.toolsCount", { count: conn.toolCount || 0 })
                        : conn.liveStatus === "error"
                          ? t("mcpPinner.statusError")
                          : t("mcpPinner.statusDisconnected")}
                    </p>
                  </div>

                  {/* Toggle switch */}
                  <Switch
                    checked={isChecked}
                    onCheckedChange={() => togglePin(conn.id)}
                    aria-label={isChecked ? t("mcpPinner.unpinToggle") : t("mcpPinner.pinToggle")}
                  />
                </div>
              );
            })}
            {/* No-chat staging note */}
            {!currentChatId && stagedIds.size > 0 && (
              <div className="px-4 py-2 bg-accent/50 text-xs text-muted-foreground">
                {t("mcpPinner.pendingNote")}
              </div>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
