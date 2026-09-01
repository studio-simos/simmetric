// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * UnifiedUploadPage tests (Phase 71-05 Task 1).
 *
 * Verifies: UPL-01 dropzone hero renders, UPL-02 multi-file DnD config,
 * D-03 drop without destination stages only (no assign), SC-5 admin-disabled
 * empty state, SC-5 admin sees full page, D-17 URL ingest panel, D-18
 * from-doc panel, D-11 skeleton stage.
 */

// ── Mocks ────────────────────────────────────────────────────────

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof key === "string") {
        return key.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts[k] ?? ""));
      }
      return key;
    },
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

jest.mock("react-router-dom", () => ({
  useParams: () => ({ workspaceId: "ws-1" }),
  useSearchParams: jest.fn(() => [new URLSearchParams(""), () => {}]),
}));

jest.mock("react-dropzone", () => ({
  useDropzone: jest.fn(() => ({
    getRootProps: () => ({ onClick: jest.fn(), "data-testid": "dropzone" }),
    getInputProps: () => ({ type: "file", hidden: true }),
    isDragActive: false,
  })),
}));

const mockInvalidateQueries = jest.fn();
jest.mock("@tanstack/react-query", () => {
  const actual = jest.requireActual("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
  };
});

jest.mock("../queries/useUploadDrafts", () => ({
  useUploadDrafts: jest.fn(() => ({ data: [], isLoading: false })),
  useStageUpload: jest.fn(() => ({
    mutateAsync: jest.fn(),
    isPending: false,
  })),
  useStageUploadUrl: jest.fn(() => ({
    mutateAsync: jest.fn(),
    isPending: false,
  })),
  useAssignDraft: jest.fn(() => ({
    mutateAsync: jest.fn(),
    isPending: false,
  })),
  useRetryKb: jest.fn(() => ({
    mutateAsync: jest.fn(),
    isPending: false,
  })),
}));

const mockSettingsGetValue = jest.fn();
jest.mock("../queries/useSettings", () => ({
  useSettings: jest.fn(() => ({ data: [], isLoading: false })),
  useSettingsHelpers: jest.fn(() => ({ getValue: mockSettingsGetValue, isReadOnly: jest.fn() })),
}));

jest.mock("../queries/useAuth", () => ({
  useMe: jest.fn(() => ({
    data: { id: "user-1", username: "admin", roles: [{ id: "r1", name: "admin", isDefault: true }], permissions: [] },
    isLoading: false,
  })),
}));

jest.mock("../queries/useArchives", () => ({
  useArchives: jest.fn(() => ({
    data: [{ id: "arch-1", name: "Archive One", slug: "archive-one", description: null }],
    isLoading: false,
  })),
}));

jest.mock("../queries/useWorkspaces", () => ({
  useWorkspaces: jest.fn(() => ({ data: [{ id: "ws-1", name: "WS" }] })),
}));

jest.mock("../contexts/ChatContext", () => ({
  useChatNav: () => ({ currentWorkspaceId: "ws-1", currentChatId: null }),
}));

jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
}));

// Mock apiGet for D-18 document list fetch
const mockApiGet = jest.fn();
jest.mock("../utils/api", () => ({
  apiGet: (...args: unknown[]) => mockApiGet(...args),
  apiPost: jest.fn(),
  ApiError: class extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  },
}));

// Mock child components (tested independently in Tasks 2 + 3)
jest.mock("../components/UploadDestinationChooser", () => ({
  __esModule: true,
  default: () => <div data-testid="destination-chooser" />,
  destinationToAssignBody: jest.fn((d: string) => ({ rag: d === "rag", kb: d === "kb" })),
  isValidForDestination: jest.fn(() => true),
}));
jest.mock("../components/PendingDocsPanel", () => ({
  __esModule: true,
  default: ({ stagePending }: { stagePending?: boolean }) => (
    <div data-testid="pending-panel" data-stage-pending={!!stagePending} />
  ),
}));
jest.mock("../components/OcrModeSelector", () => ({
  __esModule: true,
  default: () => <div data-testid="ocr-mode-selector" />,
}));

// Mock Select as a native <select> (Radix Select uses portals in jsdom)
jest.mock("../components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value?: string; onValueChange?: (v: string) => void; children: React.ReactNode }) => (
    <select
      value={value ?? ""}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children, ...rest }: { children: React.ReactNode; [k: string]: unknown }) => (
    <div {...(rest as Record<string, unknown>)}>{children}</div>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

// ── Imports ──────────────────────────────────────────────────────

import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useDropzone } from "react-dropzone";
import { useSearchParams } from "react-router-dom";
import { useMe } from "../queries/useAuth";
import {
  useStageUpload,
  useStageUploadUrl,
  useAssignDraft,
} from "../queries/useUploadDrafts";
import { apiPost } from "../utils/api";
import UnifiedUploadPage from "../components/UnifiedUploadPage";

// ── Helpers ──────────────────────────────────────────────────────

const stageMutateAsync = jest.fn();
const stageUrlMutateAsync = jest.fn();
const assignMutateAsync = jest.fn();

function setupMocks(opts: {
  isAdmin?: boolean;
  allowNonAdmin?: boolean;
  stagePending?: boolean;
} = {}) {
  const { isAdmin = true, allowNonAdmin = "true", stagePending = false } = opts;
  mockSettingsGetValue.mockReturnValue(allowNonAdmin);
  (useMe as unknown as jest.Mock).mockReturnValue({
    data: {
      id: "u1",
      username: isAdmin ? "admin" : "user",
      roles: [{ id: "r", name: isAdmin ? "admin" : "user", isDefault: true }],
      permissions: [],
    },
    isLoading: false,
  });
  (useStageUpload as unknown as jest.Mock).mockReturnValue({
    mutateAsync: stageMutateAsync,
    isPending: stagePending,
  });
  (useStageUploadUrl as unknown as jest.Mock).mockReturnValue({
    mutateAsync: stageUrlMutateAsync,
    isPending: false,
  });
  (useAssignDraft as unknown as jest.Mock).mockReturnValue({
    mutateAsync: assignMutateAsync,
    isPending: false,
  });
  mockApiGet.mockResolvedValue([]);
}

function renderPage() {
  return render(<UnifiedUploadPage />);
}

// ── Tests ────────────────────────────────────────────────────────

describe("UnifiedUploadPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupMocks();
  });

  it("UPL-01 renders dropzone hero with heading + body", () => {
    renderPage();
    expect(screen.getByText("uploads.dropzone.heading")).toBeInTheDocument();
    expect(screen.getByText("uploads.dropzone.body")).toBeInTheDocument();
  });

  it("UPL-02 useDropzone configured with multiple:true + 12 MIME accept", () => {
    renderPage();
    expect(useDropzone).toHaveBeenCalled();
    const call = (useDropzone as unknown as jest.Mock).mock.calls[0][0];
    expect(call.multiple).toBe(true);
    expect(call.accept).toBeDefined();
    // 12 MIME from draftMimeTypeSchema
    expect(Object.keys(call.accept).length).toBeGreaterThanOrEqual(12);
  });

  it("D-03 drop without destination: stage only, no assign call", async () => {
    renderPage();
    const call = (useDropzone as unknown as jest.Mock).mock.calls[0][0];
    const file = new File(["hello"], "test.md", { type: "text/markdown" });
    await call.onDrop([file]);
    await waitFor(() => {
      expect(stageMutateAsync).toHaveBeenCalledTimes(1);
    });
    // destination defaults to "unassigned" → no assign call
    expect(assignMutateAsync).not.toHaveBeenCalled();
  });

  it("SC-5 admin-disabled: !isAdmin && ALLOW_NON_ADMIN_UPLOAD!=='true' → Lock + heading + body only", () => {
    setupMocks({ isAdmin: false, allowNonAdmin: "false" });
    renderPage();
    expect(screen.getByText("uploads.disabled.heading")).toBeInTheDocument();
    expect(screen.getByText("uploads.disabled.body")).toBeInTheDocument();
    // dropzone/chooser/panel NOT rendered
    expect(screen.queryByText("uploads.dropzone.heading")).not.toBeInTheDocument();
    expect(screen.queryByTestId("destination-chooser")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pending-panel")).not.toBeInTheDocument();
  });

  it("SC-5 admin sees full page regardless of ALLOW_NON_ADMIN_UPLOAD", () => {
    setupMocks({ isAdmin: true, allowNonAdmin: "false" });
    renderPage();
    expect(screen.getByText("uploads.dropzone.heading")).toBeInTheDocument();
    expect(screen.getByTestId("destination-chooser")).toBeInTheDocument();
    expect(screen.getByTestId("pending-panel")).toBeInTheDocument();
  });

  it("D-17 URL ingest: Add from URL reveals panel; valid URL dispatches useStageUploadUrl", async () => {
    renderPage();
    fireEvent.click(screen.getByText("uploads.source.url.label"));
    // URL input + Add to queue button appear
    expect(screen.getByPlaceholderText("uploads.source.url.placeholder")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("uploads.source.url.placeholder"), {
      target: { value: "https://example.com/article" },
    });
    // select archive via native select mock — find the select containing archive options
    const selects = document.querySelectorAll("select");
    const archiveSelect = Array.from(selects).find((s) =>
      Array.from(s.options).some((o) => o.value === "arch-1"),
    )!;
    fireEvent.change(archiveSelect, { target: { value: "arch-1" } });
    fireEvent.click(screen.getByText("uploads.source.url.add"));
    await waitFor(() => {
      expect(stageUrlMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceType: "url",
          url: "https://example.com/article",
          archiveId: "arch-1",
        }),
      );
    });
  });

  it("D-17 URL ingest: invalid URL shows error toast", async () => {
    const { showError } = require("../lib/toast");
    renderPage();
    fireEvent.click(screen.getByText("uploads.source.url.label"));
    fireEvent.change(screen.getByPlaceholderText("uploads.source.url.placeholder"), {
      target: { value: "not-a-url" },
    });
    fireEvent.click(screen.getByText("uploads.source.url.add"));
    await waitFor(() => {
      expect(showError).toHaveBeenCalledWith("uploads.source.url.invalid");
    });
    expect(stageUrlMutateAsync).not.toHaveBeenCalled();
  });

  it("D-18 from-doc: Add from existing document reveals picker; submit dispatches apiPost", async () => {
    mockApiGet.mockResolvedValue([
      { id: "doc-1", name: "Doc1.pdf", workspaceId: "ws-1", type: "pdf", status: "completed" },
    ]);
    renderPage();
    fireEvent.click(screen.getByText("uploads.source.fromDoc.label"));
    await waitFor(() => {
      expect(screen.getByText("Doc1.pdf")).toBeInTheDocument();
    });
    // select the document
    fireEvent.click(screen.getByText("Doc1.pdf"));
    // select target archive via native select mock
    const selects = document.querySelectorAll("select");
    const archiveSelect = Array.from(selects).find((s) =>
      Array.from(s.options).some((o) => o.value === "arch-1"),
    )!;
    fireEvent.change(archiveSelect, { target: { value: "arch-1" } });
    fireEvent.click(screen.getByText("uploads.source.fromDoc.submit"));
    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith(
        "/archives/arch-1/copy-from-doc",
        expect.objectContaining({ documentIds: ["doc-1"] }),
      );
    });
  });

  it("D-11 skeleton stage: while stageMutation.isPending, panel receives stagePending", () => {
    setupMocks({ stagePending: true });
    renderPage();
    const panel = screen.getByTestId("pending-panel");
    expect(panel.getAttribute("data-stage-pending")).toBe("true");
  });

  // ── D-72-02: ?archiveId deep-link ───────────────────────────────

  describe("D-72-02 ?archiveId deep-link", () => {
    afterEach(() => {
      // restore default empty search params between deep-link tests
      (useSearchParams as unknown as jest.Mock).mockReturnValue([
        new URLSearchParams(""),
        () => {},
      ]);
    });

    it("valid ?archiveId pre-sets archiveId + destination=kb (assign fires on drop)", async () => {
      (useSearchParams as unknown as jest.Mock).mockReturnValue([
        new URLSearchParams("archiveId=arch-1"),
        () => {},
      ]);
      stageMutateAsync.mockResolvedValue({ id: "draft-1" });
      renderPage();
      // Wait for the deep-link useEffect to flush + re-render so handleDrop
      // closes over the pre-set destination=kb + archiveId=arch-1.
      await waitFor(() => {
        expect((useDropzone as unknown as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
      });
      const calls = (useDropzone as unknown as jest.Mock).mock.calls;
      const call = calls[calls.length - 1][0];
      const file = new File(["hello"], "test.md", { type: "text/markdown" });
      await call.onDrop([file]);
      await waitFor(() => {
        expect(assignMutateAsync).toHaveBeenCalledTimes(1);
        expect(assignMutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "draft-1",
            body: expect.objectContaining({ kb: true }),
          }),
        );
      });
    });

    it("invalid ?archiveId shows archiveNotFound toast + no assign on drop (fail-graceful)", async () => {
      const { showError } = require("../lib/toast");
      (useSearchParams as unknown as jest.Mock).mockReturnValue([
        new URLSearchParams("archiveId=non-existent"),
        () => {},
      ]);
      stageMutateAsync.mockResolvedValue({ id: "draft-2" });
      renderPage();
      await waitFor(() => {
        expect(showError).toHaveBeenCalledWith("uploads.deepLink.archiveNotFound");
      });
      // destination stays "unassigned" → drop stages only, no assign
      const calls = (useDropzone as unknown as jest.Mock).mock.calls;
      const call = calls[calls.length - 1][0];
      const file = new File(["hello"], "test2.md", { type: "text/markdown" });
      await call.onDrop([file]);
      await waitFor(() => {
        expect(stageMutateAsync).toHaveBeenCalled();
      });
      expect(assignMutateAsync).not.toHaveBeenCalled();
    });

    it("no ?archiveId: no deep-link toast, no assign on drop (default unassigned)", async () => {
      const { showError } = require("../lib/toast");
      (useSearchParams as unknown as jest.Mock).mockReturnValue([
        new URLSearchParams(""),
        () => {},
      ]);
      stageMutateAsync.mockResolvedValue({ id: "draft-3" });
      renderPage();
      expect(showError).not.toHaveBeenCalledWith("uploads.deepLink.archiveNotFound");
      const calls = (useDropzone as unknown as jest.Mock).mock.calls;
      const call = calls[calls.length - 1][0];
      const file = new File(["hello"], "test3.md", { type: "text/markdown" });
      await call.onDrop([file]);
      await waitFor(() => {
        expect(stageMutateAsync).toHaveBeenCalled();
      });
      expect(assignMutateAsync).not.toHaveBeenCalled();
    });
  });
});