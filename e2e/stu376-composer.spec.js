import { test, expect } from "@playwright/test";
import {
  applyDefaultRoutes,
  guestIdentity,
  freeSubscription,
  oneArtifact,
  rejectedGeneration,
  ENDPOINTS,
} from "./fixtures/apiFixtures.js";

/**
 * STU-376: the wired prompt composer — ghost suggestions from the 13 local
 * prototype patterns, Tab/Escape state machine, chip fill, whitespace and
 * duplicate-submission guards, and the existing attachment/settings paths.
 * Every external endpoint is intercepted with deterministic fixtures, so a
 * stray completion-provider request fails the console assertion loudly.
 */

const COMPOSER_DEFAULT_PROMPT = "A circular progress gauge with a gradient stroke";
const GAUGE_COMPLETION = " and an animated percentage label";
const IMAGE_UPLOAD_ENDPOINT = `${ENDPOINTS.buildship}/service/runpipeline-image`;

const viewports = [
  { name: "mobile", width: 360, height: 800 },
  { name: "desktop", width: 1440, height: 900 },
];

/**
 * Override the pipeline endpoint with a fixture that counts each step's
 * requests. Registered after applyDefaultRoutes, so Playwright matches it
 * before the default route map.
 */
async function routeCountingPipeline(page, { delayMs = 0 } = {}) {
  const counts = { architect: 0, generator: 0, review: 0 };
  await page.route(ENDPOINTS.pipeline, async (route) => {
    const body = route.request().postDataJSON();
    if (body && body.step && body.step in counts) counts[body.step] += 1;
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill(oneArtifact());
  });
  return counts;
}

test.beforeEach(async ({ page }) => {
  // The first-visit walkthrough is real product behavior; these tests assert
  // the bare composer, so mark it seen the way the smoke suite does.
  await page.addInitScript(() => {
    localStorage.setItem("hasSeenWalkthrough", "true");
  });
  page.consoleFailures = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      page.consoleFailures.push(msg.text());
    }
  });
  await applyDefaultRoutes(page, {
    [ENDPOINTS.identity]: guestIdentity(),
    [ENDPOINTS.getSubscription]: freeSubscription(),
  });
});

test.afterEach(async ({ page }) => {
  // Ignore Chromium permissions-policy notices that are unrelated to app code.
  const relevantFailures = page.consoleFailures.filter(
    (text) => !/Permissions policy violation: compute-pressure/.test(text),
  );
  expect(relevantFailures).toEqual([]);
});

for (const { name, width, height } of viewports) {
  test.describe(`composer wiring at ${name} viewport`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height });
    });

    test("ships the example prompt without an active suggestion", async ({ page }) => {
      await page.goto("/");

      const field = page.locator("#pipeline-input");
      await expect(field).toHaveValue(COMPOSER_DEFAULT_PROMPT);
      await expect(page.locator(".ghost .suggest")).toHaveText("");
      await expect(page.locator("#tab-hint")).toBeHidden();
      await expect(page.locator("#composer")).not.toHaveClass(/has-suggest/);
      await expect(page.locator("#hero-send")).toBeEnabled();
    });

    test("typing surfaces the local suggestion with the tab hint and live announcement", async ({ page }) => {
      const requestedUrls = [];
      page.on("request", (request) => requestedUrls.push(request.url()));

      await page.goto("/");

      await page.locator("#pipeline-input").fill(COMPOSER_DEFAULT_PROMPT);

      const composer = page.locator("#composer");
      await expect(composer).toHaveClass(/has-suggest/);
      await expect(page.locator(".ghost .suggest")).toHaveText(GAUGE_COMPLETION);
      await expect(page.locator(".ghost .typed")).toHaveText(COMPOSER_DEFAULT_PROMPT);
      await expect(page.locator("#tab-hint")).toBeVisible();
      await expect(page.locator("#suggest-status")).toContainText(
        "Suggestion: " + GAUGE_COMPLETION + ". Press Tab to accept.",
      );
      await expect(page.locator("#tab-hint")).toHaveAttribute(
        "aria-label",
        "Accept suggestion: and an animated percentage label",
      );

      // Suggestions are purely local: no completion provider may be contacted.
      const completionRequests = requestedUrls.filter(
        (url) => /groq|\/chat\/completions/i.test(url),
      );
      expect(completionRequests).toEqual([]);
    });

    test("Tab accepts the active suggestion", async ({ page }) => {
      await page.goto("/");

      const field = page.locator("#pipeline-input");
      await field.fill(COMPOSER_DEFAULT_PROMPT);
      await expect(page.locator("#composer")).toHaveClass(/has-suggest/);

      await page.keyboard.press("Tab");

      await expect(field).toHaveValue(COMPOSER_DEFAULT_PROMPT + GAUGE_COMPLETION);
      await expect(page.locator(".ghost .suggest")).toHaveText("");
      await expect(page.locator("#composer")).not.toHaveClass(/has-suggest/);
      await expect(page.locator("#tab-hint")).toBeHidden();
      await expect(page.locator("#suggest-status")).toHaveText("");
      await expect(page.locator("#hero-send")).toBeEnabled();

      // Acceptance must not re-trigger a suggestion on the accepted text.
      await page.waitForTimeout(400);
      await expect(page.locator(".ghost .suggest")).toHaveText("");
    });

    test("Escape dismisses the suggestion without changing the prompt", async ({ page }) => {
      await page.goto("/");

      const field = page.locator("#pipeline-input");
      await field.fill(COMPOSER_DEFAULT_PROMPT);
      await expect(page.locator("#composer")).toHaveClass(/has-suggest/);

      await page.keyboard.press("Escape");

      await expect(field).toHaveValue(COMPOSER_DEFAULT_PROMPT);
      await expect(page.locator(".ghost .suggest")).toHaveText("");
      await expect(page.locator("#composer")).not.toHaveClass(/has-suggest/);
      await expect(page.locator("#tab-hint")).toBeHidden();
      await expect(page.locator("#suggest-status")).toHaveText("");

      // With the suggestion dismissed, Tab falls through and moves focus.
      await page.keyboard.press("Tab");
      await expect(field).not.toBeFocused();
    });

    test("Tab without an active suggestion moves focus to the next control", async ({ page }) => {
      await page.goto("/");

      const field = page.locator("#pipeline-input");
      await field.fill("Generate some code for me please");
      // Wait out the suggestion debounce so a late match cannot sneak in.
      await page.waitForTimeout(400);
      await expect(page.locator(".ghost .suggest")).toHaveText("");
      await expect(page.locator("#composer")).not.toHaveClass(/has-suggest/);

      await page.keyboard.press("Tab");

      await expect(field).not.toBeFocused();
      await expect(
        page.locator('.tools [aria-label="Attach reference image"]'),
      ).toBeFocused();
    });

    test("example chips populate the full source prompt", async ({ page }) => {
      await page.goto("/");

      const field = page.locator("#pipeline-input");
      const chips = page.locator("#example-chips .chip");
      const count = await chips.count();
      expect(count).toBe(3);

      for (let i = 0; i < count; i += 1) {
        const chip = chips.nth(i);
        const prompt = await chip.getAttribute("data-prompt");
        expect(prompt, "every chip carries its full source prompt").toBeTruthy();

        await chip.click();
        await expect(field).toHaveValue(prompt);
        await expect(chip).toHaveAttribute("aria-pressed", "true");
        await expect(chip).toHaveClass(/is-active/);
        await expect(field).toBeFocused();
        await expect(page.locator("#hero-send")).toBeEnabled();
      }
    });

    test("empty and whitespace-only prompts cannot submit", async ({ page }) => {
      const counts = await routeCountingPipeline(page);
      await page.goto("/");

      const field = page.locator("#pipeline-input");
      const send = page.locator("#hero-send");

      await field.fill("");
      await expect(send).toBeDisabled();

      await field.fill("   \n\t ");
      await expect(send).toBeDisabled();

      // Enter on a whitespace-only prompt is a no-op: no pipeline request.
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
      expect(counts.architect + counts.generator + counts.review).toBe(0);

      await field.fill("A countdown timer");
      await expect(send).toBeEnabled();
    });
  });
}

test.describe("submission wiring at desktop viewport", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("one submission produces one pipeline request and blocks duplicates", async ({ page }) => {
    const counts = await routeCountingPipeline(page, { delayMs: 350 });
    await page.goto("/");

    const field = page.locator("#pipeline-input");
    const send = page.locator("#hero-send");

    await field.fill("A countdown timer");
    await page.keyboard.press("Enter");

    // In flight: the send control is busy and cannot submit again.
    await expect(send).toBeDisabled();
    await expect(send).toHaveClass(/is-busy/);
    await expect(send).toHaveAttribute("aria-label", "Generating");
    await expect(page.locator("#composer")).toHaveClass(/is-busy/);

    // A second submission attempt during the flight is swallowed.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");

    await expect(send).toBeEnabled({ timeout: 30000 });
    await expect(send).toHaveAttribute("aria-label", "Generate");
    await expect(send).not.toHaveClass(/is-busy/);

    expect(counts.architect).toBe(1);
    expect(counts.generator).toBe(1);
    expect(counts.review).toBe(1);
  });

  test("a failed pipeline preserves the edited prompt for retry", async ({ page }) => {
    await page.route(ENDPOINTS.pipeline, async (route) => {
      await route.fulfill(rejectedGeneration());
    });
    await page.goto("/");

    const field = page.locator("#pipeline-input");
    const send = page.locator("#hero-send");
    const retryPrompt = "My carefully edited prompt that must survive the failure";

    await field.fill(retryPrompt);
    await page.keyboard.press("Enter");

    await expect(send).toBeEnabled({ timeout: 15000 });
    await expect(field).toHaveValue(retryPrompt);

    // The pipeline logs its own failure and the browser reports the fixture's
    // 400 — both are this test's doing, not a leak.
    page.consoleFailures = page.consoleFailures.filter(
      (text) => !/Pipeline failed|Failed to load resource.*400/.test(text),
    );
  });

  test("the settings control opens the generation settings dialog", async ({ page }) => {
    await page.goto("/");

    await page.click('.tools [aria-label="Generation settings"]');
    // STU-385: the gear opens the composer generation-settings dialog (model +
    // generation options), not the API-keys editor directly.
    await expect(page.locator("#composer-settings-modal")).toHaveClass(/open/);
    await expect(page.locator("#composer-settings-modal")).toHaveAttribute(
      "aria-hidden",
      "false",
    );

    // Provider-key management is a shortcut into the canonical account
    // connection editor (STU-384), not a second independent editor.
    await page.click("#composer-settings-modal [aria-controls='api-keys-modal']");
    await expect(page.locator("#api-keys-modal")).toHaveClass(/open/);
    await expect(page.locator("#api-keys-modal")).toHaveAttribute(
      "aria-hidden",
      "false",
    );
  });

  test("attachments keep the existing size and count validation", async ({ page }) => {
    await page.route(IMAGE_UPLOAD_ENDPOINT, async (route) => {
      await route.fulfill({ status: 200, body: "[]", contentType: "application/json" });
    });
    await page.goto("/");

    const input = page.locator("#prompt-image-input");

    // Oversized files are rejected up front by the existing size rule.
    await input.setInputFiles([
      {
        name: "huge.png",
        mimeType: "image/png",
        buffer: Buffer.alloc(9 * 1024 * 1024, 1),
      },
    ]);
    await expect(page.getByText("Skipped 1 image(s) over the 8 MB limit.")).toBeVisible();

    // The existing count rule caps attachments and says so.
    const smallFile = (index) => ({
      name: `ref-${index}.png`,
      mimeType: "image/png",
      buffer: Buffer.from("tiny"),
    });
    await input.setInputFiles([1, 2, 3, 4, 5].map(smallFile));
    await expect(page.getByText("You can attach up to 4 images.")).toBeVisible();
  });
});

test.describe("touch controls at mobile viewport", () => {
  test.use({ hasTouch: true, viewport: { width: 360, height: 800 } });

  test("tapping a chip, the accept hint and send all work by touch", async ({ page }) => {
    const counts = await routeCountingPipeline(page);
    await page.goto("/");

    const field = page.locator("#pipeline-input");

    // A chip tap fills the full source prompt.
    await page.locator("#example-chips .chip", { hasText: "Signature pad" }).tap();
    await expect(field).toHaveValue("A signature pad that exports a transparent PNG");

    // Typing after a touch focus surfaces the suggestion; tapping the hint accepts it.
    await field.tap();
    await field.fill("");
    await page.keyboard.type("A signature pad");
    await expect(page.locator("#composer")).toHaveClass(/has-suggest/);
    await page.locator("#tab-hint").tap();
    await expect(field).toHaveValue("A signature pad that exports a transparent PNG");

    // The touch targets meet the 44px minimum from the responsive contract.
    const sendBox = await page.locator("#hero-send").boundingBox();
    expect(sendBox.height).toBeGreaterThanOrEqual(44);
    expect(sendBox.width).toBeGreaterThanOrEqual(44);
    const attachBox = await page
      .locator('.tools [aria-label="Attach reference image"]')
      .boundingBox();
    expect(attachBox.height).toBeGreaterThanOrEqual(44);
    expect(attachBox.width).toBeGreaterThanOrEqual(44);

    // A send tap submits exactly once through the existing pipeline.
    await page.locator("#hero-send").tap();
    await expect(page.locator("#hero-send")).toBeEnabled({ timeout: 30000 });
    expect(counts.architect).toBe(1);
    expect(counts.generator).toBe(1);
    expect(counts.review).toBe(1);
  });
});
