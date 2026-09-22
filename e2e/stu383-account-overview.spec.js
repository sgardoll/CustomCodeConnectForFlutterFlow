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

/**
 * STU-383 — the account overview with real identity, usage and honest history
 * states.
 *
 * The account view is bound to the same metered/session/subscription state as
 * the topbar (renderAccountOverview reads the same fields renderUsageSurfaces
 * reads), so it reflects sign-in/out and a usage refresh without ever showing
 * another user's cached identity. Every number traces to a real field or a
 * documented derivation; a renewal/reset date is shown only from a real
 * periodEnd — never fabricated. With no persistent history, the overview
 * renders an honest, readable no-history state and keeps current results
 * reachable through the generation workspace.
 */
const LONG_EMAIL = "alexandra.von.der-long-lane@subdomain.ap-southeast-2.example";
const EMAIL = "metered@example.com";
const currentMonth = () => new Date().toISOString().slice(0, 7);

// initializeAuth refreshes the stored session against /auth/refresh-session and
// adopts whatever email that endpoint returns, so a signed-in scenario must
// point that endpoint back at the seeded identity or it is overwritten.
function sessionFor(email = EMAIL) {
  return {
    status: 200,
    body: JSON.stringify({ email, sessionToken: "session-token" }),
    contentType: "application/json",
  };
}

function refreshOverride(email = EMAIL) {
  return { [ENDPOINTS.authRefreshSession]: sessionFor(email) };
}

function identityWithUsage({ email, count, month = currentMonth(), status = "recognized" }) {
  return {
    status: 200,
    body: JSON.stringify({
      status,
      user_id: "acct-0001",
      identity_token: "identity-token",
      usage_count: count,
      usage_month: month,
    }),
    contentType: "application/json",
  };
}

function subscriptionWithPeriodEnd(periodEnd) {
  const f = professionalSubscription();
  const body = JSON.parse(f.body);
  body.data.periodEnd = periodEnd;
  body.data.subscription.periodEnd = periodEnd;
  return { ...f, body: JSON.stringify(body) };
}

async function seedSession(page, email = "metered@example.com") {
  await page.addInitScript(({ email }) => {
    localStorage.setItem(
      "ccc_auth_session",
      JSON.stringify({ email, sessionToken: "session-token" }),
    );
  }, { email });
}

async function openAccount(page) {
  await page.locator('a.nav-link[data-view="account"]').click();
  await expect(page.locator("#account-view")).toBeVisible();
}

test.describe("STU-383 account overview", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("hasSeenWalkthrough", "true");
    });
  });

  test("identity traces to the signed-in session (long email) with no fabricated member date", async ({ page }) => {
    await seedSession(page, LONG_EMAIL);
    await applyDefaultRoutes(page, {
      ...refreshOverride(LONG_EMAIL),
      [ENDPOINTS.identity]: identityWithUsage({ email: LONG_EMAIL, count: 12 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });
    await page.goto("/");
    await openAccount(page);

    // Local-part display name is a documented derivation of the real email.
    await expect(page.locator("#acct-name")).toHaveText(LONG_EMAIL.split("@")[0]);
    await expect(page.locator("#auth-user-email")).toHaveText(LONG_EMAIL);
    await expect(page.locator("#acct-avatar")).toHaveText(LONG_EMAIL[0].toUpperCase());
    // No fabricated member-since date is shown.
    await expect(page.locator("#acct-since")).toHaveText("Signed in by email magic link.");
    await expect(page.locator("#acct-since")).not.toContainText("member since");
  });

  test("no renewal date is invented when the subscription has none", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      ...refreshOverride(),
      [ENDPOINTS.identity]: identityWithUsage({ email: undefined, count: 12 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });
    await page.goto("/");
    await openAccount(page);

    // The professional fixture carries no periodEnd; the honest surface must
    // say so rather than print a made-up date.
    await expect(page.locator("#acct-renewal")).toHaveText(
      "Renewal date is not available for this period.",
    );
    const bodyText = await page.locator("#auth-signedin").innerText();
    expect(bodyText).not.toMatch(/Renews\s+\d{1,2}\s+\w+\s+\d{4}/);
  });

  test("a real periodEnd surfaces the renewal date", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      ...refreshOverride(),
      [ENDPOINTS.identity]: identityWithUsage({ email: undefined, count: 12 }),
      [ENDPOINTS.getSubscription]: () => subscriptionWithPeriodEnd("2026-11-01T00:00:00.000Z"),
    });
    await page.goto("/");
    await openAccount(page);

    await expect(page.locator("#acct-renewal")).toContainText("Renews");
    await expect(page.locator("#acct-renewal")).toContainText("2026");
  });

  test("usage meter and remaining runs trace to metered count and tier limit", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      ...refreshOverride(),
      [ENDPOINTS.identity]: identityWithUsage({ email: undefined, count: 31 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });
    await page.goto("/");
    await openAccount(page);

    await expect(page.locator("#acct-left-count")).toHaveText("19"); // 50 - 31
    await expect(page.locator("#acct-left-limit")).toHaveText("50");
    await expect(page.locator("#acct-used-count")).toHaveText("31");
    await expect(page.locator("#usage-counter")).toHaveText("31 / 50 runs this month");
    await expect(page.locator("#acct-meter-meta")).toHaveText("31 of 50 · 62%");
    await expect(page.locator("#acct-meter-track")).toHaveAttribute(
      "aria-label",
      "31 of 50 generations used",
    );
  });

  test("the no-history state is truthful and points to the generation workspace", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      ...refreshOverride(),
      [ENDPOINTS.identity]: identityWithUsage({ email: undefined, count: 3 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });
    await page.goto("/");
    await openAccount(page);

    await expect(page.locator("#acct-no-history")).toContainText("Saved history isn't available yet.");
    await expect(page.locator("#acct-no-history")).toContainText("generation workspace");
    // No illustrative breakdown/history rows are fabricated.
    const text = await page.locator("#acct-history").innerText();
    expect(text).not.toMatch(/Custom Widget 9|Committed/);

    // The empty state keeps current results reachable via the generation workspace.
    await page.locator("#acct-no-history a").click();
    await expect(page.locator("#home-view")).toBeVisible();
    await expect(page.locator("#home-view")).toHaveClass(/is-active/);
  });

  test("account reflects a usage refresh without stale private information", async ({ page }) => {
    await seedSession(page);
    let count = 5;
    await applyDefaultRoutes(page, {
      ...refreshOverride(LONG_EMAIL),
      [ENDPOINTS.identity]: () => identityWithUsage({ email: LONG_EMAIL, count }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });
    await page.goto("/");
    await openAccount(page);
    await expect(page.locator("#acct-used-count")).toHaveText("5");

    // Refresh the server-reconciled count; the account must move to the new
    // number for the same signed-in user, never a stale cached one.
    count = 9;
    await page.reload();
    await openAccount(page);
    await expect(page.locator("#acct-used-count")).toHaveText("9");
    await expect(page.locator("#auth-user-email")).toHaveText(LONG_EMAIL);
  });

  test("signing out clears the signed-in overview so no identity lingers", async ({ page }) => {
    await seedSession(page, LONG_EMAIL);
    await applyDefaultRoutes(page, {
      ...refreshOverride(LONG_EMAIL),
      [ENDPOINTS.identity]: identityWithUsage({ email: LONG_EMAIL, count: 1 }),
      [ENDPOINTS.getSubscription]: freeSubscription(),
    });
    await page.goto("/");
    await openAccount(page);
    await expect(page.locator("#auth-user-email")).toHaveText(LONG_EMAIL);

    await page.locator("#auth-signedin button", { hasText: "Sign out" }).first().click();
    await expect(page.locator("#auth-signedin")).toBeHidden();
    await expect(page.locator("#auth-signedout")).toBeVisible();
    await expect(page.locator("#auth-signedout")).toContainText("Sign in to track usage");
  });

  test("a guest sees the anonymous Free allowance, never a signed-in overview", async ({ page }) => {
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
    });
    await page.goto("/");
    await openAccount(page);

    await expect(page.locator("#auth-signedin")).toBeHidden();
    await expect(page.locator("#auth-signedout")).toBeVisible();
    await expect(page.locator("#guest-usage-text")).toHaveText("0 / 2 generations used");
  });

  test("an unresolved subscription shows checking then unavailable — no fake balance", async ({ page }) => {
    await seedSession(page);
    let release;
    const held = new Promise((r) => { release = r; });
    await applyDefaultRoutes(page, {
      ...refreshOverride(),
      [ENDPOINTS.identity]: identityWithUsage({ email: undefined, count: 12 }),
    });
    await page.route("**/stripe/get-subscription", async (route) => {
      await held;
      await route.fulfill(unresolvedSubscription());
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator('a.nav-link[data-view="account"]').click();
    await expect(page.locator("#acct-left-count")).toHaveText("…");
    await expect(page.locator("#acct-plan-tier")).toHaveText("Checking…");

    release();
    await expect(page.locator("#acct-plan-tier")).toHaveText("Plan unavailable");
    await expect(page.locator("#acct-left-count")).toHaveText("—");
    await expect(page.locator("#acct-used-count")).toHaveText("—");
    await expect(page.locator("#acct-meter-meta")).toHaveText("Plan check failed");
    const balance = await page.locator("#usage-counter").textContent();
    expect(balance).not.toMatch(/\d+\s*\/\s*\d+\s*runs this month/);
  });

  test("connection card reflects real stored FlutterFlow credentials", async ({ page }) => {
    await seedSession(page);
    await page.addInitScript(() => {});
    await applyDefaultRoutes(page, {
      ...refreshOverride(),
      [ENDPOINTS.identity]: identityWithUsage({ email: undefined, count: 1 }),
      [ENDPOINTS.getSubscription]: freeSubscription(),
    });
    await page.goto("/");
    await openAccount(page);

    // No stored credentials on a fresh browser: the card reads as honest, real state.
    await expect(page.locator("#acct-ff-status")).toHaveText(
      "Not connected — add your FlutterFlow API key",
    );
  });

  test("screenshots for desktop and mobile reference comparisons", async ({ page }) => {
    // Captures the surfaces the criteria name — long email, zero/max usage and
    // an unresolved subscription — at 1440x900 and 360x800 for reference diffing.
    const scenarios = [
      {
        name: "professional-31-50-long-email",
        email: LONG_EMAIL,
        count: 31,
        sub: () => professionalSubscription(),
      },
      { name: "free-zero-usage", email: "zero@example.com", count: 0, sub: () => freeSubscription() },
      { name: "power-max-usage", email: "max@example.com", count: 50, sub: () => professionalSubscription() },
    ];
    const fs = await import("node:fs");
    const outDir = "screenshots/stu-383";
    fs.mkdirSync(outDir, { recursive: true });

    for (const viewport of [
      { name: "desktop", width: 1440, height: 900 },
      { name: "mobile", width: 360, height: 800 },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const s of scenarios) {
        await seedSession(page, s.email);
        await applyDefaultRoutes(page, {
          ...refreshOverride(s.email),
          [ENDPOINTS.identity]: () => identityWithUsage({ email: s.email, count: s.count }),
          [ENDPOINTS.getSubscription]: s.sub,
        });
        await page.goto("/");
        await openAccount(page);
        await page.screenshot({ path: `${outDir}/account-${s.name}-${viewport.name}.png`, fullPage: true });
      }
      // Unresolved subscription reference.
      await seedSession(page, "unresolved@example.com");
      await applyDefaultRoutes(page, {
        ...refreshOverride("unresolved@example.com"),
        [ENDPOINTS.identity]: () => identityWithUsage({ email: undefined, count: 3 }),
      });
      await page.route("**/stripe/get-subscription", (route) =>
        route.fulfill(unresolvedSubscription()),
      );
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await openAccount(page);
      await expect(page.locator("#acct-plan-tier")).toHaveText("Plan unavailable");
      await page.screenshot({ path: `${outDir}/account-unresolved-${viewport.name}.png`, fullPage: true });
    }
  });
});
