import { test, expect } from "@playwright/test";
import { applyDefaultRoutes, guestIdentity } from "./fixtures/apiFixtures.js";

/**
 * Gate fixes for the PR #100 findings on the shared modal shell
 * (src/sharedControls.js):
 *
 * F1 — a repeated open of the already active modal must preserve the page's
 *      pre-modal overflow and background-inert state. The walkthrough's blur
 *      and delayed Tab handlers re-open that same modal, so an open while it
 *      is already active used to save "hidden" as the previous overflow and
 *      overwrite the saved background state — closing then left the page
 *      unable to scroll with an inert, aria-hidden background.
 *
 * F2 — opening a replacement dialog while another is open must never leave the
 *      replacement's close restoring focus into the dialog it hid. openModal
 *      used to capture the return target after closing the previous dialog, so
 *      a replacement opened from a control inside the previous dialog saved
 *      that hidden control as its return target.
 *
 * Both tests fail on the pre-fix shell (base head 6dd8edb) and pass after.
 */

const WALKTHROUGH = "#walkthrough-modal";
const API_KEYS = "#api-keys-modal";
const TRIGGER = "#gate-test-trigger";

async function waitForApp(page) {
  await page.waitForFunction(
    () =>
      typeof window.openWalkthroughModal === "function" &&
      typeof window.openApiKeysModal === "function",
  );
}

test.describe("shared modal shell gate behaviour", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("hasSeenWalkthrough", "true"));
    await applyDefaultRoutes(page, { identity: guestIdentity() });
  });

  test("a repeated open of the active modal keeps the page scroll lock and background state intact", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForApp(page);

    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");

    // Open through the app path, then re-open the SAME modal — exactly what the
    // walkthrough's blur and delayed Tab handlers do while the tour is already up.
    await page.evaluate(() => window.openWalkthroughModal());
    await expect(page.locator(WALKTHROUGH)).toHaveClass(/open/);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");

    await page.evaluate(() => window.openWalkthroughModal());
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");

    await page.evaluate(() => window.closeWalkthroughModal());
    await expect(page.locator(WALKTHROUGH)).not.toHaveClass(/open/);

    // The close restores the value saved before the FIRST open, not "hidden".
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");

    // The background is interactive again: not inert and not aria-hidden.
    const background = await page.evaluate(() => {
      const header = document.querySelector("header.topbar");
      return { inert: header.inert, ariaHidden: header.getAttribute("aria-hidden") };
    });
    expect(background.inert).toBe(false);
    expect(background.ariaHidden).toBeNull();
  });

  test("a replacement dialog never returns focus into the dialog it hid", async ({ page }) => {
    await page.goto("/");
    await waitForApp(page);

    // A real trigger outside the dialog, focused before the first open, becomes
    // the walkthrough's return target.
    await page.evaluate(() => {
      document.getElementById("gate-test-trigger")?.remove();
      const trigger = document.createElement("button");
      trigger.id = "gate-test-trigger";
      trigger.textContent = "Open tour";
      document.body.append(trigger);
      trigger.focus();
      window.openWalkthroughModal();
    });
    await expect(page.locator(WALKTHROUGH)).toHaveClass(/open/);
    await page.waitForFunction(
      (id) => document.getElementById(id)?.contains(document.activeElement),
      "walkthrough-modal",
      { timeout: 3000 },
    );

    // Replace the tour while focus lives inside it. The shared editor opens
    // without pre-closing the tour (openApiKeysModal is the standalone path),
    // so this exercises the replacement branch of openModal.
    await page.evaluate(() => window.openApiKeysModal());
    await expect(page.locator(API_KEYS)).toHaveClass(/open/);
    await expect(page.locator(WALKTHROUGH)).not.toHaveClass(/open/);

    await page.evaluate(() => window.closeApiKeysModal());
    await expect(page.locator(API_KEYS)).not.toHaveClass(/open/);

    // The replacement's close returns focus to what opened the tour — never to
    // a control inside the dialog it hid.
    const focused = await page.evaluate(() => ({
      id: document.activeElement?.id || "",
      insideWalkthrough: document
        .getElementById("walkthrough-modal")
        .contains(document.activeElement),
    }));
    expect(focused.insideWalkthrough).toBe(false);
    expect(focused.id).toBe("gate-test-trigger");
    await expect(page.locator(TRIGGER)).toBeFocused();
  });
});
