// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * WidgetCreditsTab tests (130-02 T2)
 *
 * Covers the functional Credits tab (D-05 / CRD-01 SC2): the enabled Switch,
 * the label Input (max 200), and the URL Input with client-side http/https
 * validation mirroring the shared widgetCreditsSchema refine (widget.schema.ts:
 * 50-58) — all wired into the SHARED form instance via nested RHF dotted paths
 * (credits.enabled / credits.label / credits.url).
 *
 * Harness: the WidgetLocalizationTab.test.tsx form-instance-capture pattern —
 * a real useForm, captured via a ref, asserted through getValues after DOM
 * events.
 */

// ── Mocks (must be BEFORE any imports) ──────────────────────────

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// Quick 260826-hx5: feature-flag mock. `featureOn` is module-scoped so each
// test can flip it before renderTab(). Defaults to true so the existing
// validation tests keep passing unchanged.
let featureOn = true;
jest.mock("../hooks/useFeature", () => ({
  useFeature: () => featureOn,
}));

// ── Imports ──────────────────────────────────────────────────────

import "@testing-library/jest-dom";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { Form } from "@/components/ui/form";
import WidgetCreditsTab from "../components/WidgetCreditsTab";
import type { WidgetFormValues } from "../components/WidgetForm";

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
  questionsMode: "default",
  suggestedQuestions: {},
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
      <WidgetCreditsTab form={form} />
    </Form>
  );
}

function renderTab(defaults?: Partial<WidgetFormValues>) {
  capturedForm = null;
  return render(<Harness defaults={defaults} />);
}

beforeEach(() => {
  capturedForm = null;
  featureOn = true;
});

afterEach(() => {
  cleanup();
});

describe("WidgetCreditsTab", () => {
  it("typing into the label field updates the shared form instance via credits.label (max 200)", () => {
    renderTab();
    const labelInput = screen.getByLabelText("widgets.credits.label");
    // maxLength mirrors widgetCreditsSchema label max(200)
    expect(labelInput).toHaveAttribute("maxlength", "200");
    fireEvent.change(labelInput, { target: { value: "Powered by Simmetric Chat" } });
    expect(capturedForm!.getValues("credits.label")).toBe("Powered by Simmetric Chat");
  });

  it("rejects a javascript: URL — FormMessage shows widgets.credits.urlInvalid and submit is blocked — then accepts https://", async () => {
    const onSubmit = jest.fn();
    renderTab({ credits: { enabled: true, label: "X", url: "" } });
    const urlInput = screen.getByLabelText("widgets.credits.url");
    // javascript: must be blocked client-side (T-130-07, Pitfall 2 — never
    // z.string().url() semantics, which accepts javascript:)
    fireEvent.change(urlInput, { target: { value: "javascript:alert(1)" } });
    await capturedForm!.handleSubmit(onSubmit)();
    expect(onSubmit).not.toHaveBeenCalled();
    // The error message renders after the RHF state flush
    await waitFor(() => {
      expect(screen.getByText("widgets.credits.urlInvalid")).toBeInTheDocument();
    });
    // The same input accepts a valid http(s) URL → error clears, submit fires
    fireEvent.change(urlInput, { target: { value: "https://example.com" } });
    await capturedForm!.handleSubmit(onSubmit)();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByText("widgets.credits.urlInvalid")).not.toBeInTheDocument();
    });
  });

  it("rejects a bare http:// URL — FormMessage shows widgets.credits.urlInvalid and submit is blocked (WR-01)", async () => {
    const onSubmit = jest.fn();
    renderTab({ credits: { enabled: true, label: "X", url: "" } });
    const urlInput = screen.getByLabelText("widgets.credits.url");
    // Bare scheme (no host) must be blocked client-side (WR-01, T-131-05 —
    // the old /^https?:\/\// prefix regex accepted it, 400ing the ENTIRE PUT
    // via the server widgetCreditsSchema host check).
    fireEvent.change(urlInput, { target: { value: "http://" } });
    await capturedForm!.handleSubmit(onSubmit)();
    expect(onSubmit).not.toHaveBeenCalled();
    // The error message renders after the RHF state flush
    await waitFor(() => {
      expect(screen.getByText("widgets.credits.urlInvalid")).toBeInTheDocument();
    });
  });

  it("clicking the enabled switch flips capturedForm.getValues('credits.enabled')", () => {
    renderTab(); // enabled: true
    const sw = screen.getByRole("switch");
    fireEvent.click(sw);
    expect(capturedForm!.getValues("credits.enabled")).toBe(false);
    fireEvent.click(sw);
    expect(capturedForm!.getValues("credits.enabled")).toBe(true);
  });
});

// Quick 260826-hx5 (D-01): widget_credits_editing gating. When the flag is on,
// the editable form renders; when off, an UpgradePrompt replaces the form.
describe("WidgetCreditsTab — widget_credits_editing gating", () => {
  it("renders the editable form when the flag is on (UpgradePrompt absent)", () => {
    featureOn = true;
    renderTab();
    expect(screen.getByLabelText("widgets.credits.label")).toBeInTheDocument();
    expect(screen.queryByText("upgrade.title")).not.toBeInTheDocument();
  });

  it("renders UpgradePrompt and hides the form fields when the flag is off", () => {
    featureOn = false;
    renderTab();
    expect(screen.getByText("upgrade.title")).toBeInTheDocument();
    expect(screen.getByText("widgets.credits.editingUpgradeMessage")).toBeInTheDocument();
    expect(screen.queryByLabelText("widgets.credits.label")).not.toBeInTheDocument();
    expect(screen.queryByTestId("credits-enabled")).not.toBeInTheDocument();
  });
});
