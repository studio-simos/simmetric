// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ArchiveConfigPanel — auto-index toggle + schemaPrompt editor tests.
 *
 * Regression for quick 260725-uu1: the auto-index toggle must use the Switch UI
 * component (role="switch", data-checked:bg-primary) instead of a custom
 * button with hardcoded bg-blue-600/bg-gray-300, so it respects the user's
 * BRANDING_PRIMARY_COLOR (Settings → Aspetto → Colore principale).
 *
 * Phase 187 (WIKS-01): schemaPrompt editor section per 187-UI-SPEC —
 * Pitfall-1 payload preservation (whole-blob replace wipes omitted fields),
 * empty state template insert, char count + over-limit Save guard,
 * Edit/Preview toggle with sanitized markdown, no auto-save-on-blur.
 */
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ArchiveConfigPanel, DEFAULT_TEMPLATE_BODY } from "../components/ArchiveConfigPanel";

const apiPut = jest.fn();

jest.mock("../utils/api", () => ({
  apiPut: (...args: unknown[]) => apiPut(...(args as [string, unknown])),
}));

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: unknown) =>
      opts && typeof opts === "object" && "count" in (opts as Record<string, unknown>)
        ? `${key}:${(opts as Record<string, unknown>).count}`
        : key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
}));

jest.mock("../utils/markdown", () => ({
  // Mimics the DOMPurify-sanitized contract: raw <script> never survives as an element.
  renderMarkdown: (md: string) =>
    md
      ? `<p data-rendered="1">${md.replace(/<script[\s\S]*?<\/script>/g, "").replace(/</g, "&lt;")}</p>`
      : "",
}));

// Harness for the update mutation: captured so tests can assert the payload.
const updateMutateAsync = jest.fn();

// WR-02 harness: useArchiveConfig is per-test controllable — hydration-mock
// tests return `isLoading: true` / `data: undefined` to pin the Save gate.
const useArchiveConfigMock = jest.fn();

jest.mock("../queries/useArchives", () => ({
  useArchive: () => ({ data: { id: "arc1", autoIndex: false } }),
  useArchiveConfig: () => useArchiveConfigMock(),
  useUpdateArchiveConfig: () => ({ mutateAsync: updateMutateAsync, isPending: false }),
  useTriggerIndexing: () => ({ mutateAsync: jest.fn() }),
}));

// Mutable fixture — individual tests seed pre-existing schemaPrompt via setConfigFixture.
let configFixture: Record<string, unknown> = {
  agentPersona: "balanced",
  purpose: "",
  scope: "",
  linkingDensity: { min: 0.005, max: 0.15 },
};

function setConfigFixture(overrides: Record<string, unknown>) {
  configFixture = { ...configFixture, ...overrides };
  // Re-arm the query mock with the fresh fixture: jest.clearAllMocks() in
  // beforeEach wipes mockReturnValue, so every fixture mutation must
  // reinstall the return value (default = hydrated query state).
  useArchiveConfigMock.mockReturnValue({ data: configFixture, isLoading: false });
}

function setConfigQueryState(overrides: { data?: Record<string, unknown> | undefined; isLoading?: boolean }) {
  useArchiveConfigMock.mockReturnValue({
    data: overrides.data === undefined ? (overrides.isLoading ? undefined : configFixture) : overrides.data,
    isLoading: overrides.isLoading ?? false,
  });
}

function renderPanel() {
  return render(<ArchiveConfigPanel archiveId="arc1" />);
}

beforeEach(() => {
  jest.clearAllMocks();
  setConfigFixture({ schemaPrompt: undefined });
  setConfigQueryState({ isLoading: false });
  updateMutateAsync.mockResolvedValue(undefined);
});

describe("ArchiveConfigPanel auto-index toggle", () => {
  it("renders a Switch (role=switch) for auto-index, not a custom button", () => {
    renderPanel();
    const sw = screen.getByRole("switch");
    expect(sw).toBeInTheDocument();
    // data-state reflects the unchecked initial autoIndex (false)
    expect(sw).toHaveAttribute("data-state", "unchecked");
  });

  it("uses primary color (no hardcoded bg-blue-600/bg-gray-300)", () => {
    renderPanel();
    const sw = screen.getByRole("switch");
    const cls = sw.getAttribute("class") ?? "";
    expect(cls).not.toMatch(/bg-blue-600/);
    expect(cls).not.toMatch(/bg-gray-300/);
    // Switch UI component applies data-checked:bg-primary
    expect(cls).toMatch(/data-checked:bg-primary|peer group\/switch/);
  });

  it("calls apiPut to toggle autoIndex on click", async () => {
    apiPut.mockResolvedValueOnce(undefined);
    renderPanel();
    const sw = screen.getByRole("switch");
    fireEvent.click(sw);
    await waitFor(() => {
      expect(apiPut).toHaveBeenCalledWith("/archives/arc1", { autoIndex: true });
    });
  });
});

describe("ArchiveConfigPanel schemaPrompt (Phase 187, WIKS-01)", () => {
  it("(a) Pitfall-1 regression: header Save carries pre-existing schemaPrompt in the payload", async () => {
    setConfigFixture({ schemaPrompt: "Existing guidelines text" });
    renderPanel();
    // The header Save button (Save Configuration label) persists ALL fields
    const saveButton = screen.getByRole("button", { name: "archives.schemaPrompt.save" });
    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(updateMutateAsync).toHaveBeenCalledTimes(1);
    });
    const payload = updateMutateAsync.mock.calls[0][0] as {
      archiveId: string;
      config: Record<string, unknown>;
    };
    expect(payload.archiveId).toBe("arc1");
    expect(payload.config.schemaPrompt).toBe("Existing guidelines text");
  });

  it("(a2) empty schemaPrompt saves as empty string — clearing + saving is a valid empty state", async () => {
    setConfigFixture({ schemaPrompt: "" });
    renderPanel();
    const saveButton = screen.getByRole("button", { name: "archives.schemaPrompt.save" });
    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(updateMutateAsync).toHaveBeenCalledTimes(1);
    });
    const payload = updateMutateAsync.mock.calls[0][0] as {
      config: Record<string, unknown>;
    };
    expect(payload.config.schemaPrompt).toBe("");
  });

  it("(b) empty schemaPrompt renders placeholder + Use template; clicking inserts template body with raw_sources line", () => {
    renderPanel();
    const textarea = screen.getByPlaceholderText("archives.schemaPrompt.placeholder") as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
    const useTemplate = screen.getByRole("button", { name: "archives.schemaPrompt.useTemplate" });
    fireEvent.click(useTemplate);
    expect(textarea.value).toBe(DEFAULT_TEMPLATE_BODY);
    expect(textarea.value).toContain("raw_sources/ is immutable — never modify original source files.");
    // Template body mirrors spec §2.1 sections
    expect(textarea.value).toContain("## Page Structure");
    expect(textarea.value).toContain("## Naming Conventions");
    expect(textarea.value).toContain("## Tone");
    expect(textarea.value).toContain("## Maintenance");
    // Template visible only while empty (UI-SPEC empty row)
    expect(screen.queryByRole("button", { name: "archives.schemaPrompt.useTemplate" })).toBeNull();
  });

  it("(c) char count renders 'archives.schemaPrompt.charCount:123' for 123 chars and flips destructive over limit; Save disabled", () => {
    setConfigFixture({ schemaPrompt: "x".repeat(123) });
    const first = renderPanel();
    expect(screen.getByText("archives.schemaPrompt.charCount:123")).toBeInTheDocument();
    expect(screen.queryByText("archives.schemaPrompt.charCount:123")).not.toHaveClass("text-destructive");
    expect(screen.getByRole("button", { name: "archives.schemaPrompt.save" })).not.toBeDisabled();
    first.unmount();

    // Over limit: flip destructive + block Save client-side (D-05 belt-and-suspenders)
    setConfigFixture({ schemaPrompt: "x".repeat(10001) });
    renderPanel();
    expect(screen.getByText("archives.schemaPrompt.charCount:10001")).toHaveClass("text-destructive");
    expect(screen.getByRole("button", { name: "archives.schemaPrompt.save" })).toBeDisabled();
  });

  it("(c2) char count at exactly 10000 is NOT over limit", () => {
    setConfigFixture({ schemaPrompt: "y".repeat(10000) });
    renderPanel();
    expect(screen.getByText("archives.schemaPrompt.charCount:10000")).not.toHaveClass("text-destructive");
    expect(screen.getByRole("button", { name: "archives.schemaPrompt.save" })).not.toBeDisabled();
  });

  it("(d) Edit/Preview toggle: Preview renders sanitized markdown (no raw script passthrough)", () => {
    setConfigFixture({ schemaPrompt: "# Hello\n\n<script>alert(1)</script>" });
    renderPanel();
    // Preview initially hidden
    expect(screen.queryByTestId("schema-preview")).toBeNull();
    // Switch to Preview
    fireEvent.click(screen.getByRole("button", { name: "archives.schemaPrompt.tabPreview" }));
    const previewEl = screen.getByTestId("schema-preview");
    expect(previewEl).toBeInTheDocument();
    // renderMarkdown is mocked with a marker wrapper — content flows through it
    expect(previewEl.innerHTML).toContain('data-rendered="1"');
    // The raw <script> tag is never passed through as an element (DOMPurify-sanitized path)
    expect(previewEl.querySelector("script")).toBeNull();
    // Back to Edit
    fireEvent.click(screen.getByRole("button", { name: "archives.schemaPrompt.tabEdit" }));
    expect(screen.queryByTestId("schema-preview")).toBeNull();
  });

  it("(e) typing does NOT trigger mutateAsync (no auto-save-on-blur); Save click does", async () => {
    renderPanel();
    const textarea = screen.getByPlaceholderText("archives.schemaPrompt.placeholder") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Typed guidelines" } });
    fireEvent.blur(textarea);
    expect(updateMutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "archives.schemaPrompt.save" }));
    await waitFor(() => {
      expect(updateMutateAsync).toHaveBeenCalledTimes(1);
    });
    const payload = updateMutateAsync.mock.calls[0][0] as {
      config: Record<string, unknown>;
    };
    // The typed value rides the save payload (Pitfall 1 from the authoring side)
    expect(payload.config.schemaPrompt).toBe("Typed guidelines");
  });

  it("header Save label uses the dedicated archives.schemaPrompt.save/saving keys, not common.save", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: "archives.schemaPrompt.save" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "common.save" })).toBeNull();
  });

  // WR-02 (Phase 187 code review): Save must be gated on config-query
  // hydration. Before the query resolves, the textarea renders empty — an
  // early save PUTs schemaPrompt:"" over the stored guidance (whole-blob
  // replace wipes admin-authored text).
  it("WR-02: Save is disabled while the config query is hydrating (data undefined, isLoading true)", () => {
    setConfigQueryState({ data: undefined, isLoading: true });
    renderPanel();
    expect(screen.getByRole("button", { name: "archives.schemaPrompt.save" })).toBeDisabled();
  });

  it("WR-02: clicking Save while unhydrated never calls mutateAsync (guard is not disabled-only)", async () => {
    setConfigQueryState({ data: undefined, isLoading: true });
    renderPanel();
    // Direct handler invocation path: even if a click somehow lands (autoFocus
    // + Enter), the !archiveConfig guard skips the save entirely.
    fireEvent.click(screen.getByRole("button", { name: "archives.schemaPrompt.save" }));
    expect(updateMutateAsync).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(updateMutateAsync).not.toHaveBeenCalled();
    });
  });

  it("WR-02: Save is enabled again after hydration and carries the hydrated schemaPrompt", async () => {
    setConfigFixture({ schemaPrompt: "Hydrated guidance" });
    setConfigQueryState({ isLoading: false });
    renderPanel();
    const saveButton = screen.getByRole("button", { name: "archives.schemaPrompt.save" });
    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(updateMutateAsync).toHaveBeenCalledTimes(1);
    });
    const payload = updateMutateAsync.mock.calls[0][0] as {
      config: Record<string, unknown>;
    };
    expect(payload.config.schemaPrompt).toBe("Hydrated guidance");
  });
});