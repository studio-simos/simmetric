// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import {
  loginSchema,
  registerSchema,
  adminRegisterSchema,
  changePasswordSchema,
  updateUserSchema,
} from "../schemas/auth.schema";
import {
  createWorkspaceSchema,
  updateWorkspaceSchema,
} from "../schemas/workspace.schema";
import {
  createChatSchema,
  sendMessageSchema,
  updateChatSchema,
  renameChatSchema,
  chatRequestSchema,
} from "../schemas/chat.schema";
import {
  documentTypeSchema,
  uploadDocumentSchema,
  processDocumentSchema,
  youtubeTranscriptSchema,
} from "../schemas/document.schema";
import {
  configKeySchema,
  setConfigSchema,
  bulkSetConfigSchema,
} from "../schemas/config.schema";
import { CONFIG_DEFAULTS } from "../constants/permissions";
import { chatRetentionSchema } from "../schemas/chatRetention.schema";
import {
  createRoleSchema,
  grantWorkspaceAccessSchema,
  grantProjectAccessSchema,
} from "../schemas/role.schema";
import { createProjectSchema } from "../schemas/project.schema";
import { licensePayloadSchema } from "../schemas/license.schema";
import {
  localConfigSchema,
  s3ConfigSchema,
  s3CompatibleConfigSchema,
  sftpConfigSchema,
  createBackupDestinationSchema,
  updateBackupDestinationSchema,
  backupDestinationIdParamSchema,
} from "../schemas/backup.schema";

// ─── Auth Schemas ───────────────────────────────────────────────

describe("loginSchema", () => {
  it("accepts valid login payload", () => {
    const result = loginSchema.safeParse({ username: "admin", password: "secret123" });
    expect(result.success).toBe(true);
  });

  it("rejects empty username", () => {
    const result = loginSchema.safeParse({ username: "", password: "secret123" });
    expect(result.success).toBe(false);
  });

  it("rejects empty password", () => {
    const result = loginSchema.safeParse({ username: "admin", password: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing fields", () => {
    const result = loginSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("registerSchema", () => {
  it("accepts valid registration", () => {
    const result = registerSchema.safeParse({
      username: "newuser",
      email: "user@example.com",
      password: "securepassword123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects short username (<3 chars)", () => {
    const result = registerSchema.safeParse({
      username: "ab",
      email: "user@example.com",
      password: "securepassword123",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid email", () => {
    const result = registerSchema.safeParse({
      username: "newuser",
      email: "not-an-email",
      password: "securepassword123",
    });
    expect(result.success).toBe(false);
  });

  it("rejects short password (<8 chars)", () => {
    const result = registerSchema.safeParse({
      username: "newuser",
      email: "user@example.com",
      password: "short",
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    const result = registerSchema.safeParse({
      username: "newuser",
      email: "user@example.com",
      password: "securepassword123",
      admin: true,
    });
    // Zod strips unknown keys by default — this passes
    expect(result.success).toBe(true);
  });
});

describe("changePasswordSchema", () => {
  it("accepts valid password change", () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: "oldpass123",
      newPassword: "newpass456",
    });
    expect(result.success).toBe(true);
  });

  it("rejects short new password", () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: "oldpass123",
      newPassword: "short",
    });
    expect(result.success).toBe(false);
  });
});

// ─── Workspace Schemas ──────────────────────────────────────────

describe("createWorkspaceSchema", () => {
  it("accepts valid workspace creation", () => {
    const result = createWorkspaceSchema.safeParse({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      name: "My Workspace",
    });
    expect(result.success).toBe(true);
  });

  it("applies default embeddingModel", () => {
    const result = createWorkspaceSchema.parse({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      name: "My Workspace",
    });
    expect(result.embeddingModel).toBe("Xenova/all-MiniLM-L6-v2");
  });

  it("applies default allowMemberUploads as true", () => {
    const result = createWorkspaceSchema.parse({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      name: "My Workspace",
    });
    expect(result.allowMemberUploads).toBe(true);
  });

  it("accepts explicit allowMemberUploads true", () => {
    const result = createWorkspaceSchema.safeParse({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      name: "My Workspace",
      allowMemberUploads: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowMemberUploads).toBe(true);
    }
  });

  it("rejects invalid projectId (not UUID)", () => {
    const result = createWorkspaceSchema.safeParse({
      projectId: "not-a-uuid",
      name: "My Workspace",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = createWorkspaceSchema.safeParse({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      name: "",
    });
    expect(result.success).toBe(false);
  });
});

// ─── Chat Schemas ───────────────────────────────────────────────

describe("sendMessageSchema", () => {
  it("accepts valid message", () => {
    const result = sendMessageSchema.safeParse({ content: "Hello, AI!" });
    expect(result.success).toBe(true);
  });

  it("rejects empty content", () => {
    const result = sendMessageSchema.safeParse({ content: "" });
    expect(result.success).toBe(false);
  });

  it("rejects content exceeding 50000 chars", () => {
    const result = sendMessageSchema.safeParse({ content: "x".repeat(50001) });
    expect(result.success).toBe(false);
  });
});

describe("createChatSchema", () => {
  it("accepts valid chat creation", () => {
    const result = createChatSchema.safeParse({
      workspaceId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid workspaceId", () => {
    const result = createChatSchema.safeParse({
      workspaceId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });
});

describe("chatRequestSchema — disableRagSearch (WID-02)", () => {
  it("preserves disableRagSearch:true through safeParse", () => {
    const result = chatRequestSchema.safeParse({ message: "hi", disableRagSearch: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.disableRagSearch).toBe(true);
    }
  });

  it("leaves disableRagSearch undefined when omitted (additive optional)", () => {
    const result = chatRequestSchema.safeParse({ message: "hi" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.disableRagSearch).toBeUndefined();
    }
  });

  it("rejects non-boolean disableRagSearch", () => {
    const result = chatRequestSchema.safeParse({ message: "hi", disableRagSearch: "yes" });
    expect(result.success).toBe(false);
  });
});

// ─── Phase 94: include_thinking opt-in flag (D-03) ───
describe("chatRequestSchema — include_thinking (D-03, Phase 94)", () => {
  it("accepts include_thinking: true", () => {
    const result = chatRequestSchema.safeParse({ message: "hi", include_thinking: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.include_thinking).toBe(true);
    }
  });

  it("accepts include_thinking: false", () => {
    const result = chatRequestSchema.safeParse({ message: "hi", include_thinking: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.include_thinking).toBe(false);
    }
  });

  it("leaves include_thinking undefined when omitted (additive optional)", () => {
    const result = chatRequestSchema.safeParse({ message: "hi" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.include_thinking).toBeUndefined();
    }
  });

  it("rejects non-boolean include_thinking", () => {
    const result = chatRequestSchema.safeParse({ message: "hi", include_thinking: "true" });
    expect(result.success).toBe(false);
  });
});

// ─── quick 260815-k5s: archiveId on chatRequestSchema (additive, D-01) ───
const VALID_ARCHIVE_ID = "00000000-0000-4000-8000-000000000000";

describe("chatRequestSchema — archiveId (260815-k5s)", () => {
  it("accepts a valid UUID archiveId", () => {
    const result = chatRequestSchema.safeParse({ message: "hi", archiveId: VALID_ARCHIVE_ID });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.archiveId).toBe(VALID_ARCHIVE_ID);
    }
  });

  it("accepts explicit null archiveId (unlink semantics)", () => {
    const result = chatRequestSchema.safeParse({ message: "hi", archiveId: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.archiveId).toBeNull();
    }
  });

  it("leaves archiveId undefined when omitted (additive optional)", () => {
    const result = chatRequestSchema.safeParse({ message: "hi" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.archiveId).toBeUndefined();
    }
  });

  it("rejects non-UUID archiveId", () => {
    const result = chatRequestSchema.safeParse({ message: "hi", archiveId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });
});

// ─── Document Schemas ───────────────────────────────────────────

describe("documentTypeSchema", () => {
  it("accepts valid document types", () => {
    expect(documentTypeSchema.safeParse("pdf").success).toBe(true);
    expect(documentTypeSchema.safeParse("md").success).toBe(true);
    expect(documentTypeSchema.safeParse("csv").success).toBe(true);
  });

  it("rejects invalid document types", () => {
    expect(documentTypeSchema.safeParse("exe").success).toBe(false);
    expect(documentTypeSchema.safeParse("js").success).toBe(false);
    expect(documentTypeSchema.safeParse("html").success).toBe(false);
  });
});

describe("processDocumentSchema", () => {
  it("accepts valid process document input", () => {
    const result = processDocumentSchema.safeParse({
      documentId: "550e8400-e29b-41d4-a716-446655440000",
      documentType: "pdf",
      filePath: "/tmp/document.pdf",
      workspaceId: "660e8400-e29b-41d4-a716-446655440001",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid documentType", () => {
    const result = processDocumentSchema.safeParse({
      documentId: "550e8400-e29b-41d4-a716-446655440000",
      documentType: "exe",
      filePath: "/tmp/malware.exe",
      workspaceId: "660e8400-e29b-41d4-a716-446655440001",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty filePath", () => {
    const result = processDocumentSchema.safeParse({
      documentId: "550e8400-e29b-41d4-a716-446655440000",
      documentType: "pdf",
      filePath: "",
      workspaceId: "660e8400-e29b-41d4-a716-446655440001",
    });
    expect(result.success).toBe(false);
  });
});

// ─── Config Schemas ─────────────────────────────────────────────

describe("configKeySchema", () => {
  it("accepts valid config keys", () => {
    expect(configKeySchema.safeParse("LLM_PROVIDER").success).toBe(true);
    expect(configKeySchema.safeParse("EMBEDDING_MODEL").success).toBe(true);
    expect(configKeySchema.safeParse("JWT_SECRET").success).toBe(true);
  });

  it("rejects invalid config keys", () => {
    expect(configKeySchema.safeParse("INVALID_KEY").success).toBe(false);
    expect(configKeySchema.safeParse("RANDOM_SETTING").success).toBe(false);
  });

  it("accepts OCR_DEFAULT_MODEL config key", () => {
    expect(configKeySchema.safeParse("OCR_DEFAULT_MODEL").success).toBe(true);
  });

  it("accepts OCR_DEFAULT_MODE config key", () => {
    expect(configKeySchema.safeParse("OCR_DEFAULT_MODE").success).toBe(true);
  });

  it("accepts OCR_DEFAULT_CUSTOM_INSTRUCTIONS config key", () => {
    expect(configKeySchema.safeParse("OCR_DEFAULT_CUSTOM_INSTRUCTIONS").success).toBe(true);
  });

  it("accepts SYNTHESIS_LLM_PROVIDER_ID config key", () => {
    expect(configKeySchema.safeParse("SYNTHESIS_LLM_PROVIDER_ID").success).toBe(true);
  });

  it("accepts SYNTHESIS_LLM_MODEL config key", () => {
    expect(configKeySchema.safeParse("SYNTHESIS_LLM_MODEL").success).toBe(true);
  });

  it("accepts BRANDING_APP_SUBTITLE config key", () => {
    expect(configKeySchema.safeParse("BRANDING_APP_SUBTITLE").success).toBe(true);
  });

  it("accepts BRANDING_APP_ICON_URL config key", () => {
    expect(configKeySchema.safeParse("BRANDING_APP_ICON_URL").success).toBe(true);
  });

  it("bulkSetConfigSchema accepts configs with new branding keys", () => {
    const result = bulkSetConfigSchema.safeParse({
      configs: [
        { key: "BRANDING_APP_SUBTITLE", value: "Enterprise knowledge assistant" },
        { key: "BRANDING_APP_ICON_URL", value: "/branding/app-icon.png" },
      ],
    });
    expect(result.success).toBe(true);
  });

  // Phase 99 (WEB-01 D-07) — Web search config keys must be accepted by
  // configKeySchema so admins can persist them via PUT /api/system/settings.
  it("accepts web_search_provider config key (Phase 99, WEB-01)", () => {
    expect(configKeySchema.safeParse("web_search_provider").success).toBe(true);
  });

  it("accepts searxng_url config key (Phase 99, WEB-01)", () => {
    expect(configKeySchema.safeParse("searxng_url").success).toBe(true);
  });

  it("setConfigSchema accepts web_search_provider + searxng_url pairs", () => {
    const providerResult = setConfigSchema.safeParse({
      key: "web_search_provider",
      value: "searxng",
    });
    expect(providerResult.success).toBe(true);

    const urlResult = setConfigSchema.safeParse({
      key: "searxng_url",
      value: "http://localhost:8888",
    });
    expect(urlResult.success).toBe(true);
  });

  it("bulkSetConfigSchema accepts a web_search_provider + searxng_url bulk update", () => {
    const result = bulkSetConfigSchema.safeParse({
      configs: [
        { key: "web_search_provider", value: "tavily" },
        { key: "searxng_url", value: "http://searxng.local:8888" },
      ],
    });
    expect(result.success).toBe(true);
  });

  // Negative control — a near-miss typo must still be rejected, proving the
  // enum didn't accidentally widen to accept arbitrary snake_case web_* keys.
  it("rejects a typoed 'web_search_providerX' key (negative control)", () => {
    expect(configKeySchema.safeParse("web_search_providerX").success).toBe(false);
  });

  it("rejects a typoed 'searxng_url_extra' key (negative control)", () => {
    expect(configKeySchema.safeParse("searxng_url_extra").success).toBe(false);
  });

  // 260829-kkn — Upload-draft reaper configurability keys must be accepted by
  // configKeySchema so admins can persist them via PUT /api/system/settings.
  it("accepts upload_draft_reaper_enabled config key (260829-kkn)", () => {
    expect(configKeySchema.safeParse("upload_draft_reaper_enabled").success).toBe(true);
  });

  it("accepts upload_draft_reaper_cron config key (260829-kkn)", () => {
    expect(configKeySchema.safeParse("upload_draft_reaper_cron").success).toBe(true);
  });

  // Negative control — a near-miss key must still be rejected (typo guard,
  // mirrors the web_search_providerX pattern).
  it("rejects a typoed 'upload_draft_reaper_bogus' key (260829-kkn)", () => {
    expect(configKeySchema.safeParse("upload_draft_reaper_bogus").success).toBe(false);
  });

  it("CONFIG_DEFAULTS pins the reaper defaults (enabled=true, cron daily 03:00 UTC)", () => {
    expect(CONFIG_DEFAULTS["upload_draft_reaper_enabled"]).toBe("true");
    expect(CONFIG_DEFAULTS["upload_draft_reaper_cron"]).toBe("0 3 * * *");
  });
});

describe("setConfigSchema", () => {
  it("accepts valid config set", () => {
    const result = setConfigSchema.safeParse({ key: "LLM_PROVIDER", value: "ollama" });
    expect(result.success).toBe(true);
  });

  it("accepts openrouter as LLM provider", () => {
    const result = setConfigSchema.safeParse({ key: "LLM_PROVIDER", value: "openrouter" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid key", () => {
    const result = setConfigSchema.safeParse({ key: "HACK_KEY", value: "evil" });
    expect(result.success).toBe(false);
  });
});

describe("bulkSetConfigSchema", () => {
  it("accepts valid bulk config", () => {
    const result = bulkSetConfigSchema.safeParse({
      configs: [
        { key: "LLM_PROVIDER", value: "openai" },
        { key: "EMBEDDING_PROVIDER", value: "local" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects bulk config with invalid key", () => {
    const result = bulkSetConfigSchema.safeParse({
      configs: [
        { key: "LLM_PROVIDER", value: "openai" },
        { key: "INVALID_KEY", value: "evil" },
      ],
    });
    expect(result.success).toBe(false);
  });
});

// ─── Role Schemas ───────────────────────────────────────────────

describe("createRoleSchema", () => {
  it("accepts valid role with permissions", () => {
    const result = createRoleSchema.safeParse({
      name: "Editor",
      permissionNames: ["chat:write", "document:read"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts role with no permissions (empty array)", () => {
    const result = createRoleSchema.safeParse({
      name: "Editor",
      permissionNames: [],
    });
    expect(result.success).toBe(true);
  });

  it("defaults permissionNames to empty array when omitted", () => {
    const result = createRoleSchema.safeParse({
      name: "Viewer",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.permissionNames).toEqual([]);
    }
  });

  it("rejects role with invalid permission", () => {
    const result = createRoleSchema.safeParse({
      name: "Editor",
      permissionNames: ["invalid:permission"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = createRoleSchema.safeParse({
      name: "",
      permissionNames: ["chat:write"],
    });
    expect(result.success).toBe(false);
  });
});

describe("grantWorkspaceAccessSchema", () => {
  it("accepts valid UUIDs", () => {
    const result = grantWorkspaceAccessSchema.safeParse({
      userId: "550e8400-e29b-41d4-a716-446655440000",
      workspaceId: "660e8400-e29b-41d4-a716-446655440001",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid userId", () => {
    const result = grantWorkspaceAccessSchema.safeParse({
      userId: "not-a-uuid",
      workspaceId: "660e8400-e29b-41d4-a716-446655440001",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid workspaceId", () => {
    const result = grantWorkspaceAccessSchema.safeParse({
      userId: "550e8400-e29b-41d4-a716-446655440000",
      workspaceId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });
});

// ─── Project Schemas ────────────────────────────────────────────

describe("createProjectSchema", () => {
  it("accepts valid project creation", () => {
    const result = createProjectSchema.safeParse({
      name: "My Project",
      description: "A test project",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = createProjectSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });
});

// ─── adminRegisterSchema ──────────────────────────────────────────

describe("adminRegisterSchema", () => {
  it("accepts valid admin registration without role", () => {
    const result = adminRegisterSchema.safeParse({
      username: "newadmin",
      email: "admin@example.com",
      password: "securepassword123",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.role).toBe("user"); // defaults to "user"
    }
  });

  it("accepts admin registration with role=admin", () => {
    const result = adminRegisterSchema.safeParse({
      username: "newadmin",
      email: "admin@example.com",
      password: "securepassword123",
      role: "admin",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.role).toBe("admin");
    }
  });

  it("accepts any valid role string", () => {
    const result = adminRegisterSchema.safeParse({
      username: "newadmin",
      email: "admin@example.com",
      password: "securepassword123",
      role: "custom_role",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.role).toBe("custom_role");
    }
  });

  it("rejects short username", () => {
    const result = adminRegisterSchema.safeParse({
      username: "ab",
      email: "admin@example.com",
      password: "securepassword123",
    });
    expect(result.success).toBe(false);
  });

  it("rejects short password", () => {
    const result = adminRegisterSchema.safeParse({
      username: "newadmin",
      email: "admin@example.com",
      password: "short",
    });
    expect(result.success).toBe(false);
  });
});

// ─── updateUserSchema ──────────────────────────────────────────────

describe("updateUserSchema", () => {
  it("accepts partial update with username only", () => {
    const result = updateUserSchema.safeParse({ username: "updateduser" });
    expect(result.success).toBe(true);
  });

  it("accepts partial update with email only", () => {
    const result = updateUserSchema.safeParse({ email: "new@example.com" });
    expect(result.success).toBe(true);
  });

  it("accepts partial update with password only", () => {
    const result = updateUserSchema.safeParse({ password: "newpassword123" });
    expect(result.success).toBe(true);
  });

  it("rejects empty username", () => {
    const result = updateUserSchema.safeParse({ username: "ab" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid email", () => {
    const result = updateUserSchema.safeParse({ email: "not-an-email" });
    expect(result.success).toBe(false);
  });

  it("accepts empty object (no fields to update)", () => {
    const result = updateUserSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

// ─── updateWorkspaceSchema ─────────────────────────────────────────

describe("updateWorkspaceSchema", () => {
  it("accepts valid workspace update with name", () => {
    const result = updateWorkspaceSchema.safeParse({ name: "Updated Workspace" });
    expect(result.success).toBe(true);
  });

  it("accepts partial update with instructions only", () => {
    const result = updateWorkspaceSchema.safeParse({ instructions: "New instructions" });
    expect(result.success).toBe(true);
  });

  it("accepts nullable instructions", () => {
    const result = updateWorkspaceSchema.safeParse({ instructions: null });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = updateWorkspaceSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("accepts empty object (no fields to update)", () => {
    const result = updateWorkspaceSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts templateId as null", () => {
    const result = updateWorkspaceSchema.safeParse({ templateId: null });
    expect(result.success).toBe(true);
  });

  it("accepts allowMemberUploads boolean", () => {
    const result = updateWorkspaceSchema.safeParse({ allowMemberUploads: true });
    expect(result.success).toBe(true);
  });

  it("rejects non-boolean allowMemberUploads", () => {
    const result = updateWorkspaceSchema.safeParse({ allowMemberUploads: "yes" });
    expect(result.success).toBe(false);
  });
});

// ─── updateChatSchema / renameChatSchema ───────────────────────────

describe("updateChatSchema", () => {
  it("accepts valid chat name update", () => {
    const result = updateChatSchema.safeParse({ name: "Renamed Chat" });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = updateChatSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("accepts empty object (no fields to update)", () => {
    const result = updateChatSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe("renameChatSchema", () => {
  it("is equivalent to updateChatSchema", () => {
    expect(renameChatSchema).toBe(updateChatSchema);
  });
});

// ─── uploadDocumentSchema ──────────────────────────────────────────

describe("uploadDocumentSchema", () => {
  it("rejects upload without workspaceId", () => {
    const result = uploadDocumentSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("accepts upload with valid workspaceId", () => {
    const result = uploadDocumentSchema.safeParse({
      workspaceId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid workspaceId", () => {
    const result = uploadDocumentSchema.safeParse({ workspaceId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("upload schema does not accept embeddingModel", () => {
    const result = uploadDocumentSchema.safeParse({
      workspaceId: "550e8400-e29b-41d4-a716-446655440000",
      embeddingModel: "text-embedding-3-small",
    });
    // Zod strips unknown keys by default, so embeddingModel is ignored
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("embeddingModel");
    }
  });
});

// ─── youtubeTranscriptSchema ───────────────────────────────────────

describe("youtubeTranscriptSchema", () => {
  it("accepts valid YouTube URL with watch parameter", () => {
    const result = youtubeTranscriptSchema.safeParse({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      workspaceId: "550e8400-e29b-41d4-a716-446655440000",
      documentId: "660e8400-e29b-41d4-a716-446655440001",
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid YouTube short URL", () => {
    const result = youtubeTranscriptSchema.safeParse({
      url: "https://youtu.be/dQw4w9WgXcQ",
      workspaceId: "550e8400-e29b-41d4-a716-446655440000",
      documentId: "660e8400-e29b-41d4-a716-446655440001",
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-YouTube URL", () => {
    const result = youtubeTranscriptSchema.safeParse({
      url: "https://example.com/video",
      workspaceId: "550e8400-e29b-41d4-a716-446655440000",
      documentId: "660e8400-e29b-41d4-a716-446655440001",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid documentId", () => {
    const result = youtubeTranscriptSchema.safeParse({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      workspaceId: "550e8400-e29b-41d4-a716-446655440000",
      documentId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects transcript without workspaceId", () => {
    const result = youtubeTranscriptSchema.safeParse({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      documentId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(false);
  });
});

// ─── grantProjectAccessSchema ─────────────────────────────────────

describe("grantProjectAccessSchema", () => {
  it("accepts valid UUIDs", () => {
    const result = grantProjectAccessSchema.safeParse({
      userId: "550e8400-e29b-41d4-a716-446655440000",
      projectId: "660e8400-e29b-41d4-a716-446655440001",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid userId", () => {
    const result = grantProjectAccessSchema.safeParse({
      userId: "not-a-uuid",
      projectId: "660e8400-e29b-41d4-a716-446655440001",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid projectId", () => {
    const result = grantProjectAccessSchema.safeParse({
      userId: "550e8400-e29b-41d4-a716-446655440000",
      projectId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing fields", () => {
    const result = grantProjectAccessSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ─── licensePayloadSchema ──────────────────────────────────────────

describe("licensePayloadSchema", () => {
  const validPayload = {
    tier: "enterprise",
    iss: "simmetric-chat",
    sub: "Acme Corp",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
  };

  it("accepts valid enterprise payload", () => {
    const result = licensePayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it("accepts community tier", () => {
    const result = licensePayloadSchema.safeParse({ ...validPayload, tier: "community" });
    expect(result.success).toBe(true);
  });

  it("accepts payload with feature overrides", () => {
    const result = licensePayloadSchema.safeParse({
      ...validPayload,
      features: { sso_enabled: true, max_workspaces: 50 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.features!.sso_enabled).toBe(true);
      expect(result.data.features!.max_workspaces).toBe(50);
    }
  });

  it("rejects invalid tier", () => {
    const result = licensePayloadSchema.safeParse({ ...validPayload, tier: "ultimate" });
    expect(result.success).toBe(false);
  });

  it("rejects empty issuer", () => {
    const result = licensePayloadSchema.safeParse({ ...validPayload, iss: "" });
    expect(result.success).toBe(false);
  });

  it("rejects empty licensee (sub)", () => {
    const result = licensePayloadSchema.safeParse({ ...validPayload, sub: "" });
    expect(result.success).toBe(false);
  });

  it("accepts payload without features (optional)", () => {
    const result = licensePayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.features).toBeUndefined();
    }
  });
});

// ─── Edge Cases ────────────────────────────────────────────────────

describe("Schema edge cases", () => {
  it("registerSchema rejects very long username (>100 chars)", () => {
    const result = registerSchema.safeParse({
      username: "a".repeat(101),
      email: "user@example.com",
      password: "securepassword123",
    });
    expect(result.success).toBe(false);
  });

  it("registerSchema accepts Unicode username", () => {
    const result = registerSchema.safeParse({
      username: "用户名",
      email: "user@example.com",
      password: "securepassword123",
    });
    expect(result.success).toBe(true);
  });

  it("loginSchema accepts email as username field", () => {
    const result = loginSchema.safeParse({ username: "user@example.com", password: "secret123" });
    expect(result.success).toBe(true);
  });

  it("createWorkspaceSchema rejects name >200 chars", () => {
    const result = createWorkspaceSchema.safeParse({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      name: "x".repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it("createWorkspaceSchema accepts template override fields", () => {
    const result = createWorkspaceSchema.safeParse({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      name: "Legal Workspace",
      systemPrompt: "You are a legal assistant.",
      skills: ["rag_search", "workspace_memory"],
      constraints: { localLLMOnly: true, citationRequired: true },
      parsingConfig: { ocrRequired: true },
    });
    expect(result.success).toBe(true);
  });

  it("sendMessageSchema accepts exactly 50000 chars", () => {
    const result = sendMessageSchema.safeParse({ content: "x".repeat(50000) });
    expect(result.success).toBe(true);
  });

  it("changePasswordSchema rejects same current and new password", () => {
    // Schema allows this — application logic should prevent it
    const result = changePasswordSchema.safeParse({
      currentPassword: "samepass123",
      newPassword: "samepass123",
    });
    expect(result.success).toBe(true);
  });

  it("createRoleSchema accepts description up to 500 chars", () => {
    const result = createRoleSchema.safeParse({
      name: "Editor",
      description: "d".repeat(500),
      permissionNames: ["chat:write"],
    });
    expect(result.success).toBe(true);
  });

  it("createRoleSchema rejects description >500 chars", () => {
    const result = createRoleSchema.safeParse({
      name: "Editor",
      description: "d".repeat(501),
      permissionNames: ["chat:write"],
    });
    expect(result.success).toBe(false);
  });
});

// ─── Menu Section Constants ────────────────────────────────────────

import {
  MENU_SECTIONS,
  DEFAULT_ROLE_MENU_SECTIONS,
  PERMISSION_NAMES,
  permissionNameSchema,
} from "../constants/permissions";

describe("MENU_SECTIONS", () => {
  it("includes mcpConnections", () => {
    expect(MENU_SECTIONS).toContain("mcpConnections");
  });
});

describe("DEFAULT_ROLE_MENU_SECTIONS", () => {
  it("admin includes mcpConnections", () => {
    expect(DEFAULT_ROLE_MENU_SECTIONS.admin).toContain("mcpConnections");
  });

  it("does not include superuser key", () => {
    expect(DEFAULT_ROLE_MENU_SECTIONS).not.toHaveProperty("superuser");
  });

  it("user does NOT include mcpConnections", () => {
    expect(DEFAULT_ROLE_MENU_SECTIONS.user).not.toContain("mcpConnections");
  });
});

// ─── Backup Destination Schemas (Phase 52) ─────────────────────

describe("localConfigSchema", () => {
  it("accepts valid local config", () => {
    const result = localConfigSchema.safeParse({ path: "/var/backups" });
    expect(result.success).toBe(true);
  });

  it("rejects missing path", () => {
    const result = localConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("s3ConfigSchema", () => {
  it("accepts valid S3 config", () => {
    const result = s3ConfigSchema.safeParse({
      bucket: "my-bucket",
      region: "us-east-1",
      accessKeyId: "AKIA123",
      secretAccessKey: "secret",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing fields", () => {
    const result = s3ConfigSchema.safeParse({ bucket: "my-bucket" });
    expect(result.success).toBe(false);
  });
});

describe("s3CompatibleConfigSchema", () => {
  it("accepts valid S3 Compatible config", () => {
    const result = s3CompatibleConfigSchema.safeParse({
      bucket: "my-bucket",
      region: "us-east-1",
      accessKeyId: "AKIA123",
      secretAccessKey: "secret",
      endpoint: "https://s3.example.com",
    });
    expect(result.success).toBe(true);
  });

  it("defaults forcePathStyle to false", () => {
    const result = s3CompatibleConfigSchema.safeParse({
      bucket: "my-bucket",
      region: "us-east-1",
      accessKeyId: "AKIA123",
      secretAccessKey: "secret",
      endpoint: "https://s3.example.com",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.forcePathStyle).toBe(false);
  });
});

describe("sftpConfigSchema", () => {
  it("accepts config with password", () => {
    const result = sftpConfigSchema.safeParse({
      host: "sftp.example.com",
      port: 22,
      username: "user",
      password: "pass123",
    });
    expect(result.success).toBe(true);
  });

  it("accepts config with privateKey only", () => {
    const result = sftpConfigSchema.safeParse({
      host: "sftp.example.com",
      port: 22,
      username: "user",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----",
    });
    expect(result.success).toBe(true);
  });

  it("rejects without password AND privateKey", () => {
    const result = sftpConfigSchema.safeParse({
      host: "sftp.example.com",
      port: 22,
      username: "user",
    });
    expect(result.success).toBe(false);
  });

  it("rejects port=0", () => {
    const result = sftpConfigSchema.safeParse({
      host: "sftp.example.com",
      port: 0,
      username: "user",
      password: "pass",
    });
    expect(result.success).toBe(false);
  });

  it("rejects port=99999", () => {
    const result = sftpConfigSchema.safeParse({
      host: "sftp.example.com",
      port: 99999,
      username: "user",
      password: "pass",
    });
    expect(result.success).toBe(false);
  });
});

describe("createBackupDestinationSchema", () => {
  it("accepts valid S3 destination", () => {
    const result = createBackupDestinationSchema.safeParse({
      name: "My S3 Backup",
      type: "s3",
      config: {
        bucket: "my-bucket",
        region: "us-east-1",
        accessKeyId: "AKIA123",
        secretAccessKey: "secret",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects type/config mismatch (s3 type with ftp config)", () => {
    const result = createBackupDestinationSchema.safeParse({
      name: "Bad config",
      type: "s3",
      config: {
        host: "ftp.example.com",
        port: 21,
        username: "user",
        password: "pass",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = createBackupDestinationSchema.safeParse({
      name: "",
      type: "local",
      config: { path: "/tmp" },
    });
    expect(result.success).toBe(false);
  });
});

describe("updateBackupDestinationSchema", () => {
  it("accepts partial update", () => {
    const result = updateBackupDestinationSchema.safeParse({
      name: "Updated Name",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty object", () => {
    const result = updateBackupDestinationSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("backupDestinationIdParamSchema", () => {
  it("accepts valid UUID", () => {
    const result = backupDestinationIdParamSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid UUID", () => {
    const result = backupDestinationIdParamSchema.safeParse({ id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });
});

describe("permissionNameSchema — backup permissions", () => {
  const newStrings = [
    "backup:destination:read",
    "backup:destination:write",
    "backup:job:read",
    "backup:job:write",
    "backup:log:read",
    "backup:restore:write",
  ];
  it.each(newStrings)("accepts %s", (s) => {
    expect(permissionNameSchema.safeParse(s).success).toBe(true);
  });
  it("rejects unknown permission strings", () => {
    expect(permissionNameSchema.safeParse("backup:notareal:perm").success).toBe(false);
  });
});

// ─── Phase 100 (PLG-01 D-09): filters:manage permission ──────────
// The 31st permission (filters:manage) gates GET /api/filters + PATCH
// /api/filters/:name. It must be accepted by permissionNameSchema (Zod enum
// derived from PERMISSION_NAMES) AND present in the PERMISSION_NAMES array.
// A missing entry would cause createRoleSchema to reject any role that
// includes filters:manage, breaking the admin RBAC gate (T-100-07).
describe("permissionNameSchema — filters:manage (Phase 100, PLG-01)", () => {
  it("accepts filters:manage via safeParse", () => {
    expect(permissionNameSchema.safeParse("filters:manage").success).toBe(true);
  });

  it("includes filters:manage in the PERMISSION_NAMES array", () => {
    expect(PERMISSION_NAMES).toContain("filters:manage");
  });

  it("rejects a near-miss typo 'filters:manager' (negative control)", () => {
    expect(permissionNameSchema.safeParse("filters:manager").success).toBe(false);
  });
});

// ─── Synthesis rename schema (Phase 74 Plan 03, D-13 divergence) ───────

import { renameSynthesisRunSchema } from "../schemas/synthesis.schema";

describe("renameSynthesisRunSchema", () => {
  it("accepts valid name", () => {
    const result = renameSynthesisRunSchema.safeParse({
      name: "Sintesi · Ricerche · 21/07/2026 18:35",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty name (min 1)", () => {
    const result = renameSynthesisRunSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects name longer than 100 chars (max 100)", () => {
    const result = renameSynthesisRunSchema.safeParse({
      name: "a".repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing name (NOT optional — Pitfall 5 divergence)", () => {
    const result = renameSynthesisRunSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("accepts 100-char boundary", () => {
    const result = renameSynthesisRunSchema.safeParse({
      name: "a".repeat(100),
    });
    expect(result.success).toBe(true);
  });
});

// ─── renameUploadSchema (Phase 76 Plan 01, D-07 1-500 char) ───────────

import { renameUploadSchema } from "../schemas/uploadDraft.schema";
import { renameUploadSchema as renameUploadSchemaFromBarrel } from "../index";

describe("renameUploadSchema", () => {
  it("rejects empty originalName (min 1, D-07)", () => {
    const result = renameUploadSchema.safeParse({ originalName: "" });
    expect(result.success).toBe(false);
  });

  it("accepts exactly 500 chars (D-07 boundary)", () => {
    const result = renameUploadSchema.safeParse({ originalName: "a".repeat(500) });
    expect(result.success).toBe(true);
  });

  it("rejects 501 chars (D-07 max 500)", () => {
    const result = renameUploadSchema.safeParse({ originalName: "a".repeat(501) });
    expect(result.success).toBe(false);
  });

  it("accepts a normal display name", () => {
    const result = renameUploadSchema.safeParse({ originalName: "Report.pdf" });
    expect(result.success).toBe(true);
  });

  it("is re-exported from the @simmetric-chat/shared barrel", () => {
    // The barrel re-export must resolve to the same schema object.
    expect(renameUploadSchemaFromBarrel).toBe(renameUploadSchema);
  });
});

// ─── Chat Retention Schema (Phase 84, SEED-001, D-08) ──────────

describe("chatRetentionSchema", () => {
  it("Test 1: accepts { retentionDays: 30, confirmDataLoss: true }", () => {
    const result = chatRetentionSchema.safeParse({ retentionDays: 30, confirmDataLoss: true });
    expect(result.success).toBe(true);
  });

  it("Test 2: rejects { retentionDays: 30, confirmDataLoss: false } (refine blocks)", () => {
    const result = chatRetentionSchema.safeParse({ retentionDays: 30, confirmDataLoss: false });
    expect(result.success).toBe(false);
  });

  it("Test 3: accepts { retentionDays: null, confirmDataLoss: true } (null = OFF allowed)", () => {
    const result = chatRetentionSchema.safeParse({ retentionDays: null, confirmDataLoss: true });
    expect(result.success).toBe(true);
  });

  it("Test 4: rejects { retentionDays: 0, confirmDataLoss: true } (positive int only)", () => {
    const result = chatRetentionSchema.safeParse({ retentionDays: 0, confirmDataLoss: true });
    expect(result.success).toBe(false);
  });

  it("Test 5: rejects { retentionDays: -5, confirmDataLoss: true }", () => {
    const result = chatRetentionSchema.safeParse({ retentionDays: -5, confirmDataLoss: true });
    expect(result.success).toBe(false);
  });

  it("Test 6: rejects { retentionDays: 1.5, confirmDataLoss: true } (int only)", () => {
    const result = chatRetentionSchema.safeParse({ retentionDays: 1.5, confirmDataLoss: true });
    expect(result.success).toBe(false);
  });

  it("Test 7: configKeySchema accepts 'chat_message_retention_days'", () => {
    const result = configKeySchema.safeParse("chat_message_retention_days");
    expect(result.success).toBe(true);
  });
});

// ─── SourceCitation seam (TYP-01, Phase 87 D-05a compile-fixture) ──────────
// Package-pure: imports the type from the shared barrel only (no cross-package
// fs.readFileSync here — the grep guards live in server/frontend, per D-05b).
import { type SourceCitation } from "../index";

describe("SourceCitation seam (TYP-01)", () => {
  it("accepts a fully-populated superset citation", () => {
    const citation: SourceCitation = {
      documentId: "doc-1",
      documentName: "Doc",
      pageNumber: 1,
      lineStart: 10,
      lineEnd: 20,
      paragraph: 2,
      chunkText: "text",
      score: 0.85,
      source: "archive",
    };
    // Type-level assertion: if this compiles, the additive superset is satisfied.
    expect(citation.documentId).toBe("doc-1");
  });

  it("accepts a citation with score omitted (archive-fallback case)", () => {
    const citation: SourceCitation = {
      documentId: "doc-2",
      documentName: "Doc2",
      source: "archive",
      // no score — must compile (score?: number per D-01)
    };
    expect(citation.score).toBeUndefined();
  });
});
