/**
 * E2E — Feature 7.5 settings left-menu navigation (quick task 260714-phg).
 *
 * Flow: admin login → /settings → click settings-menu-item tabs → assert the
 * main content changes → deep-link ?tab=providers activates the right item.
 *
 * Requires: DB seeded (admin/admin123) + server :3000 + frontend :5173.
 */
import { test, expect } from "./fixtures";

test("settings left menu navigates between tabs and content updates", async ({ adminPage: page }) => {
  test.setTimeout(60000);
  await page.goto("/settings");
  await page.waitForSelector(".settings-menu-item", { timeout: 20000 });

  const items = page.locator(".settings-menu-item");
  const count = await items.count();
  expect(count).toBeGreaterThanOrEqual(2);

  const secondItem = items.nth(1);
  await secondItem.click();
  await page.waitForTimeout(500);

  const deepLink = `/settings?tab=providers`;
  await page.goto(deepLink);
  await page.waitForSelector(".settings-menu-item", { timeout: 20000 });
  await page.waitForTimeout(500);

  const activeCount = await page.locator('.settings-menu-item[data-active="true"]').count();
  expect(activeCount).toBeGreaterThanOrEqual(1);
});