// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Archive Schema Templates Service — manage schema templates and apply them to archives.
 *
 * Note (KB-02 audit, D-09): ArchiveSchemaTemplate (schema.prisma ~line 886-899) does NOT
 * have a `deletedAt` field — it is not soft-deletable. The queries below intentionally do
 * NOT filter by `deletedAt: null`. Adding such a filter would cause Prisma to reject the
 * query with an "Unknown field `deletedAt`" error (column does not exist on the table).
 * Confirmed per Phase 64 RESEARCH.md Pitfall 6 — accepted disposition, no mitigation needed.
 */

import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import type { ArchiveConfigInput, ArchiveSchemaTemplateInput } from "@simmetric-chat/shared";

/**
 * List all schema templates, optionally filtered by archiveId.
 * Built-in templates (isBuiltIn=true) are always included.
 */
export async function listTemplates(archiveId?: string) {
  return prisma.archiveSchemaTemplate.findMany({
    where: {
      OR: [{ archiveId: null }, { archiveId: archiveId || undefined }],
    },
    orderBy: [{ isBuiltIn: "desc" }, { name: "asc" }],
  });
}

/**
 * Get a single template by ID.
 */
export async function getTemplate(id: string) {
  return prisma.archiveSchemaTemplate.findUnique({ where: { id } });
}

/**
 * Create a new schema template.
 */
export async function createTemplate(data: ArchiveSchemaTemplateInput & { archiveId?: string }) {
  return prisma.archiveSchemaTemplate.create({
    data: {
      name: data.name,
      description: data.description || null,
      config: data.config as Prisma.InputJsonValue,
      pageTypes: data.pageTypes !== undefined ? (data.pageTypes as Prisma.InputJsonValue) : undefined,
      archiveId: data.archiveId || null,
    },
  });
}

/**
 * Apply a template's config to an archive's ArchiveConfig record.
 */
export async function applyTemplate(archiveId: string, templateId: string) {
  const template = await prisma.archiveSchemaTemplate.findUnique({ where: { id: templateId } });
  if (!template) throw new Error("Template not found");

  await prisma.archiveConfig.upsert({
    where: { archiveId },
    create: { archiveId, config: template.config as Prisma.InputJsonValue },
    update: { config: template.config as Prisma.InputJsonValue },
  });

  return template;
}

/**
 * Seed built-in schema templates if none exist.
 * Safe to call multiple times (idempotent).
 */
export async function seedBuiltInTemplates() {
  const existing = await prisma.archiveSchemaTemplate.findMany({ where: { isBuiltIn: true } });
  if (existing.length > 0) return existing;

  const templates: Array<{
    name: string;
    description: string;
    config: ArchiveConfigInput;
    pageTypes: Array<{ name: string; requiredSections: string[]; optionalSections: string[] }>;
  }> = [
    {
      name: "Research",
      description: "Template for academic and research knowledge bases.",
      config: {
        namingConvention: { pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", message: "Slug must be kebab-case lowercase alphanumeric." },
        requiredFrontmatter: {
          title: { type: "string", required: true },
          author: { type: "string", required: true },
          date: { type: "string", required: true },
          tags: { type: "string", required: false },
        },
        lintRules: [
          { type: "section_required", severity: "error", config: { section: "Abstract" } },
          { type: "section_required", severity: "warning", config: { section: "References" } },
        ],
        linkingDensity: { min: 0.01, max: 0.15 },
        agentPersona: "conservative",
        purpose: "Organize research papers, experiments, and literature reviews.",
      },
      pageTypes: [
        { name: "Paper", requiredSections: ["Abstract", "Methodology", "Results"], optionalSections: ["References", "Appendix"] },
        { name: "Experiment", requiredSections: ["Hypothesis", "Methodology", "Results"], optionalSections: ["Conclusion"] },
      ],
    },
    {
      name: "Project",
      description: "Template for software project documentation and decision records.",
      config: {
        namingConvention: { pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", message: "Slug must be kebab-case lowercase alphanumeric." },
        requiredFrontmatter: {
          title: { type: "string", required: true },
          status: { type: "string", required: true },
          date: { type: "string", required: true },
        },
        lintRules: [
          { type: "section_required", severity: "error", config: { section: "Context" } },
          { type: "section_required", severity: "warning", config: { section: "Decision" } },
        ],
        linkingDensity: { min: 0.02, max: 0.2 },
        agentPersona: "balanced",
        purpose: "Track ADRs, RFCs, and project documentation.",
      },
      pageTypes: [
        { name: "ADR", requiredSections: ["Context", "Decision", "Consequences"], optionalSections: ["Alternatives"] },
        { name: "RFC", requiredSections: ["Summary", "Motivation"], optionalSections: ["Design", "Timeline"] },
      ],
    },
    {
      name: "Personal",
      description: "Template for personal knowledge management and journaling.",
      config: {
        namingConvention: { pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", message: "Slug must be kebab-case lowercase alphanumeric." },
        requiredFrontmatter: {
          title: { type: "string", required: true },
          date: { type: "string", required: false },
          tags: { type: "string", required: false },
        },
        lintRules: [
          { type: "section_required", severity: "warning", config: { section: "Summary" } },
        ],
        linkingDensity: { min: 0.005, max: 0.25 },
        agentPersona: "exploratory",
        purpose: "Flexible PKM with light structure.",
      },
      pageTypes: [
        { name: "Journal", requiredSections: [], optionalSections: ["Summary", "Reflection"] },
        { name: "Note", requiredSections: [], optionalSections: ["Summary", "Links"] },
      ],
    },
  ];

  const created = [];
  for (const t of templates) {
    const record = await prisma.archiveSchemaTemplate.create({
      data: {
        name: t.name,
        description: t.description,
        config: t.config as Prisma.InputJsonValue,
        pageTypes: t.pageTypes as Prisma.InputJsonValue,
        isBuiltIn: true,
        archiveId: null,
      },
    });
    created.push(record);
  }

  return created;
}
