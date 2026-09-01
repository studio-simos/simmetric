// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { render, screen, fireEvent } from "@testing-library/react";
import { PlanBanner } from "../PlanBanner";
import type { AgentPlan } from "@simmetric-chat/shared";

const plan: AgentPlan = {
  goal: "Rispondere sulla retention policy",
  steps: [
    { step: 1, action: "Cercare 'retention policy'", tool: "rag_search" },
    { step: 2, action: "Sintetizzare la risposta", tool: null },
  ],
};

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, d?: unknown) => {
      if (typeof d === "string") return d;
      if (d && typeof d === "object" && "defaultValue" in d) return (d as { defaultValue: string }).defaultValue;
      return k;
    },
  }),
}));

describe("PlanBanner", () => {
  it("renders the goal and steps when expanded (default)", () => {
    render(<PlanBanner plan={plan} />);
    expect(screen.getByText(plan.goal)).toBeInTheDocument();
    // The first tool step appears both in the header summary and the step list.
    expect(screen.getAllByText(/Cercare/).length).toBeGreaterThanOrEqual(1);
  });

  it("toggles expansion on click (aria-expanded flips)", () => {
    render(<PlanBanner plan={plan} />);
    const toggle = screen.getByRole("button");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(plan.goal)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("starts collapsed when defaultExpanded=false (persisted banner)", () => {
    render(<PlanBanner plan={plan} defaultExpanded={false} />);
    const toggle = screen.getByRole("button");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(plan.goal)).not.toBeInTheDocument();
  });
});