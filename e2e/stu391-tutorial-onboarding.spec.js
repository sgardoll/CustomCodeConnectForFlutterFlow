import { test, expect } from "@playwright/test";
import {
  applyDefaultRoutes,
  guestIdentity,
  signedInSession,
  freeSubscription,
  err,
  sampleProjectList,
  ENDPOINTS,
} from "./fixtures/apiFixtures.js";

/**
 * STU-391 — tutorials and connection onboarding in the new visual system.
 *
 * The welcome/tutorial modal is the onboarding surface. A fresh user sees it
 * once; dismiss is remembered through the existing hasSeenWalkthrough flag and
 * a Tutorial nav entry reopens it. The walkthrough's "connect account" step
 * routes to the REAL API-key editor (STU-384): on success the walkthrough
 * returns to its next step and then to the composer, and on failure it returns
 * to the SAME step instead of advancing. Closing settings opened OUTSIDE
 * onboarding must never launch or advance the walkthrough. The tutorial video
 * is keyboard-capable (native controls), responsive and never autoplays.
 */
const KEY = "ff-secret-token-abc123";
const PROJ = "proj-abc-123";

function signedInContext(email = "metered@example.com") {
  return {
    [ENDPOINTS.identity]: {
      status: 200,
      body: JSON.stringify({
        status: "recognized",
        user_id: "acct-0001",
        identity_token: "identity-token",
        usage_count: 2,
        usage_month: new Date().toISOString().slice(0, 7),
      }),
      contentType: "application/json",
    },
    [ENDPOINTS.authRefreshSession]: {
      status: 200,
      body: JSON.stringify({ email, sessionToken: "session-token" }),
      contentType: "application/json",
    },
    [ENDPOINTS.getSubscription]: freeSubscription(),
  };
}

const WALKTHROUGH = "#walkthrough-modal";

test.describe("STU-391 tutorial + connection onboarding", () => {
  test("fresh user sees the tutorial once with a keyboard-capable, non-autoplaying video", async ({ page }) => {
    await applyDefaultRoutes(page, { identity: guestIdentity() });
    await page.goto("/");

    await expect(page.locator(WALKTHROUGH)).toBeVisible();
    await expect(page.locator("#walkthrough-step1")).toHaveClass(/wt-current/);
    await expect(page.locator("#walkthrough-step1")).toContainText(
      "Connect your FlutterFlow account",
    );

    const video = page.locator("#wt-tutorial-video");
    await expect(video).toHaveAttribute("controls", "");
    // The video must not autoplay unexpectedly.
    expect(await video.evaluate((el) => el.hasAttribute("autoplay"))).toBe(false);
    expect(await video.evaluate((el) => el.paused)).toBe(true);
    // preload is conservative (metadata), not autoplay/buffering-first.
    await expect(video).toHaveAttribute("preload", "metadata");
    // Native controls keep it keyboard reachable and tab-sequence capable.
    expect(await video.evaluate((el) => el.tabIndex >= 0)).toBe(true);
  });

  test("reduced-motion still renders the onboarding usable", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await applyDefaultRoutes(page, { identity: guestIdentity() });
    await page.goto("/");

    await expect(page.locator(WALKTHROUGH)).toBeVisible();
    await expect(page.locator("#walkthrough-step1")).toBeVisible();
    // The primary action remains clickable under reduced motion.
    await page.click("#walkthrough-step1 .wt-step-link");
    await expect(page.locator("#api-keys-modal")).toBeVisible();
  });

  test("dismissing onboarding is remembered for the returning user", async ({ page }) => {
    await applyDefaultRoutes(page, { identity: guestIdentity() });
    await page.goto("/");
    await expect(page.locator(WALKTHROUGH)).toBeVisible();

    await page.check("#walkthrough-dont-show");
    await page.click(".wt-gotit-btn");
    await expect(page.locator(WALKTHROUGH)).toBeHidden();

    expect(
      await page.evaluate(() => localStorage.getItem("hasSeenWalkthrough")),
    ).toBe("true");

    // Returning-user load does not re-show it.
    await page.reload();
    await expect(page.locator(WALKTHROUGH)).toBeHidden();
  });

  test("a returning user reopens the tutorial from the Tutorial entry", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("hasSeenWalkthrough", "true");
    });
    await applyDefaultRoutes(page, { identity: guestIdentity() });
    await page.goto("/");
    await expect(page.locator(WALKTHROUGH)).toBeHidden();

    await page.click("#wt-reopen");
    await expect(page.locator(WALKTHROUGH)).toBeVisible();
    await expect(page.locator("#walkthrough-step1")).toHaveClass(/wt-current/);
  });

  test("connecting from onboarding routes to the real editor and, on success, returns to the next step then the composer", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("hasSeenWalkthrough", "true");
    });
    await applyDefaultRoutes(page, signedInContext());
    await page.goto("/");
    await page.click("#wt-reopen");
    await expect(page.locator(WALKTHROUGH)).toBeVisible();

    // Connect step opens the REAL account editor, not a fake flow.
    await page.click("#walkthrough-step1 .wt-step-link");
    await expect(page.locator("#api-keys-modal")).toBeVisible();
    await expect(page.locator(WALKTHROUGH)).toBeHidden();

    const input = page.locator("#flutterflow-api-key-input");
    await input.fill(KEY);
    await input.blur();
    await expect(
      page.locator(`#flutterflow-projects-select option[value="${PROJ}"]`),
    ).toHaveCount(1);
    await page.locator("#flutterflow-projects-select").selectOption(PROJ);
    await page.locator("#api-keys-modal .bg-blue-500").click();
    await expect(page.locator("#api-keys-modal")).toBeHidden();

    // saveApiKeys closes the editor inside a 1s timeout, then returns to the
    // walkthrough at the next step. Poll for the walkthrough rather than
    // sleeping on a fixed window so the assertion is immune to CI load.
    await expect(page.locator(WALKTHROUGH)).toBeVisible({ timeout: 8000 });
    await expect(page.locator("#walkthrough-step2")).toHaveClass(/wt-current/);

    // "Add Prompt" returns to the composer.
    await page.click("#walkthrough-step2 .wt-step-link");
    await expect(page.locator(WALKTHROUGH)).toBeHidden();
    await expect(page.locator("#pipeline-input")).toBeFocused();
    // Advancing only happens when a FlutterFlow key is stored, which is the
    // behavioural proof that connecting wrote through the real editor.
  });

  test("a failed or cancelled connection returns to the same onboarding step, not forward", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("hasSeenWalkthrough", "true");
    });
    await applyDefaultRoutes(page, {
      ...signedInContext(),
      // Listed projects fail: the real editor rejects the key.
      [ENDPOINTS.flutterFlowListProjects]: err(401, { error: "unauthorized" }),
      [ENDPOINTS.flutterFlowLegacyListProjects]: err(401, { error: "unauthorized" }),
    });
    await page.goto("/");
    await page.click("#wt-reopen");
    await expect(page.locator(WALKTHROUGH)).toBeVisible();
    await expect(page.locator("#walkthrough-step1")).toHaveClass(/wt-current/);

    await page.click("#walkthrough-step1 .wt-step-link");
    await expect(page.locator("#api-keys-modal")).toBeVisible();

    // Close the editor without having stored a key (failure / cancel path).
    await page.evaluate(() => window.closeApiKeysModal());
    await expect(page.locator("#api-keys-modal")).toBeHidden();

    // Returned to the SAME step — no advance past an unconnected account.
    await expect(page.locator(WALKTHROUGH)).toBeVisible();
    await expect(page.locator("#walkthrough-step1")).toHaveClass(/wt-current/);
  });

  test("closing settings opened outside onboarding does not launch or advance the walkthrough", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("hasSeenWalkthrough", "true");
      localStorage.setItem(
        "ccc_auth_session",
        JSON.stringify({ email: "metered@example.com", sessionToken: "session-token" }),
      );
    });
    await applyDefaultRoutes(page, signedInContext());
    await page.goto("/");
    await expect(page.locator(WALKTHROUGH)).toBeHidden();

    // Open the settings editor from the account connection card — NOT onboarding.
    await page.locator('a.nav-link[data-view="account"]').click();
    await expect(page.locator("#account-view")).toBeVisible();
    await page
      .locator(".acct-connection button", { hasText: "Configure" })
      .first()
      .scrollIntoViewIfNeeded();
    await page
      .locator(".acct-connection button", { hasText: "Configure" })
      .first()
      .click();
    await expect(page.locator("#api-keys-modal")).toBeVisible();

    // Closing it must not launch the walkthrough at all.
    await page.evaluate(() => window.closeApiKeysModal());
    await expect(page.locator("#api-keys-modal")).toBeHidden();
    await expect(page.locator(WALKTHROUGH)).toBeHidden();

    // Nor later (the old buggy path reopened it after the save window).
    await page.waitForTimeout(1200);
    await expect(page.locator(WALKTHROUGH)).toBeHidden();
  });
});
