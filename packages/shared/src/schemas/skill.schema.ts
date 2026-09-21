// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

/**
 * Phase 190 (SKIL-01..05) — custom prompt-template skill contracts.
 *
 * Single source of truth shared by server (routes/skills.ts + chat.ts
 * skillCall transport) and the frontend (SkillsPage / SkillsPalette).
 * No business logic — pure Zod schemas + inferred types (shared AGENTS.md).
 *
 * Decisions implemented (190-CONTEXT.md):
 *  - D-01: skillMode is the literal "prompt" ONLY (webhook is v0.26 SKIL-F01).
 *  - D-03: prompt config = { template, defaultParams, injectAs } — injectAs is
 *    the literal "user" ONLY (D-12 rejected the system-prompt arm).
 *  - D-04: every {{placeholder}} in the template needs an inputSchema.properties
 *    entry (refine below; a template with zero placeholders needs none).
 *  - D-08: RESERVED_SLUGS = the 5 chat command slugs + the 7 builtin names —
 *    a custom skill can never shadow a command or a builtin registry entry.
 *  - D-11: skillCallSchema rides chatRequestSchema additively (widget path
 *    strips it structurally via widgetChatRequestSchema — Pitfall 6).
 *  - D-14: template static text must not carry cross-provider tool-call syntax
 *    markers (create/update injection-shape gate, T-190-01 — CR-02 extended
 *    the scan to updateSkillSchema); CR-03 adds the spotlight envelope
 *    delimiter markers to the same scan.
 */

/** Slug for the /slash invocation: kebab-case, max 50 (spec §2.2). */
const slugSchema = z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, "Invalid slug");

/**
 * D-08 — slugs a custom skill may never take: the 5 hardcoded chat commands
 * (model/help/clear/reset/new) + the 7 builtin skill names (verbatim from
 * packages/server/src/agent/builtinSkills.ts registrations). Registry-invariant
 * enforcement lives here (create-time) so no custom row can shadow a builtin.
 */
export const RESERVED_SLUGS = [
  "model",
  "help",
  "clear",
  "reset",
  "new",
  "rag_search",
  "memory_search",
  "web_search",
  "workspace_memory",
  "document_temp_process",
  "wiki_query",
  "wiki_write",
] as const;

/** D-05 — three scope levels (per-project rides Workspace → Project, no column). */
const skillScopeSchema = z.enum(["personal", "workspace", "global"]);

/** D-01/D-03 — prompt-mode config. injectAs is the literal "user" ONLY (D-12). */
const promptSkillConfigSchema = z.object({
  template: z.string().min(1).max(50000),
  defaultParams: z.record(z.string(), z.string()).default({}),
  injectAs: z.literal("user").default("user"),
});

/**
 * JSON-Schema-ish input contract: properties keyed by param name (permissive
 * property objects), optional required array, passthrough for JSON-schema
 * extras (type, additionalProperties, …). Defaults to {} so a template
 * without placeholders needs no properties at all (D-04).
 */
const skillInputSchemaSchema = z
  .object({
    properties: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    required: z.array(z.string()).default([]),
  })
  .passthrough()
  .default({ properties: {}, required: [] });

/** Template placeholder extraction — exactly 2 braces around word/hyphen chars. */
const TEMPLATE_PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;

/**
 * D-14 — cross-provider tool-call syntax markers. A template's STATIC text must
 * never attempt to instruct the model to emit tool-call syntax (T-190-01);
 * compiled parameter values are separately DLP-masked / spotlighted (D-12/D-13).
 */
const TOOL_CALL_SYNTAX_MARKERS = ["<function_calls>", "<tool_call>", "⌜"] as const;

/**
 * CR-03 — the D-12 spotlight envelope delimiter markers. An in-band occurrence
 * of either delimiter (verbatim line or the leading `===` run) would let a
 * template's static text — or a substituted param value — spoof the envelope
 * boundary. The create/update marker scan below rejects template static text
 * carrying them; `wrapSpotlightedTemplate` (server skillService) additionally
 * neutralizes any that still arrive via param values (defense-in-depth).
 * Shared here (not imported from the server) so the schema stays a leaf.
 */
const SPOTLIGHT_DELIMITER_MARKERS = [
  "=== BEGIN USER-SUPPLIED",
  "=== END USER-SUPPLIED",
] as const;

/**
 * CR-02/CR-03 — the D-14/D-12 template-injection marker scan, shared by the
 * create AND update refines. Static text = the template with {{placeholders}}
 * stripped (parameter values legitimately pass through DLP masking at chat
 * time; the gate only guards author-authored scaffolding).
 */
function rejectTemplateInjectionMarkers(template: string, ctx: z.RefinementCtx): void {
  const staticText = template.replace(TEMPLATE_PLACEHOLDER_RE, "");
  for (const marker of TOOL_CALL_SYNTAX_MARKERS) {
    if (staticText.includes(marker)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["config", "template"],
        message: "Template must not contain tool-call syntax markers",
      });
      return;
    }
  }
  for (const marker of SPOTLIGHT_DELIMITER_MARKERS) {
    if (staticText.includes(marker)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["config", "template"],
        message: "Template must not contain the spotlight delimiter lines",
      });
      return;
    }
  }
}

export const createSkillSchema = z
  .object({
    slug: slugSchema,
    name: z.string().min(1).max(100),
    description: z.string().min(1).max(2000),
    skillMode: z.literal("prompt"),
    config: promptSkillConfigSchema,
    inputSchema: skillInputSchemaSchema,
    scope: skillScopeSchema.default("personal"),
    workspaceId: z.string().uuid("Invalid workspace ID").optional(),
  })
  .superRefine((data, ctx) => {
    // (a) D-08/WR-05 — reserved slugs are rejected at the schema layer, PLUS
    // the /model prefix family: the ChatPanel Enter handler matches any
    // "/model…" input (handleModelCommand takes the whole "/model" prefix,
    // no word boundary), so slug "model-x" would be captured by the /model
    // branch and the palette would advertise a dead command.
    if (
      (RESERVED_SLUGS as readonly string[]).includes(data.slug) ||
      data.slug.startsWith("model")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slug"],
        message: "This slug is reserved",
      });
    }
    // (b) D-04 — every {{placeholder}} in the template needs a property.
    const placeholders = new Set<string>();
    for (const match of data.config.template.matchAll(TEMPLATE_PLACEHOLDER_RE)) {
      placeholders.add(match[1] as string);
    }
    for (const key of placeholders) {
      if (!(key in data.inputSchema.properties)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["inputSchema", "properties", key],
          message: `Template placeholder {{${key}}} has no matching inputSchema.properties entry`,
        });
      }
    }
    // (c) Scope coherence — workspace scope needs workspaceId; the other two
    // scopes reject a present one (D-05).
    if (data.scope === "workspace" && !data.workspaceId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspaceId"],
        message: "workspaceId is required when scope is 'workspace'",
      });
    }
    if (data.scope !== "workspace" && data.workspaceId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspaceId"],
        message: `workspaceId must be omitted when scope is '${data.scope}'`,
      });
    }
    // (d) D-14/CR-03 — template STATIC text must not carry tool-call syntax
    // markers NOR the spotlight envelope delimiters (shared helper — the
    // update refine reuses the same scan).
    rejectTemplateInjectionMarkers(data.config.template, ctx);
  });

/**
 * PUT /api/skills/:id body — standalone object (NOT .partial() — drops refines
 * per shared AGENTS.md / memory.schema.ts idiom). Template patches re-validate
 * the D-04 placeholder contract; scope/workspaceId edits keep the same
 * coherence rule; slug is immutable (slash-command identity — delete + recreate).
 */
export const updateSkillSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().min(1).max(2000).optional(),
    config: promptSkillConfigSchema.optional(),
    inputSchema: skillInputSchemaSchema.optional(),
    scope: skillScopeSchema.optional(),
    workspaceId: z.string().uuid("Invalid workspace ID").optional(),
  })
  // .strict(): a slug patch must REJECT (slug is the slash-command identity —
  // immutable; delete + recreate is the lifecycle). Zod strips unknown keys by
  // default, which would silently accept (and drop) a slug patch.
  .strict()
  .superRefine((data, ctx) => {
    const template = data.config?.template;
    const inputSchema = data.inputSchema;
    // (d) CR-02 — the D-14/D-12 marker scan on the UPDATE path: a template
    // patch must clear the same injection-shape gate create enforces (the
    // old create-only refine let any owner PUT a <tool_call>/<function_calls>
    // template past the gate). Placeholder stripping is part of the helper.
    if (template !== undefined) {
      rejectTemplateInjectionMarkers(template, ctx);
    }
    // (b) D-04 — only enforceable when the patch carries BOTH sides; a
    // template-only patch keeps the existing inputSchema (route merges it).
    if (template !== undefined && inputSchema !== undefined) {
      for (const match of template.matchAll(TEMPLATE_PLACEHOLDER_RE)) {
        const key = match[1] as string;
        if (!(key in inputSchema.properties)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["inputSchema", "properties", key],
            message: `Template placeholder {{${key}}} has no matching inputSchema.properties entry`,
          });
        }
      }
    }
    // (c) Scope coherence on partial patches.
    const scope = data.scope;
    const workspaceId = data.workspaceId;
    if (scope === "workspace" && workspaceId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspaceId"],
        message: "workspaceId is required when scope is 'workspace'",
      });
    }
    if (scope !== undefined && scope !== "workspace" && workspaceId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspaceId"],
        message: `workspaceId must be omitted when scope is '${scope}'`,
      });
    }
  });

/** POST /api/skills/:id/test body — compiled-prompt preview, no LLM call (D-21). */
export const testSkillSchema = z.object({
  params: z.record(z.string(), z.string().max(50000)).default({}),
});

/**
 * D-11 — the chat-stream transport for an explicit /slug invocation. Rides
 * chatRequestSchema additively. .strict() so unknown keys reject (T-190-01:
 * a crafted body cannot smuggle extra contract through the seam). Params are
 * string-valued only (template replacement contract, D-03).
 */
export const skillCallSchema = z
  .object({
    slug: slugSchema,
    params: z.record(z.string(), z.string().max(50000)).optional(),
  })
  .strict();

/** :id route param guard. */
export const skillIdParamSchema = z.object({
  id: z.string().uuid("Invalid skill ID"),
});