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

const COMPOSER_PLACEHOLDER = /Describe the widget or action you need/i;
const COMPOSER_DEFAULT_PROMPT = "A circular progress gauge with a gradient stroke";

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
    // The first-visit walkthrough is real product behavior, but these tests
    // assert the bare landing surfaces; the walkthrough's own coverage is
    // owned by the tutorials slice. Mark it seen so the modal cannot cover
    // the landing and steal focus.
    await page.addInitScript(() => {
      localStorage.setItem("hasSeenWalkthrough", "true");
    });
  });

  test.afterEach(async ({ page }) => {
    // Ignore Chromium permissions-policy notices that are unrelated to app code.
    const relevantFailures = page.consoleFailures.filter(
      (text) => !/Permissions policy violation: compute-pressure/.test(text),
    );
    expect(relevantFailures).toEqual([]);
  });

  test("shows the hero landing and the composer", async ({ page }) => {
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
    });

    await page.goto("/");

    // Hero landing is visible and branded.
    await expect(page).toHaveTitle(/Custom Code Connect/);
    const heading = page.locator("h1");
    await expect(heading).toBeVisible();
    await expect(heading).toContainText("FlutterFlow custom code.");

    // Composer is present with its shipped example prompt.
    const composer = page.locator("#pipeline-input");
    await expect(composer).toBeVisible();
    await expect(composer).toHaveValue(COMPOSER_DEFAULT_PROMPT);
    await expect(composer).toHaveAttribute(
      "placeholder",
      COMPOSER_PLACEHOLDER,
    );

    // The ready state remains in the DOM but is hidden until generation is
    // dismissed; the redesigned shell has no preview-frame container.
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

    // The redesigned composer's send control is the hero send button.
    const runButton = page.locator("#hero-send");
    await expect(runButton).toBeEnabled();
  });

  test("guest usage badge shows the intercepted free allowance", async ({ page }) => {
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
    });

    // The redesigned shell surfaces guest usage on the Account surface.
    await page.goto("/#account");

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

    // The tier badge lives on the Account surface in the redesigned shell.
    await page.goto("/#account");

    const badge = page.locator("#subscription-tier-badge");
    await expect(badge).toContainText("Pro");
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

    // The tier badge lives on the Account surface in the redesigned shell.
    await page.goto("/#account");

    const badge = page.locator("#subscription-tier-badge");
    await expect(badge).toContainText("Power");
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

    // The tier badge lives on the Account surface in the redesigned shell.
    await page.goto("/#account");

    const badge = page.locator("#subscription-tier-badge");
    await expect(badge).toContainText("Plan unavailable");
  });
});
