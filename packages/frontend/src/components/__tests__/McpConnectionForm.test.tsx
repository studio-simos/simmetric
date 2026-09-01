// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import type { ChildrenOnlyProps } from "../../__tests__/mockComponentTypes";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import McpConnectionForm from "../McpConnectionForm";
import { showSuccess } from "../../lib/toast";

const mockCreateConnection = jest.fn();
const mockUpdateConnection = jest.fn();

jest.mock("../../queries/useMcpConnections", () => ({
  useCreateMcpConnection: () => ({ mutateAsync: mockCreateConnection }),
  useUpdateMcpConnection: () => ({ mutateAsync: mockUpdateConnection }),
}));

jest.mock("../../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
}));

// Mock Select to render native select for testability
jest.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange }: { children?: ReactNode; value?: string; onValueChange?: (value: string) => void }) => (
    <select value={value} onChange={(e) => onValueChange && onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: ChildrenOnlyProps) => <>{children}</>,
  SelectItem: ({ children, value }: { children?: ReactNode; value?: string }) => <option value={value}>{children}</option>,
  SelectTrigger: ({ children }: ChildrenOnlyProps) => <>{children}</>,
  SelectValue: () => null,
}));

jest.mock("../../utils/api", () => ({
  apiGet: jest.fn(),
}));

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts?.count !== undefined ? `${String(opts.count)}` : key),
  }),
}));

import { apiGet } from "../../utils/api";

describe("McpConnectionForm", () => {
  const onClose = jest.fn();
  const onSave = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (apiGet as jest.Mock).mockImplementation((path: string) => {
      if (path === "/projects") return Promise.resolve([{ id: "p1", name: "Project A" }]);
      if (path === "/workspaces") return Promise.resolve([{ id: "w1", name: "Workspace A" }]);
      return Promise.resolve([]);
    });
  });

  it("renders create form with all fields", async () => {
    render(<McpConnectionForm onClose={onClose} onSave={onSave} />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText("settings.mcpConnections.namePlaceholder")).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText("settings.mcpConnections.urlPlaceholder")).toBeInTheDocument();
  });

  it("calls createConnection on submit with valid data", async () => {
    mockCreateConnection.mockResolvedValue({ id: "c1" });
    render(<McpConnectionForm onClose={onClose} onSave={onSave} />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText("settings.mcpConnections.namePlaceholder")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText("settings.mcpConnections.namePlaceholder"), {
      target: { value: "Test Connection" },
    });
    fireEvent.change(screen.getByPlaceholderText("settings.mcpConnections.urlPlaceholder"), {
      target: { value: "https://mcp.example.com/sse" },
    });

    // Select a project
    const projectSelect = screen.getAllByRole("combobox")[1]; // first is transport, second is project
    if (projectSelect) fireEvent.change(projectSelect, { target: { value: "p1" } });

    fireEvent.click(screen.getByText("settings.mcpConnections.saveChanges"));

    await waitFor(() => {
      expect(mockCreateConnection).toHaveBeenCalled();
    });

    expect(showSuccess).toHaveBeenCalledWith("settings.mcpConnections.createSuccess");
    expect(onSave).toHaveBeenCalled();
  });

  it("shows scope error when neither project nor workspace is selected", async () => {
    render(<McpConnectionForm onClose={onClose} onSave={onSave} />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText("settings.mcpConnections.namePlaceholder")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText("settings.mcpConnections.namePlaceholder"), {
      target: { value: "Test" },
    });
    fireEvent.change(screen.getByPlaceholderText("settings.mcpConnections.urlPlaceholder"), {
      target: { value: "https://mcp.example.com/sse" },
    });

    // Both selects default to the "none" sentinel — no scope selected.
    fireEvent.click(screen.getByText("settings.mcpConnections.saveChanges"));

    await waitFor(() => {
      expect(screen.getByText("settings.mcpConnections.errorScopeRequired")).toBeInTheDocument();
    });
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("selecting a project clears the workspace (mutual exclusivity) and submits", async () => {
    mockCreateConnection.mockResolvedValue({ id: "c1" });
    render(<McpConnectionForm onClose={onClose} onSave={onSave} />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText("settings.mcpConnections.namePlaceholder")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText("settings.mcpConnections.namePlaceholder"), {
      target: { value: "Test" },
    });
    fireEvent.change(screen.getByPlaceholderText("settings.mcpConnections.urlPlaceholder"), {
      target: { value: "https://mcp.example.com/sse" },
    });

    // Select a workspace first, then a project — the workspace must be cleared.
    const selects = screen.getAllByRole("combobox");
    const workspaceSelect = selects[2];
    if (workspaceSelect) fireEvent.change(workspaceSelect, { target: { value: "w1" } });
    const projectSelect = selects[1];
    if (projectSelect) fireEvent.change(projectSelect, { target: { value: "p1" } });

    fireEvent.click(screen.getByText("settings.mcpConnections.saveChanges"));

    await waitFor(() => {
      expect(mockCreateConnection).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "p1", workspaceId: undefined }),
      );
    });
    expect(showSuccess).toHaveBeenCalledWith("settings.mcpConnections.createSuccess");
  });

  it("shows header error for invalid header name", async () => {
    render(<McpConnectionForm onClose={onClose} onSave={onSave} />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText("settings.mcpConnections.namePlaceholder")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText("settings.mcpConnections.namePlaceholder"), {
      target: { value: "Test" },
    });
    fireEvent.change(screen.getByPlaceholderText("settings.mcpConnections.urlPlaceholder"), {
      target: { value: "https://mcp.example.com/sse" },
    });

    const selects = screen.getAllByRole("combobox");
    const projectSelect = selects[1];
    if (projectSelect) fireEvent.change(projectSelect, { target: { value: "p1" } }); // project

    // Add a header row and type an invalid name (space + '!' break ^[A-Za-z0-9-]+$)
    fireEvent.click(screen.getByText("settings.mcpConnections.headersAdd"));
    const nameInput = screen.getByPlaceholderText("settings.mcpConnections.headersNamePlaceholder");
    fireEvent.change(nameInput, { target: { value: "Bad Name!" } });

    fireEvent.click(screen.getByText("settings.mcpConnections.saveChanges"));

    await waitFor(() => {
      expect(screen.getByText("settings.mcpConnections.errorInvalidHeaderName")).toBeInTheDocument();
    });
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("preset button adds a pre-filled header row", async () => {
    render(<McpConnectionForm onClose={onClose} onSave={onSave} />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText("settings.mcpConnections.namePlaceholder")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("+ Authorization"));

    await waitFor(() => {
      expect(screen.getByDisplayValue("Authorization")).toBeInTheDocument();
    });
  });

  it("edit mode loads existing headers as rows", async () => {
    mockUpdateConnection.mockResolvedValue(undefined);
    const connection = {
      id: "c1",
      name: "Existing",
      url: "https://old.example.com",
      transportType: "sse" as const,
      projectId: "p1",
      workspaceId: null,
      headers: { Authorization: "Bearer abc" },
      enabled: true,
      lastSyncAt: null,
      createdAt: "",
      updatedAt: "",
    };

    render(<McpConnectionForm connection={connection} onClose={onClose} onSave={onSave} />);
    await waitFor(() => {
      expect(screen.getByDisplayValue("Existing")).toBeInTheDocument();
    });

    expect(screen.getByDisplayValue("Authorization")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Bearer abc")).toBeInTheDocument();
  });

  it("calls updateConnection in edit mode", async () => {
    mockUpdateConnection.mockResolvedValue(undefined);
    const connection = {
      id: "c1",
      name: "Existing",
      url: "https://old.example.com",
      transportType: "sse" as const,
      projectId: "p1",
      workspaceId: null,
      headers: {},
      enabled: true,
      lastSyncAt: null,
      createdAt: "",
      updatedAt: "",
    };

    render(<McpConnectionForm connection={connection} onClose={onClose} onSave={onSave} />);
    await waitFor(() => {
      expect(screen.getByDisplayValue("Existing")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByDisplayValue("Existing"), {
      target: { value: "Updated Name" },
    });

    fireEvent.click(screen.getByText("settings.mcpConnections.saveChanges"));

    await waitFor(() => {
      expect(mockUpdateConnection).toHaveBeenCalledWith(expect.objectContaining({ id: "c1", data: expect.objectContaining({ name: "Updated Name" }) }));
    });
    expect(showSuccess).toHaveBeenCalledWith("settings.mcpConnections.updateSuccess");
  });

  it("closes on cancel click", async () => {
    render(<McpConnectionForm onClose={onClose} onSave={onSave} />);
    await waitFor(() => {
      expect(screen.getByText("common.cancel")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("common.cancel"));
    expect(onClose).toHaveBeenCalled();
  });
});
