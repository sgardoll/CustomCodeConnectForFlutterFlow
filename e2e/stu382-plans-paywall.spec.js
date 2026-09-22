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
 *  - C5: the plan comparison cards carry only capabilities the product
 *    actually delivers. "API & MCP access" and "early access" both ship, so
 *    they appear as available rows ("API & MCP access (contact us)" names its
 *    non-self-serve access path); no row may read as not-yet-available.
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
  // The price assertions in this suite (A$11 / A$49) must render the AUD base
  // value, never a converted one. formatPrice converts whenever the detected
  // currency is not AUD, and that conversion would differ between a dev
  // machine (Sydney TZ → A$11) and CI (UTC → $7.15) and fail non-hermetically.
  // Pin the timezone so the verdict does not depend on the host.
  test.use({ timezoneId: "Australia/Sydney", locale: "en-AU" });

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

    // Allowance refreshed from the reconciled contract: 50/run limit minus the
    // 12 metered runs leaves 38 remaining in the topbar allowance.
    await expect(page.locator("#topbar-credits-count")).toHaveText("38");

    // Models refreshed from the reconciled contract.
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

  test("C5: the plans cards present only capabilities the product delivers, all as available", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: identityWithUsage({ count: 6 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });
    await page.goto("/#plans");
    const plansView = page.locator("#plans-view");

    // The owner asked to KEEP the "API & MCP Access" and "All models + early
    // access" rows, and confirmed BOTH capabilities ship. They must therefore
    // read as available. API/MCP access is reached by contacting us rather than
    // through a self-serve signup, so that row names its access path. The rows
    // render from PLAN_FEATURES (the same source the modal uses). toContainText
    // auto-waits until the JS render fills the lists, so we never race an
    // un-rendered card.
    await expect(plansView).toContainText("All models + early access");
    await expect(plansView).toContainText("API & MCP access (contact us)");

    const plansText = await plansView.innerText();
    // No row may read as not-yet-available. An earlier revision marked these
    // two "(coming soon)" on the incorrect inference that no user-facing
    // surface existed in the codebase; the owner has since confirmed both ship.
    const rows = plansText.split("\n");
    for (const phrase of ["api & mcp", "early access"]) {
      const matching = rows.filter((r) => r.toLowerCase().includes(phrase));
      expect(matching.length).toBeGreaterThan(0);
      for (const row of matching) {
        expect(row).not.toMatch(/coming soon|not yet available|unavailable/i);
      }
    }

    // Supported rows remain present and accurately priced. The AUD timezone pin
    // above makes these price assertions hermetic (A$11/A$49, not a converted
    // value) on any host.
    await expect(page.locator("#plans-power-price")).toHaveText("A$49");
    await expect(page.locator("#plans-pro-price")).toHaveText("A$11");
    expect(plansText).toContain("BYOK");
    expect(plansText).toContain("Code Regeneration");

    // The pricing modal renders from the same PLAN_FEATURES source, so its
    // Power card carries the same restored rows — the modal is covered, not
    // just the plans page.
    await page.evaluate(() => window.openPricingModal());
    const modalPower = page.locator("#pricing-modal .pm-card-power .pm-features");
    await expect(modalPower).toContainText("All models + early access");
    await expect(modalPower).toContainText("API & MCP access (contact us)");
    await expect(modalPower).toContainText("BYOK");
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
