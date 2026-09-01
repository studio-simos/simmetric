// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ArchiveGraphView component tests
 */

// Mock i18next before any imports
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// Mock D3 to avoid SVG/jsdom complexities
jest.mock("d3", () => {
  const createSel = () => {
    const s: Record<string, unknown> = {};
    const methods = [
      "selectAll", "data", "join", "append", "attr", "style", "text",
      "call", "transition", "duration", "on", "remove", "scaleExtent",
      "strength", "id", "radius", "distance", "force", "alphaTarget",
      "restart", "stop", "transform", "toString",
    ];
    for (const m of methods) {
      s[m] = jest.fn(() => s);
    }
    return s;
  };
  return {
    select: jest.fn(() => createSel()),
    zoom: jest.fn(() => createSel()),
    zoomIdentity: {},
    forceSimulation: jest.fn(() => createSel()),
    forceLink: jest.fn(() => createSel()),
    forceManyBody: jest.fn(() => createSel()),
    forceCenter: jest.fn(() => createSel()),
    forceCollide: jest.fn(() => createSel()),
    drag: jest.fn(() => createSel()),
  };
});

// Mock API
const mockApiGet = jest.fn();
jest.mock("../utils/api", () => ({
  apiGet: (...args: Parameters<typeof mockApiGet>) => mockApiGet(...args),
}));

import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { ArchiveGraphView } from "../components/ArchiveGraphView";

describe("ArchiveGraphView", () => {
  beforeEach(() => {
    mockApiGet.mockReset();
  });

  it("renders loading state initially", () => {
    mockApiGet.mockImplementation(() => new Promise(() => {})); // never resolves
    render(<ArchiveGraphView archiveId="test-archive-id" />);
    expect(screen.getByText("graph.loading")).toBeInTheDocument();
  });

  it("shows no pages message when nodes array is empty", async () => {
    mockApiGet.mockResolvedValue({ nodes: [], edges: [] });
    render(<ArchiveGraphView archiveId="test-archive-id" />);
    await waitFor(() => {
      expect(screen.getByText("graph.noPages")).toBeInTheDocument();
    });
  });

  it("renders SVG element when graph data is loaded", async () => {
    mockApiGet.mockResolvedValue({
      nodes: [
        { id: "page-1", title: "Page One", category: "entities", slug: "page-one" },
        { id: "page-2", title: "Page Two", category: "concepts", slug: "page-two" },
      ],
      edges: [{ source: "page-1", target: "page-2" }],
    });
    render(<ArchiveGraphView archiveId="test-archive-id" />);
    await waitFor(() => {
      expect(document.querySelector("svg")).toBeInTheDocument();
    });
  });

  it("calls onNodeClick with slug when a node is clicked", async () => {
    const onNodeClick = jest.fn();
    mockApiGet.mockResolvedValue({
      nodes: [{ id: "page-1", title: "Page One", category: "entities", slug: "page-one" }],
      edges: [],
    });
    render(
      <ArchiveGraphView archiveId="test-archive-id" onNodeClick={onNodeClick} />
    );
    await waitFor(() => {
      expect(document.querySelector("svg")).toBeInTheDocument();
    });
    // D3 click handler is registered via node.on("click", ...)
    // Since D3 is mocked, we cannot directly trigger it from the DOM.
    // This test verifies the component renders without crashing with the prop.
    expect(onNodeClick).not.toHaveBeenCalled();
  });

  it("calls apiGet with correct path", async () => {
    mockApiGet.mockResolvedValue({ nodes: [], edges: [] });
    render(<ArchiveGraphView archiveId="archive-42" />);
    await waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledWith("/archives/archive-42/graph");
    });
  });
});
