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

// The walkthrough modal animates in (overlay fade ~0.25s, content scale-in
// ~0.3s via `.modal-content` transform). `toBeVisible` and `.open`/`aria-hidden`
// all pass the instant the transition starts, so a following interaction would
// race the open animation — during that window the modal is not yet fully on
// top and e.g. `#main-stage` can still intercept the pointer. Wait state-based
// for the animation to genuinely settle (computed transform back to scale(1)
// and overlay fully opaque) so a subsequent click cannot land mid-open. This is
// a state condition tied to the animation, not a wall-clock sleep.
async function waitForWalkthroughOpen(page) {
  await page.waitForFunction(
    () => {
      const overlay = document.getElementById("walkthrough-modal");
      if (!overlay || !overlay.classList.contains("open")) return false;
      if (overlay.getAttribute("aria-hidden") !== "false") return false;
      const content = overlay.querySelector(".modal-content");
      if (!content) return false;
      const transform = getComputedStyle(content).transform;
      const settled =
        !transform || transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)";
      return settled && getComputedStyle(overlay).opacity === "1";
    },
    { timeout: 8000 },
  );
  await expect(page.locator(WALKTHROUGH)).toBeVisible();
}

// A walkthrough interaction follows either the initial auto-open or a reopen
// (e.g. returning from the API-key editor). Assert the target itself is visible
// AND the modal has finished opening before clicking, then let Playwright's own
// actionability confirm the click lands on the element — so the click cannot
// race the open animation.
async function clickInsideWalkthrough(page, selector) {
  await waitForWalkthroughOpen(page);
  const target = page.locator(selector);
  await expect(target).toBeVisible();
  await target.click();
}

// Reopen the tutorial from the nav. On a cold start the deferred app.js module
// may not have wired openWalkthroughModal yet, so a click can land while the
// handler is undefined and silently navigate to #tutorial instead of opening
// the modal — wait for the wire-up (state) before clicking, then wait for the
// open animation to finish.
async function reopenWalkthrough(page) {
  await page.waitForFunction(
    () => typeof window.openWalkthroughModal === "function",
    { timeout: 8000 },
  );
  await page.click("#wt-reopen");
  await waitForWalkthroughOpen(page);
}

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
    // Prove real keyboard reach: Tab forward from the modal chrome and confirm
    // the video itself receives focus. The native `controls` attribute is what
    // makes it tabbable/operable — this exercises the actual Tab sequence
    // rather than the near-vacuous tabIndex >= 0 check.
    await page.locator("#walkthrough-modal .modal-close").focus();
    await expect(page.locator("#walkthrough-modal .modal-close")).toBeFocused();
    let reachedVideo = false;
    for (let i = 0; i < 8 && !reachedVideo; i++) {
      await page.keyboard.press("Tab");
      reachedVideo = await video.evaluate((el) => document.activeElement === el);
    }
    expect(reachedVideo).toBe(true);
  });

  test("reduced-motion still renders the onboarding usable", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await applyDefaultRoutes(page, { identity: guestIdentity() });
    await page.goto("/");

    await expect(page.locator(WALKTHROUGH)).toBeVisible();
    await expect(page.locator("#walkthrough-step1")).toBeVisible();
    // The primary action remains clickable under reduced motion.
    await clickInsideWalkthrough(page, "#walkthrough-step1 .wt-step-link");
    await expect(page.locator("#api-keys-modal")).toBeVisible();
  });

  test("dismissing onboarding is remembered for the returning user", async ({ page }) => {
    await applyDefaultRoutes(page, { identity: guestIdentity() });
    await page.goto("/");
    await expect(page.locator(WALKTHROUGH)).toBeVisible();

    await page.check("#walkthrough-dont-show");
    await clickInsideWalkthrough(page, ".wt-gotit-btn");
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

    await reopenWalkthrough(page);
    await expect(page.locator("#walkthrough-step1")).toHaveClass(/wt-current/);
  });

  test("connecting from onboarding routes to the real editor and, on success, returns to the next step then the composer", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("hasSeenWalkthrough", "true");
    });
    await applyDefaultRoutes(page, signedInContext());
    await page.goto("/");
    await reopenWalkthrough(page);

    // Connect step opens the REAL account editor, not a fake flow.
    await clickInsideWalkthrough(page, "#walkthrough-step1 .wt-step-link");
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
    // sleeping on a fixed window so the assertion is immune to CI load, then
    // let the robust click wait for the reopen animation to settle.
    await expect(page.locator(WALKTHROUGH)).toBeVisible({ timeout: 8000 });
    await expect(page.locator("#walkthrough-step2")).toHaveClass(/wt-current/);

    // "Add Prompt" returns to the composer.
    await clickInsideWalkthrough(page, "#walkthrough-step2 .wt-step-link");
    await expect(page.locator(WALKTHROUGH)).toBeHidden();
    await expect(page.locator("#pipeline-input")).toBeFocused();
    // Advancing only happens when the connection genuinely succeeded, which is
    // the behavioural proof that connecting wrote through the real editor and
    // its projects fetch returned a real project.
  });

  test("a cancelled connection (no key entered) returns to the same onboarding step, not forward", async ({ page }) => {
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
    await reopenWalkthrough(page);
    await expect(page.locator("#walkthrough-step1")).toHaveClass(/wt-current/);

    await clickInsideWalkthrough(page, "#walkthrough-step1 .wt-step-link");
    await expect(page.locator("#api-keys-modal")).toBeVisible();

    // Cancel path: close the editor without having typed/stored a key.
    await page.evaluate(() => window.closeApiKeysModal());
    await expect(page.locator("#api-keys-modal")).toBeHidden();

    // Returned to the SAME step — no advance past an unconnected account.
    await expect(page.locator(WALKTHROUGH)).toBeVisible();
    await expect(page.locator("#walkthrough-step1")).toHaveClass(/wt-current/);
    await expect(page.locator("#walkthrough-step2")).not.toHaveClass(/wt-current/);
  });

  test("a rejected key entered on onboarding returns to the same step with the failure surfaced", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("hasSeenWalkthrough", "true");
    });
    await applyDefaultRoutes(page, {
      ...signedInContext(),
      // The key the user types is genuinely rejected by the real endpoint.
      [ENDPOINTS.flutterFlowListProjects]: err(401, { error: "unauthorized" }),
      [ENDPOINTS.flutterFlowLegacyListProjects]: err(401, { error: "unauthorized" }),
    });
    await page.goto("/");
    await reopenWalkthrough(page);
    await expect(page.locator("#walkthrough-step1")).toHaveClass(/wt-current/);

    await clickInsideWalkthrough(page, "#walkthrough-step1 .wt-step-link");
    await expect(page.locator("#api-keys-modal")).toBeVisible();

    // Type a key and blur so the real (routed-401) endpoint evaluates it, then
    // Save & Close. This is the REAL failure path: bytes get stored, but the
    // connection is rejected.
    await page.locator("#flutterflow-api-key-input").fill(KEY);
    await page.locator("#flutterflow-api-key-input").blur();
    await expect(page.locator("#flutterflow-projects-error")).toBeVisible();
    await page.locator("#api-keys-modal .bg-blue-500").click();

    // saveApiKeys stored bytes, but the connection genuinely failed, so the
    // walkthrough must return to the SAME step — never advance on a rejected
    // key.
    await expect(page.locator("#api-keys-modal")).toBeHidden();
    await expect(page.locator(WALKTHROUGH)).toBeVisible();
    await expect(page.locator("#walkthrough-step1")).toHaveClass(/wt-current/);
    await expect(page.locator("#walkthrough-step2")).not.toHaveClass(/wt-current/);

    // The failure is surfaced truthfully on the account connection card, which
    // STU-384 renders from the real fetch outcome, not from stored bytes.
    await clickInsideWalkthrough(page, ".wt-gotit-btn");
    await expect(page.locator(WALKTHROUGH)).toBeHidden();
    await page.locator('a.nav-link[data-view="account"]').click();
    await expect(page.locator("#account-view")).toBeVisible();
    await expect(page.locator("#acct-ff-status")).toContainText("API key rejected");
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

    // Nor later (the old buggy path reopened it after the save window). Poll
    // the negative over the window instead of a single fixed sleep, so a
    // delayed reopen is caught mid-window rather than slipping past a one-shot
    // wall-clock gap.
    const settleDeadline = Date.now() + 1500;
    while (Date.now() < settleDeadline) {
      await expect(page.locator(WALKTHROUGH)).toBeHidden();
      await page.waitForTimeout(100);
    }
  });
});
