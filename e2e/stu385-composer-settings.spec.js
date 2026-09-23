import { test, expect } from "@playwright/test";
import {
  applyDefaultRoutes,
  ENDPOINTS,
  freeSubscription,
  guestIdentity,
  oneArtifact,
  professionalSubscription,
  unresolvedSubscription,
} from "./fixtures/apiFixtures.js";

/**
 * STU-385 — generation options moved into the composer settings dialog.
 *
 * The composer's gear opens the generation-settings dialog, which presents the
 * existing model selector and supported generation options (image input). The
 * selection still reaches the actual generation request, provider-key
 * management is a shortcut into the canonical account connection editor, and
 * an ordinary close returns focus to the composer without ever reopening the
 * walkthrough.
 */

const GEAR = '.tools [aria-label="Generation settings"]';
const SETTINGS = "#composer-settings-modal";
// The dialog's model selector is a mirror of the canonical #code-generator-model
// that stays on the page; selections made here forward to it, so they reach the
// actual generation request unchanged.
const MODEL_SELECT = `${SETTINGS} #composer-settings-model`;
const FREE_NOTICE = `${SETTINGS} #composer-settings-free-notice`;
const PRO_MODEL = "openai/gpt-5.6-sol";
const NON_VISION_PRO_MODEL = "openrouter/deepseek/deepseek-v4-pro";

const currentMonth = () => new Date().toISOString().slice(0, 7);

function signedInIdentity({ count = 0 } = {}) {
  return {
    status: 200,
    body: JSON.stringify({
      status: "recognized",
      user_id: "stu385-0001",
      identity_token: "identity-token",
      usage_count: count,
      usage_month: currentMonth(),
    }),
    contentType: "application/json",
  };
}

function seedSession(page, email = "settings@example.com") {
  return page.addInitScript(
    ([sessionEmail]) => {
      localStorage.setItem(
        "ccc_auth_session",
        JSON.stringify({ email: sessionEmail, sessionToken: "session-token" }),
      );
    },
    [email]
  );
}

async function openSettings(page) {
  await page.click(GEAR);
  await expect(page.locator(SETTINGS)).toHaveClass(/open/);
}

async function closeSettings(page, { via = "escape" } = {}) {
  if (via === "escape") {
    await page.keyboard.press("Escape");
  } else {
    await page.click(`${SETTINGS} [data-modal-initial-focus]`);
  }
  await expect(page.locator(SETTINGS)).not.toHaveClass(/open/);
  await expect(page.locator(SETTINGS)).toHaveAttribute("aria-hidden", "true");
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("hasSeenWalkthrough", "true");
  });
});

test.describe("model availability by subscription tier", () => {
  test("free plan labels Pro models and offers a transparent upgrade", async ({ page }) => {
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
    });
    await page.goto("/");
    await openSettings(page);

    // Pro models are labelled and the upgrade action is visible inside the dialog.
    const proOption = page.locator(`${MODEL_SELECT} option[value="${PRO_MODEL}"]`);
    await expect(proOption).toContainText("(PRO)");
    await expect(page.locator(FREE_NOTICE)).toBeVisible();
    await expect(page.locator(FREE_NOTICE)).toContainText("Upgrade for all models");

    // Selecting a gated Pro model never silently grants it: it reverts to the
    // free model and surfaces the pricing action (the transparent upgrade).
    await page.locator(MODEL_SELECT).selectOption(PRO_MODEL);
    await expect(page.locator("#pricing-modal")).toHaveClass(/open/);
    await expect(page.locator(MODEL_SELECT)).toHaveValue(
      "google/gemini-3.7-flash",
    );
  });

  test("paid plan unlocks Pro models without a label or upgrade notice", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: signedInIdentity(),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });
    await page.goto("/");
    // Wait for the subscription to settle (canonical selector is re-labelled on
    // resolve) before opening the dialog so its mirror syncs the settled state.
    await expect(
      page.locator('#code-generator-model option[value="' + PRO_MODEL + '"]'),
    ).not.toContainText("(PRO)");
    await openSettings(page);

    const proOption = page.locator(`${MODEL_SELECT} option[value="${PRO_MODEL}"]`);
    await expect(proOption).toBeEnabled();
    await expect(proOption).not.toContainText("(PRO)");
    await expect(page.locator(FREE_NOTICE)).toBeHidden();
  });

  test("an unresolved plan never pretends to be a free-only tier", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: signedInIdentity(),
      [ENDPOINTS.getSubscription]: unresolvedSubscription(),
    });
    await page.goto("/");
    // Let the unresolved contract settle (never labelled a free-only tier).
    await expect(
      page.locator('#code-generator-model option[value="' + PRO_MODEL + '"]'),
    ).not.toContainText("(PRO)");
    await openSettings(page);

    // While the plan can't be resolved, the dialog must not claim a free-only
    // limitation: no (PRO) gate, no free-only upgrade notice.
    const proOption = page.locator(`${MODEL_SELECT} option[value="${PRO_MODEL}"]`);
    await expect(proOption).not.toContainText("(PRO)");
    await expect(page.locator(FREE_NOTICE)).toBeHidden();
  });
});

test.describe("the dialog stays wired to the generation request", () => {
  test("a model chosen in the dialog is what the generation request carries", async ({
    page,
  }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: signedInIdentity(),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });

    // Capture the generator-stage model that actually leaves the browser.
    const generatorModels = [];
    await page.route(ENDPOINTS.pipeline, async (route) => {
      const body = route.request().postDataJSON();
      if (body && body.step === "generator") generatorModels.push(body.model);
      await route.fulfill(oneArtifact());
    });

    await page.goto("/");
    await expect(
      page.locator('#code-generator-model option[value="' + PRO_MODEL + '"]'),
    ).not.toContainText("(PRO)"); // await pro entitlement settlement
    await openSettings(page);
    await page.locator(MODEL_SELECT).selectOption("anthropic/claude-opus-5");
    await closeSettings(page, { via: "done" });

    await page.locator("#hero-send").click();
    await expect(page.locator("#generation-stage")).toBeVisible({ timeout: 30000 });
    expect(generatorModels).toEqual(["anthropic/claude-opus-5"]);
  });

  test("switching models updates the image-capability generation option", async ({
    page,
  }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: signedInIdentity(),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });
    await page.goto("/");
    await expect(
      page.locator('#code-generator-model option[value="' + PRO_MODEL + '"]'),
    ).not.toContainText("(PRO)"); // await pro entitlement settlement
    await openSettings(page);

    const capability = page.locator("#composer-image-capability");
    const attach = page.locator("#prompt-image-upload");

    // Default vision-capable model supports image input.
    await expect(capability).toHaveText("Supported");
    await expect(attach).toBeVisible();

    // A non-vision Pro model flips the option and hides the attach affordance.
    await page.locator(MODEL_SELECT).selectOption(NON_VISION_PRO_MODEL);
    await expect(capability).toHaveText("Not supported");
    await expect(attach).toBeHidden();

    // Back to a vision model restores support.
    await page.locator(MODEL_SELECT).selectOption("google/gemini-3.7-flash");
    await expect(capability).toHaveText("Supported");
    await expect(attach).toBeVisible();
  });

  test("provider keys are managed through the account connection editor shortcut", async ({
    page,
  }) => {
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
    });
    await page.goto("/");
    await openSettings(page);

    // The dialog's key row is a shortcut into the canonical editor — not a
    // second independent editor.
    await page.click(`${SETTINGS} [aria-controls="api-keys-modal"]`);
    await expect(page.locator("#api-keys-modal")).toHaveClass(/open/);
    await expect(
      page.locator("#api-keys-modal #flutterflow-api-key-input"),
    ).toBeVisible();
  });
});

test.describe("focus and walkthrough behaviour around the dialog", () => {
  test("closing the dialog returns focus to the composer", async ({ page }) => {
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
    });
    await page.goto("/");
    await openSettings(page);
    await closeSettings(page, { via: "done" });

    const activeLabel = await page.evaluate(
      () => document.activeElement?.getAttribute("aria-label") || "",
    );
    expect(activeLabel).toBe("Generation settings");
  });

  test("an ordinary close never reopens the walkthrough", async ({ page }) => {
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
      [ENDPOINTS.getSubscription]: freeSubscription(),
    });
    await page.goto("/");

    // Normal settings visit — not the walkthrough's connect step.
    await openSettings(page);
    await closeSettings(page, { via: "escape" });
    await page.waitForTimeout(150);
    await expect(page.locator("#walkthrough-modal")).not.toHaveClass(/open/);

    // Same invariant through Done.
    await openSettings(page);
    await closeSettings(page, { via: "done" });
    await page.waitForTimeout(150);
    await expect(page.locator("#walkthrough-modal")).not.toHaveClass(/open/);
  });
});
