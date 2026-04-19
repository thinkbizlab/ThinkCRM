import { test, expect } from "@playwright/test";

const SLUG = process.env.E2E_TENANT_SLUG || "e2e-test";
const EMAIL = process.env.E2E_ADMIN_EMAIL || "admin@e2e-test.com";
const PASSWORD = process.env.E2E_ADMIN_PASSWORD || "E2eTestPassword!123";

test.describe("Authentication", () => {
  test("shows login form on cold load", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#auth-screen")).toBeVisible();
    await expect(page.locator("#login-form")).toBeVisible();
    await expect(page.locator(".login-heading")).toHaveText("Sign in");
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

  test("login → dashboard → logout", async ({ page }) => {
    await page.goto("/");
    await page.fill('input[name="tenantSlug"]', SLUG);
    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('.login-submit[type="submit"]');

    // Should navigate to dashboard
    await expect(page.locator("#dashboard-screen")).toBeVisible({ timeout: 10_000 });

    // Logout via user dropdown
    await page.click("#user-avatar-btn");
    await expect(page.locator("#logout-btn")).toBeVisible();
    await page.click("#logout-btn");

    // Should return to login
    await expect(page.locator("#auth-screen")).toBeVisible({ timeout: 5_000 });
  });

  test("signup creates a new workspace", async ({ page }) => {
    const uniqueSlug = `e2e-${Date.now()}`;
    await page.goto("/signup");

    await expect(page.locator("#signup-panel")).toBeVisible({ timeout: 5_000 });
    await page.fill('#signup-panel input[name="companyName"]', "E2E Test Corp");
    await page.fill('#signup-panel input[name="slug"]', uniqueSlug);
    await page.fill('#signup-panel input[name="fullName"]', "E2E Admin");
    await page.fill('#signup-panel input[name="email"]', `admin@${uniqueSlug}.test`);
    await page.fill('#signup-panel input[name="password"]', "E2eTestPassword!123");

    await page.click('#signup-panel button[type="submit"]');

    // Should auto-login to dashboard after signup
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
