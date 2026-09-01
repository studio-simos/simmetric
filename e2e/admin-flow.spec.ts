import { test, expect } from "./fixtures";

test.describe("Admin critical path", () => {
  test("health endpoint responds", async ({ request }) => {
    const res = await request.get("http://localhost:3000/api/health");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(["ok", "degraded"]).toContain(body.status);
  });

  test("frontend loads", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("body", { timeout: 10000 });
    const title = await page.title();
    expect(title).toBeDefined();
  });

  test("login page has form elements", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    const inputs = page.locator("input");
    const count = await inputs.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});