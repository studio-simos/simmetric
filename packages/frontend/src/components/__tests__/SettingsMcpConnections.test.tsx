// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SettingsMcpConnections from "../SettingsMcpConnections";
import { showSuccess } from "../../lib/toast";

const mockConnections = [
  {
    id: "c1", name: "Server A", url: "http://a.com", transportType: "sse" as const,
    projectId: "p1", workspaceId: null, headers: {}, enabled: true,
    lastSyncAt: null, createdAt: "", updatedAt: "",
    liveStatus: "connected" as const, toolCount: 3, lastError: null,
  },
  {
    id: "c2", name: "Server B", url: "http://b.com", transportType: "streamable-http" as const,
    projectId: null, workspaceId: "w1", headers: {}, enabled: false,
    lastSyncAt: null, createdAt: "", updatedAt: "",
    liveStatus: "error" as const, toolCount: 0, lastError: "Connection refused",
  },
];

const mockDeleteConnection = jest.fn();
const mockToggleConnection = jest.fn();
const mockTestConnection = jest.fn();

jest.mock("../../queries/useMcpConnections", () => ({
  useMcpConnections: () => ({ data: mockConnections, isLoading: false }),
  useDeleteMcpConnection: () => ({ mutateAsync: mockDeleteConnection }),
  useToggleMcpConnection: () => ({ mutateAsync: mockToggleConnection }),
  useTestMcpConnection: () => ({ mutateAsync: mockTestConnection }),
}));

jest.mock("../../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
}));

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts?.count !== undefined ? `${String(opts.count)}` : key),
  }),
}));

describe("SettingsMcpConnections", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders table with connections", () => {
    render(<SettingsMcpConnections />);
    expect(screen.getByText("Server A")).toBeInTheDocument();
    expect(screen.getByText("Server B")).toBeInTheDocument();
  });

  it("calls deleteConnection when delete is confirmed", async () => {
    mockDeleteConnection.mockResolvedValue(undefined);

    render(<SettingsMcpConnections />);
    const deleteButtons = screen.getAllByText("common.delete");
    const firstDeleteButton = deleteButtons[0];
    if (firstDeleteButton) fireEvent.click(firstDeleteButton);

    // AlertDialog opens with another "common.delete" confirm button
    const confirmButton = await screen.findByRole("button", { name: /common\.delete/i });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockDeleteConnection).toHaveBeenCalledWith("c1");
    });
    expect(showSuccess).toHaveBeenCalledWith("settings.mcpConnections.deleteSuccess");
  });

  it("calls toggleConnection when enabled checkbox is toggled", async () => {
    mockToggleConnection.mockResolvedValue(undefined);

    render(<SettingsMcpConnections />);
    const switches = screen.getAllByRole("switch");
    const firstSwitch = switches[0];
    if (firstSwitch) fireEvent.click(firstSwitch);

    await waitFor(() => {
      expect(mockToggleConnection).toHaveBeenCalledWith(expect.objectContaining({ id: "c1", enabled: false }));
    });
  });

  it("calls testConnection when test button is clicked", async () => {
    mockTestConnection.mockResolvedValue({ success: true, toolCount: 3 });

    render(<SettingsMcpConnections />);
    const testButtons = screen.getAllByText("settings.mcpConnections.test");
    const firstTestButton = testButtons[0];
    if (firstTestButton) fireEvent.click(firstTestButton);

    await waitFor(() => {
      expect(mockTestConnection).toHaveBeenCalledWith("c1");
    });
  });
});
