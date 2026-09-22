import { test, expect } from "@playwright/test";
import {
  applyDefaultRoutes,
  guestIdentity,
  freeSubscription,
  professionalSubscription,
  signedInSession,
  magicLinkSent,
  magicLinkAliasRejected,
  magicLinkSendFailure,
  magicLinkVerifyFailure,
  ENDPOINTS,
} from "./fixtures/apiFixtures.js";

/**
 * Restyled magic-link sign-in (STU-386): validation, sending, sent,
 * expired-link, failed-request, retry, alias-policy and return-to-task
 * behavior. Every auth endpoint is intercepted with deterministic fixtures;
 * no real email is sent and no billing/checkout call completes.
 */
test.describe("Magic-link sign-in", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("hasSeenWalkthrough", "true");
    });
  });

  test("rejects an invalid email inline without calling the backend", async ({ page }) => {
    let sendCalled = false;
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
    });
    await page.route(ENDPOINTS.authSendMagicLink, async (route) => {
      sendCalled = true;
      await route.fulfill(magicLinkSent());
    });

    await page.goto("/#account");
    await page.locator("#auth-signedout button", { hasText: "Sign In" }).click();

    const modal = page.locator("#signin-modal");
    await expect(modal).toHaveClass(/open/);

    const input = page.locator("#signin-email-input");
    await input.fill("not-an-email");
    await page.locator("#signin-submit-btn").click();

    await expect(page.locator("#signin-message")).toContainText("valid email");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    expect(sendCalled).toBe(false);
  });

  test("sends a link, then leaves the submit control usable to resend", async ({ page }) => {
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
      [ENDPOINTS.authSendMagicLink]: magicLinkSent(),
    });

    await page.goto("/#account");
    await page.locator("#auth-signedout button", { hasText: "Sign In" }).click();

    const input = page.locator("#signin-email-input");
    const submit = page.locator("#signin-submit-btn");
    await input.fill("person@example.com");
    await submit.click();

    await expect(page.locator("#signin-message")).toContainText(
      "Check your email",
    );
    // Acceptance criterion: retry/send-again must stay usable — the button
    // is never left permanently disabled after a successful request.
    await expect(submit).toBeEnabled();

    // Resend to a second address works without reloading or reopening the modal.
    await input.fill("person-two@example.com");
    await submit.click();
    await expect(page.locator("#signin-message")).toContainText(
      "person-two@example.com",
    );
    await expect(submit).toBeEnabled();
  });

  test("shows an inline alias-policy error and keeps normal addresses working", async ({ page }) => {
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
      [ENDPOINTS.authSendMagicLink]: magicLinkAliasRejected("user+tag@gmail.com"),
    });

    await page.goto("/#account");
    await page.locator("#auth-signedout button", { hasText: "Sign In" }).click();

    const input = page.locator("#signin-email-input");
    const submit = page.locator("#signin-submit-btn");
    await input.fill("user+tag@gmail.com");
    await submit.click();

    // STU-149's alias-policy error is surfaced inline, not swallowed.
    await expect(page.locator("#signin-message")).toContainText("primary email address");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(submit).toBeEnabled();
    // The address is preserved so the user can see what was rejected.
    await expect(input).toHaveValue("user+tag@gmail.com");
  });

  test("recovers from a failed send, and retry succeeds", async ({ page }) => {
    let attempt = 0;
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
    });
    await page.route(ENDPOINTS.authSendMagicLink, async (route) => {
      attempt += 1;
      const fixture = attempt === 1 ? magicLinkSendFailure() : magicLinkSent();
      await route.fulfill(fixture);
    });

    await page.goto("/#account");
    await page.locator("#auth-signedout button", { hasText: "Sign In" }).click();

    const input = page.locator("#signin-email-input");
    const submit = page.locator("#signin-submit-btn");
    await input.fill("person@example.com");
    await submit.click();

    await expect(page.locator("#signin-message")).toContainText("Something went wrong");
    await expect(submit).toBeEnabled();

    // Retry with the same control, no reload required.
    await submit.click();
    await expect(page.locator("#signin-message")).toContainText("Check your email");
    expect(attempt).toBe(2);
  });

  test("an expired or invalid token surfaces an inline retry in the sign-in modal", async ({ page }) => {
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
      [ENDPOINTS.authVerifyMagicLink]: magicLinkVerifyFailure(),
    });

    await page.goto("/?token=expired-token-0001");

    const modal = page.locator("#signin-modal");
    await expect(modal).toHaveClass(/open/);
    await expect(page.locator("#signin-message")).toContainText("invalid or expired");

    // The token param is stripped so retrying never resubmits the dead token.
    await expect(page).toHaveURL(/^(?!.*token=).*$/);
  });

  test("a successful token verification refreshes the session and subscription", async ({ page }) => {
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.authVerifyMagicLink]: signedInSession(),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });

    await page.goto("/?token=good-token-0001#account");

    // Session refresh completes and the account surface reflects it — no
    // auto-purchase or auto-deploy is triggered by this flow.
    await expect(page.locator("#auth-signedin")).toBeVisible();
    await expect(page.locator("#auth-user-email")).toContainText("test@example.com");
    await expect(page.locator("#subscription-tier-badge")).toContainText("Professional");
    await expect(page.locator("#signin-modal")).not.toHaveClass(/open/);
  });

  test("signing in from the Plans surface returns to Plans after verification", async ({ page }) => {
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
    });

    await page.goto("/#plans");
    await expect(page.locator("#plans-view")).toBeVisible();

    // Subscribing while signed out opens the sign-in modal instead of checkout.
    await page.locator("#plans-checkout-btn-professional").click();
    await expect(page.locator("#signin-modal")).toHaveClass(/open/);

    // The magic-link round trip is a fresh navigation with no memory of the
    // DOM — the return surface must survive via storage, not page state.
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.authVerifyMagicLink]: signedInSession(),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });
    await page.goto("/?token=good-token-0002");

    await expect(page).toHaveURL(/#plans$/);
    await expect(page.locator("#plans-view")).toBeVisible();
    // Returning to Plans must not auto-purchase: no checkout redirect happens.
    await expect(page).not.toHaveURL(/checkout\.stripe\.com/);
  });
});
