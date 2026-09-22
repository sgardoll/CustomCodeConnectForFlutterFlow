import { test, expect } from "@playwright/test";
import {
  applyDefaultRoutes,
  guestIdentity,
  freeSubscription,
  professionalSubscription,
  powerSubscription,
  unresolvedSubscription,
  ENDPOINTS,
} from "./fixtures/apiFixtures.js";

const COMPOSER_PLACEHOLDER = /Describe your custom widget or action/i;

/**
 * Baseline smoke test for the redesigned hero landing and composer state.
 * Does not invoke paid generation, billing or real project writes; every
 * external endpoint is intercepted with deterministic fixtures.
 */
test.describe("Redesigned hero landing and composer", () => {
  test.beforeEach(async ({ page }) => {
    page.consoleFailures = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        page.consoleFailures.push(msg.text());
      }
    });
  });

  test.afterEach(async ({ page }) => {
    expect(page.consoleFailures).toEqual([]);
  });

  test("shows the hero landing and an empty composer", async ({ page }) => {
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
    });

    await page.goto("/");

    // Hero landing is visible and branded.
    await expect(page).toHaveTitle(/Custom Code Connect/);
    const heading = page.locator("h1");
    await expect(heading).toBeVisible();
    await expect(heading).toContainText("FlutterFlow Custom Code, Solved.");

    // Composer is present and empty by default.
    const composer = page.locator("#pipeline-input");
    await expect(composer).toBeVisible();
    await expect(composer).toHaveValue("");
    await expect(composer).toHaveAttribute(
      "placeholder",
      /Describe your custom widget or action/i,
    );

    // The main stage starts with the preview/welcome frame visible; the ready
    // state remains in the DOM but is hidden until generation is dismissed.
    const previewFrame = page.locator("#preview-frame-container");
    await expect(previewFrame).toBeVisible();
    const readyState = page.locator("#ready-state");
    await expect(readyState).toBeHidden();
    await expect(readyState).toContainText("Ready to Generate");
  });

  test("composer accepts input and reflects typed state", async ({ page }) => {
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
    });

    await page.goto("/");

    const composer = page.locator("#pipeline-input");
    await composer.fill("A circular progress gauge with gradient stroke.");
    await expect(composer).toHaveValue(
      "A circular progress gauge with gradient stroke.",
    );

    // The run button is enabled once there is input.
    const runButton = page.locator("#btn-run-pipeline");
    await expect(runButton).toBeEnabled();
  });

  test("guest usage badge shows the intercepted free allowance", async ({ page }) => {
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
    });

    await page.goto("/");

    const usageText = page.locator("#guest-usage-text");
    await expect(usageText).toBeVisible();
    await expect(usageText).toContainText("0 / 2 generations used");
  });

  test("signed-in Professional badge is rendered from fixture", async ({ page }) => {
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });

    // Seed a signed-in session before navigation so subscription state is surfaced.
    await page.addInitScript(() => {
      localStorage.setItem(
        "ccc_auth_session",
        JSON.stringify({
          email: "pro@example.com",
          sessionToken: "test-session-token-pro",
        }),
      );
    });

    await page.goto("/");

    const badge = page.locator("#subscription-tier-badge");
    await expect(badge).toContainText("Professional");
  });

  test("signed-in Power badge is rendered from fixture", async ({ page }) => {
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.getSubscription]: powerSubscription(),
    });

    await page.addInitScript(() => {
      localStorage.setItem(
        "ccc_auth_session",
        JSON.stringify({
          email: "power@example.com",
          sessionToken: "test-session-token-power",
        }),
      );
    });

    await page.goto("/");

    const badge = page.locator("#subscription-tier-badge");
    await expect(badge).toContainText("Power Developer");
  });

  test("unresolved subscription surfaces the unavailable plan state", async ({ page }) => {
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.getSubscription]: unresolvedSubscription(),
    });

    await page.addInitScript(() => {
      localStorage.setItem(
        "ccc_auth_session",
        JSON.stringify({
          email: "unresolved@example.com",
          sessionToken: "test-session-token-unresolved",
        }),
      );
    });

    await page.goto("/");

    const badge = page.locator("#subscription-tier-badge");
    await expect(badge).toContainText("Plan unavailable");
  });
});
