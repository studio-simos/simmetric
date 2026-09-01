// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";
import prisma from "../utils/prisma";

export interface TemplateConfig {
  slug: string;
  name: string;
  description: string;
  icon: string;
  systemPrompt: string;
  skills: string[];
  parsingConfig: {
    ocrRequired?: boolean;
    [key: string]: unknown;
  };
  constraints: {
    localLLMOnly?: boolean;
    hybridSearchForced?: boolean;
    citationRequired?: boolean;
    [key: string]: unknown;
  };
  embeddingModel?: string;
}

const TEMPLATES_DIR = path.join(__dirname, "..", "templates");

/** Load all built-in template JSON files from disk */
function loadBuiltinTemplates(): TemplateConfig[] {
  const templates: TemplateConfig[] = [];
  try {
    const files = fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, file), "utf-8");
        const config: TemplateConfig = JSON.parse(raw);
        templates.push(config);
      } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[templates] Failed to load ${file}: ${message}`);
      }
    }
  } catch {
    // templates directory doesn't exist yet
  }
  return templates;
}

/**
 * Seed built-in templates into the database.
 * Called on server startup. Updates existing templates if the JSON config changed.
 */
export async function seedTemplates(): Promise<void> {
  const builtins = loadBuiltinTemplates();

  for (const tmpl of builtins) {
    await prisma.workspaceTemplate.upsert({
      where: { slug: tmpl.slug },
      update: {
        name: tmpl.name,
        description: tmpl.description ?? null,
        icon: tmpl.icon ?? null,
        systemPrompt: tmpl.systemPrompt,
        skills: JSON.stringify(tmpl.skills),
        parsingConfig: JSON.stringify(tmpl.parsingConfig),
        constraints: JSON.stringify(tmpl.constraints),
        embeddingModel: tmpl.embeddingModel ?? null,
        isBuiltIn: true,
      },
      create: {
        slug: tmpl.slug,
        name: tmpl.name,
        description: tmpl.description ?? null,
        icon: tmpl.icon ?? null,
        systemPrompt: tmpl.systemPrompt,
        skills: JSON.stringify(tmpl.skills),
        parsingConfig: JSON.stringify(tmpl.parsingConfig),
        constraints: JSON.stringify(tmpl.constraints),
        embeddingModel: tmpl.embeddingModel ?? null,
        isBuiltIn: true,
      },
    });
  }

  logger.info(`[templates] Seeded ${builtins.length} built-in templates`);
}

/**
 * Get a template's constraints and config by workspace ID.
 * Returns null if the workspace has no template.
 */
export async function getTemplateForWorkspace(workspaceId: string): Promise<TemplateConfig | null> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: { template: true },
  });

  if (!workspace?.template) return null;

  return deserializeTemplate(workspace.template);
}

/**
 * Get all templates (built-in + custom) from the database.
 */
export async function listTemplates() {
  return prisma.workspaceTemplate.findMany({
    orderBy: [{ isBuiltIn: "desc" as const }, { name: "asc" as const }],
  });
}

/**
 * Get a single template by ID.
 */
export async function getTemplateById(id: string) {
  return prisma.workspaceTemplate.findUnique({ where: { id } });
}

/**
 * Resolve the effective system prompt for a workspace.
 * If the workspace has a template, use the template's system prompt
 * unless the workspace has a custom override in its agentConfig.
 */
export async function resolveSystemPrompt(
  workspaceId: string,
  agentConfigSystemPrompt: string
): Promise<string> {
  // If the agentConfig has a non-default system prompt, use it
  if (agentConfigSystemPrompt && agentConfigSystemPrompt !== "You are a helpful AI assistant with access to workspace documents and tools.") {
    return agentConfigSystemPrompt;
  }

  // Otherwise, use the template's system prompt if available
  const template = await getTemplateForWorkspace(workspaceId);
  if (template) {
    return template.systemPrompt;
  }

  return agentConfigSystemPrompt;
}

/**
 * Resolve the effective skills for a workspace.
 * If the workspace has a template, use the template's skills
 * unless the agentConfig has custom skills.
 */
export async function resolveSkills(
  workspaceId: string,
  agentConfigSkills: string[]
): Promise<string[]> {
  const template = await getTemplateForWorkspace(workspaceId);
  if (template && template.skills.length > 0) {
    // Use template skills as defaults, agentConfig can override
    if (agentConfigSkills.length > 0) {
      // Merge: template skills first, then any additional from agentConfig
      const merged = [...new Set([...template.skills, ...agentConfigSkills])];
      return merged;
    }
    return template.skills;
  }
  return agentConfigSkills;
}

/**
 * Save a template config as a JSON file to the templates directory.
 * This makes custom templates persist across DB resets since seedTemplates()
 * reads all .json files from the templates directory on startup.
 */
export function saveTemplateToFile(config: TemplateConfig): void {
  const filePath = path.join(TEMPLATES_DIR, `${config.slug}.json`);
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  logger.info(`[templates] Saved template file: ${filePath}`);
}

/** Deserialize a DB template row into a TemplateConfig */
function deserializeTemplate(row: {
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  systemPrompt: string;
  skills: string;
  parsingConfig: string;
  constraints: string;
  embeddingModel: string | null;
}): TemplateConfig {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description ?? "",
    icon: row.icon ?? "📋",
    systemPrompt: row.systemPrompt,
    skills: JSON.parse(row.skills),
    parsingConfig: JSON.parse(row.parsingConfig),
    constraints: JSON.parse(row.constraints),
    embeddingModel: row.embeddingModel ?? undefined,
  };
}