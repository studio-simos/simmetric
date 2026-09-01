// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

const CATEGORY_COLORS: Record<string, string> = {
  entities: "#3b82f6",   // blue-500
  concepts: "#8b5cf6",   // violet-500
  decisions: "#10b981",  // emerald-500
  default: "#6b7280",    // gray-500
};

export function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? CATEGORY_COLORS.default ?? "#6b7280";
}

export const GRAPH_COLORS = {
  nodeStroke: "#ffffff",
  nodeStrokeWidth: 2,
  linkStroke: "#9ca3af",
  linkStrokeWidth: 1.5,
  labelColor: "#374151",
  labelDarkColor: "#d1d5db",
  highlightColor: "#f59e0b", // amber-500
};
