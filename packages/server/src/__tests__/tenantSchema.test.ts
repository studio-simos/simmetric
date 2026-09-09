// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 182 (Tenant Data Model) — schema-shape invariant test.
 *
 * Source-string assertion convention (per bootOrder.test.ts): reads the
 * Prisma schema files as UTF-8 and asserts the tenancy invariants as string
 * checks on per-model blocks. NO DB, NO Prisma client import — the schema
 * FILES are the system under test.
 *
 * Pins (182-CONTEXT.md decisions D-01..D-06 + RESEARCH promise list):
 * 1. D-01/SAAS-01a — User is identity-pure: NO organizationId column,
 *    membership back-relation present.
 * 2. SAAS-01c/D-03 (TS-04) — User.email/username stay GLOBALLY unique.
 * 3. SAAS-01d/D-04 — Role/Permission/RolePermission/RoleMenuSection/UserRole
 *    are global reference data: NO organizationId.
 * 4. SAAS-01b — all 26 promise-list tables carry organizationId (25 non-null
 *    @default zero-UUID + SystemConfig nullable with NO default).
 * 5. D-06 freeze — existing unique constraints byte-identical.
 * 6. New geometry — DlpPattern composite unique, SystemConfig scalar key
 *    unique (Phase 183 deferral), OrganizationMember partial composite.
 * 7. Enterprise fragment — BackupDestination org column; SSO/IdP/SCIM/EventLog org-less.
 * 8. roleInOrg — enum-as-string with owner|admin|member comment pin.
 */

const fs = require("fs");
const path = require("path");

// Module-scope marker (export {}) so tsc treats this file as a module and the
// top-level fs/path binds don't collide with other non-module test files.
export {};

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

function readSchema(fileName: string): string {
  return fs.readFileSync(
    path.resolve(__dirname, "../../prisma", fileName),
    "utf8",
  );
}

/** Split a .prisma source into per-model blocks keyed by model name. */
function extractModelBlocks(src: string): Record<string, string> {
  const blocks: Record<string, string> = {};
  const re = /^model\s+(\w+)\s*\{/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) {
    const start = match.index;
    const openBrace = src.indexOf("{", start);
    let depth = 0;
    let end = src.length;
    for (let i = openBrace; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    blocks[match[1]!] = src.slice(start, end);
  }
  return blocks;
}

const schemaSrc = readSchema("schema.prisma");
const enterpriseSrc = readSchema("schema-enterprise.prisma");
const schemaModels = extractModelBlocks(schemaSrc);
const enterpriseModels = extractModelBlocks(enterpriseSrc);

// SAAS-01b promise list — 26 tables (25 non-null + system_config nullable).
// Table @@map names per 182-RESEARCH "The Promise List".
const PROMISE_LIST_TABLES: Array<{ model: string; table: string }> = [
  { model: "Project", table: "projects" },
  { model: "Workspace", table: "workspaces" },
  { model: "WorkspaceAccess", table: "workspace_access" },
  { model: "ProjectAccess", table: "project_access" },
  { model: "Provider", table: "providers" },
  { model: "ProviderModel", table: "provider_models" },
  { model: "Archive", table: "archives" },
  { model: "Widget", table: "widgets" },
  { model: "WidgetWorkspace", table: "widget_workspaces" },
  { model: "WorkspaceTemplate", table: "workspace_templates" },
  { model: "DlpPattern", table: "dlp_patterns" },
  { model: "Webhook", table: "webhooks" },
  { model: "WorkspaceTokenUsage", table: "workspace_token_usage" },
  { model: "ApiKey", table: "api_keys" },
  { model: "WorkspaceAgentConfig", table: "workspace_agent_configs" },
  { model: "Chat", table: "chats" },
  { model: "ChatMessage", table: "chat_messages" },
  { model: "ChatFolder", table: "chat_folders" },
  { model: "Document", table: "documents" },
  { model: "UploadDraft", table: "upload_drafts" },
  { model: "OcrJob", table: "ocr_jobs" },
  { model: "ArchiveImportJob", table: "archive_import_jobs" },
  { model: "SynthesisRun", table: "synthesis_runs" },
  { model: "MCPConnection", table: "mcp_connections" },
  { model: "PushSubscription", table: "push_subscriptions" },
  { model: "SystemConfig", table: "system_config" },
];

describe("tenant schema — D-01 user identity purity (SAAS-01a)", () => {
  const userBlock = schemaModels["User"] ?? "";

  test("User model block exists", () => {
    expect(userBlock).not.toBe("");
  });

  test("User carries NO organizationId column (D-01: identity-pure)", () => {
    expect(userBlock).not.toMatch(/^\s*organizationId\s/m);
  });

  test("User carries the membership back-relation", () => {
    expect(userBlock).toContain("organizationMemberships OrganizationMember[]");
  });
});

describe("tenant schema — TS-04 global identity uniques (SAAS-01c/D-03)", () => {
  const userBlock = schemaModels["User"] ?? "";

  test("User.email stays scalar @unique", () => {
    expect(userBlock).toMatch(/^\s*email\s+String\s+@unique\s*$/m);
  });

  test("User.username stays scalar @unique", () => {
    expect(userBlock).toMatch(/^\s*username\s+String\s+@unique\s*$/m);
  });

  test("User has NO composite unique containing email or username", () => {
    expect(userBlock).not.toMatch(/@@unique\(\[[^\]]*(email|username)/);
  });
});

describe("tenant schema — Role family stays global (SAAS-01d/D-04)", () => {
  test.each(["Role", "Permission", "RolePermission", "RoleMenuSection", "UserRole"])(
    "%s block contains NO organizationId",
    (modelName) => {
      const block = schemaModels[modelName] ?? "";
      expect(block).not.toBe("");
      expect(block).not.toMatch(/^\s*organizationId\s/m);
    },
  );
});

describe("tenant schema — promise-list org columns (SAAS-01b)", () => {
  test("promise list has exactly 26 tables", () => {
    expect(PROMISE_LIST_TABLES).toHaveLength(26);
  });

  test.each(
    PROMISE_LIST_TABLES.filter((t) => t.model !== "SystemConfig").map((t) => [t.model, t.table] as const),
  )("%s declares non-null organizationId with the zero-UUID default", (modelName) => {
    const block = schemaModels[modelName] ?? "";
    expect(block).not.toBe("");
    expect(block).toMatch(
      new RegExp(`^\\s*organizationId\\s+String\\s+@default\\("${ZERO_UUID}"\\)`, "m"),
    );
  });

  test("system_config declares nullable organizationId with NO default", () => {
    const block = schemaModels["SystemConfig"] ?? "";
    expect(block).toMatch(/^\s*organizationId\s+String\?\s*$/m);
    // NO @default on the nullable column — the global-row geometry
    // (Tier A′) must not silently pin a default org.
    expect(block).not.toMatch(/organizationId\s+String\?[^\n]*@default/);
  });
});

describe("tenant schema — D-06 unique freeze", () => {
  test("Project keeps @@unique([createdBy, name]) with no organizationId", () => {
    expect(schemaModels["Project"]).toContain("@@unique([createdBy, name])");
    expect(schemaModels["Project"]).not.toMatch(/@@unique\(\[[^\]]*organizationId/);
  });

  test("Workspace keeps @@unique([projectId, name]) with no organizationId", () => {
    expect(schemaModels["Workspace"]).toContain("@@unique([projectId, name])");
    expect(schemaModels["Workspace"]).not.toMatch(/@@unique\(\[[^\]]*organizationId/);
  });

  test("Archive keeps @@unique([createdBy, name]) and global slug @unique", () => {
    expect(schemaModels["Archive"]).toContain("@@unique([createdBy, name])");
    expect(schemaModels["Archive"]).toMatch(/^\s*slug\s+String\s+@unique\s*$/m);
  });

  test("ProviderModel keeps @@unique([providerId, name])", () => {
    expect(schemaModels["ProviderModel"]).toContain("@@unique([providerId, name])");
  });

  test("ApiKey keeps prefix @unique and key_hash @unique", () => {
    expect(schemaModels["ApiKey"]).toMatch(/^\s*prefix\s+String\s+@unique/m);
    expect(schemaModels["ApiKey"]).toMatch(/^\s*key_hash\s+String\s+@unique/m);
  });

  test("WorkspaceTemplate keeps global slug @unique", () => {
    expect(schemaModels["WorkspaceTemplate"]).toMatch(/^\s*slug\s+String\s+@unique/m);
  });

  test("Document keeps cacheKey @unique", () => {
    expect(schemaModels["Document"]).toMatch(/^\s*cacheKey\s+String\s+@unique/m);
  });
});

describe("tenant schema — new unique geometry (D-05/D-06/Phase 183 deferral)", () => {
  test("DlpPattern has the composite @@unique([organizationId, name])", () => {
    expect(schemaModels["DlpPattern"]).toContain("@@unique([organizationId, name])");
  });

  test("DlpPattern no longer carries the scalar name @unique", () => {
    expect(schemaModels["DlpPattern"]).not.toMatch(/^\s*name\s+String\s+@unique\s*$/m);
  });

  test("system_config carries the composite @@unique([organizationId, key]) (Phase 183 M5 D-08 swap — deferral fulfilled)", () => {
    expect(schemaModels["SystemConfig"]).toContain("@@unique([organizationId, key]");
  });

  test("system_config no longer carries the scalar key @unique (D-08 one-way swap)", () => {
    expect(schemaModels["SystemConfig"]).not.toMatch(/^\s*key\s+String\s+@unique\s*$/m);
  });

  test("system_config carries the P1 partial unique (key WHERE organizationId IS NULL) — checkpoint ADOPT verdict", () => {
    expect(schemaModels["SystemConfig"]).toContain(
      '@@unique([key], map: "system_config_key_key_null_org", where: { organizationId: null })',
    );
  });

  test("organization_members carries the partial composite @@unique([organizationId, userId], where: { deletedAt: null })", () => {
    expect(schemaModels["OrganizationMember"]).toContain(
      "@@unique([organizationId, userId], where: { deletedAt: null })",
    );
  });

  test("organization_members carries @@index([userId]) and @@index([organizationId])", () => {
    expect(schemaModels["OrganizationMember"]).toContain("@@index([userId])");
    expect(schemaModels["OrganizationMember"]).toContain("@@index([organizationId])");
  });

  test("generator enables the partialIndexes preview flag (D-05 spike)", () => {
    expect(schemaSrc).toContain('previewFeatures = ["partialIndexes"]');
  });
});

describe("tenant schema — enterprise fragment (BackupDestination + org-less auth surfaces)", () => {
  test("backup_destinations declares non-null organizationId with the zero-UUID default", () => {
    expect(enterpriseModels["BackupDestination"]).toMatch(
      new RegExp(`^\\s*organizationId\\s+String\\s+@default\\("${ZERO_UUID}"\\)`, "m"),
    );
  });

  test.each(["SsoConfig", "IdentityProvider", "ScimGroup", "EventLog"])(
    "%s stays org-less (D-03 auth-subsystem freeze)",
    (modelName) => {
      const block = enterpriseModels[modelName] ?? "";
      expect(block).not.toBe("");
      expect(block).not.toMatch(/^\s*organizationId\s/m);
    },
  );
});

describe("tenant schema — roleInOrg geometry", () => {
  test("organization_members declares roleInOrg String @default(\"member\")", () => {
    expect(schemaModels["OrganizationMember"]).toMatch(
      /^\s*roleInOrg\s+String\s+@default\("member"\)/m,
    );
  });

  test("roleInOrg comment pins the owner | admin | member value set", () => {
    expect(schemaModels["OrganizationMember"]).toMatch(/owner \| admin \| member/);
  });
});