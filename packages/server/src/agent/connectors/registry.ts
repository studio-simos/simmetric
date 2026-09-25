// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * @fileoverview Connector skill registry data (Phase 196, MCPO-04 D-04) —
 * a DATA-ONLY module (no imports from agent/skills.ts) so the palette gate
 * in agent/skills.ts can consume it without an import cycle
 * (connectors/skills.ts imports registerSkill from agent/skills.ts; skills.ts
 * must not import that file back).
 *
 * Plan 02 extends CONNECTOR_SKILL_PROVIDERS with the remaining five tools;
 * this map is the single source for the gate's provider resolution.
 *
 * Phase 197 (MCPO-05 D-01) adds the three gmail_* tools, all mapped to
 * provider "google" — the palette gate grows automatically
 * (CONNECTOR_SKILL_NAMES derives from this map; no gate code change).
 */

/** Provider id each connector tool requires an authorized connection for. */
export type ConnectorProvider = "google" | "microsoft";

/**
 * The connector skill registry: tool name → provider whose authorized
 * connection gates availability (palette gate D-04). Skill names are
 * user-visible LLM tool contracts (one-way — keep stable, D-04/D-05).
 */
export const CONNECTOR_SKILL_PROVIDERS: Record<string, ConnectorProvider> = {
  gdrive_search: "google",
  gdrive_read: "google",
  gdrive_ingest: "google",
  graph_mail_search: "microsoft",
  graph_sharepoint_search: "microsoft",
  graph_onedrive_ingest: "microsoft",
  gmail_search: "google",
  gmail_get_thread: "google",
  gmail_ingest_thread: "google",
};

/** The set of connector tool names (palette-gate membership check). */
export const CONNECTOR_SKILL_NAMES: ReadonlySet<string> = new Set(
  Object.keys(CONNECTOR_SKILL_PROVIDERS),
);