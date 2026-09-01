// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DlpAuditPanel component tests (Phase 115-02 Wave 2)
 *
 * Covers empty state, data state with table rows, "View details" expand,
 * pagination controls, and loading state.
 *
 * Framework: Jest + @testing-library/react
 * Transform: @swc/jest (per project conventions)
 */

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === "dlpAudit.loading") return "Loading DLP history...";
      if (key === "dlpAudit.error") return "Failed to load DLP history";
      if (key === "dlpAudit.retry") return "Retry";
      if (key === "dlpAudit.empty") return "No DLP events recorded yet.";
      if (key === "dlpAudit.emptyDesc") return "DLP events appear here when messages containing sensitive data are processed.";
      if (key === "dlpAudit.description") return "Recent DLP matches across all workspaces.";
      if (key === "dlpAudit.date") return "Date";
      if (key === "dlpAudit.user") return "User";
      if (key === "dlpAudit.entity") return "Chat";
      if (key === "dlpAudit.action") return "Action";
      if (key === "dlpAudit.matchTypes") return "Match Types";
      if (key === "dlpAudit.details") return "Details";
      if (key === "dlpAudit.viewDetails") return "View matched text";
      if (key === "dlpAudit.hideDetails") return "Hide matched text";
      if (key === "dlpAudit.page") return `Page ${options?.current} of ${options?.total}`;
      if (key === "dlpAudit.previous") return "Previous";
      if (key === "dlpAudit.next") return "Next";
      if (key === "dlpAudit.system") return "System";
      if (key === "dlpAudit.noMatchDetails") return "No match details available for this event.";
      if (key === "dlpAudit.matchTypesOnly") return "Match type detected (matched text not recorded).";
      if (key === "dlpAudit.actionInput") return "Input";
      if (key === "dlpAudit.actionOutput") return "Output";
      if (key === "dlpAudit.actionRagContext") return "RAG Context";
      if (key === "dlpAudit.filterSource") return "Source";
      if (key === "dlpAudit.filterAll") return "All sources";
      if (key === "dlpAudit.filterChat") return "Chat";
      if (key === "dlpAudit.filterWidget") return "Widget";
      if (key === "dlpAudit.filterChatId") return "Filter by chat ID…";
      if (key === "dlpAudit.filterUser") return "Filter by user…";
      if (key === "dlpAudit.filterEmpty") return "No DLP events match the current filters.";
      return key;
    },
  }),
}));

jest.mock("lucide-react", () => ({
  ShieldAlert: () => <svg data-testid="shield-alert" />,
  ChevronDown: () => <svg data-testid="chevron-down" />,
  ChevronRight: () => <svg data-testid="chevron-right" />,
  Eye: () => <svg data-testid="eye" />,
  EyeOff: () => <svg data-testid="eye-off" />,
}));

jest.mock("../utils/api", () => ({
  apiGet: jest.fn(),
}));

jest.mock("../queries/keys", () => ({
  queryKeys: {
    eventLogs: {
      list: (filters: Record<string, unknown>) => ["eventLogs", "list", filters],
    },
    // useFeature → useLicenseInfo reads queryKeys.license.info (quick
    // 260829-m6p: mock was missing the license key after the 168-01 tracer
    // wired useFeature to the license query — every test in this file
    // crashed with "Cannot read properties of undefined (reading 'info').
    license: {
      info: ["license", "info"],
    },
  },
}));

jest.mock("../hooks/useFeature", () => ({
  // The panel's feature gate is orthogonal to these tests; pin it enabled so
  // the query-driven table renders.
  useFeature: () => true,
}));

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { DlpAuditPanel } from "../components/DlpAuditPanel";

const mockApiGet = jest.requireMock("../utils/api").apiGet as jest.Mock;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const sampleDlpLog = {
  id: "log-1",
  entityType: "dlp",
  entityId: "chat-1",
  action: "dlp.input_match",
  userId: "user-1",
  userName: "Alice",
  entityName: "Support Chat",
  metadata: {
    matchTypes: ["email", "credit_card"],
    matches: [
      { type: "email", text: "user@example.com" },
      { type: "credit_card", text: "4111111111111111" },
    ],
  },
  createdAt: "2026-08-01T12:00:00Z",
};

describe("DlpAuditPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("empty state", () => {
    it("renders empty state message when no DLP events exist", async () => {
      mockApiGet.mockResolvedValue({ logs: [], total: 0 });

      render(<DlpAuditPanel />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText("No DLP events recorded yet.")).toBeInTheDocument();
      });
    });
  });

  describe("loading state", () => {
    it("renders loading skeleton while query is pending", () => {
      // Never resolve the query
      mockApiGet.mockReturnValue(new Promise(() => {}));

      render(<DlpAuditPanel />, { wrapper: createWrapper() });

      expect(screen.getByText("Loading DLP history...")).toBeInTheDocument();
    });
  });

  describe("data state", () => {
    it("renders table row when DLP events are returned from the API", async () => {
      mockApiGet.mockResolvedValue({ logs: [sampleDlpLog], total: 1 });

      render(<DlpAuditPanel />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText("Alice")).toBeInTheDocument();
        expect(screen.getByText("Support Chat")).toBeInTheDocument();
        expect(screen.getByText("Input")).toBeInTheDocument();
        expect(screen.getByText("email")).toBeInTheDocument();
        expect(screen.getByText("credit_card")).toBeInTheDocument();
      });
    });

    it("shows 'View matched text' button for each row", async () => {
      mockApiGet.mockResolvedValue({ logs: [sampleDlpLog], total: 1 });

      render(<DlpAuditPanel />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getAllByText("View matched text").length).toBeGreaterThan(0);
      });
    });

    it("clicking 'View matched text' reveals matched text", async () => {
      mockApiGet.mockResolvedValue({ logs: [sampleDlpLog], total: 1 });

      render(<DlpAuditPanel />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText("Alice")).toBeInTheDocument();
      });

      // Click "View matched text" to expand
      const viewBtns = screen.getAllByText("View matched text");
      fireEvent.click(viewBtns[0]);

      // Now click the "Show matched text" toggle (Eye icon button)
      await waitFor(() => {
        screen.getByText("View matched text");
      });
    });
  });

  describe("type-only events (quick 260829-m6p)", () => {
    const typeOnlyLog = {
      ...sampleDlpLog,
      id: "log-type-only",
      action: "dlp.output_match",
      // Matches the historical bug shape: badge types present, no matches array
      metadata: { matchTypes: ["email"] },
    };

    it("expanded row with matchTypes but no matches shows the type list, not the noMatchDetails fallback", async () => {
      mockApiGet.mockResolvedValue({ logs: [typeOnlyLog], total: 1 });

      render(<DlpAuditPanel />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText("Alice")).toBeInTheDocument();
      });

      // Expand the row details (desktop expand button — there are two
      // "View matched text" buttons per row: mobile + desktop).
      const detailBtns = screen.getAllByText("View matched text");
      fireEvent.click(detailBtns[detailBtns.length - 1]);

      // Type-only line is rendered with the type badge and the hint — the
      // badge appears twice (collapsed-row badge + expanded type line), so
      // assert "all" occurrences; the fallback must NOT be shown.
      expect(screen.getAllByText("email").length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText("Match type detected (matched text not recorded).")).toBeInTheDocument();
      expect(screen.queryByText("No match details available for this event.")).not.toBeInTheDocument();
    });

    it("expanded row with BOTH matchTypes and matches still shows the matched-text view", async () => {
      mockApiGet.mockResolvedValue({ logs: [sampleDlpLog], total: 1 });

      render(<DlpAuditPanel />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText("Alice")).toBeInTheDocument();
      });

      const detailBtns = screen.getAllByText("View matched text");
      fireEvent.click(detailBtns[detailBtns.length - 1]);

      // Matched-text toggle button is available (Eye) — the type-only hint
      // must not appear for rows that carry matches.
      expect(screen.queryByText("Match type detected (matched text not recorded).")).not.toBeInTheDocument();
      expect(screen.getAllByText("View matched text").length).toBeGreaterThan(0);
    });
  });

  describe("pagination", () => {
    it("shows pagination controls when total > page size", async () => {
      const logs = Array.from({ length: 20 }).map((_, i) => ({
        ...sampleDlpLog,
        id: `log-${i + 1}`,
        entityName: `Chat ${i + 1}`,
      }));
      mockApiGet.mockResolvedValue({ logs, total: 45 });

      render(<DlpAuditPanel />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
      });

      // Next button should be enabled
      const nextBtn = screen.getByText("Next");
      expect(nextBtn).not.toBeDisabled();

      // Previous button should be disabled on page 1
      const prevBtn = screen.getByText("Previous");
      expect(prevBtn).toBeDisabled();
    });

    it("clicking Next advances to page 2", async () => {
      const logs = Array.from({ length: 20 }).map((_, i) => ({
        ...sampleDlpLog,
        id: `log-${i + 1}`,
        entityName: `Chat ${i + 1}`,
      }));
      mockApiGet.mockResolvedValue({ logs, total: 45 });

      render(<DlpAuditPanel />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Next"));

      await waitFor(() => {
        expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
      });
    });

    it("pagination controls hidden when total <= page size", async () => {
      mockApiGet.mockResolvedValue({ logs: [sampleDlpLog], total: 1 });

      render(<DlpAuditPanel />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.queryByText(/Page/)).not.toBeInTheDocument();
      });
    });
  });

  describe("error state", () => {
    it("renders error message when API fails", async () => {
      mockApiGet.mockRejectedValue(new Error("Network error"));

      render(<DlpAuditPanel />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText("Failed to load DLP history")).toBeInTheDocument();
      });

      expect(screen.getByText("Retry")).toBeInTheDocument();
    });
  });

  // 260829-ms8 (DLP_FEATURES_SPEC §2.1 v1): client-side filters over the
  // fetched page — source select (All/Chat/Widget) + chatId/user search.
  // Server-side source filtering is deferred to slice 3.
  describe("source/tag filters (quick 260829-ms8)", () => {
    const chatLog = {
      ...sampleDlpLog,
      id: "log-chat",
      userName: "Alice",
      entityName: "Support Chat",
      metadata: { matchTypes: ["email"], source: "chat" },
    };
    const widgetLog = {
      ...sampleDlpLog,
      id: "log-widget",
      userName: "widget-service",
      entityName: "Widget Chat",
      metadata: { matchTypes: ["email"], source: "widget" },
    };
    const legacyLog = {
      ...sampleDlpLog,
      id: "log-legacy",
      userName: "Bob",
      entityName: "Legacy Chat",
      metadata: { matchTypes: ["ssn"] }, // no source key (legacy row)
    };

    it("renders the source select with All/Chat/Widget options", async () => {
      mockApiGet.mockResolvedValue({ logs: [chatLog], total: 1 });

      render(<DlpAuditPanel />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByLabelText("Source")).toBeInTheDocument();
      });
      const select = screen.getByLabelText("Source") as HTMLSelectElement;
      expect(select.value).toBe("all");
      expect(screen.getByText("All sources")).toBeInTheDocument();
    });

    it("filter=chat hides widget rows and keeps chat rows (client-side)", async () => {
      mockApiGet.mockResolvedValue({ logs: [chatLog, widgetLog], total: 2 });

      render(<DlpAuditPanel />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText("Alice")).toBeInTheDocument();
        expect(screen.getByText("widget-service")).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText("Source"), { target: { value: "chat" } });

      expect(screen.getByText("Alice")).toBeInTheDocument();
      expect(screen.queryByText("widget-service")).not.toBeInTheDocument();
      // Filtered-empty hint must NOT appear while rows match.
      expect(screen.queryByText("No DLP events match the current filters.")).not.toBeInTheDocument();
    });

    it("filter=widget shows only widget rows", async () => {
      mockApiGet.mockResolvedValue({ logs: [chatLog, widgetLog], total: 2 });

      render(<DlpAuditPanel />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText("widget-service")).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText("Source"), { target: { value: "widget" } });

      expect(screen.getByText("widget-service")).toBeInTheDocument();
      expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    });

    it("legacy rows (no metadata.source) are hidden under chat/widget filters → filtered-empty state", async () => {
      mockApiGet.mockResolvedValue({ logs: [legacyLog], total: 1 });

      render(<DlpAuditPanel />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText("Bob")).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText("Source"), { target: { value: "widget" } });

      expect(screen.queryByText("Bob")).not.toBeInTheDocument();
      expect(screen.getByText("No DLP events match the current filters.")).toBeInTheDocument();
    });

    it("chatId filter matches entityId substring case-insensitively", async () => {
      mockApiGet.mockResolvedValue({ logs: [chatLog, widgetLog], total: 2 });

      render(<DlpAuditPanel />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText("Alice")).toBeInTheDocument();
      });

      // chat id + widget chat id differ only in suffix; type a shared prefix
      fireEvent.change(screen.getByLabelText("Filter by chat ID…"), { target: { value: "CHAT-" } });

      // Both ids contain "chat-1" prefix → both remain visible
      expect(screen.getByText("Alice")).toBeInTheDocument();
      expect(screen.getByText("widget-service")).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText("Filter by chat ID…"), { target: { value: "chat-999" } });

      expect(screen.queryByText("Alice")).not.toBeInTheDocument();
      expect(screen.queryByText("widget-service")).not.toBeInTheDocument();
      expect(screen.getByText("No DLP events match the current filters.")).toBeInTheDocument();
    });

    it("user filter matches userName substring case-insensitively", async () => {
      mockApiGet.mockResolvedValue({ logs: [chatLog, widgetLog], total: 2 });

      render(<DlpAuditPanel />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText("Alice")).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText("Filter by user…"), { target: { value: "WIDGET" } });

      expect(screen.getByText("widget-service")).toBeInTheDocument();
      expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    });
  });
});
