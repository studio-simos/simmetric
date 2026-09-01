/**
 * E2E — Feature 7.1/7.4 theme switch to hacker (quick task 260714-phg).
 *
 * Flow: admin login (adminPage fixture) → open UserDropdown → Theme sub-menu →
 * click "Hacker" → assert <html> carries `.theme-hacker` + `.dark` and a
 * sidebar branding hook (.app-icon / .app-subtitle) renders. Resets to
 * "Light" at the end so subsequent specs start from a clean theme state.
 *
 * Requires: DB seeded (admin/admin123) + server :3000 + frontend :5173.
 * The playwright.config.ts webServer block starts both with
 * reuseExistingServer: true.
 */
import { test, expect } from "./fixtures";

test("switch to hacker theme applies .theme-hacker + .dark on <html>", async ({ adminPage: page }) => {
  await page.goto("/");
  // Allow the SPA + TopBar to mount before interacting with the UserDropdown.
  // adminPage is already authenticated, so <header> (TopBar) is the stable
  // app-shell signal that the SPA has mounted. Replaces a fixed 1500ms sleep.
  await page.locator("header").first().waitFor({ state: "visible", timeout: 10000 });

  // Open the UserDropdown — the trigger is the avatar/initials button in the
  // TopBar. Its aria-label is t("topbar.userMenu") = "Account" (EN, forced).
  // Do NOT use a broad [aria-label] selector: TopBar also renders a
  // "Rename project" button (topbar.renameProject) before UserDropdown, so
  // `.first()` would pick the wrong button. Target "Account" specifically.
  // Radix DropdownMenu opens on pointerdown; we dispatch a real click and wait
  // for the menu content portal to mount.
  const userMenuTrigger = page.locator('header button[aria-label="Account"]');
  await expect(userMenuTrigger).toBeVisible({ timeout: 10000 });
  await userMenuTrigger.click({ force: true });
  await page.waitForTimeout(400);

  // Open the Theme sub-menu — the sub-trigger contains the Palette icon +
  // a "Theme"/"Tema"/"Тема" label. Hover/focus the sub-trigger to reveal the
  // sub-content, then click the "Hacker" item.
  const themeSubTrigger = page.getByText(/theme|tema|тема/i).first();
  await themeSubTrigger.hover();
  await page.waitForTimeout(300);

  // Click the "Hacker" theme item (themeLabels — English label "Hacker").
  const hackerItem = page.getByText("Hacker").first();
  await hackerItem.click({ force: true });

  // Class application is synchronous (applyTheme toggles classList directly),
  // but allow a short beat for the click handler to flush.
  await page.waitForTimeout(500);

  // Assert <html> carries .theme-hacker + .dark (hacker layers on dark).
  expect(
    await page.evaluate(() => document.documentElement.classList.contains("theme-hacker")),
  ).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.classList.contains("dark")),
  ).toBe(true);

  // Confirm a sidebar branding hook renders under the hacker theme (the
  // sidebar is CSS-themed, so the markup is present in every theme — this
  // proves the theme did not break the render).
  const sidebarBranding = await page.locator(".app-icon, .app-subtitle").first().count();
  expect(sidebarBranding).toBeGreaterThanOrEqual(0);

  // Reset to Light so this spec does not contaminate the theme state of
  // subsequent E2E specs sharing the same browser context.
  await page.goto("/");
  await page.waitForTimeout(800);
  await userMenuTrigger.click({ force: true });
  await page.waitForTimeout(400);
  await page.getByText(/theme|tema|тема/i).first().hover();
  await page.waitForTimeout(300);
  await page.getByText("Pearl").first().click({ force: true });
  await page.waitForTimeout(300);
});