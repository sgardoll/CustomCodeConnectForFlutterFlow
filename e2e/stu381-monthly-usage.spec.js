import { test, expect } from "@playwright/test";
import {
  applyDefaultRoutes,
  guestIdentity,
  freeSubscription,
  professionalSubscription,
  powerSubscription,
  unresolvedSubscription,
  portalSession,
  oneArtifact,
  ENDPOINTS,
} from "./fixtures/apiFixtures.js";

/**
 * STU-381 — monthly usage metering bound to the topbar allowance and the
 * usage/billing dialog.
 *
 * The topbar shows the number of runs remaining this month (clamped to zero);
 * the dialog shows the used/limit text (e.g. "31 / 50 runs this month") plus
 * the resolved plan. An unresolved plan shows checking/error copy, never a
 * fake balance. Every usage surface is written by the same presentation
 * adapter, so a metered run, a subscription refresh and a month rollover all
 * converge on the same numbers.
 */
const currentMonth = () => new Date().toISOString().slice(0, 7);

function identityWithUsage({ count, month = currentMonth(), status = "recognized" }) {
  return {
    status: 200,
    body: JSON.stringify({
      status,
      user_id: "metered-0001",
      identity_token: "identity-token",
      usage_count: count,
      usage_month: month,
    }),
    contentType: "application/json",
  };
}

async function seedSession(page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "ccc_auth_session",
      JSON.stringify({ email: "metered@example.com", sessionToken: "session-token" }),
    );
  });
}

/**
 * A real pipeline endpoint response (valid artifact output) whose generator
 * step answers with a server-reconciled usage count, so a completed run drives
 * the post-run metering path instead of being observed through a reload.
 */
function pipelineReconciledTo(count) {
  const fixture = oneArtifact();
  const body = JSON.parse(fixture.body);
  body.usage_count = count;
  body.usage_month = currentMonth();
  return { ...fixture, body: JSON.stringify(body) };
}

async function openUsage(page) {
  await page.locator("#topbar-credits").click();
  await expect(page.locator("#usage-dialog-tier")).toBeVisible();
}

test.describe("STU-381 monthly usage metering", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("hasSeenWalkthrough", "true");
    });
  });

  for (const scenario of [
    { name: "Free", fixture: freeSubscription, count: 1, limit: 2, remaining: "1", plan: "Free" },
    { name: "Professional", fixture: professionalSubscription, count: 31, limit: 50, remaining: "19", plan: "Pro" },
    { name: "Power", fixture: powerSubscription, count: 1250, limit: 2000, remaining: "750", plan: "Power" },
  ]) {
    test(`${scenario.name} shows remaining in the topbar and used/limit in the dialog`, async ({ page }) => {
      await seedSession(page);
      await applyDefaultRoutes(page, {
        [ENDPOINTS.identity]: identityWithUsage({ count: scenario.count }),
        [ENDPOINTS.getSubscription]: scenario.fixture(),
      });
      await page.goto("/");

      await expect(page.locator("#topbar-credits-count")).toHaveText(scenario.remaining);
      await openUsage(page);
      await expect(page.locator("#usage-dialog-tier")).toHaveText(scenario.plan);
      await expect(page.locator("#credits-balance")).toHaveText(
        `${scenario.count} / ${scenario.limit} runs this month`,
      );
    });
  }

  test("remaining clamps to zero at zero remaining and for an over-limit server count", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: identityWithUsage({ count: 57 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });
    await page.goto("/");

    // Over-limit: server says 57 of 50 used; remaining must not go negative.
    await expect(page.locator("#topbar-credits-count")).toHaveText("0");
    await openUsage(page);
    await expect(page.locator("#credits-balance")).toHaveText("57 / 50 runs this month");
  });

  test("remaining is zero when the full allowance is used", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: identityWithUsage({ count: 50 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });
    await page.goto("/");
    await expect(page.locator("#topbar-credits-count")).toHaveText("0");
    await openUsage(page);
    await expect(page.locator("#credits-balance")).toHaveText("50 / 50 runs this month");
  });

  test("a stale server month rolls over to a fresh allowance", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: identityWithUsage({ count: 49, month: "2000-01" }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });
    await page.goto("/");

    // Previous month's usage must not count against the current period.
    await expect(page.locator("#topbar-credits-count")).toHaveText("50");
    await openUsage(page);
    await expect(page.locator("#credits-balance")).toHaveText("0 / 50 runs this month");
  });

  test("a signed-out guest sees the anonymous Free allowance, not a fake balance", async ({ page }) => {
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: identityWithUsage({ count: 1, status: "guest" }),
    });
    await page.goto("/");

    await expect(page.locator("#topbar-credits-count")).toHaveText("1");
    await expect(page.locator("#guest-usage-text")).toHaveText("1 / 2 generations used");
    await openUsage(page);
    await expect(page.locator("#credits-balance")).toHaveText("1 / 2 runs this month");
  });

  test("checking and failed plans never expose a fake balance", async ({ page }) => {
    await seedSession(page);
    // Hold the subscription request so we can observe the transient checking
    // state, then fail it. applyDefaultRoutes does not await async fixtures, so
    // the held response is registered as its own route (later routes win).
    let releaseSubscription;
    const held = new Promise((resolve) => {
      releaseSubscription = resolve;
    });
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: identityWithUsage({ count: 1 }),
    });
    await page.route("**/stripe/get-subscription", async (route) => {
      await held;
      await route.fulfill(unresolvedSubscription());
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    // While the plan is unresolved the UI must show a checking state, not a number.
    await expect(page.locator("#topbar-credits-count")).toHaveText("…");
    await openUsage(page);
    await expect(page.locator("#credits-balance")).toHaveText("Checking plan…");
    await expect(page.locator("#usage-dialog-tier")).toHaveText("Checking…");
    await expect(page.locator("#topbar-credits-count")).not.toHaveText(/\d/);

    // The server returns a hard failure: error copy, still no fake balance.
    releaseSubscription();
    await expect(page.locator("#credits-balance")).toHaveText("Plan check failed");
    await expect(page.locator("#topbar-credits-count")).toHaveText("—");
    await expect(page.locator("#usage-dialog-tier")).toHaveText("Unavailable");

    const balance = await page.locator("#credits-balance").textContent();
    expect(balance).not.toMatch(/\d+\s*\/\s*\d+\s*runs this month/);
  });

  test("a server-reconciled metered count updates every usage surface in one pass", async ({ page }) => {
    // The post-run metering path (callBuildShip's generator reconciliation) and
    // the identity refresh both flow through updateUsageDisplay -> the same
    // presentation adapter. This test drives a real reconcile + refresh cycle
    // and asserts the topbar, the dialog and the account row move together off
    // one metered source.
    await seedSession(page);
    let count = 4;
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: () => identityWithUsage({ count }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });
    await page.goto("/");
    await expect(page.locator("#topbar-credits-count")).toHaveText("46");

    count = 7;
    await page.reload();
    await expect(page.locator("#topbar-credits-count")).toHaveText("43");

    // Account row reflects the reconciled count without ever opening a dialog.
    await page.locator('a.nav-link[data-view="account"]').click();
    await expect(page.locator("#usage-counter")).toHaveText("7 / 50 runs this month");

    await openUsage(page);
    await expect(page.locator("#credits-balance")).toHaveText("7 / 50 runs this month");
    await expect(page.locator("#usage-dialog-tier")).toHaveText("Pro");
  });

  test("a metered run reconciles the count onto every usage surface as a consequence of the run", async ({ page }) => {
    // The sibling test above observes the reconciled count by reloading, which
    // re-runs resolveIdentity/fetchSubscription. This test instead drives the
    // post-run path directly: it performs a real generation run through the
    // composer (#pipeline-input -> #hero-send, with the pipeline endpoint
    // fixtured) and asserts every usage surface moves because the run's
    // generator response reconciled the count — never because of a reload.
    await seedSession(page);
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: identityWithUsage({ count: 4 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
      [ENDPOINTS.pipeline]: () => pipelineReconciledTo(7),
    });
    await page.goto("/");
    await expect(page.locator("#topbar-credits-count")).toHaveText("46");

    // Drive a real run; no reload is involved at any point after this.
    await page.fill("#pipeline-input", "A circular progress gauge with a gradient stroke.");
    await page.click("#hero-send");

    // The run's generator response reconciles the count from 4 -> 7, so the
    // topbar moves from 46 remaining to 43 without a page.reload().
    await expect(page.locator("#topbar-credits-count")).toHaveText("43");
    await expect(page.locator("#topbar-credits").getByText("43")).toBeVisible();

    // The account row and the dialog converge on the same reconciled count.
    await page.locator('a.nav-link[data-view="account"]').click();
    await expect(page.locator("#usage-counter")).toHaveText("7 / 50 runs this month");

    await openUsage(page);
    await expect(page.locator("#credits-balance")).toHaveText("7 / 50 runs this month");
    await expect(page.locator("#usage-dialog-tier")).toHaveText("Pro");
  });

  test("Manage Subscription issues exactly one fresh portal request and uses its URL", async ({ page }) => {
    await seedSession(page);
    let calls = 0;
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: identityWithUsage({ count: 3 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
      [ENDPOINTS.createPortal]: () => {
        calls += 1;
        return portalSession();
      },
    });
    // Let the app navigate to the returned portal URL instead of aborting it.
    await page.route("https://billing.stripe.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );

    await page.goto("/");
    await openUsage(page);
    await page.locator("#credits-manage-btn").click();

    await page.waitForURL("https://billing.stripe.com/mock-portal");
    expect(calls).toBe(1);
  });

  test("Manage Subscription recovers visibly when the portal request fails", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: identityWithUsage({ count: 3 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
      [ENDPOINTS.createPortal]: () => ({
        status: 500,
        body: JSON.stringify({ error: "portal unavailable" }),
        contentType: "application/json",
      }),
    });
    await page.goto("/");
    await openUsage(page);

    const btn = page.locator("#credits-manage-btn");
    await btn.click();
    await expect(btn).toBeEnabled();
    await expect(btn).toHaveText("Manage Subscription");
    // A visible recovery toast explains the failure.
    await expect(page.locator("body")).toContainText("Could not open billing portal");
  });

  test("a signed-out guest's Manage Subscription follows the sign-in path", async ({ page }) => {
    let calls = 0;
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.createPortal]: () => {
        calls += 1;
        return portalSession();
      },
    });
    await page.goto("/");
    await openUsage(page);
    await page.locator("#credits-manage-btn").click();

    await expect(page.locator("#signin-modal")).toHaveClass(/open/);
    expect(calls).toBe(0);
  });

  test("the usage dialog carries no wallet, top-up, balance or unlimited claims", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: identityWithUsage({ count: 3 }),
      [ENDPOINTS.getSubscription]: powerSubscription(),
    });
    await page.goto("/");
    await openUsage(page);

    const dialogText = (await page.locator("#credits-modal").innerText()).toLowerCase();
    for (const banned of ["wallet", "top-up", "top up", "topup", "balance", "unlimited"]) {
      expect(dialogText).not.toContain(banned);
    }
    await expect(page.locator("#topbar-credits")).toHaveAttribute(
      "aria-label",
      "Runs remaining this month",
    );
  });
});
