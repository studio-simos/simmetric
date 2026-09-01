// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { showSuccess, showError } from "../lib/toast";
import {
  useChats,
  useChatFolders,
  usePinChat,
  useUnpinChat,
  useMoveChat,
  useCreateFolder,
  useRenameFolder,
  useDeleteFolder,
  useDeleteChat,
  useRenameChat,
} from "../queries/useChats";
import type { ChatSummary, ChatFolder } from "../queries/useChats";
import { useTranslation } from "react-i18next";
import { HighlightedName } from "./HighlightedName";
import ChatBadgeMenu from "./ChatBadgeMenu";
import { ChevronLeft, ChevronRight } from "lucide-react";
import FolderAccordion from "./FolderAccordion";
import { DndContext, PointerSensor, KeyboardSensor, TouchSensor, useSensor, useSensors, DragEndEvent, useDraggable, useDroppable } from "@dnd-kit/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { cn } from "@/lib/utils"
import { getErrorMessage } from "../utils/errorUtils";
import {
  groupChatsByDate,
  DATE_BUCKET_ORDER,
} from "../utils/groupChatsByDate";

type SidebarView = "folders" | "date";

function readSidebarView(): SidebarView {
  if (typeof localStorage === "undefined") return "folders";
  const saved = localStorage.getItem("sidebarView");
  return saved === "date" ? "date" : "folders";
}

interface ChatSidebarProps {
  workspaceId: string;
  currentChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  /**
   * "panel" (default) — inline sidebar at lg+, fixed `w-64` with a right
   * border that separates it from the chat area.
   * "sheet" — rendered inside the mobile/tablet Sheet. Fills the Sheet
   * width (`w-full`) and drops its own right border (the Sheet content
   * already provides `border-r`), mirroring how `RightPanel` fills the
   * console Sheet.
   */
  variant?: "panel" | "sheet";
  /**
   * Called when the sheet variant's header close (chevron) button is
   * clicked — ChatPanel wires it to `setMobileSidebarOpen(false)`. The
   * panel variant ignores this and closes itself by collapsing to the
   * rail. Keeping the close affordance inside the header (next to the
   * "New chat" button) makes the mobile sheet bar visually consistent
   * with the desktop panel, instead of a separate corner X.
   */
  onClose?: () => void;
}

interface DragData { folderId?: string | null; }

function DraggableChatRow({ chatId, children }: { chatId: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: chatId, data: { chatId } });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  // Whole-row draggable: dnd-kit `attributes` (tabIndex, role,
  // aria-roledescription="draggable", aria-describedby) + `listeners` live on
  // the wrapper div so the entire chat block is the drag surface. The
  // PointerSensor `distance: 8` activation constraint (configured on the
  // DndContext above) lets a click (<8px movement) still fire the inner row's
  // onClick to select the chat, while a press-and-move (>8px) starts a drag.
  // The inner row keeps its own `role="option"` / `aria-selected`; dnd-kit's
  // `aria-roledescription` augments rather than conflicts with it (standard
  // dnd-kit sortable pattern). `touch-none` while dragging prevents the
  // browser from scrolling on touch-drag. The `group` class stays on the
  // inner row (renderChatRow) so ChatBadgeMenu hover styles keep working.
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn("cursor-grab active:cursor-grabbing", transform && "touch-none")}
    >
      {children}
    </div>
  );
}

function UnfiledDropTarget({ children }: { children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: "unfiled", data: { folderId: "unfiled" } });
  return (
    <div
      ref={setNodeRef}
      className={cn("transition-colors duration-150 rounded-lg", (isOver) && "bg-primary/50/10 border-2 border-primary/50")}
    >
      {children}
    </div>
  );
}

export default function ChatSidebar({ workspaceId, currentChatId, onSelectChat, onNewChat, onClose, variant = "panel" }: ChatSidebarProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [sidebarView, setSidebarView] = useState<SidebarView>(readSidebarView);
  const [searchQuery, setSearchQuery] = useState("");
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renamingFolderName, setRenamingFolderName] = useState("");
  const [deletingFolder, setDeletingFolder] = useState<{ folderId: string; name: string; chatCount: number } | null>(null);
  const [deletingChat, setDeletingChat] = useState<{ chatId: string; name: string } | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  // Desktop panel collapse (panel variant only). Mirrors the RightPanel
  // console: collapses to a thin left rail, open state persisted to
  // localStorage (default open). The sheet variant is transient (driven by
  // the Sheet open state in ChatPanel) so its `open` is never used and not
  // persisted.
  const [open, setOpen] = useState(() => {
    const saved = localStorage.getItem("chat-sidebar-open");
    return saved === null ? true : saved === "true";
  });
  useEffect(() => {
    if (variant === "panel") {
      localStorage.setItem("chat-sidebar-open", String(open));
    }
  }, [open, variant]);
    const { t } = useTranslation();

  // TanStack Query hooks (replaces store fetch actions)
  const { data: chats = [], isLoading: chatsLoading } = useChats(workspaceId);
  const { data: folders = [], isLoading: foldersLoading } = useChatFolders(workspaceId);

  const pinChatMutation = usePinChat();
  const unpinChatMutation = useUnpinChat();
  const moveChatMutation = useMoveChat();
  const createFolderMutation = useCreateFolder();
  const renameFolderMutation = useRenameFolder();
  const deleteFolderMutation = useDeleteFolder();
  const deleteChatMutation = useDeleteChat();
  const renameChatMutation = useRenameChat();

  const loading = chatsLoading || foldersLoading;

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor)
  );

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const chatId = active.id as string;
    const data = over.data.current as DragData | undefined;
    const folderId = data?.folderId ?? null;
    try {
      if (folderId === "unfiled") {
        await moveChatMutation.mutateAsync({ workspaceId, chatId, folderId: null });
        showSuccess(t("sidebar.toastMoved", { folder: t("sidebar.unfiledHeader") }));
      } else if (folderId) {
        await moveChatMutation.mutateAsync({ workspaceId, chatId, folderId });
        const folderName = folders.find((f: ChatFolder) => f.id === folderId)?.name || "";
        showSuccess(t("sidebar.toastMoved", { folder: folderName }));
      }
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("sidebar.moveFailed")));
    }
  };

  const handleDelete = async (chatId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const chat = chats.find((c) => c.id === chatId);
    if (!chat) return;
    setDeletingChat({ chatId, name: chat.name });
  };

  const handleDeleteConfirm = async () => {
    if (!deletingChat) return;
    try {
      await deleteChatMutation.mutateAsync({
        workspaceId,
        chatId: deletingChat.chatId,
      });
      if (currentChatId === deletingChat.chatId) {
        onNewChat();
      }
      showSuccess(t("sidebar.chatDeleted", "Chat deleted"));
    } catch (err: unknown) {
      showError(t("sidebar.deleteChatFailed", "Failed to delete chat") + ": " + getErrorMessage(err));
    } finally {
      setDeletingChat(null);
    }
  };

  const handleRename = async (chatId: string) => {
    const name = renameInput.trim();
    if (!name) { setRenaming(null); return; }
    try {
      await renameChatMutation.mutateAsync({ workspaceId, chatId, name });
      showSuccess(t("sidebar.chatRenamed", "Chat renamed"));
    } catch (err: unknown) {
      showError(t("sidebar.renameChatFailed", "Failed to rename chat") + ": " + getErrorMessage(err));
    } finally {
      setRenaming(null);
    }
  };

  const handleFolderRename = async (folderId: string) => {
    const name = renamingFolderName.trim();
    if (!name) {
      setRenamingFolderId(null);
      setRenamingFolderName("");
      return;
    }
    try {
      await renameFolderMutation.mutateAsync({ workspaceId, folderId, name });
      showSuccess(t("sidebar.toastFolderRenamed"));
    } catch (err: unknown) {
      showError(t("sidebar.renameFolder") + ": " + getErrorMessage(err));
    } finally {
      setRenamingFolderId(null);
      setRenamingFolderName("");
    }
  };

  const handleFolderDeleteConfirm = async (cascade: boolean) => {
    if (!deletingFolder) return;
    try {
      await deleteFolderMutation.mutateAsync({
        workspaceId,
        folderId: deletingFolder.folderId,
        cascade,
      });
      showSuccess(t("sidebar.toastFolderDeleted"));
    } catch (err: unknown) {
      showError(t("sidebar.deleteFolder") + ": " + getErrorMessage(err));
    } finally {
      setDeletingFolder(null);
    }
  };

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      await createFolderMutation.mutateAsync({ workspaceId, name });
      showSuccess(t("sidebar.toastFolderCreated", "Folder created"));
      setNewFolderName("");
      setCreatingFolder(false);
    } catch (err: unknown) {
      showError(t("sidebar.createFolderFailed", "Failed to create folder") + ": " + getErrorMessage(err));
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const filteredChats = searchQuery
    ? chats.filter((c) => c.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : chats;

  // Partition chats into sections
  const pinnedChats = filteredChats.filter((c) => c.isPinned);
  const unfiledChats = filteredChats.filter((c) => !c.folderId && !c.isPinned);

  // Date view grouping (all filtered chats, ignoring pin/folder)
  const groupedByDate = groupChatsByDate(filteredChats);

  // Persist view toggle
  useEffect(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("sidebarView", sidebarView);
    }
  }, [sidebarView]);

  // Close delete dialog on Escape
  useEffect(() => {
    if (!deletingFolder && !deletingChat) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDeletingFolder(null);
        setDeletingChat(null);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [deletingFolder, deletingChat]);

  // Render a single chat row (used across sections)
  const renderChatRow = (chat: ChatSummary) => {
    const isActive = currentChatId === chat.id;
    return (
      <div
        key={chat.id}
        role="option"
        aria-selected={isActive}
        aria-current={isActive ? "true" : undefined}
        onClick={() => onSelectChat(chat.id)}
        className={cn(
          "group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 w-full",
          isActive ? "text-primary" : "hover:bg-accent text-muted-foreground",
        )}
      >
        <div className="flex-1 min-w-0">
          {renaming === chat.id ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleRename(chat.id);
              }}
              className="flex gap-1"
            >
              <Input
                type="text"
                value={renameInput}
                onChange={(e) => setRenameInput(e.target.value)}
                className="flex-1 min-w-0 px-1 py-0.5 h-auto text-sm"
                autoFocus
                onBlur={() => handleRename(chat.id)}
              />
            </form>
          ) : (
            <p className="text-sm truncate" title={chat.name}>
              <HighlightedName name={chat.name} query={searchQuery} />
            </p>
          )}
          <p className="text-xs text-secondary-foreground">
            {formatDate(chat.updatedAt)}
          </p>
        </div>
        <ChatBadgeMenu
          chatId={chat.id}
          isPinned={!!chat.isPinned}
          folders={folders.map((f) => ({ id: f.id, name: f.name }))}
          onRename={() => {
            setRenaming(chat.id);
            setRenameInput(chat.name);
          }}
          onDelete={() =>
            handleDelete(chat.id, {
              stopPropagation: () => {},
            } as React.MouseEvent)
          }
          onPin={async () => {
            await pinChatMutation.mutateAsync({ workspaceId, chatId: chat.id });
            showSuccess(t("sidebar.toastPinned"));
          }}
          onUnpin={async () => {
            await unpinChatMutation.mutateAsync({ workspaceId, chatId: chat.id });
            showSuccess(t("sidebar.toastUnpinned"));
          }}
          onMoveToFolder={async (folderId) => {
            await moveChatMutation.mutateAsync({
              workspaceId,
              chatId: chat.id,
              folderId: folderId || null,
            });
            const folderName = folderId
              ? folders.find((f: ChatFolder) => f.id === folderId)?.name
              : t("sidebar.unfiledHeader");
            showSuccess(t("sidebar.toastMoved", { folder: folderName }));
          }}
          onDownload={async () => {
            try {
              const token = localStorage.getItem("token");
              const res = await fetch(
                `/api/workspaces/${workspaceId}/chats/${chat.id}/export`,
                {
                  headers: token ? { Authorization: `Bearer ${token}` } : {},
                },
              );
              if (!res.ok) throw new Error("Export failed");
              const blob = await res.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              const contentDisposition = res.headers.get("Content-Disposition");
              const filename = contentDisposition
                ? contentDisposition.split("filename=")[1]?.replace(/"/g, "") ||
                  `${chat.name.replace(/[^a-zA-Z0-9]/g, "_")}.json`
                : `${chat.name.replace(/[^a-zA-Z0-9]/g, "_")}.json`;
              a.download = filename;
              a.click();
              URL.revokeObjectURL(url);
            } catch (err: unknown) {
              showError(t("chat.sidebar.exportFailed", { error: getErrorMessage(err) }));
            }
          }}
        />
      </div>
    );
  };

  // Collapsed rail — desktop panel variant only, anchored LEFT (mirrors the
  // RightPanel console's right rail). A thin `w-9` strip with a chevron + a
  // vertical label; clicking expands the sidebar back to its full width.
  if (variant === "panel" && !open) {
    return (
      <div className="hidden lg:flex flex-none w-9 border-r border-border bg-card">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full flex flex-col items-center gap-2 pt-2 text-muted-foreground hover:text-foreground transition-theme"
          aria-label={t("chat.openSidebar", "Open chat list")}
          title={t("chat.openSidebar", "Open chat list")}
        >
          <ChevronRight className="w-4 h-4" />
          <span className="font-mono text-[10px] uppercase tracking-wider [writing-mode:vertical-rl]">
            {t("chat.sidebarTitle", "Chat list")}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className={cn("bg-card flex flex-col h-full", variant === "sheet" ? "w-full" : "hidden lg:flex flex-none w-64 border-r border-border")}>
      {/* Header */}
      <div className="p-3 border-b border-border">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => (variant === "panel" ? setOpen(false) : onClose?.())}
            className="flex-none text-muted-foreground hover:text-foreground"
            aria-label={t("chat.closeSidebar", "Close chat list")}
            title={t("chat.closeSidebar", "Close chat list")}
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={onNewChat}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            {t("sidebar.newChat")}
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <div className="relative">
          <Input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("sidebar.searchPlaceholder")}
            className="pr-8"
            aria-label={t("sidebar.searchPlaceholder")}
          />
          {searchQuery && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-secondary-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </Button>
          )}
        </div>
      </div>

      {/* View toggle: Folders / Date */}
      <div className="px-3 pb-2" role="tablist" aria-label={t("sidebar.view.ariaLabel")}>
        <div className="flex items-center gap-1 p-0.5 rounded-lg bg-accent/60">
          {(["folders", "date"] as const).map((view) => (
            <button
              key={view}
              type="button"
              role="tab"
              aria-selected={sidebarView === view}
              onClick={() => setSidebarView(view)}
              className={cn(
                "flex-1 px-2 py-1 rounded-md text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                sidebarView === view
                  ? "bg-card text-foreground shadow-sm"
                  : "text-secondary-foreground hover:text-foreground",
              )}
            >
              {t(`sidebar.view.${view}`)}
            </button>
          ))}
        </div>
      </div>

      {/* Chat list with DnD */}
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          {loading ? (
            <div className="p-3 text-sm text-secondary-foreground text-center">{t("chat.sidebar.loadingChats")}</div>
          ) : chats.length === 0 ? (
            <div className="p-3 text-sm text-secondary-foreground text-center">{t("chat.sidebar.noChats")}</div>
          ) : (
            <div className="p-2 space-y-2">
              {sidebarView === "date" ? (
                <div className="space-y-2">
                  <div className="px-1 py-1 text-[11px] text-secondary-foreground/70">
                    {t("sidebar.dateView.dndDisabled")}
                  </div>
                  {DATE_BUCKET_ORDER.map((bucket) => {
                    const bucketChats = groupedByDate[bucket];
                    if (bucketChats.length === 0) return null;
                    return (
                      <div key={bucket}>
                        <div className="flex items-center px-3 py-1 text-sm font-semibold text-foreground border-t border-border">
                          {t(`sidebar.group.${bucket}`)}
                        </div>
                        <div className="space-y-1">
                          {/* DnD disabled in date view: render rows without DraggableChatRow */}
                          {bucketChats.map((chat) => renderChatRow(chat))}
                        </div>
                      </div>
                    );
                  })}
                  {searchQuery && filteredChats.length === 0 && (
                    <div className="px-3 py-4 text-center text-xs text-secondary-foreground">
                      {t("sidebar.noSearchResults")}
                    </div>
                  )}
                </div>
              ) : (
                <>
              {/* Pinned section */}
              {pinnedChats.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 px-3 py-2 text-sm font-semibold text-foreground border-t border-border">
                    <svg className="w-4 h-4 text-primary/50" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                    </svg>
                    {t("sidebar.pinnedHeader")}
                  </div>
                  <div className="space-y-1">
                    {pinnedChats.map((chat) => (
                      <DraggableChatRow chatId={chat.id} key={chat.id}>
                        {renderChatRow(chat)}
                      </DraggableChatRow>
                    ))}
                  </div>
                </div>
              )}

              {/* Folders section */}
              <div>
                <div className="flex items-center justify-between px-3 py-1">
                  <span className="text-sm font-semibold text-foreground">{t("sidebar.foldersHeader")}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setCreatingFolder(true)}
                    className="min-h-[44px] min-w-[44px]"
                    aria-label={t("sidebar.createFolder")}
                  >
                    <svg className="w-4 h-4 text-secondary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                  </Button>
                </div>
                {creatingFolder && (
                  <div className="px-3 py-1">
                    <form
                      onSubmit={(e) => { e.preventDefault(); handleCreateFolder(); }}
                      className="flex gap-1"
                    >
                      <Input
                        type="text"
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        placeholder={t("sidebar.folderNamePlaceholder", "Folder name")}
                        className="flex-1 min-w-0 px-2 py-1 h-auto text-sm"
                        autoFocus
                        onBlur={() => { if (!newFolderName.trim()) setCreatingFolder(false); }}
                      />
                    </form>
                  </div>
                )}
                <div className="space-y-1">
                  {folders.map((folder) => {
                    const folderChats = filteredChats.filter((c) => c.folderId === folder.id && !c.isPinned);
                    const isRenaming = renamingFolderId === folder.id;

                    if (isRenaming) {
                      return (
                        <div key={folder.id} className="border rounded-lg border-border">
                          <div className="flex items-center gap-2 px-3 py-2 min-h-[36px] bg-accent">
                            <svg className="w-4 h-4 text-secondary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                            <Input
                              value={renamingFolderName}
                              onChange={(e) => setRenamingFolderName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleFolderRename(folder.id);
                                if (e.key === "Escape") { setRenamingFolderId(null); setRenamingFolderName(""); }
                              }}
                              onBlur={() => handleFolderRename(folder.id)}
                              autoFocus
                              className="flex-1 border-0 bg-transparent text-sm font-medium text-foreground outline-none shadow-none focus-visible:ring-0"
                            />
                          </div>
                          <div className="p-2 space-y-1">
                            {folderChats.map((chat) => (
                              <DraggableChatRow chatId={chat.id} key={chat.id}>
                                {renderChatRow(chat)}
                              </DraggableChatRow>
                            ))}
                          </div>
                        </div>
                      );
                    }

                    return (
                      <FolderAccordion
                        key={folder.id}
                        folder={folder}
                        chatCount={folderChats.length}
                        onRename={() => { setRenamingFolderId(folder.id); setRenamingFolderName(folder.name); }}
                        onDelete={() => setDeletingFolder({ folderId: folder.id, name: folder.name, chatCount: folderChats.length })}
                      >
                        {folderChats.map((chat) => (
                          <DraggableChatRow chatId={chat.id} key={chat.id}>
                            {renderChatRow(chat)}
                          </DraggableChatRow>
                        ))}
                      </FolderAccordion>
                    );
                  })}
                </div>
              </div>

              {/* Unfiled section */}
              <UnfiledDropTarget>
                <div>
                  <div className="px-3 py-2 text-sm font-semibold text-foreground border-t border-border">
                    {t("sidebar.unfiledHeader")}
                  </div>
                  {unfiledChats.length > 0 && (
                    <div className="space-y-1">
                      {unfiledChats.map((chat) => (
                        <DraggableChatRow chatId={chat.id} key={chat.id}>
                          {renderChatRow(chat)}
                        </DraggableChatRow>
                      ))}
                    </div>
                  )}
                </div>
              </UnfiledDropTarget>

              {/* Search empty state */}
              {searchQuery && filteredChats.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-secondary-foreground">
                  {t("sidebar.noSearchResults")}
                </div>
              )}
                </>
              )}
            </div>
          )}
        </div>
      </DndContext>

      {/* Folder delete confirmation dialog */}
      {deletingFolder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg shadow-lg w-80 p-4 space-y-3">
            <h3 className="text-base font-semibold text-foreground">
              {t("sidebar.deleteFolder")}: {deletingFolder.name}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("sidebar.folderDeleteKeep", { count: deletingFolder.chatCount })}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("sidebar.folderDeleteCascade", { count: deletingFolder.chatCount })}
            </p>
            <div className="flex gap-2 justify-end pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeletingFolder(null)}
              >
                {t("sidebar.menuCancel", "Cancel")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleFolderDeleteConfirm(false)}
              >
                {t("sidebar.folderDeleteKeep", { count: deletingFolder.chatCount })}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => handleFolderDeleteConfirm(true)}
              >
                {t("sidebar.folderDeleteCascade", { count: deletingFolder.chatCount })}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Chat delete confirmation dialog */}
      {deletingChat && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg shadow-lg w-80 p-4 space-y-3">
            <h3 className="text-base font-semibold text-foreground">
              {t("sidebar.deleteChat", "Delete Chat")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("sidebar.deleteChatConfirm", "Are you sure you want to delete this chat and all its messages?")}
            </p>
            <div className="flex gap-2 justify-end pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeletingChat(null)}
              >
                {t("sidebar.menuCancel", "Cancel")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDeleteConfirm}
              >
                {t("sidebar.deleteChatButton", "Delete")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}