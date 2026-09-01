// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DocumentsPage tests — upload area, document list, empty state, delete dialog, polling
 */
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import DocumentsPage from "../components/DocumentsPage";

// Mock i18next
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === "documents.documentsCount") return `${options?.count ?? 0} documents`;
      return key;
    },
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

// Mock toast wrapper
jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
}));

// Mock react-router-dom
const mockNavigate = jest.fn();
jest.mock("react-router-dom", () => ({
  useParams: () => ({ workspaceId: undefined }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a data-testid={`link-${to}`} href={to}>{children}</a>
  ),
  useNavigate: () => mockNavigate,
}));

// Mock ChatContext
jest.mock("../contexts/ChatContext", () => ({
  useChatNav: () => ({ currentWorkspaceId: "ws-1", currentChatId: null }),
}));

// Mock auth queries
jest.mock("../queries/useAuth", () => ({
  useMe: () => ({
    data: { id: "user-1", permissions: ["admin:settings"] },
    isLoading: false,
  }),
}));

// Mock API
const mockApiGet = jest.fn();
const mockApiDelete = jest.fn();
const mockApiPost = jest.fn();
jest.mock("../utils/api", () => ({
  apiGet: (...args: Parameters<typeof mockApiGet>) => mockApiGet(...args),
  apiDelete: (...args: Parameters<typeof mockApiDelete>) => mockApiDelete(...args),
  apiPost: (...args: Parameters<typeof mockApiPost>) => mockApiPost(...args),
  ApiError: class ApiError extends Error { status: number; details: unknown; constructor(s: number, m: string, d?: unknown) { super(m); this.status = s; this.details = d; } },
}));

// Mock workspace queries
jest.mock("../queries/useWorkspaces", () => ({
  useWorkspaces: () => ({
    data: [{ id: "ws-1", name: "Test Workspace" }],
    isLoading: false,
  }),
}));

// Mock archive queries (KB-05 copy-to-archive dialog added in Phase 64-06)
jest.mock("../queries/useArchives", () => ({
  useArchives: () => ({ data: [], isLoading: false }),
  useCopyDocToArchive: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

describe("DocumentsPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("renders document list Table with rows when documents exist", async () => {
    mockApiGet.mockResolvedValueOnce([
      {
        id: "doc-1",
        workspaceId: "ws-1",
        name: "test.pdf",
        type: "pdf",
        chunkCount: 5,
        embeddingModel: "Xenova/all-MiniLM-L6-v2",
        status: "completed",
        statusMessage: null,
        fileSize: 1024,
        createdAt: "2026-05-20T00:00:00Z",
      },
      {
        id: "doc-2",
        workspaceId: "ws-1",
        name: "report.docx",
        type: "docx",
        chunkCount: 10,
        embeddingModel: "Xenova/all-MiniLM-L6-v2",
        status: "processing",
        statusMessage: null,
        fileSize: 2048,
        createdAt: "2026-05-20T00:00:00Z",
      },
    ]);

    render(<DocumentsPage />);

    await waitFor(() => {
      expect(screen.getByText("test.pdf")).toBeInTheDocument();
    });
    expect(screen.getByText("report.docx")).toBeInTheDocument();
    expect(screen.getByText("1.0 KB")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
  });

  it("renders empty state when no documents", async () => {
    mockApiGet.mockResolvedValueOnce([]);
    render(<DocumentsPage />);

    await waitFor(() => {
      expect(screen.getByText("documents.emptyTitle")).toBeInTheDocument();
    });
    expect(screen.getByText("documents.emptyBody")).toBeInTheDocument();
  });

  it("opens AlertDialog when delete button is clicked", async () => {
    mockApiGet.mockResolvedValueOnce([
      {
        id: "doc-1",
        workspaceId: "ws-1",
        name: "test.pdf",
        type: "pdf",
        chunkCount: 5,
        embeddingModel: "Xenova/all-MiniLM-L6-v2",
        status: "completed",
        statusMessage: null,
        fileSize: 1024,
        createdAt: "2026-05-20T00:00:00Z",
      },
    ]);

    render(<DocumentsPage />);

    await waitFor(() => {
      expect(screen.getByText("test.pdf")).toBeInTheDocument();
    });

    // Select the document via its row checkbox, then click "Delete Selected"
    const checkboxes = screen.getAllByRole("checkbox");
    // checkboxes[0] = select-all, checkboxes[1] = first row
    fireEvent.click(checkboxes[1]);

    const deleteButton = screen.getByRole("button", { name: /documents.bulkSelect.deleteSelected/i });
    fireEvent.click(deleteButton);

    expect(screen.getByText(/documents.bulkDelete.confirmTitle/i)).toBeInTheDocument();
  });

  it("starts polling when documents have pending/processing status", async () => {
    mockApiGet.mockResolvedValueOnce([
      {
        id: "doc-1",
        workspaceId: "ws-1",
        name: "processing.pdf",
        type: "pdf",
        chunkCount: 0,
        embeddingModel: "Xenova/all-MiniLM-L6-v2",
        status: "processing",
        statusMessage: null,
        fileSize: 1024,
        createdAt: "2026-05-20T00:00:00Z",
      },
    ]);

    render(<DocumentsPage />);

    await waitFor(() => {
      expect(screen.getByText("processing.pdf")).toBeInTheDocument();
    });

    // Polling should trigger another fetch after interval
    mockApiGet.mockResolvedValueOnce([
      {
        id: "doc-1",
        workspaceId: "ws-1",
        name: "processing.pdf",
        type: "pdf",
        chunkCount: 0,
        embeddingModel: "Xenova/all-MiniLM-L6-v2",
        status: "completed",
        statusMessage: null,
        fileSize: 1024,
        createdAt: "2026-05-20T00:00:00Z",
      },
    ]);

    jest.advanceTimersByTime(4000);

    await waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledTimes(2);
    });
  });

  it("navigates to /documents/:id when the View button is clicked", async () => {
    mockApiGet.mockResolvedValueOnce([
      {
        id: "doc-1",
        workspaceId: "ws-1",
        name: "test.pdf",
        type: "pdf",
        chunkCount: 5,
        embeddingModel: "Xenova/all-MiniLM-L6-v2",
        status: "completed",
        statusMessage: null,
        fileSize: 1024,
        createdAt: "2026-05-20T00:00:00Z",
      },
    ]);

    render(<DocumentsPage />);

    await waitFor(() => {
      expect(screen.getByText("documents.view")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("documents.view"));
    expect(mockNavigate).toHaveBeenCalledWith("/documents/doc-1");
  });
});
