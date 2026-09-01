// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * WidgetLocalizationTab tests (128-03 T1)
 *
 * Covers the functional Localization tab (D-03 / I18N-01): the fallbackLocale
 * selector over ALL_LANGUAGES (8 options), the 8 locale groups × 5 text fields
 * wired via nested react-hook-form dotted paths (localizedTexts.<locale>.<field>),
 * shared-form-state updates, and seeding from the widget blob.
 */

// ── Mocks (must be BEFORE any imports) ──────────────────────────

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// Mock Select to render a native select for testability (repo precedent:
// SettingsLLM.test.tsx:29-39). The id prop is forwarded so FormLabel's
// htmlFor (formItemId) associates with the native select.
jest.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange, id }: { children?: React.ReactNode; value?: string; onValueChange?: (value: string) => void; id?: string }) => (
    <select id={id} value={value} onChange={(e) => onValueChange && onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children?: React.ReactNode; value?: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}));

// ── Imports ──────────────────────────────────────────────────────

import "@testing-library/jest-dom";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { Form } from "@/components/ui/form";
import WidgetLocalizationTab from "../components/WidgetLocalizationTab";
import type { WidgetFormValues } from "../components/WidgetForm";

const ALL_LOCALES = ["en", "de", "es", "fr", "it", "ru", "zh", "pt"] as const;

const baseDefaults: WidgetFormValues = {
  name: "",
  position: "bottom-right",
  isActive: true,
  welcomeMessage: "",
  fallbackMessage: "",
  primaryColor: "#4c6ef5",
  botName: "",
  logoUrl: "",
  avatarUrl: "",
  autoOpenByUrlEnabled: false,
  autoOpenUrlPatterns: "",
  autoOpenByTimeEnabled: false,
  autoOpenDelay: "",
  exitIntentEnabled: false,
  exitIntentCooldownMin: "30",
  leadCaptureEnabled: false,
  leadCapturePrompt: "",
  allowedOrigins: "",
  fallbackLocale: "en",
  localizedTexts: {},
  // 129-01: WidgetFormValues gained the two non-optional questions fields —
  // baseDefaults is typed as WidgetFormValues, so it must carry them or
  // typecheck breaks.
  questionsMode: "default",
  suggestedQuestions: {},
  // 130-02: WidgetFormValues gained the required credits field — same
  // typed-as-WidgetFormValues break, same fix.
  credits: { enabled: true, label: "", url: "" },
};

let capturedForm: UseFormReturn<WidgetFormValues> | null = null;

function Harness({ defaults }: { defaults?: Partial<WidgetFormValues> }) {
  const form = useForm<WidgetFormValues>({
    defaultValues: { ...baseDefaults, ...defaults },
  });
  capturedForm = form;
  return (
    <Form {...form}>
      <WidgetLocalizationTab form={form} />
    </Form>
  );
}

function renderTab(defaults?: Partial<WidgetFormValues>) {
  capturedForm = null;
  return render(<Harness defaults={defaults} />);
}

beforeEach(() => {
  capturedForm = null;
});

afterEach(() => {
  cleanup();
});

describe("WidgetLocalizationTab", () => {
  it("renders a fallbackLocale Select with 8 options from ALL_LANGUAGES", () => {
    renderTab();
    const select = screen.getByLabelText("widgets.localization.fallbackLocaleLabel");
    expect(select).toBeInTheDocument();
    const options = within(select).getAllByRole("option");
    expect(options).toHaveLength(8);
    expect(options.map((o) => o.getAttribute("value"))).toEqual([...ALL_LOCALES]);
  });

  it("renders 8 locale groups × 5 fields (welcomeMessage, fallbackMessage, placeholder, piiConsent, leadPrompt)", () => {
    renderTab();
    // 8 locales × 5 textareas
    expect(screen.getAllByRole("textbox")).toHaveLength(40);
    // One heading per locale group
    for (const code of ALL_LOCALES) {
      expect(screen.getByTestId(`locale-group-${code}`)).toBeInTheDocument();
    }
    // Each of the 5 field labels appears once per locale group
    for (const field of ["welcomeMessage", "fallbackMessage", "placeholder", "piiConsent", "leadPrompt"]) {
      expect(screen.getAllByText(`widgets.localization.${field}`)).toHaveLength(8);
    }
  });

  it("typing into a localization field updates the shared form state via the dotted path", () => {
    renderTab();
    const itGroup = screen.getByTestId("locale-group-it");
    const itWelcome = within(itGroup).getByLabelText("widgets.localization.welcomeMessage");
    fireEvent.change(itWelcome, { target: { value: "Benvenuto!" } });
    expect(capturedForm!.getValues("localizedTexts.it.welcomeMessage")).toBe("Benvenuto!");
  });

  it("changing fallbackLocale updates form.getValues('fallbackLocale')", () => {
    renderTab();
    const select = screen.getByLabelText("widgets.localization.fallbackLocaleLabel");
    fireEvent.change(select, { target: { value: "it" } });
    expect(capturedForm!.getValues("fallbackLocale")).toBe("it");
  });

  it("seeds the instance from widget.localizedTexts + fallbackLocale (D-06 fields)", () => {
    renderTab({
      fallbackLocale: "de",
      localizedTexts: {
        it: { welcomeMessage: "Ciao", placeholder: "Scrivi qui" },
        en: { welcomeMessage: "Hello" },
      },
    });
    // Selector reflects the seeded fallbackLocale
    expect(screen.getByLabelText("widgets.localization.fallbackLocaleLabel")).toHaveValue("de");
    // Seeded blob values render in the per-locale textareas
    const itGroup = screen.getByTestId("locale-group-it");
    expect(within(itGroup).getByLabelText("widgets.localization.welcomeMessage")).toHaveValue("Ciao");
    expect(within(itGroup).getByLabelText("widgets.localization.placeholder")).toHaveValue("Scrivi qui");
    const enGroup = screen.getByTestId("locale-group-en");
    expect(within(enGroup).getByLabelText("widgets.localization.welcomeMessage")).toHaveValue("Hello");
    // Unseeded locales render empty
    const ruGroup = screen.getByTestId("locale-group-ru");
    expect(within(ruGroup).getByLabelText("widgets.localization.welcomeMessage")).toHaveValue("");
  });
});
