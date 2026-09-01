// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * WidgetQuestionsTab tests (129-02 T1)
 *
 * Covers the functional Questions tab (D-01 / D-02 / QST-01/QST-02): the
 * tri-state RadioGroup (Default questions / No questions / Custom) as the
 * FIRST control, mode seeding from the record, the 7 locale groups with
 * per-locale question lists on nested react-hook-form dotted paths
 * (suggestedQuestions.<locale>), manual array editing with
 * { shouldDirty: true }, the max-10 × 200-char caps, and the empty-locale
 * state.
 */

// ── Mocks (must be BEFORE any imports) ──────────────────────────

const tMock = jest.fn((key: string) => key);

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      tMock(key, opts);
      return key;
    },
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// ── Imports ──────────────────────────────────────────────────────

import "@testing-library/jest-dom";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { Form } from "@/components/ui/form";
import WidgetQuestionsTab from "../components/WidgetQuestionsTab";
import type { WidgetFormValues } from "../components/WidgetForm";

const ALL_LOCALES = ["en", "de", "es", "fr", "it", "ru", "zh"] as const;

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
  // 130-02: WidgetFormValues gained the required credits field — same
  // typed-as-WidgetFormValues break, same fix.
  credits: { enabled: true, label: "", url: "" },
};

let capturedForm: UseFormReturn<WidgetFormValues> | null = null;

// Subscribes to formState.isDirty the same way WidgetForm's dirty-guard does
// (useEffect on formState.isDirty) — RHF's formState is proxy-based and only
// updates when subscribed, so a bare read of capturedForm.formState.isDirty
// would never see the flip.
function DirtyProbe() {
  const isDirty = capturedForm!.formState.isDirty;
  return <span data-testid="dirty-probe">{String(isDirty)}</span>;
}

function Harness({ defaults }: { defaults?: Partial<WidgetFormValues> }) {
  const form = useForm<WidgetFormValues>({
    defaultValues: { ...baseDefaults, ...defaults },
  });
  capturedForm = form;
  return (
    <Form {...form}>
      <WidgetQuestionsTab form={form} />
      <DirtyProbe />
    </Form>
  );
}

function renderTab(defaults?: Partial<WidgetFormValues>) {
  capturedForm = null;
  return render(<Harness defaults={defaults} />);
}

beforeEach(() => {
  capturedForm = null;
  tMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("WidgetQuestionsTab", () => {
  it("renders the tri-state RadioGroup FIRST with 3 options + hints under the modeLabel FormLabel", () => {
    const { container } = renderTab({ questionsMode: "custom" });
    // FormLabel for the group
    expect(screen.getByText("widgets.questions.modeLabel")).toBeInTheDocument();
    // 3 radio options
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    // Option labels + hint copy
    expect(screen.getByText("widgets.questions.modeDefault")).toBeInTheDocument();
    expect(screen.getByText("widgets.questions.modeDefaultHint")).toBeInTheDocument();
    expect(screen.getByText("widgets.questions.modeNone")).toBeInTheDocument();
    expect(screen.getByText("widgets.questions.modeNoneHint")).toBeInTheDocument();
    expect(screen.getByText("widgets.questions.modeCustom")).toBeInTheDocument();
    expect(screen.getByText("widgets.questions.modeCustomHint")).toBeInTheDocument();
    // Static max hint helper line
    expect(screen.getByText("widgets.questions.maxHint")).toBeInTheDocument();
    // FIRST control: the radio group precedes the first locale group in DOM order
    // (FormControl's Slot overrides the RadioGroup's data-slot, so query by role)
    const radioGroup = container.querySelector('[role="radiogroup"]');
    const firstLocaleGroup = container.querySelector('[data-testid="locale-group-en"]');
    expect(radioGroup).not.toBeNull();
    expect(firstLocaleGroup).not.toBeNull();
    expect(
      radioGroup!.compareDocumentPosition(firstLocaleGroup!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("seeds the checked radio from questionsMode (default / none / custom)", () => {
    renderTab(); // baseDefaults → "default"
    expect(screen.getByRole("radio", { name: /widgets.questions.modeDefault/ })).toBeChecked();

    cleanup();
    renderTab({ questionsMode: "none" });
    expect(screen.getByRole("radio", { name: /widgets.questions.modeNone/ })).toBeChecked();

    cleanup();
    renderTab({ questionsMode: "custom" });
    expect(screen.getByRole("radio", { name: /widgets.questions.modeCustom/ })).toBeChecked();
  });

  it("renders 7 locale groups in Custom mode; static hints only in Default/None modes", () => {
    renderTab({ questionsMode: "custom" });
    for (const code of ALL_LOCALES) {
      expect(screen.getByTestId(`locale-group-${code}`)).toBeInTheDocument();
    }

    cleanup();
    renderTab(); // default mode
    expect(screen.queryByTestId("locale-group-en")).not.toBeInTheDocument();
    // The 3 client defaults render as static text (DEFAULT_CONFIG list,
    // useWidgetConfig.ts:46-50 — hardcoded, widget package not importable)
    expect(screen.getByText("What is this product?")).toBeInTheDocument();
    expect(screen.getByText("How does it work?")).toBeInTheDocument();
    expect(screen.getByText("What are the pricing plans?")).toBeInTheDocument();
    expect(screen.getByText("widgets.questions.modeDefaultHint")).toBeInTheDocument();

    cleanup();
    renderTab({ questionsMode: "none" });
    expect(screen.queryByTestId("locale-group-en")).not.toBeInTheDocument();
    // Static none-mode section renders the hint copy
    expect(within(screen.getByTestId("questions-none-static")).getByText("widgets.questions.modeNoneHint")).toBeInTheDocument();
  });

  it("typing into a question Input updates the shared form state via the dotted path", () => {
    renderTab({ questionsMode: "custom", suggestedQuestions: { it: [""] } });
    const itGroup = screen.getByTestId("locale-group-it");
    const input = within(itGroup).getByPlaceholderText("widgets.questions.questionPlaceholder");
    fireEvent.change(input, { target: { value: "Ciao?" } });
    expect(capturedForm!.getValues("suggestedQuestions.it")).toEqual(["Ciao?"]);
  });

  it("Add-question appends a row with shouldDirty; remove drops it; counter shows the row count", async () => {
    renderTab({ questionsMode: "custom" });
    const itGroup = screen.getByTestId("locale-group-it");
    // Empty locale → Add-question button as the primary empty-state action
    fireEvent.click(within(itGroup).getByRole("button", { name: "widgets.questions.addQuestion" }));
    await waitFor(() => expect(screen.getByTestId("dirty-probe")).toHaveTextContent("true"));
    expect(capturedForm!.getValues("suggestedQuestions.it")).toEqual([""]);
    expect(tMock).toHaveBeenCalledWith("widgets.questions.count", { count: 1 });

    // Type into the appended row
    const input = within(itGroup).getByPlaceholderText("widgets.questions.questionPlaceholder");
    fireEvent.change(input, { target: { value: "Ciao?" } });

    // Remove the row → back to the empty state (emptyLocale copy + Add button;
    // the counter only renders when rows exist)
    fireEvent.click(within(itGroup).getByRole("button", { name: "widgets.questions.removeQuestion" }));
    expect(capturedForm!.getValues("suggestedQuestions.it")).toEqual([]);
    expect(within(itGroup).getByText("widgets.questions.emptyLocale")).toBeInTheDocument();
  });

  it("caps each locale at 10 rows (Add disabled) and enforces maxLength={200}", () => {
    renderTab({
      questionsMode: "custom",
      suggestedQuestions: { it: Array.from({ length: 10 }, (_, i) => `Q${i}`) },
    });
    const itGroup = screen.getByTestId("locale-group-it");
    // 10 rows render
    const inputs = within(itGroup).getAllByPlaceholderText("widgets.questions.questionPlaceholder");
    expect(inputs).toHaveLength(10);
    // maxLength cap on each row Input
    expect(inputs[0]).toHaveAttribute("maxlength", "200");
    // Add button disabled at 10 rows
    expect(within(itGroup).getByRole("button", { name: "widgets.questions.addQuestion" })).toBeDisabled();
    // Counter reads 10/10
    expect(tMock).toHaveBeenCalledWith("widgets.questions.count", { count: 10 });
  });

  it("renders the emptyLocale copy + Add-question button for an empty locale", () => {
    renderTab({ questionsMode: "custom" });
    const itGroup = screen.getByTestId("locale-group-it");
    expect(within(itGroup).getByText("widgets.questions.emptyLocale")).toBeInTheDocument();
    expect(within(itGroup).getByRole("button", { name: "widgets.questions.addQuestion" })).toBeInTheDocument();
  });
});
