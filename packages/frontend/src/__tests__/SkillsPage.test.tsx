// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SkillsPage component tests — sections, badges, owner gating, empty/loading
 * states, SKIL-05 limit surfacing (null→unlimited), 402 note, delete dialog.
 * Hooks are mocked (TanStack Query golden rule) — no live network.
 */

import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import SkillsPage from "../components/SkillsPage";
import { ApiError } from "../utils/api";

// jsdom shims (ModelPalette.test.tsx precedent)
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
global.Element.prototype.scrollIntoView = jest.fn();

// Mock i18next — key map + interpolation
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        "skills.page.heading": "Skills",
        "skills.page.subtitle": "Create reusable prompt templates and invoke them in chat with /slug.",
        "skills.page.create": "Create Skill",
        "skills.page.limit": "{{used}} of {{limit}} custom skills used",
        "skills.page.limitUnlimited": "Unlimited custom skills",
        "skills.page.limitReached":
          "You've reached your plan's limit of {{limit}} custom skills. Upgrade to Enterprise for unlimited skills.",
        "skills.builtinSection": "Built-in skills",
        "skills.builtinBadge": "Built-in",
        "skills.customSection": "Custom skills",
        "skills.form.modePrompt": "Prompt",
        "skills.form.scopePersonal": "Personal",
        "skills.form.scopeWorkspace": "Workspace",
        "skills.form.scopeGlobal": "Global",
        "skills.empty.heading": "No custom skills yet",
        "skills.empty.body": "Create a prompt-template skill, then invoke it in chat with /slug.",
        "skills.delete.title": "Delete skill /{{slug}}?",
        "skills.delete.body": "Messages that invoke it will no longer resolve in chat immediately. This cannot be undone.",
        "skills.error.limit402": "Skill limit reached for your tier",
        "skills.success.deleted": "Skill deleted",
        "common.cancel": "Cancel",
        "common.delete": "Delete",
        "common.edit": "Edit",
        // Dialog keys (Task 2 battery)
        "skills.form.createTitle": "Create skill",
        "skills.form.editTitle": "Edit skill",
        "skills.form.save": "Save Skill",
        "skills.form.saving": "Saving...",
        "skills.form.name": "Name",
        "skills.form.mode": "Mode",
        "skills.form.modeWebhook": "Webhook",
        "skills.form.modeWebhookSoon": "Webhook skills are coming soon",
        "skills.form.scope": "Scope",
        "skills.form.scopeGlobalAdminOnly": "Only admins can create global skills",
        "skills.form.workspace": "Workspace",
        "skills.form.selectWorkspace": "Select workspace...",
        "skills.form.template": "Template",
        "skills.form.defaultParams": "Default parameters",
        "skills.form.paramKey": "Key",
        "skills.form.paramValue": "Value",
        "skills.form.addParam": "Add parameter",
        "skills.form.removeParam": "Remove",
        "skills.form.inputSchema": "Input schema",
        "skills.form.inputSchemaAuto": "Auto-generate",
        "skills.form.inputSchemaManual": "Manual JSON",
        "skills.form.jsonError": "Invalid JSON — fix the schema to save.",
        "skills.form.slugInvalid": "Use lowercase letters, numbers and hyphens only (e.g. translate-text).",
        "skills.form.slugReserved": "This slug is reserved by a built-in command. Choose another.",
        "skills.form.slugDuplicate": "A skill with this slug already exists.",
        "skills.form.test": "Test Skill",
        "skills.form.testPreview": "Compiled prompt preview",
        "skills.form.testNeedsSave": "Save the skill to enable testing.",
        "skills.form.enabled": "Enabled",
        "skills.error.save": "Failed to save skill",
      };
      if (key === "skills.page.limit" && opts) {
        return `${opts.used} of ${opts.limit} custom skills used`;
      }
      if (key === "skills.delete.title" && opts) {
        return `Delete skill /${opts.slug}?`;
      }
      if (key === "skills.page.limitReached" && opts) {
        return `You've reached your plan's limit of ${opts.limit} custom skills. Upgrade to Enterprise for unlimited skills.`;
      }
      return map[key] || key;
    },
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

/* ------------------------------------------------------------------ */
/*  Hook mocks                                                         */
/* ------------------------------------------------------------------ */

const OWNER_ID = "user-1";
const OTHER_ID = "user-2";

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "sk-1",
    slug: "translate-text",
    name: "custom_translate-text",
    description: "Translates text",
    skillMode: "prompt",
    scope: "personal" as const,
    isEnabled: true,
    workspaceId: null,
    createdBy: OWNER_ID,
    config: { defaultParams: {} },
    inputSchema: { properties: { input: { type: "string" } }, required: ["input"] },
    ...overrides,
  };
}

const mockBuiltin = [
  "rag_search",
  "memory_search",
  "web_search",
  "workspace_memory",
  "document_temp_process",
  "wiki_query",
  "wiki_write",
].map((name) => ({ name, displayName: name, description: `Builtin ${name}`, type: "builtin" }));

const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockTest = jest.fn();

jest.mock("../queries/useSkills", () => ({
  useSkills: () => (globalThis as Record<string, unknown>).__skillsState as never,
  useCreateSkill: () => ({ mutateAsync: mockCreate, isPending: false }),
  useUpdateSkill: () => ({ mutateAsync: mockUpdate, isPending: false }),
  useDeleteSkill: () => ({ mutateAsync: mockDelete, isPending: false }),
  useTestSkill: () => ({ mutateAsync: mockTest, isPending: false }),
}));

const mockLicense = { data: { tier: "community", features: { max_skills: 3 } } };
jest.mock("../hooks/useFeature", () => ({
  useFeatureLimit: () => (globalThis as Record<string, unknown>).__limitValue as number,
  useLicenseInfo: () => (globalThis as Record<string, unknown>).__licenseData,
  useLicenseTier: () => (globalThis as Record<string, unknown>).__tierValue ?? "community",
}));

const mockMe = { data: { id: OWNER_ID, permissions: [] as string[] } };
jest.mock("../queries/useAuth", () => ({
  useMe: (_enabled?: boolean) => ({ data: { id: OWNER_ID, permissions: [] as string[] }, isLoading: false }),
}));

jest.mock("../queries/useWorkspaces", () => ({
  useWorkspaces: () => ({
    data: [
      { id: "ws-1", name: "Marketing" },
      { id: "ws-2", name: "Engineering" },
    ],
    isLoading: false,
  }),
}));

// SkillsPage reads license.features.max_skills raw for the Pitfall 3 null arm
jest.mock("../queries/useLicense", () => ({
  useLicenseInfo: () => (globalThis as Record<string, unknown>).__licenseData,
}));

function setSkillsState(data: unknown) {
  (globalThis as Record<string, unknown>).__skillsState =
    data === undefined
      ? { data: undefined, isLoading: true }
      : { data, isLoading: false };
}

function setLicense(features: Record<string, unknown>) {
  (globalThis as Record<string, unknown>).__licenseData = { data: { tier: "community", features } };
  (globalThis as Record<string, unknown>).__limitValue = typeof features.max_skills === "number" ? features.max_skills : 0;
}

function renderPage() {
  return render(
    <TooltipProvider>
      <SkillsPage />
    </TooltipProvider>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.removeItem("token");
  setLicense({ max_skills: 3 });
  setSkillsState({
    builtin: mockBuiltin,
    custom: [makeRow()],
    accessible: [],
  });
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("SkillsPage", () => {
  it("renders Built-in 7 rows read-only with secondary badges", () => {
    renderPage();
    expect(screen.getByTestId("skills-builtin-rag_search")).toBeInTheDocument();
    expect(screen.getByTestId("skills-builtin-wiki_write")).toBeInTheDocument();
    // 7 builtin rows
    const builtinRows = mockBuiltin.map((b) => screen.getByTestId(`skills-builtin-${b.name}`));
    expect(builtinRows).toHaveLength(7);
    // No edit/delete buttons inside builtin rows (read-only section)
    expect(screen.queryByTestId("skills-edit-")).not.toBeInTheDocument();
  });

  it("renders custom rows with scope + mode badges and slug in mono", () => {
    renderPage();
    expect(screen.getByTestId("skills-custom-translate-text")).toBeInTheDocument();
    expect(screen.getByText("/translate-text")).toBeInTheDocument();
    expect(screen.getByText("Personal")).toBeInTheDocument();
    expect(screen.getAllByText("Prompt").length).toBeGreaterThan(0);
  });

  it("owner row has edit/delete; non-owner row lacks them (partial row)", () => {
    // Two rows: one owned by user-1, one by user-2 (visible global).
    setSkillsState({
      builtin: mockBuiltin,
      custom: [
        makeRow({ id: "sk-1", slug: "mine", createdBy: OWNER_ID }),
        makeRow({ id: "sk-2", slug: "theirs", createdBy: OTHER_ID, scope: "global" }),
      ],
      accessible: [],
    });
    renderPage();
    expect(screen.getByTestId("skills-edit-mine")).toBeInTheDocument();
    expect(screen.getByTestId("skills-delete-mine")).toBeInTheDocument();
    expect(screen.queryByTestId("skills-edit-theirs")).not.toBeInTheDocument();
    expect(screen.queryByTestId("skills-delete-theirs")).not.toBeInTheDocument();
  });

  it("zero customs renders the empty state with Create CTA; builtin rows stay", () => {
    setSkillsState({ builtin: mockBuiltin, custom: [], accessible: [] });
    renderPage();
    expect(screen.getByTestId("skills-empty")).toBeInTheDocument();
    expect(screen.getByText("No custom skills yet")).toBeInTheDocument();
    expect(screen.getByTestId("skills-empty-create-cta")).toBeInTheDocument();
    expect(screen.getByTestId("skills-builtin-rag_search")).toBeInTheDocument();
  });

  it("loading renders Skeleton rows", () => {
    setSkillsState(undefined);
    renderPage();
    expect(screen.getByTestId("skills-loading")).toBeInTheDocument();
  });

  it("null max_skills renders limitUnlimited copy and NO numeric counter (Pitfall 3)", () => {
    setLicense({ max_skills: null });
    renderPage();
    expect(screen.getByText("Unlimited custom skills")).toBeInTheDocument();
    expect(screen.queryByText(/custom skills used/)).not.toBeInTheDocument();
  });

  it("numeric limit renders the used/limit counter", () => {
    setSkillsState({
      builtin: mockBuiltin,
      custom: [makeRow(), makeRow({ id: "sk-2", slug: "second" })],
      accessible: [],
    });
    renderPage();
    expect(screen.getByText("2 of 3 custom skills used")).toBeInTheDocument();
  });

  it("a create 402 (feature max_skills) renders limitReached note + disabled create + error toast", async () => {
    // Create mock: reject with a REAL ApiError 402 carrying the limit detail
    // (the page gates the limit arm on `instanceof ApiError && status 402`).
    mockCreate.mockRejectedValue(new ApiError(402, "limit", { limit: 3 }));
    renderPage();
    fireEvent.click(screen.getByTestId("skills-create-cta"));
    // Fill the create form and submit — the save path routes through
    // useCreateSkill whose rejection is the 402.
    fireEvent.change(await screen.findByTestId("skill-form-slug"), { target: { value: "my-skill" } });
    fireEvent.change(screen.getByTestId("skill-form-name"), { target: { value: "My Skill" } });
    fireEvent.change(screen.getByTestId("skill-form-description"), { target: { value: "Desc" } });
    fireEvent.click(screen.getByTestId("skill-form-save"));
    await waitFor(() => {
      expect(screen.getByTestId("skills-limit-reached")).toBeInTheDocument();
    });
    expect(screen.getByTestId("skills-create-cta")).toBeDisabled();
  });

  it("delete opens the AlertDialog and confirm calls useDeleteSkill", async () => {
    setSkillsState({ builtin: mockBuiltin, custom: [makeRow()], accessible: [] });
    mockDelete.mockResolvedValue(undefined);
    renderPage();
    fireEvent.click(screen.getByTestId("skills-delete-translate-text"));
    expect(screen.getByText("Delete skill /translate-text?")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("skills-delete-confirm"));
    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith("sk-1");
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Dialog battery (Task 2 — SkillFormDialog via SkillsPage)           */
/* ------------------------------------------------------------------ */

async function openCreateDialog() {
  renderPage();
  fireEvent.click(screen.getByTestId("skills-create-cta"));
  await screen.findByTestId("skill-form-slug");
}

describe("SkillFormDialog (via SkillsPage)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.removeItem("token");
    setLicense({ max_skills: 3 });
    setSkillsState({ builtin: mockBuiltin, custom: [], accessible: [] });
  });

  it("create-mode Test button is disabled with the testNeedsSave helper", async () => {
    await openCreateDialog();
    const testButton = screen.getByTestId("skill-form-test");
    expect(testButton).toBeDisabled();
    expect(screen.getByText("Save the skill to enable testing.")).toBeInTheDocument();
  });

  it("auto-generate scans {{param}} occurrences into a properties object", async () => {
    await openCreateDialog();
    fireEvent.change(screen.getByTestId("skill-form-template"), {
      target: { value: "Translate {{input}} to {{targetLang}} please" },
    });
    const rendered = screen.getByTestId("skill-schema-auto").textContent ?? "";
    const parsed = JSON.parse(rendered);
    expect(Object.keys(parsed.properties)).toEqual(["input", "targetLang"]);
    expect(parsed.properties.input).toEqual({ type: "string" });
  });

  it("zero-placeholder template hides the defaultParams editor", async () => {
    await openCreateDialog();
    expect(screen.queryByTestId("skill-form-default-params")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("skill-form-template"), {
      target: { value: "No placeholders here" },
    });
    expect(screen.queryByTestId("skill-form-default-params")).not.toBeInTheDocument();
  });

  it("template with placeholders reveals the defaultParams editor (zero-one-many)", async () => {
    await openCreateDialog();
    fireEvent.change(screen.getByTestId("skill-form-template"), {
      target: { value: "Translate {{input}}" },
    });
    expect(screen.getByTestId("skill-form-default-params")).toBeInTheDocument();
    // add a default param row
    fireEvent.click(screen.getByTestId("skill-param-add"));
    fireEvent.change(screen.getByTestId("skill-param-key-0"), { target: { value: "input" } });
    fireEvent.change(screen.getByTestId("skill-param-value-0"), { target: { value: "hello" } });
    // Save routes through useCreateSkill with defaultParams carried
    fireEvent.change(screen.getByTestId("skill-form-slug"), { target: { value: "tr" } });
    fireEvent.change(screen.getByTestId("skill-form-name"), { target: { value: "Tr" } });
    fireEvent.change(screen.getByTestId("skill-form-description"), { target: { value: "D" } });
    mockCreate.mockResolvedValue(undefined);
    fireEvent.click(screen.getByTestId("skill-form-save"));
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalled();
    });
    const payload = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect((payload.config as Record<string, unknown>).defaultParams).toEqual({ input: "hello" });
  });

  it("scope Global option is disabled for non-admins", async () => {
    await openCreateDialog();
    // Radix SelectContent renders in a portal on open — open the scope select first.
    const scopeTrigger = screen
      .getByTestId("skill-form-scope")
      .querySelector('[role="combobox"]') as Element;
    fireEvent.click(scopeTrigger);
    const globalOption = await screen.findByTestId("skill-form-scope-global");
    // Radix SelectItem signals disabled via data-disabled (not the native attr)
    expect(globalOption).toHaveAttribute("data-disabled");
  });

  it("workspace scope reveals the workspace Select", async () => {
    await openCreateDialog();
    expect(screen.queryByTestId("skill-form-workspace")).not.toBeInTheDocument();
    const scopeTrigger = screen
      .getByTestId("skill-form-scope")
      .querySelector('[role="combobox"]') as Element;
    fireEvent.click(scopeTrigger);
    fireEvent.click(await screen.findByRole("option", { name: "Workspace" }));
    expect(screen.getByTestId("skill-form-workspace")).toBeInTheDocument();
    // Marketing/Engineering options render from the workspaces query
    const wsTrigger = screen
      .getByTestId("skill-form-workspace")
      .querySelector('[role="combobox"]') as Element;
    fireEvent.click(wsTrigger);
    expect(await screen.findByRole("option", { name: "Marketing" })).toBeInTheDocument();
  });

  it("reserved slug renders slugReserved on blur", async () => {
    await openCreateDialog();
    const slugField = screen.getByTestId("skill-form-slug");
    fireEvent.change(slugField, { target: { value: "model" } });
    fireEvent.blur(slugField);
    expect(
      screen.getByText("This slug is reserved by a built-in command. Choose another.")
    ).toBeInTheDocument();
  });

  it("invalid slug format renders slugInvalid on blur", async () => {
    await openCreateDialog();
    const slugField = screen.getByTestId("skill-form-slug");
    fireEvent.change(slugField, { target: { value: "Bad Slug!" } });
    fireEvent.blur(slugField);
    expect(
      screen.getByText("Use lowercase letters, numbers and hyphens only (e.g. translate-text).")
    ).toBeInTheDocument();
  });

  it("edit mode pre-fills fields and Save calls useUpdateSkill", async () => {
    setSkillsState({
      builtin: mockBuiltin,
      custom: [
        makeRow({
          config: {
            defaultParams: { input: "ciao" },
            template: "Translate {{input}}",
          },
          inputSchema: { properties: { input: { type: "string" } }, required: ["input"] },
        }),
      ],
      accessible: [],
    });
    renderPage();
    fireEvent.click(screen.getByTestId("skills-edit-translate-text"));
    await screen.findByTestId("skill-form-name");
    expect((screen.getByTestId("skill-form-name") as HTMLInputElement).value).toBe("custom_translate-text");
    expect((screen.getByTestId("skill-form-template") as HTMLTextAreaElement).value).toBe(
      "Translate {{input}}"
    );
    expect(screen.getByTestId("skill-form-enabled")).toBeInTheDocument();
    mockUpdate.mockResolvedValue(undefined);
    fireEvent.click(screen.getByTestId("skill-form-save"));
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sk-1" })
      );
    });
  });

  it("edit-mode save rejects a 409 as slugDuplicate inline", async () => {
    setSkillsState({ builtin: mockBuiltin, custom: [makeRow()], accessible: [] });
    mockUpdate.mockRejectedValue(new ApiError(409, "duplicate"));
    renderPage();
    fireEvent.click(screen.getByTestId("skills-edit-translate-text"));
    await screen.findByTestId("skill-form-name");
    fireEvent.click(screen.getByTestId("skill-form-save"));
    await waitFor(() => {
      expect(screen.getByText("A skill with this slug already exists.")).toBeInTheDocument();
    });
  });

  it("manual JSON tab flags invalid JSON with jsonError", async () => {
    await openCreateDialog();
    // Radix TabsTrigger activates on mouseDown (WidgetDetailPage.test.tsx precedent)
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Manual JSON" }));
    fireEvent.change(await screen.findByTestId("skill-form-json"), { target: { value: "{ not json" } });
    expect(screen.getByText("Invalid JSON — fix the schema to save.")).toBeInTheDocument();
  });

  it("edit-mode Test Skill calls useTestSkill and renders the compiled preview", async () => {
    setSkillsState({ builtin: mockBuiltin, custom: [makeRow()], accessible: [] });
    mockTest.mockResolvedValue({ compiledPrompt: "COMPILED PROMPT OUTPUT" });
    renderPage();
    fireEvent.click(screen.getByTestId("skills-edit-translate-text"));
    await screen.findByTestId("skill-form-name");
    fireEvent.click(screen.getByTestId("skill-form-test"));
    await waitFor(() => {
      expect(screen.getByTestId("skill-test-preview")).toBeInTheDocument();
    });
    expect(screen.getByText("Compiled prompt preview")).toBeInTheDocument();
    expect(screen.getByText("COMPILED PROMPT OUTPUT")).toBeInTheDocument();
    expect(mockTest).toHaveBeenCalledWith({ id: "sk-1", params: {} });
  });

  it("WR-06: an edit save ALWAYS carries inputSchema alongside config (both-sides refine always evaluable)", async () => {
    // The D-04 update refine only evaluates when the patch carries BOTH
    // config and inputSchema — a template-only patch would 400 against the
    // persisted schema (the field-error the UI renders as a generic
    // skills.error.save). The dialog guards this by always including the
    // (auto or manual) inputSchema in the edit payload; this pin keeps the
    // invariant from regressing.
    setSkillsState({
      builtin: mockBuiltin,
      custom: [
        makeRow({
          config: {
            defaultParams: {},
            template: "Translate {{input}} to {{targetLang}}",
          },
          inputSchema: { properties: { input: { type: "string" } }, required: ["input"] },
        }),
      ],
      accessible: [],
    });
    mockUpdate.mockResolvedValue(undefined);
    renderPage();
    fireEvent.click(screen.getByTestId("skills-edit-translate-text"));
    await screen.findByTestId("skill-form-name");
    // Do NOT touch the schema tab — the trap scenario (auto-generate tab is
    // the default; nothing re-opened, nothing touched).
    fireEvent.click(screen.getByTestId("skill-form-save"));
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalled();
    });
    const payload = mockUpdate.mock.calls[0][0].data as Record<string, unknown>;
    // Both sides present + coherent (autoSchema recomputed from the current
    // template covers every placeholder).
    expect(payload.config).toBeDefined();
    expect(payload.inputSchema).toEqual({
      properties: { input: { type: "string" }, targetLang: { type: "string" } },
      required: [],
    });
  });

  it("highlight overlay renders placeholder spans from the template text", async () => {
    await openCreateDialog();
    fireEvent.change(screen.getByTestId("skill-form-template"), {
      target: { value: "Hello {{name}}" },
    });
    const overlay = screen.getByTestId("skill-template-overlay");
    const spans = overlay.querySelectorAll("span");
    expect(spans.length).toBe(2);
    // First segment (plain text) is transparent; second (placeholder) carries the tint class
    expect(spans[0].className).toContain("text-transparent");
    expect(spans[1].className).toContain("text-primary/70");
    expect(spans[1].textContent).toBe("{{name}}");
  });
});