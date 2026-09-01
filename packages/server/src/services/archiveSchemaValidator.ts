// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Archive Schema Validator — validates page content against archive schema rules.
 *
 * Distinguishes human writes (blocks on errors) from agent writes (warnings only).
 * Link density is always warning-only (never blocking).
 */

import matter from "gray-matter";
import type { ArchiveConfigInput } from "@simmetric-chat/shared";

interface Violation {
  rule: string;
  severity: "error" | "warning";
  message: string;
  field?: string;
}

export interface ValidationResult {
  valid: boolean;
  violations: Violation[];
  warnings: Violation[];
}

/**
 * Validate page content (markdown with frontmatter) against archive schema rules.
 *
 * @param content — raw markdown string (may include YAML frontmatter)
 * @param config — archive schema config
 * @param source — "human" or "agent"; determines whether errors become violations or warnings
 */
export function validatePageContent(
  content: string,
  config: ArchiveConfigInput | undefined,
  source: "human" | "agent",
): ValidationResult {
  const result: ValidationResult = { valid: true, violations: [], warnings: [] };
  if (!config) return result;

  const parsed = matter(content);
  const frontmatter = parsed.data || {};
  const body = parsed.content || "";

  // Required frontmatter fields
  if (config.requiredFrontmatter) {
    for (const [key, rule] of Object.entries(config.requiredFrontmatter)) {
      if (rule.required && (frontmatter[key] === undefined || frontmatter[key] === null)) {
        const issue: Violation = {
          rule: "frontmatter_required",
          severity: "error",
          message: `Missing required frontmatter: ${key}`,
          field: key,
        };
        if (source === "human") {
          result.violations.push(issue);
        } else {
          result.warnings.push(issue);
        }
      }
    }
  }

  // Link density check (always warning, never blocking)
  if (config.linkingDensity) {
    const wikilinks = (body.match(/\[\[[^\]]+\]\]/g) || []).length;
    const wordCount = body.split(/\s+/).filter(Boolean).length;
    const density = wordCount > 0 ? wikilinks / wordCount : 0;
    if (density < config.linkingDensity.min) {
      result.warnings.push({
        rule: "link_density",
        severity: "warning",
        message: `Link density ${density.toFixed(3)} below minimum ${config.linkingDensity.min}`,
      });
    }
    if (density > config.linkingDensity.max) {
      result.warnings.push({
        rule: "link_density",
        severity: "warning",
        message: `Link density ${density.toFixed(3)} above maximum ${config.linkingDensity.max}`,
      });
    }
  }

  // Lint rules
  if (config.lintRules) {
    for (const lintRule of config.lintRules) {
      // Section required rules
      if (lintRule.type === "section_required" && lintRule.config) {
        const cfg = lintRule.config as { section: string };
        const escaped = cfg.section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const hasSection = new RegExp(`^##\\s+${escaped}(\\s|$)`, "m").test(body);
        if (!hasSection) {
          const issue: Violation = {
            rule: "section_required",
            severity: lintRule.severity,
            message: `Missing required section: ${cfg.section}`,
            field: cfg.section,
          };
          if (lintRule.severity === "error" && source === "human") {
            result.violations.push(issue);
          } else {
            result.warnings.push(issue);
          }
        }
      }

      // Naming convention rule
      if (lintRule.type === "naming_convention" && lintRule.config) {
        const cfg = lintRule.config as { pattern: string; message: string };
        const issue: Violation = {
          rule: "naming_convention",
          severity: lintRule.severity,
          message: cfg.message,
          field: "slug",
        };
        if (lintRule.severity === "error" && source === "human") {
          result.violations.push(issue);
        } else {
          result.warnings.push(issue);
        }
      }
    }
  }

  result.valid = result.violations.length === 0;
  return result;
}

/**
 * Validate a page slug against the archive naming convention.
 *
 * @param slug — page slug (e.g. "my-page-title")
 * @param config — archive schema config
 */
export function validateSlugAgainstConvention(
  slug: string,
  config: ArchiveConfigInput | undefined,
): ValidationResult {
  const result: ValidationResult = { valid: true, violations: [], warnings: [] };
  if (!config?.namingConvention) return result;

  const regex = new RegExp(config.namingConvention.pattern);
  if (!regex.test(slug)) {
    const issue: Violation = {
      rule: "naming_convention",
      severity: "error",
      message: config.namingConvention.message,
      field: "slug",
    };
    result.violations.push(issue);
    result.valid = false;
  }

  return result;
}
