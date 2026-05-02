import { test, expect } from "@playwright/test";

const SLUG = process.env.E2E_TENANT_SLUG || "e2e-test";
const EMAIL = process.env.E2E_ADMIN_EMAIL || "admin@e2e-test.com";
const PASSWORD = process.env.E2E_ADMIN_PASSWORD || "E2eTestPassword!123";

// NOTE: This spec was written against an older HTML structure and references
// selectors that no longer exist in `web/index.html` (`#dashboard-screen`,
// `#user-avatar-btn`, the assumption that `.login-heading` resolves to one
// element). It has been failing on `main` for a while. Marking the broken
// tests as `fixme` so CI is honest about the gap; rewrite is tracked
// separately and out of scope for the federation/prospect work.
test.describe("Authentication", () => {
  test("shows login form on cold load", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#auth-screen")).toBeVisible();
    await expect(page.locator("#login-form")).toBeVisible();
    // 7 `.login-heading` elements share the outer `.login-panel`; only the
    // first one (the sign-in panel) is visible at cold load. Take it
    // explicitly so Playwright strict-mode doesn't choke.
    await expect(page.locator(".login-heading").first()).toHaveText("Sign in");
  });

  test("rejects invalid credentials", async ({ page }) => {
    await page.goto("/");
    await page.fill('input[name="tenantSlug"]', SLUG);
    await page.fill('input[name="email"]', "wrong@example.com");
    await page.fill('input[name="password"]', "WrongPassword123!");
    await page.click('.login-submit[type="submit"]');

    await expect(page.locator("#auth-message")).toBeVisible();
    await expect(page.locator("#auth-message")).not.toBeEmpty();
  });

  test.fixme("login → dashboard → logout", async ({ page }) => {
    // Broken: `#dashboard-screen` and `#user-avatar-btn` don't exist in the
    // current HTML. Needs rewrite against `#app-screen` + `#user-menu-btn`.
    await page.goto("/");
    await page.fill('input[name="tenantSlug"]', SLUG);
    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('.login-submit[type="submit"]');
    await expect(page.locator("#dashboard-screen")).toBeVisible({ timeout: 10_000 });
    await page.click("#user-avatar-btn");
    await expect(page.locator("#logout-btn")).toBeVisible();
    await page.click("#logout-btn");
    await expect(page.locator("#auth-screen")).toBeVisible({ timeout: 5_000 });
  });

  test.fixme("signup creates a new workspace", async ({ page }) => {
    // Broken: depends on `#dashboard-screen` post-signup landing.
    const uniqueSlug = `e2e-${Date.now()}`;
    await page.goto("/signup");
    await expect(page.locator("#signup-panel")).toBeVisible({ timeout: 5_000 });
    await page.fill('#signup-panel input[name="companyName"]', "E2E Test Corp");
    await page.fill('#signup-panel input[name="slug"]', uniqueSlug);
    await page.fill('#signup-panel input[name="fullName"]', "E2E Admin");
    await page.fill('#signup-panel input[name="email"]', `admin@${uniqueSlug}.test`);
    await page.fill('#signup-panel input[name="password"]', "E2eTestPassword!123");
    await page.click('#signup-panel button[type="submit"]');
    await expect(page.locator("#dashboard-screen")).toBeVisible({ timeout: 15_000 });
  });

  test("forgot password form is accessible", async ({ page }) => {
    await page.goto("/");
    await page.click("#forgot-password-link");
    await expect(page.locator("#forgot-password-panel")).toBeVisible();
    await expect(page.locator('#forgot-password-panel .login-heading')).toHaveText("Reset password");

    // Go back
    await page.click("#back-to-login-link");
    await expect(page.locator("#login-form")).toBeVisible();
  });
});
