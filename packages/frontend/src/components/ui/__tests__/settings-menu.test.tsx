// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SettingsMenu primitive tests — Feature 7.5 Slice C (7.5 settings laterale),
 * extended with always-expanded sub-section sub-menus (2026-07-15).
 *
 * The SettingsMenu is a plain-button two-level vertical nav reused by the
 * desktop settings rail and the mobile Sheet: each group (settings "page"/tab)
 * is a clickable header, and its sub-sections are an always-expanded indented
 * sub-list. It is theme-agnostic (the hacker neon override is pure CSS via
 * `.settings-menu-item[data-active]`).
 */
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";

// Mock react-i18next: t returns the key verbatim so label keys are assertable.
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

import { SettingsMenu } from "../settings-menu";

const GROUPS = [
  {
    key: "general",
    labelKey: "settings.tabs.general",
    sections: [
      { id: "profile", labelKey: "settings.subSections.profile" },
      { id: "general", labelKey: "settings.subSections.generalSettings" },
    ],
  },
  {
    key: "security",
    labelKey: "settings.tabs.security",
    sections: [
      { id: "roles", labelKey: "settings.subSections.roles" },
      { id: "users", labelKey: "settings.subSections.users" },
    ],
  },
];

describe("SettingsMenu", () => {
  it("renders every group header and sub-section voice with translated labels", () => {
    render(
      <SettingsMenu
        groups={GROUPS}
        activeTab="security"
        onSelectTab={jest.fn()}
        onSelectSection={jest.fn()}
      />,
    );

    // Group headers (tabs).
    expect(screen.getByText("settings.tabs.general")).toBeInTheDocument();
    expect(screen.getByText("settings.tabs.security")).toBeInTheDocument();
    // Sub-section voices — all expanded, always visible.
    expect(screen.getByText("settings.subSections.profile")).toBeInTheDocument();
    expect(screen.getByText("settings.subSections.generalSettings")).toBeInTheDocument();
    expect(screen.getByText("settings.subSections.roles")).toBeInTheDocument();
    expect(screen.getByText("settings.subSections.users")).toBeInTheDocument();
  });

  it("marks the active group header with data-active + aria-current + settings-menu-item class", () => {
    render(
      <SettingsMenu
        groups={GROUPS}
        activeTab="security"
        onSelectTab={jest.fn()}
        onSelectSection={jest.fn()}
      />,
    );

    const securityHeader = screen
      .getByText("settings.tabs.security")
      .closest("button")!;
    expect(securityHeader).toHaveAttribute("data-active", "true");
    expect(securityHeader).toHaveAttribute("aria-current", "page");
    expect(securityHeader.className).toContain("settings-menu-item");
    expect(securityHeader.className).toContain("border-primary");

    const generalHeader = screen
      .getByText("settings.tabs.general")
      .closest("button")!;
    expect(generalHeader).toHaveAttribute("data-active", "false");
    expect(generalHeader).not.toHaveAttribute("aria-current");
    expect(generalHeader.className).toContain("border-transparent");
  });

  it("marks the active sub-section voice with data-active + settings-menu-item", () => {
    render(
      <SettingsMenu
        groups={GROUPS}
        activeTab="security"
        activeSection="roles"
        onSelectTab={jest.fn()}
        onSelectSection={jest.fn()}
      />,
    );

    const rolesVoice = screen
      .getByText("settings.subSections.roles")
      .closest("button")!;
    expect(rolesVoice).toHaveAttribute("data-active", "true");
    expect(rolesVoice).toHaveAttribute("aria-current", "true");
    expect(rolesVoice.className).toContain("settings-menu-item");
    expect(rolesVoice.className).toContain("border-primary");

    // A non-active voice under the same group is not marked active.
    const usersVoice = screen
      .getByText("settings.subSections.users")
      .closest("button")!;
    expect(usersVoice).toHaveAttribute("data-active", "false");
    expect(usersVoice.className).toContain("border-transparent");
  });

  it("calls onSelectTab with the group key when a group header is clicked", () => {
    const onSelectTab = jest.fn();
    render(
      <SettingsMenu
        groups={GROUPS}
        activeTab="security"
        onSelectTab={onSelectTab}
        onSelectSection={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByText("settings.tabs.general"));
    expect(onSelectTab).toHaveBeenCalledTimes(1);
    expect(onSelectTab).toHaveBeenCalledWith("general");
  });

  it("calls onSelectSection with (tabKey, sectionId) when a sub-section voice is clicked", () => {
    const onSelectSection = jest.fn();
    render(
      <SettingsMenu
        groups={GROUPS}
        activeTab="general"
        onSelectTab={jest.fn()}
        onSelectSection={onSelectSection}
      />,
    );

    fireEvent.click(screen.getByText("settings.subSections.generalSettings"));
    expect(onSelectSection).toHaveBeenCalledTimes(1);
    expect(onSelectSection).toHaveBeenCalledWith("general", "general");
  });

  it("renders nothing when groups is empty (no crash)", () => {
    const { container } = render(
      <SettingsMenu
        groups={[]}
        activeTab="general"
        onSelectTab={jest.fn()}
        onSelectSection={jest.fn()}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("renders each item as type=button with aria-label = translated label", () => {
    render(
      <SettingsMenu
        groups={GROUPS}
        activeTab="general"
        onSelectTab={jest.fn()}
        onSelectSection={jest.fn()}
      />,
    );

    const generalHeader = screen
      .getByText("settings.tabs.general")
      .closest("button")!;
    expect(generalHeader).toHaveAttribute("type", "button");
    expect(generalHeader).toHaveAttribute("aria-label", "settings.tabs.general");

    const profileVoice = screen
      .getByText("settings.subSections.profile")
      .closest("button")!;
    expect(profileVoice).toHaveAttribute("type", "button");
    expect(profileVoice).toHaveAttribute("aria-label", "settings.subSections.profile");
  });
});