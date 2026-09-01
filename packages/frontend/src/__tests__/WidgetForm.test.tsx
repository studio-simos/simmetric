// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * WidgetForm tests (128-02 T1 + 128-03 T2)
 *
 * 128-02: de-modalized "host" rendering (D-02), unchanged settings save path
 * (ADM-03 regression), workspaces payload, create-mode navigation via
 * onSave(created.id) (Pitfall 6), onDirtyChange dirty-guard contract.
 *
 * 128-03: Tabs-in-form restructure (OQ2 final — WidgetForm owns the Tabs
 * inside its <form>), payload extension (fallbackLocale + localizedTexts
 * null-when-empty alongside legacy scalars), tab-switch state preservation
 * (forceMount + hidden), and the 5 triggers + shells + leads inside the form.
 */

// ── Mocks (must be BEFORE any imports) ──────────────────────────

const mockCreateWidget = jest.fn().mockResolvedValue({ id: "new-1", name: "X" });
const mockUpdateWidget = jest.fn().mockResolvedValue({});
const mockUpdateWorkspaces = jest.fn().mockResolvedValue({});

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// Mock the i18n module (repo precedent: SettingsGeneral.test.tsx) so the
// Localization tab's ALL_LANGUAGES import is deterministic.
jest.mock("../i18n", () => ({
  ALL_LANGUAGES: [
    { code: "en", name: "English" },
    { code: "de", name: "Deutsch" },
    { code: "es", name: "Español" },
    { code: "fr", name: "Français" },
    { code: "it", name: "Italiano" },
    { code: "ru", name: "Русский" },
    { code: "zh", name: "中文" },
  ],
  getEnabledLanguages: () => ["en", "de", "es", "fr", "it", "ru", "zh"],
  setEnabledLanguages: jest.fn(),
}));

// Mock Select to render a native select for testability (repo precedent:
// SettingsLLM.test.tsx:29-39). The id prop is forwarded so FormLabel's
// htmlFor associates with the native select. SelectGroup/SelectLabel render
// as passthrough wrappers (260831-hgy — provider grouping) so grouped
// options flatten into the same native select.
jest.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange, id }: { children?: React.ReactNode; value?: string; onValueChange?: (value: string) => void; id?: string }) => (
    <select id={id} value={value} onChange={(e) => onValueChange && onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  SelectGroup: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children?: React.ReactNode; value?: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectLabel: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  SelectTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}));

jest.mock("../queries/useWidgets", () => ({
  useCreateWidget: () => ({ mutateAsync: mockCreateWidget }),
  useUpdateWidget: () => ({ mutateAsync: mockUpdateWidget }),
  useUpdateWidgetWorkspaces: () => ({ mutateAsync: mockUpdateWorkspaces }),
  useWidgetLeads: () => ({
    data: { leads: [{ id: "lead-1", widgetId: "widget-1", sessionId: null, name: "Jane", email: "lead@example.com", transcript: [], createdAt: "2026-01-02T00:00:00.000Z" }], total: 1, page: 1, limit: 20 },
    isLoading: false,
  }),
  useWidgetLead: () => ({ data: null }),
  useExportLeadsCsv: () => ({ mutateAsync: jest.fn() }),
}));

jest.mock("../queries/useSettings", () => ({
  useSettingsHelpers: () => ({ getValue: () => "", isReadOnly: () => false }),
}));

jest.mock("../hooks/useFeature", () => ({
  useFeature: () => true,
}));

jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
  toastWithAction: jest.fn(),
}));

jest.mock("../components/WidgetWorkspaceSelector", () => ({
  __esModule: true,
  default: () => <div data-testid="workspace-selector" />,
}));

// 260809-uxk T4: archive selector — useArchives is a global list (no workspace
// arg); two archives so the "none" option vs archive options are testable.
const ARCHIVE_ID_A = "00000000-0000-4000-8000-0000000000aa";
const ARCHIVE_ID_B = "00000000-0000-4000-8000-0000000000bb";
jest.mock("../queries/useArchives", () => ({
  useArchives: () => ({
    data: [
      { id: ARCHIVE_ID_A, name: "React & Dev docs" },
      { id: ARCHIVE_ID_B, name: "Product Handbook" },
    ],
    isLoading: false,
  }),
}));

// 260831-hgy: response model pin — useAvailableModels flattened list with
// two providers × models (mirrors the AvailableModel shape from useProviders).
const PROVIDER_ID_1 = "00000000-0000-4000-8000-0000000000cc";
const PROVIDER_ID_2 = "00000000-0000-4000-8000-0000000000dd";
jest.mock("../queries/useProviders", () => ({
  useAvailableModels: () => ({
    data: [
      {
        id: "pm-1", name: "qwen2.5:7b", displayName: "Qwen 2.5 7B", isLocal: true,
        providerId: PROVIDER_ID_1, providerName: "Ollama", providerType: "ollama",
        isDefault: false, capabilities: [],
      },
      {
        id: "pm-2", name: "llama3.1:8b", displayName: null, isLocal: true,
        providerId: PROVIDER_ID_1, providerName: "Ollama", providerType: "ollama",
        isDefault: false, capabilities: [],
      },
      {
        id: "pm-3", name: "gpt-4o", displayName: "GPT-4o", isLocal: false,
        providerId: PROVIDER_ID_2, providerName: "OpenAI", providerType: "openai",
        isDefault: false, capabilities: [],
      },
    ],
    isLoading: false,
  }),
}));

// ── Imports ──────────────────────────────────────────────────────

import "@testing-library/jest-dom";
import { useState } from "react";
import { screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { renderWithProviders } from "./test-utils";
import WidgetForm, { type WidgetTab } from "../components/WidgetForm";
import type { Widget } from "@simmetric-chat/shared";

const mockWidget: Widget = {
  id: "widget-1",
  name: "Test Widget",
  welcomeMessage: null,
  fallbackMessage: null,
  position: "bottom-right",
  isActive: true,
  logoUrl: null,
  primaryColor: null,
  botName: null,
  avatarUrl: null,
  allowedOrigins: null,
  autoOpenDelay: null,
  autoOpenUrlPatterns: null,
  exitIntentEnabled: false,
  exitIntentCooldownMs: 1800000,
  leadCaptureEnabled: false,
  leadCapturePrompt: null,
  createdBy: "admin",
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  workspaces: [],
  _count: { sessions: 0, leads: 1 },
  localizedTexts: null,
  suggestedQuestions: null,
  credits: null,
  fallbackLocale: null,
};

beforeEach(() => {
  mockCreateWidget.mockClear();
  mockUpdateWidget.mockClear();
  mockUpdateWorkspaces.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("WidgetForm (de-modalized host mode)", () => {
  it("renders without the fixed-overlay dialog markup (no role=dialog, no aria-modal, no bg-black/50)", () => {
    const { container } = renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[aria-modal="true"]')).toBeNull();
    expect(container.innerHTML).not.toContain("bg-black/50");
  });

  it("submits the settings payload via useUpdateWidget (ADM-03 regression)", async () => {
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "My Widget" },
    });
    fireEvent.change(screen.getByPlaceholderText("settings.widget.welcomeMessagePlaceholder"), {
      target: { value: "Hello there" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => {
      expect(mockUpdateWidget).toHaveBeenCalledWith({
        id: "widget-1",
        data: expect.objectContaining({
          name: "My Widget",
          position: "bottom-right",
          welcomeMessage: "Hello there",
        }),
      });
    });
    // G-128-3: empty legacy scalars are OMITTED, never sent as null — a null
    // 400s the whole PUT (updateWidgetSchema declares them non-nullable).
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    expect(payload).not.toHaveProperty("fallbackMessage");
    expect(payload).not.toHaveProperty("welcomeMessage", null);
  });

  it("also calls useUpdateWidgetWorkspaces with the selected workspace ids (edit mode)", async () => {
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "My Widget" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => {
      expect(mockUpdateWorkspaces).toHaveBeenCalledWith({
        widgetId: "widget-1",
        workspaceIds: [],
      });
    });
  });

  it("calls useCreateWidget and passes the created id to onSave (Pitfall 6)", async () => {
    const onSave = jest.fn();
    renderWithProviders(<WidgetForm tab="settings" onTabChange={jest.fn()} onSave={onSave} />);
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "New Widget" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockCreateWidget).toHaveBeenCalled());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("new-1"));
  });

  it("reports dirty state via onDirtyChange (true after edit, false after submit)", async () => {
    const onDirtyChange = jest.fn();
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} onDirtyChange={onDirtyChange} />
    );
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "Renamed" },
    });
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(true));
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(false));
  });
});

describe("WidgetForm (tabs-in-form + payload extension, 128-03 T2)", () => {
  it("submit payload includes localizedTexts + fallbackLocale alongside the legacy scalars (I18N-01, D-03)", async () => {
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "My Widget" },
    });
    // Type into a localization field (nested dotted path)
    const itGroup = screen.getByTestId("locale-group-it");
    fireEvent.change(within(itGroup).getByLabelText("widgets.localization.welcomeMessage"), {
      target: { value: "Benvenuto" },
    });
    // Change the default language
    fireEvent.change(screen.getByLabelText("widgets.localization.fallbackLocaleLabel"), {
      target: { value: "it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => {
      expect(mockUpdateWidget).toHaveBeenCalledWith({
        id: "widget-1",
        data: expect.objectContaining({
          name: "My Widget",
          // G-128-3: empty legacy scalars are OMITTED (no null keys) — the
          // payload must satisfy updateWidgetSchema's non-nullable scalars
          // so the localizedTexts blob + fallbackLocale reach Prisma.
          // New blob + selector
          fallbackLocale: "it",
          localizedTexts: { it: { welcomeMessage: "Benvenuto" } },
        }),
      });
    });
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    expect(payload).not.toHaveProperty("welcomeMessage");
    expect(payload).not.toHaveProperty("fallbackMessage");
  });

  it("legacy scalar fields keep their payload entries even when the blob is present", async () => {
    const widgetWithBlob: Widget = {
      ...mockWidget,
      welcomeMessage: "Legacy hello",
      localizedTexts: { en: { welcomeMessage: "Blob hello" } },
    };
    renderWithProviders(
      <WidgetForm widget={widgetWithBlob} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "My Widget" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => {
      expect(mockUpdateWidget).toHaveBeenCalledWith({
        id: "widget-1",
        data: expect.objectContaining({
          welcomeMessage: "Legacy hello",
          localizedTexts: { en: { welcomeMessage: "Blob hello" } },
        }),
      });
    });
  });

  it("omits empty white_label branding fields (botName/logoUrl/avatarUrl) — no null keys (G-128-3)", async () => {
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "My Widget" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalled());
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    // white_label is enabled (useFeature mock → true), but the empty branding
    // fields must be OMITTED — botName null would 400 updateWidgetSchema
    // (z.string().max(100).optional(), not nullable — G-128-3).
    expect(payload).not.toHaveProperty("botName");
    expect(payload).not.toHaveProperty("logoUrl");
    expect(payload).not.toHaveProperty("avatarUrl");
  });

  it("JSON-stringifies autoOpenUrlPatterns when the auto-open toggle is on; omits it when off (G-128-3)", async () => {
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "My Widget" },
    });
    // Enable auto-open by URL and type patterns
    fireEvent.click(screen.getByRole("switch", { name: "settings.widget.autoOpenByUrl" }));
    fireEvent.change(await screen.findByPlaceholderText("settings.widget.urlPatternsPlaceholder"), {
      target: { value: "/pricing/*, /blog/*" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => {
      expect(mockUpdateWidget).toHaveBeenCalledWith({
        id: "widget-1",
        data: expect.objectContaining({
          // Schema declares z.string() (widget.schema.ts:213) — the DB stores
          // a JSON-encoded string of string[] per the repo convention.
          autoOpenUrlPatterns: JSON.stringify(["/pricing/*", "/blog/*"]),
        }),
      });
    });
    // Toggle off → the field is omitted entirely (no array, no null)
    fireEvent.click(screen.getByRole("switch", { name: "settings.widget.autoOpenByUrl" }));
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalledTimes(2));
    const payloadToggleOff = mockUpdateWidget.mock.calls[1][0].data;
    expect(payloadToggleOff).not.toHaveProperty("autoOpenUrlPatterns");
  });

  it("switching tabs keeps the form mounted (forceMount + hidden — one instance, SC3)", () => {
    function Harness() {
      const [tab, setTab] = useState<WidgetTab>("settings");
      return (
        <WidgetForm widget={mockWidget} tab={tab} onTabChange={(next) => setTab(next)} onSave={jest.fn()} />
      );
    }
    renderWithProviders(<Harness />);
    // Type into the settings form
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "Persisted" },
    });
    // Switch to the localization tab (Radix activates on onMouseDown)
    fireEvent.mouseDown(screen.getByText("widgets.tabs.localization"));
    // All 5 panels stay in the DOM (forceMount)
    const panels = Array.from(document.querySelectorAll('[data-slot="tabs-content"]'));
    expect(panels).toHaveLength(5);
    // Localization panel visible; settings panel hidden
    const locPanel = panels.find((p) => p.textContent?.includes("widgets.localization.fallbackLocaleLabel"));
    expect(locPanel).toBeDefined();
    expect(locPanel!.className).not.toContain("hidden");
    const settingsPanel = panels.find((p) => p.textContent?.includes("settings.widget.nameLabel"));
    expect(settingsPanel).toBeDefined();
    expect(settingsPanel!.className).toContain("hidden");
    // Switch back — the typed value survives (one form instance)
    fireEvent.mouseDown(screen.getByText("widgets.tabs.settings"));
    expect(screen.getByPlaceholderText("settings.widget.namePlaceholder")).toHaveValue("Persisted");
  });

  it("all 5 tab triggers + panels render inside WidgetForm's form tree", () => {
    const { container } = renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    // 5 triggers inside the <form>
    expect(form!.querySelectorAll('[role="tab"]')).toHaveLength(5);
    // 5 panels inside the <form>
    expect(form!.querySelectorAll('[data-slot="tabs-content"]')).toHaveLength(5);
    // Panels are children of the form — the questions panel now renders the
    // functional editor (WidgetQuestionsTab marker), credits renders the
    // WidgetCreditsTab editor marker (130-02 — the coming-soon shell is gone)
    expect(form!.textContent).toContain("widgets.questions.modeLabel");
    expect(form!.textContent).toContain("widgets.credits.label");
    expect(form!.textContent).not.toContain("widgets.tabs.creditsComingSoon");
    expect(form!.textContent).toContain("lead@example.com");
  });
});

describe("WidgetForm (questions tri-state payload, 129-01)", () => {
  it("default mode (suggestedQuestions: null) omits suggestedQuestions from the PUT payload (G-128-3)", async () => {
    // mockWidget.suggestedQuestions is null → the 3-branch seeding derives
    // questionsMode "default" → the payload branch does NOTHING for questions
    // (field omitted entirely) → the blob stays null server-side → the client
    // DEFAULT_CONFIG shows (QST-01 SC1, D-02).
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "My Widget" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalled());
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    expect(payload).not.toHaveProperty("suggestedQuestions");
  });
});

describe("WidgetForm (questions tri-state payload, 129-02)", () => {
  // The localization tab ALSO renders locale-group-<code> sections (both tabs
  // are forceMounted), so scope every questions query to the questions panel.
  function questionsPanel(): HTMLElement {
    const panels = Array.from(document.querySelectorAll('[data-slot="tabs-content"]'));
    const panel = panels.find((p) => p.textContent?.includes("widgets.questions.modeLabel"));
    expect(panel).toBeDefined();
    return panel as HTMLElement;
  }

  it("none mode → the PUT payload carries suggestedQuestions: {} (Pitfall 3 pin: never null)", async () => {
    // mockWidget.suggestedQuestions is null → questionsMode seeds "default";
    // switching the radio to "none" must send {} — defaults never resurrect
    // (QST-01 SC1, D-02).
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="questions" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "My Widget" },
    });
    fireEvent.click(within(questionsPanel()).getByRole("radio", { name: /widgets.questions.modeNone/ }));
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalled());
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    expect(payload.suggestedQuestions).toEqual({});
  });

  it("custom mode with a filled locale → the payload carries the trimmed non-empty record", async () => {
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="questions" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "My Widget" },
    });
    fireEvent.click(within(questionsPanel()).getByRole("radio", { name: /widgets.questions.modeCustom/ }));
    // Add a row to the it locale and type a question
    const itGroup = within(questionsPanel()).getByTestId("locale-group-it");
    fireEvent.click(within(itGroup).getByRole("button", { name: "widgets.questions.addQuestion" }));
    fireEvent.change(within(itGroup).getByPlaceholderText("widgets.questions.questionPlaceholder"), {
      target: { value: "  Ciao?  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalled());
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    // Trimmed, non-empty only — empty rows dropped
    expect(payload.suggestedQuestions).toEqual({ it: ["Ciao?"] });
  });

  it("custom mode where all rows are empty/whitespace → the payload carries suggestedQuestions: {} (none shown)", async () => {
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="questions" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "My Widget" },
    });
    fireEvent.click(within(questionsPanel()).getByRole("radio", { name: /widgets.questions.modeCustom/ }));
    // Add a row and leave it empty (whitespace)
    const itGroup = within(questionsPanel()).getByTestId("locale-group-it");
    fireEvent.click(within(itGroup).getByRole("button", { name: "widgets.questions.addQuestion" }));
    fireEvent.change(within(itGroup).getByPlaceholderText("widgets.questions.questionPlaceholder"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalled());
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    // "none shown" semantics — defaults do not resurrect (QST-01 SC1)
    expect(payload.suggestedQuestions).toEqual({});
  });

  it("the questions tab panel renders WidgetQuestionsTab (coming-soon shell is gone)", () => {
    const { container } = renderWithProviders(
      <WidgetForm widget={mockWidget} tab="questions" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    // The retired coming-soon key is gone; the functional editor marker renders
    expect(form!.textContent).not.toContain("widgets.tabs.questionsComingSoon");
    expect(form!.textContent).toContain("widgets.questions.modeLabel");
  });

  it("default mode with a stored blob → the PUT payload carries suggestedQuestions: null (WR-01 null-clear)", async () => {
    // A widget that has ever had a custom record (non-empty blob) seeds
    // questionsMode "custom" (WidgetForm.tsx:172). Switching the radio to
    // "default" and saving must NULL-CLEAR the blob — the server translates
    // null → Prisma.DbNull (toJsonWriteValue, widgetLocalizationMigration
    // precedent) so the reload re-seeds "default" and the client
    // DEFAULT_CONFIG shows. Before the WR-01 fix the "default" branch did
    // nothing and the admin's choice was silently discarded (129-REVIEW WR-01).
    const widgetWithBlob: Widget = {
      ...mockWidget,
      suggestedQuestions: { it: ["Ciao?"] },
    };
    renderWithProviders(
      <WidgetForm widget={widgetWithBlob} tab="questions" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "My Widget" },
    });
    fireEvent.click(within(questionsPanel()).getByRole("radio", { name: /widgets.questions.modeDefault/ }));
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalled());
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    expect(payload.suggestedQuestions).toBeNull();
  });

  it("default mode with no blob (never configured) → the payload omits suggestedQuestions (G-128-3 omit-only pin)", async () => {
    // mockWidget.suggestedQuestions is null → questionsMode seeds "default".
    // Saving WITHOUT touching the radio must keep the omit-only behavior —
    // the field stays absent from the payload (G-128-3). The WR-01 null-clear
    // is scoped to widgets that currently have a blob; never-configured
    // widgets must not start sending null.
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="questions" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "My Widget" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalled());
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    expect(payload).not.toHaveProperty("suggestedQuestions");
  });

  it("no-remount custom→default double-save with a stale prop → the SECOND payload carries suggestedQuestions: null (WR-02 race)", async () => {
    // The WR-02 refetch-window race (129-REVIEW WR-02): the null-clear guard
    // reads the `widget` PROP, which only refreshes when the useWidgets()
    // list-query refetch lands after save #1. A fast second save inside that
    // window reads the stale pre-save prop (null blob) and would OMIT the
    // field — the server keeps the custom blob and the admin's "Default
    // questions" choice is silently discarded. The form's in-memory blob is
    // the truth the guard needs: data.suggestedQuestions retains the typed
    // record across the radio switch (reset(getValues()) preserves values).
    // This test renders ONCE and never re-mounts — the prop stays the stale
    // null-blob widget for both saves, exactly the raced condition.
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="questions" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "My Widget" },
    });
    // custom → type a question → save #1 (payload carries the blob)
    fireEvent.click(within(questionsPanel()).getByRole("radio", { name: /widgets.questions.modeCustom/ }));
    const itGroup = within(questionsPanel()).getByTestId("locale-group-it");
    fireEvent.click(within(itGroup).getByRole("button", { name: "widgets.questions.addQuestion" }));
    fireEvent.change(within(itGroup).getByPlaceholderText("widgets.questions.questionPlaceholder"), {
      target: { value: "Ciao?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalledTimes(1));
    const firstPayload = mockUpdateWidget.mock.calls[0][0].data;
    expect(firstPayload.suggestedQuestions).toEqual({ it: ["Ciao?"] });
    // default → save #2 WITHOUT re-mounting (prop still the stale null-blob
    // widget — no refetch simulated). The second payload MUST null-clear.
    fireEvent.click(within(questionsPanel()).getByRole("radio", { name: /widgets.questions.modeDefault/ }));
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalledTimes(2));
    const secondPayload = mockUpdateWidget.mock.calls[1][0].data;
    expect(secondPayload.suggestedQuestions).toBeNull();
  });

  it("none→default transition with a fresh {} blob prop → the payload carries suggestedQuestions: null (prop-check half of the OR guard)", async () => {
    // A widget with suggestedQuestions: {} seeds questionsMode "none"
    // (WidgetForm.tsx:172 — empty record is non-null). Switching to "default"
    // and saving must null-clear: the prop check (`widget?.suggestedQuestions
    // != null`) fires because {} is non-null. This pins the prop-check half of
    // the OR guard — a form-value-only check would regress it, because the
    // none→default transition carries {} in the form (Object.keys({}).length
    // === 0) and the form half alone would not fire (129-REVIEW WR-02 warning).
    const widgetWithEmptyBlob: Widget = {
      ...mockWidget,
      suggestedQuestions: {},
    };
    renderWithProviders(
      <WidgetForm widget={widgetWithEmptyBlob} tab="questions" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "My Widget" },
    });
    fireEvent.click(within(questionsPanel()).getByRole("radio", { name: /widgets.questions.modeDefault/ }));
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalled());
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    expect(payload.suggestedQuestions).toBeNull();
  });
});

describe("WidgetForm (credits payload, 130-02)", () => {
  // The three credits payload cases (D-05, G-128-3): full valid blob when
  // BOTH label and url trim non-empty, null-clear when both are empty, and
  // null-clear on a MIXED fill (exactly one side filled) — a partial blob
  // (label: "" fails widgetCreditsSchema min(1), url: "" fails the http/https
  // refine) would 400 the ENTIRE PUT via the strict schema. Credits has NO
  // tri-state — the payload branch is full-valid-blob-or-null, never {} and
  // never partial (RESEARCH Pattern 3; the questions {} branch must NOT be
  // copied).
  //
  // The credits shell renders in the credits tab until Task 2 lands the
  // WidgetCreditsTab editor, so the cases reach the exact branch states
  // through seeded widget.credits fixtures (the editor DOM-typing coverage
  // lives in WidgetCreditsTab.test.tsx). The fixture blob seeds the form's
  // nested credits.* fields; reset(getValues()) after save #1 preserves them
  // across saves in the same mount (one form instance, no remount).
  function renderWithCredits(credits: Widget["credits"]) {
    renderWithProviders(
      <WidgetForm
        widget={{ ...mockWidget, credits }}
        tab="credits"
        onTabChange={jest.fn()}
        onSave={jest.fn()}
      />
    );
  }

  it("BOTH label and url filled (trimmed) → the payload carries the full valid blob (enabled + trimmed label + trimmed url)", async () => {
    renderWithCredits({ enabled: true, label: "  Powered by Simmetric  ", url: "  https://example.com/  " });
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "My Widget" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalled());
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    expect(payload.credits).toEqual({
      enabled: true,
      label: "Powered by Simmetric",
      url: "https://example.com/",
    });
  });

  it("BOTH label and url empty → the payload carries credits: null (null-clear → client defaults, D-02)", async () => {
    renderWithCredits({ enabled: true, label: "", url: "" });
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "My Widget" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalled());
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    expect(payload.credits).toBeNull();
  });

  it("enabled:false with empty label and url → the payload carries the persisted blob { enabled: false, label: \"\", url: \"\" } — never null-clear (WR-02)", async () => {
    renderWithCredits({ enabled: false, label: "", url: "" });
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "My Widget" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalled());
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    // WR-02 (D-06): the enabled:false toggle must actually hide credits —
    // persisting the blob (empty label/url allowed per the widened schema)
    // makes shouldShowCredits(whiteLabel=true, {enabled:false,...}) → false.
    // Null-clearing would resurrect the client defaults (the old no-op bug).
    expect(payload.credits).toEqual({ enabled: false, label: "", url: "" });
  });

  it("MIXED fill (only the label filled) → the payload carries credits: null — never a partial blob", async () => {
    renderWithCredits({ enabled: true, label: "Powered by Simmetric", url: "" });
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "My Widget" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalled());
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    expect(payload.credits).toBeNull();
  });

  it("MIXED fill (only the url filled) → the payload carries credits: null — never a partial blob", async () => {
    renderWithCredits({ enabled: true, label: "", url: "https://example.com" });
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "My Widget" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalled());
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    expect(payload.credits).toBeNull();
  });
});

describe("WidgetForm (archive selector payload, 260809-uxk T4)", () => {
  // The Select mock renders a native select labeled via FormLabel (htmlFor→id
  // is forwarded by the mock), so getByLabelText("settings.widget.archiveLabel")
  // targets it. fireEvent.change works on native selects.
  const archiveSelect = () => screen.getByLabelText("settings.widget.archiveLabel") as HTMLSelectElement;

  it("renders the archive selector with a 'none' option + one option per archive", () => {
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    const select = archiveSelect();
    const options = Array.from(select.options).map((o) => o.value);
    // "none" option (empty string value) + the two mocked archives
    expect(options).toContain("");
    expect(options).toContain(ARCHIVE_ID_A);
    expect(options).toContain(ARCHIVE_ID_B);
    expect(options).toHaveLength(3);
  });

  it("selecting an archive and saving sends data.archiveId = the selected id", async () => {
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    fireEvent.change(archiveSelect(), { target: { value: ARCHIVE_ID_A } });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalled());
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    expect(payload.archiveId).toBe(ARCHIVE_ID_A);
  });

  it("leaving the selector on 'none' sends archiveId: null (nullable write contract)", async () => {
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalled());
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    expect(payload.archiveId).toBeNull();
  });

  it("editing a widget with archiveId set seeds the selector with that value", () => {
    const archivedWidget = { ...mockWidget, archiveId: ARCHIVE_ID_A };
    renderWithProviders(
      <WidgetForm widget={archivedWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    expect(archiveSelect().value).toBe(ARCHIVE_ID_A);
  });

  it("create mode sends archiveId: null when the selector stays on 'none'", async () => {
    renderWithProviders(<WidgetForm tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("settings.widget.namePlaceholder"), {
      target: { value: "New Widget" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockCreateWidget).toHaveBeenCalled());
    const payload = mockCreateWidget.mock.calls[0][0];
    expect(payload.archiveId).toBeNull();
  });
});

// ── 151-02 (G-151-1b): per-widget daily MESSAGE limit field ────────────────
describe("WidgetForm (sessionLimitPerDay field, 151-02 G-151-1b)", () => {
  it("renders the messages-per-day input with label + hint (edit mode)", () => {
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    expect(screen.getByLabelText("settings.widget.sessionLimitPerDay")).toBeInTheDocument();
    expect(screen.getByText("settings.widget.sessionLimitPerDayHint")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("settings.widget.sessionLimitPerDayPlaceholder")).toBeInTheDocument();
  });

  it("seeds the field from the widget row when sessionLimitPerDay is set", () => {
    const limitedWidget = { ...mockWidget, sessionLimitPerDay: 25 };
    renderWithProviders(
      <WidgetForm widget={limitedWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    const input = screen.getByLabelText("settings.widget.sessionLimitPerDay") as HTMLInputElement;
    expect(input.value).toBe("25");
  });

  it("saves a filled sessionLimitPerDay as a positive int in the payload", async () => {
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    fireEvent.change(screen.getByLabelText("settings.widget.sessionLimitPerDay"), {
      target: { value: "42" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalled());
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    expect(payload.sessionLimitPerDay).toBe(42);
  });

  it("sends sessionLimitPerDay: null when left empty (global default — nullable write contract)", async () => {
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalled());
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    expect(payload.sessionLimitPerDay).toBeNull();
  });

  it("sends sessionLimitPerDay: null for a non-positive value (0/negative ignored)", async () => {
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    fireEvent.change(screen.getByLabelText("settings.widget.sessionLimitPerDay"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalled());
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    expect(payload.sessionLimitPerDay).toBeNull();
  });
});

// ── 151-03 (G-151-1c): autoOpenUrlPatterns dual-shape seeding regression ────
//
// The server stores/returns autoOpenUrlPatterns as a RAW JSON-encoded string
// (widget.schema.ts:311-313; admin GET routes pass the Prisma row through
// unparsed). The form seeds the toggle + textarea via parsePatternList, so
// every persisted shape must render without throwing. Before the fix,
// WidgetForm.tsx called `.join(", ")` on the raw string during useForm
// defaultValues seeding → TypeError → ErrorBoundary (G-151-1c).

describe("WidgetForm (autoOpenUrlPatterns JSON-string seeding, 151-03 G-151-1c)", () => {
  const autoOpenSwitch = () =>
    screen.getByRole("switch", { name: "settings.widget.autoOpenByUrl" });
  // The URL-patterns textarea only renders while the toggle is ON
  const urlPatternsTextarea = () =>
    screen.getByPlaceholderText("settings.widget.urlPatternsPlaceholder") as HTMLTextAreaElement;

  it("renders a widget with a persisted RAW JSON string pattern — no crash, textarea seeded, toggle ON (the reported repro)", () => {
    // The exact reported reproduction: the user typed a bare URL (no glob),
    // the save path JSON.stringify'd it → the DB holds '["localhost"]', and
    // GET /api/widgets returns that raw string. Edit-mode render must not
    // throw (ErrorBoundary guard) and must seed the pattern as plain text.
    const widgetWithPersistedPattern: Widget = {
      ...mockWidget,
      autoOpenUrlPatterns: JSON.stringify(["localhost"]),
    };
    renderWithProviders(
      <WidgetForm widget={widgetWithPersistedPattern} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    // The form rendered (no ErrorBoundary fallback) and the pattern is
    // seeded comma-separated in the textarea as plain text.
    expect(urlPatternsTextarea().value).toBe("localhost");
    expect(autoOpenSwitch()).toHaveAttribute("data-state", "checked");
  });

  it("an empty stored list '[]' seeds the toggle OFF with an empty textarea — no crash", () => {
    const widgetWithEmptyList: Widget = {
      ...mockWidget,
      autoOpenUrlPatterns: JSON.stringify([]),
    };
    renderWithProviders(
      <WidgetForm widget={widgetWithEmptyList} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    // Toggle OFF → the textarea is not rendered; the parsed list is empty so
    // "[]" must NOT enable the toggle (regression pin for the truthy-length
    // bug: `!!'[]'.length` would have flipped it ON).
    expect(autoOpenSwitch()).toHaveAttribute("data-state", "unchecked");
    expect(screen.queryByPlaceholderText("settings.widget.urlPatternsPlaceholder")).toBeNull();
  });

  it("a malformed persisted string (no JSON syntax) degrades to an empty list — no crash (T-151-03-01)", () => {
    const malformedWidget: Widget = {
      ...mockWidget,
      autoOpenUrlPatterns: "localhost", // not JSON — safeJsonParse → null
    };
    renderWithProviders(
      <WidgetForm widget={malformedWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    expect(autoOpenSwitch()).toHaveAttribute("data-state", "unchecked");
    expect(screen.queryByPlaceholderText("settings.widget.urlPatternsPlaceholder")).toBeNull();
  });
});

// ── Quick 260826-p0d: dynamic embed snippet reflecting live trigger toggles ──
// The snippet code block renders the output of buildWidgetSnippet(...) inline
// (WidgetForm.tsx embed section). form.watch drives real-time reflection —
// toggling a trigger updates the visible <script src> in the same render. The
// code block is the <div className="bg-muted ... whitespace-pre"> element; we
// locate it via its whitespace-pre class and assert on textContent.
describe("WidgetForm (dynamic embed snippet, 260826-p0d)", () => {
  // The snippet code block carries the whitespace-pre class (WidgetForm.tsx).
  const snippetBlock = (): HTMLElement => {
    const el = document.querySelector("div.whitespace-pre");
    if (!el) throw new Error("snippet code block (div.whitespace-pre) not found");
    return el;
  };

  it("renders no query params in the snippet when all triggers are OFF (D-05 omission)", () => {
    // mockWidget has autoOpenDelay: null, autoOpenUrlPatterns: null,
    // exitIntentEnabled: false → all toggles seed OFF.
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    const text = snippetBlock().textContent ?? "";
    // The script src has no query string — just the .js URL.
    expect(text).toContain("widget-1.js");
    expect(text).not.toContain("autoOpenDelay=");
    expect(text).not.toContain("autoOpenUrlPatterns=");
    expect(text).not.toContain("exitIntentEnabled=");
    expect(text).not.toContain("?");
  });

  it("reflects autoOpenDelay=5 in the snippet when auto-open-by-time is toggled ON (real-time, D-04)", () => {
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    // Toggle auto-open-by-time ON
    fireEvent.click(screen.getByRole("switch", { name: "settings.widget.autoOpenByTime" }));
    // The delay input renders; set it to 5
    const delayInput = screen.getByPlaceholderText("settings.widget.autoOpenDelayPlaceholder");
    fireEvent.change(delayInput, { target: { value: "5" } });
    // The snippet code block now contains autoOpenDelay=5
    const text = snippetBlock().textContent ?? "";
    expect(text).toContain("autoOpenDelay=5");
  });

  it("reflects exitIntentEnabled=1 in the snippet when exit-intent is toggled ON (real-time, D-04)", () => {
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    // Toggle exit-intent ON
    fireEvent.click(screen.getByRole("switch", { name: "settings.widget.exitIntentToggle" }));
    const text = snippetBlock().textContent ?? "";
    expect(text).toContain("exitIntentEnabled=1");
  });

  it("reflects autoOpenUrlPatterns when auto-open-by-URL is toggled ON with patterns (real-time, D-04)", () => {
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    // Toggle auto-open-by-URL ON
    fireEvent.click(screen.getByRole("switch", { name: "settings.widget.autoOpenByUrl" }));
    // The patterns textarea renders; type patterns
    const patternsInput = screen.getByPlaceholderText("settings.widget.urlPatternsPlaceholder");
    fireEvent.change(patternsInput, { target: { value: "/pricing/*" } });
    const text = snippetBlock().textContent ?? "";
    // The wire format is a URL-encoded JSON-encoded string of string[].
    expect(text).toContain("autoOpenUrlPatterns=");
    // The decoded value should be the JSON of ["/pricing/*"]
    const paramIdx = text.indexOf("autoOpenUrlPatterns=");
    const after = text.slice(paramIdx + "autoOpenUrlPatterns=".length);
    // The encoded value runs to the next & or end-of-src / closing quote.
    // Assert the decoded JSON shape is present after decode.
    const encodedMatch = after.match(/^([^&"<\s]*)/);
    expect(encodedMatch).not.toBeNull();
    expect(decodeURIComponent(encodedMatch![1])).toBe(JSON.stringify(["/pricing/*"]));
  });

  it("removes the params when toggles are turned back OFF (omission-not-empty, D-05)", () => {
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    // ON → param appears
    fireEvent.click(screen.getByRole("switch", { name: "settings.widget.autoOpenByTime" }));
    fireEvent.change(screen.getByPlaceholderText("settings.widget.autoOpenDelayPlaceholder"), {
      target: { value: "5" },
    });
    expect(snippetBlock().textContent ?? "").toContain("autoOpenDelay=5");
    // OFF → param disappears
    fireEvent.click(screen.getByRole("switch", { name: "settings.widget.autoOpenByTime" }));
    expect(snippetBlock().textContent ?? "").not.toContain("autoOpenDelay=");
  });
});

// ── 260831-hgy: per-widget response model pin selector ──────────────────────
describe("WidgetForm (response model pin, 260831-hgy)", () => {
  // The Select mock renders a native select labeled via FormLabel, so
  // getByLabelText("settings.widget.responseModelLabel") targets it.
  const modelSelect = () =>
    screen.getByLabelText("settings.widget.responseModelLabel") as HTMLSelectElement;

  it("(a) renders the provider-grouped options + the 'Workspace default' clear option", () => {
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    const select = modelSelect();
    const options = Array.from(select.options).map((o) => o.value);
    // Clear option first
    expect(options).toContain("");
    // One composite option per available model (provider::model), from two
    // different providers (grouping flattens into the native select)
    expect(options).toContain(`${PROVIDER_ID_1}::qwen2.5:7b`);
    expect(options).toContain(`${PROVIDER_ID_1}::llama3.1:8b`);
    expect(options).toContain(`${PROVIDER_ID_2}::gpt-4o`);
    // Provider group labels render (SelectLabel passthrough)
    expect(select.textContent).toContain("Ollama");
    expect(select.textContent).toContain("OpenAI");
    // Local/Cloud hint renders
    expect(select.textContent).toContain("Local");
    expect(select.textContent).toContain("Cloud");
  });

  it("(b) submit with a selected model → payload contains responseProviderId/responseModel from the split composite", async () => {
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    fireEvent.change(modelSelect(), { target: { value: `${PROVIDER_ID_1}::qwen2.5:7b` } });
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalled());
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    expect(payload.responseProviderId).toBe(PROVIDER_ID_1);
    expect(payload.responseModel).toBe("qwen2.5:7b");
  });

  it("(c) '' (Workspace default) → payload sends null for BOTH fields (clear contract)", async () => {
    renderWithProviders(
      <WidgetForm widget={mockWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    // The selector starts on "" (unconfigured widget) — save directly
    fireEvent.click(screen.getByRole("button", { name: "settings.widget.saveChanges" }));
    await waitFor(() => expect(mockUpdateWidget).toHaveBeenCalled());
    const payload = mockUpdateWidget.mock.calls[0][0].data;
    expect(payload.responseProviderId).toBeNull();
    expect(payload.responseModel).toBeNull();
  });

  it("(d) a stale stored selection renders the unavailable item without throwing", () => {
    // Provider deleted / model renamed: the stored composite is NOT among
    // availableModels. The form must render the extra "unavailable" item so
    // the trigger is not empty and the admin can see/replace/clear the pin.
    const staleWidget: Widget = {
      ...mockWidget,
      responseProviderId: "00000000-0000-4000-8000-00000000dead",
      responseModel: "old-model:deleted",
    };
    renderWithProviders(
      <WidgetForm widget={staleWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    const select = modelSelect();
    // The seeded composite IS the selected value and an option exists for it
    expect(select.value).toBe("00000000-0000-4000-8000-00000000dead::old-model:deleted");
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain("00000000-0000-4000-8000-00000000dead::old-model:deleted");
    expect(select.textContent).toContain("settings.widget.responseModelUnavailable");
  });

  it("a configured widget seeds the selector with the stored composite", () => {
    const pinnedWidget: Widget = {
      ...mockWidget,
      responseProviderId: PROVIDER_ID_2,
      responseModel: "gpt-4o",
    };
    renderWithProviders(
      <WidgetForm widget={pinnedWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    expect(modelSelect().value).toBe(`${PROVIDER_ID_2}::gpt-4o`);
  });

  it("a half-set legacy row (provider only) seeds '' (normalizes to cleared)", () => {
    const halfSetWidget: Widget = {
      ...mockWidget,
      responseProviderId: PROVIDER_ID_1,
      responseModel: null,
    };
    renderWithProviders(
      <WidgetForm widget={halfSetWidget} tab="settings" onTabChange={jest.fn()} onSave={jest.fn()} />
    );
    expect(modelSelect().value).toBe("");
  });
});
