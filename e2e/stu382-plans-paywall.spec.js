import { test, expect } from "@playwright/test";
import {
  applyDefaultRoutes,
  guestIdentity,
  freeSubscription,
  professionalSubscription,
  unresolvedSubscription,
  ENDPOINTS,
  checkoutSession,
} from "./fixtures/apiFixtures.js";

/**
 * STU-382 — the plans surface and paywall states must be backed by real
 * subscription contracts.
 *
 * Covered criteria:
 *  - C1: Free/Pro/Power labels and current-plan indicators agree across the
 *    topbar, the account badge, the plans page and model gating.
 *  - C3: a cancelled, blocked or un-reconciled checkout return is never
 *    reported as subscribed; a return whose contract has reconciled refreshes
 *    allowance and unlocks available models.
 *  - C4: the shipped surface advertises no simulated purchase success (the
 *    design's mock "Subscription confirmed / no charge was made" dialogs are
 *    absent), and an upgrade click goes to the real Stripe checkout endpoint.
 *  - C5: the plan comparison cards carry no unsupported prototype promises
 *    (no "API & MCP access", no "early access") and only supported rows.
 *
 * A checkout return alone never grants a paid tier. Entitlement only ever
 * comes from the get-subscription reconciliation fixture, so "?checkout=X"
 * with a FREE contract must still render Free everywhere.
 */

const currentMonth = () => new Date().toISOString().slice(0, 7);

function identityWithUsage({ count = 0, status = "recognized" } = {}) {
  return {
    status: 200,
    body: JSON.stringify({
      status,
      user_id: "stu382-0001",
      identity_token: "identity-token",
      usage_count: count,
      usage_month: currentMonth(),
    }),
    contentType: "application/json",
  };
}

async function seedSession(page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "ccc_auth_session",
      JSON.stringify({ email: "plans@example.com", sessionToken: "session-token" }),
    );
  });
}

const proModelOption = (page) =>
  page.locator('#code-generator-model option[value="openai/gpt-5.6-sol"]');

test.describe("STU-382 plans surface and paywall states", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("hasSeenWalkthrough", "true"));
  });

  test("C1: professional labels and current-plan indicators agree across surfaces", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: identityWithUsage({ count: 6 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });
    await page.goto("/#plans");

    await expect(page.locator("#topbar-plan")).toHaveText("Pro");
    await expect(page.locator("#subscription-tier-badge")).toHaveText("Pro");
    await expect(page.locator("#plans-checkout-btn-professional")).toHaveText("Current plan");
    await expect(page.locator("#plans-checkout-btn-professional")).toBeDisabled();
    await expect(page.locator("#plans-checkout-btn-power")).toHaveText("Subscribe");
    await expect(page.locator("#plans-free-current")).toBeHidden();

    // Model gating agrees: Pro tier keeps Pro models unlocked and unlabelled.
    await expect(proModelOption(page)).toBeEnabled();
    await expect(proModelOption(page)).not.toContainText("(PRO)");
  });

  test("C3: a cancelled checkout is never reported as subscribed", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: identityWithUsage(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
    });
    await page.goto("/?checkout=cancel");

    await expect(page.locator("#topbar-plan")).toHaveText("Free");
    await expect(page.locator("#subscription-tier-badge")).toHaveText("Free");
    await expect(page.getByText("Checkout cancelled.")).toBeVisible();
    // Never a live-plan claim.
    await expect(page.getByText("Subscription active")).toHaveCount(0);
    // Entitlement still free — Pro model stays labelled as gated.
    await expect(proModelOption(page)).toContainText("(PRO)");
  });

  test("C3/C4: a checkout return alone never grants a paid tier before reconciliation", async ({ page }) => {
    await seedSession(page);
    // Contract still free (blocked / webhook not yet reconciled) even though
    // the user returned with `?checkout=success`.
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: identityWithUsage(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
    });
    await page.goto("/?checkout=success");

    // No entitlement change, anywhere.
    await expect(page.locator("#topbar-plan")).toHaveText("Free");
    await expect(page.locator("#subscription-tier-badge")).toHaveText("Free");
    await expect(proModelOption(page)).toContainText("(PRO)");

    // The confirmation is honest: it says "confirming", never "Subscription active".
    await expect(page.getByText("confirming your subscription", { exact: false })).toBeVisible();
    await expect(page.getByText("Subscription active")).toHaveCount(0);
  });

  test("C3: a verified return refreshes allowance and unlocks available models", async ({ page }) => {
    await seedSession(page);
    // Contract reconciled to professional — this is the ONLY thing that
    // grants the paid tier, never the return param itself.
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: identityWithUsage({ count: 12 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });
    await page.goto("/?checkout=success");

    await expect(page.locator("#topbar-plan")).toHaveText("Pro");
    await expect(page.locator("#subscription-tier-badge")).toHaveText("Pro");
    await expect(page.getByText("Subscription active!")).toBeVisible();

    // Allowance and models refreshed from the reconciled contract.
    await expect(proModelOption(page)).toBeEnabled();
    await expect(proModelOption(page)).not.toContainText("(PRO)");
  });

  test("C4: no simulated purchase success survives; upgrade posts to the real Stripe endpoint", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: identityWithUsage(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
    });
    await page.goto("/");

    // The design's mock "preview" purchase-success dialogs must not ship,
    // even hidden in the pricing modal. Scan the full document source so an
    // inert/hidden mock cannot dodge the assertion.
    const pageHtml = await page.content();
    for (const mock of ["Subscription confirmed", "no charge was made", "Redirecting to checkout", "This is where the Stripe session would open"]) {
      expect(pageHtml).not.toContain(mock);
    }

    // Upgrade goes to the real checkout endpoint — and never locally writes a
    // paid subscription before Stripe returns.
    let checkoutPosted = false;
    await page.route(`${ENDPOINTS.createCheckout}`, async (route) => {
      checkoutPosted = true;
      await route.fulfill(checkoutSession());
    });

    await page.evaluate(() => window.openPricingModal());
    await page.locator("#checkout-btn-professional").click();

    await expect
      .poll(() => checkoutPosted, { timeout: 5000 })
      .toBe(true);
    expect(checkoutPosted).toBe(true);
  });

  test("C4/C1: keyboard-reachable sign-in, upgrade and Manage actions render correctly", async ({ page }) => {
    // Guest account view: Sign In and Upgrade are keyboard-focusable on mobile.
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
    });
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/#account");

    const guestSignIn = page.locator('#auth-signedout button');
    const guestUpgrade = page.locator('#auth-guest-usage button', { hasText: "Upgrade" });
    await expect(guestSignIn).toBeVisible();
    await expect(guestUpgrade).toBeVisible();
    await guestSignIn.focus();
    await expect(guestSignIn).toBeFocused();
    await guestUpgrade.focus();
    await expect(guestUpgrade).toBeFocused();

    // Signed-in professional: Manage Subscription is reachable.
    await page.setViewportSize({ width: 360, height: 800 });
    await page.addInitScript(() =>
      localStorage.setItem(
        "ccc_auth_session",
        JSON.stringify({ email: "plans@example.com", sessionToken: "session-token" }),
      ),
    );
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: identityWithUsage({ count: 12 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });
    await page.reload();
    const manageBtn = page.locator("#manage-billing-btn");
    await expect(manageBtn).toBeVisible();
    await manageBtn.focus();
    await expect(manageBtn).toBeFocused();
  });

  test("C5: the plans cards carry no unsupported prototype promises", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: identityWithUsage({ count: 6 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });
    await page.goto("/#plans");
    const plansText = await page.locator("#plans-view").innerText();
    for (const promise of ["API & MCP", "early access"]) {
      expect(plansText.toLowerCase()).not.toContain(promise.toLowerCase());
    }
    // Supported rows remain present and accurately priced.
    await expect(page.locator("#plans-power-price")).toHaveText("A$49");
    await expect(page.locator("#plans-pro-price")).toHaveText("A$11");
    expect(plansText).toContain("BYOK");
    expect(plansText).toContain("Code Regeneration");
  });
});

/**
 * Criterion 2 — the Displayed price and the currency posted to the checkout
 * must agree, for the AUD base and for a converted non-AUD fixture, using the
 * app's own formatPrice/exchange-rate path.
 */
async function displayedProAndCheckoutCurrency(page, expectedDisplayed) {
  // Auto-wait until updatePricingDisplay has formatted the price for the
  // detected currency, so we never read the static HTML default.
  await expect(page.locator("#plans-pro-price")).toHaveText(expectedDisplayed);
  const displayed = await page.locator("#plans-pro-price").innerText();
  let postedCurrency = null;
  await page.route(`${ENDPOINTS.createCheckout}`, async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    postedCurrency = body.currency;
    await route.fulfill(checkoutSession());
  });
  // Start the real checkout flow directly; the plans page prices and the
  // currency posted to /stripe/create-checkout-session-intl must agree.
  await page.evaluate(() => window.startCheckout("professional"));
  await expect.poll(() => postedCurrency, { timeout: 5000 }).not.toBeNull();
  return { displayed, postedCurrency };
}

test.describe("STU-382 pricing currency matches checkout selection", () => {
  test.use({ timezoneId: "Australia/Sydney", locale: "en-AU" });
  test("AUD base formats as A$ and the checkout posts AUD", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: identityWithUsage(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
    });
    await page.goto("/#plans");
    const { displayed, postedCurrency } = await displayedProAndCheckoutCurrency(page, "A$11");
    expect(displayed).toBe("A$11");
    expect(postedCurrency).toBe("AUD");
  });
});

test.describe("STU-382 pricing currency matches checkout selection (USD)", () => {
  test.use({ timezoneId: "America/New_York", locale: "en-US" });
  test("non-AUD fixture converts via exchange rates and the checkout posts USD", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: identityWithUsage(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
    });
    await page.goto("/#plans");
    const { displayed, postedCurrency } = await displayedProAndCheckoutCurrency(page, "$7.15");
    // 11 AUD × 0.65 (fixture USD rate) = USD 7.15.
    expect(displayed).toBe("$7.15");
    expect(postedCurrency).toBe("USD");
  });
});
