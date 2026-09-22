import { test, expect } from "@playwright/test";
import {
  applyDefaultRoutes,
  guestIdentity,
  freeSubscription,
  ENDPOINTS,
} from "./fixtures/apiFixtures.js";

/**
 * STU-394 regression: the redesigned shell replaced the legacy "Run Pipeline"
 * button with the hero send control, but runThinkingPipeline() still looked up
 * #btn-run-pipeline and dereferenced it without a guard. Every Generate click
 * threw before any network call, so generation was dead on the redesigned
 * shell while the unit suite, the smoke suite and CI all stayed green.
 *
 * Both tests below fail against that code and pass once the trigger is
 * restored. Every assertion depends on the run actually starting — none of
 * them is satisfied merely by the button staying quiet.
 *
 * The generation endpoint is intercepted; nothing real is charged or deployed.
 */

const PROMPT = "A circular progress gauge with a gradient stroke.";

/**
 * Watch the send control for its busy state. The flag survives the run
 * finishing faster than the assertions can observe, so it is a durable record
 * of whether runThinkingPipeline() got past its button lookup.
 */
async function observeSendBusy(page) {
  await page.evaluate(() => {
    window.__sendBusySeen = false;
    const send = document.getElementById("hero-send");
    new MutationObserver(() => {
      if (send.classList.contains("is-busy")) window.__sendBusySeen = true;
    }).observe(send, { attributes: true, attributeFilter: ["class"] });
  });
}

const sendBusySeen = (page) =>
  page.evaluate(() => window.__sendBusySeen === true);

test.describe("Generation trigger (STU-394)", () => {
  test.beforeEach(async ({ page }) => {
    // The first-visit walkthrough is real product behavior, but it would cover
    // the composer and steal focus from the send control.
    await page.addInitScript(() => {
      localStorage.setItem("hasSeenWalkthrough", "true");
    });
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
    });
    await page.goto("/");
  });

  test("clicking Generate starts a run instead of throwing", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await observeSendBusy(page);
    await page.fill("#pipeline-input", PROMPT);
    await page.click("#hero-send");

    // The run must genuinely have begun...
    await expect.poll(() => sendBusySeen(page)).toBe(true);

    // ...without an uncaught error, and without needing the element the
    // redesign deleted.
    expect(pageErrors).toEqual([]);
    expect(
      await page.evaluate(() => !!document.getElementById("btn-run-pipeline")),
    ).toBe(false);
  });

  test("the send control returns to idle once the run settles", async ({ page }) => {
    await observeSendBusy(page);
    await page.fill("#pipeline-input", PROMPT);
    await page.click("#hero-send");

    // It must actually go busy first — otherwise "ends up idle" is true of a
    // control that never did anything.
    await expect.poll(() => sendBusySeen(page)).toBe(true);

    // Then the fixtured run resolves and the control must come back to idle
    // rather than staying stuck disabled and spinning.
    const send = page.locator("#hero-send");
    await expect(send).not.toHaveClass(/is-busy/, { timeout: 30_000 });
    await expect(send).toBeEnabled();
  });
});
