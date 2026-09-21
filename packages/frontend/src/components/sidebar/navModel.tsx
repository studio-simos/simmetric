// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * navModel — the shared navigation group model (UI revision R-6).
 *
 * Extracted from AppNavOverlay (R-5): the five nav groups (overview /
 * chatTools / knowledge / platform / system) with the exact RBAC gating the
 * sidebar had — same `menuSections` filter, same `isAdmin` gates, same
 * enterprise lock flags. Consumed by BOTH the AppNavOverlay dialog and the
 * persistent AppSidebarNav so the two surfaces can never drift.
 */

import type { ReactNode } from "react";
import {
  LayoutGrid,
  MessageSquare,
  FileText,
  BookOpen,
  Layers,
  FolderKanban,
  Store,
  BarChart3,
  ScrollText,
  Shield,
  Upload,
  Settings,
  Lock,
  Wrench,
} from "lucide-react";

export interface NavEntry {
  id: string;
  labelKey: string;
  keywords: string;
  icon: ReactNode;
  path: string;
  locked?: boolean;
}

export interface NavGroup {
  id: string;
  labelKey: string;
  entries: NavEntry[];
}

export interface BuildNavGroupsParams {
  menuSections: string[];
  isAdmin: boolean;
  isEnterprise: boolean;
}

/** Small monochrome lock indicator (replaces the 🔒 emoji in labels). */
export function LockBadge() {
  return <Lock className="w-3 h-3 text-muted-foreground flex-none" aria-hidden="true" />;
}

/**
 * Sidebar active-path convention: exact match or a child route
 * (`pathname === path || pathname.startsWith(path + "/")`).
 */
export function isActiveNavPath(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(path + "/");
}

/**
 * Build the RBAC-filtered nav groups. Byte-identical semantics to the
 * AppNavOverlay group builder this was extracted from: `menuSections`
 * filters every entry, `isAdmin` gates SSO, `isEnterprise` clears the
 * lock flags (widget / analytics / eventLog / sso).
 */
export function buildNavGroups({
  menuSections,
  isAdmin,
  isEnterprise,
}: BuildNavGroupsParams): NavGroup[] {
  const list: NavGroup[] = [];
  if (menuSections.includes("dashboard")) {
    list.push({
      id: "overview",
      labelKey: "sidebar.group.overview",
      entries: [
        {
          id: "dashboard",
          labelKey: "sidebar.dashboard",
          keywords: "dashboard home overview",
          icon: <LayoutGrid className="w-4 h-4" />,
          path: "/dashboard",
        },
      ],
    });
  }
  const chatEntries: NavEntry[] = [
    {
      id: "chat",
      labelKey: "sidebar.chat",
      keywords: "chat conversations messages",
      icon: <MessageSquare className="w-4 h-4" />,
      path: "/",
    },
  ];
  if (menuSections.includes("projects")) {
    chatEntries.push({
      id: "projects",
      labelKey: "sidebar.projects",
      keywords: "projects management",
      icon: <FolderKanban className="w-4 h-4" />,
      path: "/projects",
    });
  }
  if (menuSections.includes("workspaces")) {
    chatEntries.push({
      id: "workspaces",
      labelKey: "sidebar.workspaces",
      keywords: "workspaces management",
      icon: <Layers className="w-4 h-4" />,
      path: "/workspaces",
    });
  }
  // Phase 190 (SKIL-01, D-19) — skills entry in the chatTools group AFTER
  // workspaces; gated by the "skills" menu section (Plan 01 addition).
  if (menuSections.includes("skills")) {
    chatEntries.push({
      id: "skills",
      labelKey: "sidebar.skills",
      keywords: "skills commands prompts templates",
      icon: <Wrench className="w-4 h-4" />,
      path: "/skills",
    });
  }
  list.push({ id: "chatTools", labelKey: "sidebar.group.chatTools", entries: chatEntries });

  const knowledgeEntries: NavEntry[] = [];
  if (menuSections.includes("documents")) {
    knowledgeEntries.push({
      id: "documents",
      labelKey: "sidebar.documents",
      keywords: "documents files viewer",
      icon: <FileText className="w-4 h-4" />,
      path: "/documents",
    });
  }
  if (menuSections.includes("knowledgeBase")) {
    knowledgeEntries.push({
      id: "knowledgeBase",
      labelKey: "sidebar.knowledgeBase",
      keywords: "knowledge base wiki archives",
      icon: <BookOpen className="w-4 h-4" />,
      path: "/knowledge-base",
    });
  }
  if (menuSections.includes("uploads")) {
    knowledgeEntries.push({
      id: "uploads",
      labelKey: "sidebar.uploads",
      keywords: "uploads files ocr",
      icon: <Upload className="w-4 h-4" />,
      path: "/uploads",
    });
  }
  if (knowledgeEntries.length > 0) {
    list.push({ id: "knowledge", labelKey: "sidebar.group.knowledge", entries: knowledgeEntries });
  }

  const platformEntries: NavEntry[] = [];
  if (menuSections.includes("widget")) {
    platformEntries.push({
      id: "widget",
      labelKey: "sidebar.widget",
      keywords: "widgets embed chat",
      icon: <LayoutGrid className="w-4 h-4" />,
      path: "/widgets",
      locked: !isEnterprise,
    });
  }
  if (menuSections.includes("marketplace")) {
    platformEntries.push({
      id: "marketplace",
      labelKey: "sidebar.marketplace",
      keywords: "marketplace mcp servers catalog",
      icon: <Store className="w-4 h-4" />,
      path: "/mcp-marketplace",
    });
  }
  if (menuSections.includes("analytics")) {
    platformEntries.push({
      id: "analytics",
      labelKey: "sidebar.analytics",
      keywords: "analytics stats usage charts",
      icon: <BarChart3 className="w-4 h-4" />,
      path: "/analytics",
      locked: !isEnterprise,
    });
  }
  if (platformEntries.length > 0) {
    list.push({ id: "platform", labelKey: "sidebar.group.platform", entries: platformEntries });
  }

  const systemEntries: NavEntry[] = [];
  if (menuSections.includes("eventLog")) {
    systemEntries.push({
      id: "eventLog",
      labelKey: "sidebar.eventLog",
      keywords: "event log audit logs",
      icon: <ScrollText className="w-4 h-4" />,
      path: "/logs",
      locked: !isEnterprise,
    });
  }
  if (isAdmin) {
    systemEntries.push({
      id: "sso",
      labelKey: "sidebar.sso",
      keywords: "sso saml oidc authentication",
      icon: <Shield className="w-4 h-4" />,
      path: "/sso",
      locked: !isEnterprise,
    });
  }
  if (menuSections.includes("settings")) {
    systemEntries.push({
      id: "settings",
      labelKey: "sidebar.settings",
      keywords: "settings preferences configuration",
      icon: <Settings className="w-4 h-4" />,
      path: "/settings",
    });
  }
  if (systemEntries.length > 0) {
    list.push({ id: "system", labelKey: "sidebar.group.system", entries: systemEntries });
  }
  return list;
}