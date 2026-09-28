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
      page.consoleFailures.push(`${msg.text()} (${msg.location().url})`);
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
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");

      const field = page.locator("#pipeline-input");
      // The hero demo types the shipped prompt in on load — the settled value
      // only holds once the class retires, so wait for the demo's end state
      // rather than polling the prefix.
      await expect(page.locator("#composer")).not.toHaveClass(/is-demo-typing/, {
        timeout: 15000,
      });
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

/**
 * STU-445 — the hero's opening typing demo and the composer's focus state.
 * Both are visual behaviours, so the assertions read computed styles and the
 * changing prompt text rather than the presence of elements.
 */
test.describe("STU-445 hero composer behaviour", () => {
  test("the hero demo types the shipped prompt behind the orange caret", async ({ page }) => {
    // Watch from navigation commit so a fast machine cannot finish the demo
    // before the first sample.
    await page.goto("/", { waitUntil: "commit" });

    const samples = await page.evaluate(async (expected) => {
      const seen = [];
      // Canonical HTML: 5200ms hold followed by 73ms per character.
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const composer = document.getElementById("composer");
        const typed = document.querySelector(".ghost .typed");
        const typing = composer?.classList.contains("is-demo-typing") ?? false;
        // Start once the demo owns the field, then keep sampling through the
        // final frame, where the full prompt lands and the class retires.
        if (typed && (typing || seen.length > 0)) {
          const text = typed.textContent || "";
          if (seen[seen.length - 1] !== text) seen.push(text);
          if (text === expected) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return seen;
    }, COMPOSER_DEFAULT_PROMPT);

    // The visible text CHANGES over time: every sample is a strictly longer
    // prefix of the shipped prompt — real typing, not a static element.
    expect(samples.length).toBeGreaterThan(1);
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index].length).toBeGreaterThan(samples[index - 1].length);
      expect(samples[index].startsWith(samples[index - 1])).toBe(true);
    }
    expect(samples[samples.length - 1]).toBe(COMPOSER_DEFAULT_PROMPT);

    // The demo retires cleanly: caret class off, prompt settled, send ready.
    await expect(page.locator("#composer")).not.toHaveClass(/is-demo-typing/);
    await expect(page.locator("#pipeline-input")).toHaveValue(COMPOSER_DEFAULT_PROMPT);
    await expect(page.locator("#hero-send")).toBeEnabled();
  });

  test("a mid-demo click completes the prompt — a submit can never carry a prefix", async ({
    page,
  }) => {
    const prompts = [];
    await page.route(ENDPOINTS.pipeline, async (route) => {
      const body = route.request().postDataJSON();
      if (body && body.step === "architect") prompts.push(body.prompt);
      await route.fulfill(oneArtifact());
    });

    await page.goto("/", { waitUntil: "commit" });

    // Catch the demo mid-type: a real prefix is in the field and the rest of
    // the prompt is still seconds away, so a frozen prefix would fail below.
    await page.waitForFunction(
      (expected) => {
        const field = document.getElementById("pipeline-input");
        const composer = document.getElementById("composer");
        return (
          composer?.classList.contains("is-demo-typing") &&
          field &&
          field.value.length > 0 &&
          field.value.length < expected.length
        );
      },
      COMPOSER_DEFAULT_PROMPT,
      { timeout: 8000 },
    );

    // The takeover lands the complete shipped prompt — the same end state as
    // a finished demo — not whatever the timer had reached.
    await page.locator("#pipeline-input").click();
    const field = page.locator("#pipeline-input");
    await expect(field).toHaveValue(COMPOSER_DEFAULT_PROMPT);
    await expect(page.locator("#composer")).not.toHaveClass(/is-demo-typing/);
    await expect(page.locator("#hero-send")).toBeEnabled();

    // Submitting right after the takeover runs the complete example, never a
    // half-typed prefix.
    await page.locator("#hero-send").click();
    await expect
      .poll(() => prompts.length, { timeout: 30000 })
      .toBe(1);
    expect(prompts[0]).toContain(COMPOSER_DEFAULT_PROMPT);
  });

  test("mid-demo typing writes a new prompt — it never joins the example", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "commit" });

    // Catch the demo mid-type: a real prefix is in the field and the rest of
    // the prompt is still seconds away.
    await page.waitForFunction(
      (expected) => {
        const field = document.getElementById("pipeline-input");
        const composer = document.getElementById("composer");
        return (
          composer?.classList.contains("is-demo-typing") &&
          field &&
          field.value.length > 0 &&
          field.value.length < expected.length
        );
      },
      COMPOSER_DEFAULT_PROMPT,
      { timeout: 8000 },
    );

    // The demo's text is demo-owned, not a draft: the first real edit clears
    // it, so the keystrokes produce a prompt of the user's own — never the
    // shipped example with new text joined to it.
    const field = page.locator("#pipeline-input");
    await field.pressSequentially("A velocity gauge");
    await expect(field).toHaveValue("A velocity gauge");
    await expect(page.locator("#composer")).not.toHaveClass(/is-demo-typing/);
    await expect(page.locator("#hero-send")).toBeEnabled();
  });

  test("Backspace during the demo clears the demo text, not the whole example", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "commit" });

    await page.waitForFunction(
      (expected) => {
        const field = document.getElementById("pipeline-input");
        const composer = document.getElementById("composer");
        return (
          composer?.classList.contains("is-demo-typing") &&
          field &&
          field.value.length > 0 &&
          field.value.length < expected.length
        );
      },
      COMPOSER_DEFAULT_PROMPT,
      { timeout: 8000 },
    );

    // Deleting into a demo-owned field removes the demo's text: the native
    // delete sees the cleared field, not a restored example to delete inside.
    const field = page.locator("#pipeline-input");
    await field.press("Backspace");
    await expect(field).toHaveValue("");
    await expect(page.locator("#composer")).not.toHaveClass(/is-demo-typing/);
  });

  test("a mid-demo click hands the prompt over — Backspace trims it", async ({ page }) => {
    await page.goto("/", { waitUntil: "commit" });

    // Catch the demo mid-type: a real prefix is in the field and the rest of
    // the prompt is still seconds away.
    await page.waitForFunction(
      (expected) => {
        const field = document.getElementById("pipeline-input");
        const composer = document.getElementById("composer");
        return (
          composer?.classList.contains("is-demo-typing") &&
          field &&
          field.value.length > 0 &&
          field.value.length < expected.length
        );
      },
      COMPOSER_DEFAULT_PROMPT,
      { timeout: 8000 },
    );

    // A pointer takeover means "edit what I clicked": the restore lands the
    // complete prompt as the field's own text, so a later Backspace trims a
    // single character instead of clearing the demo-owned example.
    const field = page.locator("#pipeline-input");
    await field.click();
    await expect(field).toHaveValue(COMPOSER_DEFAULT_PROMPT);
    await field.press("End");
    await field.press("Backspace");
    await expect(field).toHaveValue(COMPOSER_DEFAULT_PROMPT.slice(0, -1));
    await expect(page.locator("#composer")).not.toHaveClass(/is-demo-typing/);
    await expect(page.locator("#hero-send")).toBeEnabled();
  });

  test("leaving Home mid-demo settles the prompt — never a submittable prefix", async ({
    page,
  }) => {
    const prompts = [];
    await page.route(ENDPOINTS.pipeline, async (route) => {
      const body = route.request().postDataJSON();
      if (body && body.step === "architect") prompts.push(body.prompt);
      await route.fulfill(oneArtifact());
    });

    await page.goto("/", { waitUntil: "commit" });

    // Catch the demo mid-type: a real prefix is in the field and the rest of
    // the prompt is still seconds away, so a frozen prefix would fail below.
    await page.waitForFunction(
      (expected) => {
        const field = document.getElementById("pipeline-input");
        const composer = document.getElementById("composer");
        return (
          composer?.classList.contains("is-demo-typing") &&
          field &&
          field.value.length > 0 &&
          field.value.length < expected.length
        );
      },
      COMPOSER_DEFAULT_PROMPT,
      { timeout: 8000 },
    );

    // Switching surfaces is a system cancellation, not a user takeover: the
    // demo settles on the complete shipped prompt, so a returning Generate
    // can never carry whatever prefix the timer reached.
    await page.evaluate(() => window.switchView("account"));
    await page.evaluate(() => window.switchView("home"));
    const field = page.locator("#pipeline-input");
    await expect(field).toHaveValue(COMPOSER_DEFAULT_PROMPT);
    await expect(page.locator("#composer")).not.toHaveClass(/is-demo-typing/);
    await expect(page.locator("#hero-send")).toBeEnabled();

    await page.locator("#hero-send").click();
    await expect
      .poll(() => prompts.length, { timeout: 30000 })
      .toBe(1);
    expect(prompts[0]).toContain(COMPOSER_DEFAULT_PROMPT);
  });

  test("leaving Home during the demo hold settles the prompt too", async ({ page }) => {
    await page.goto("/", { waitUntil: "commit" });

    // Catch the demo inside its hold: the typing class is on but the first
    // character has not landed yet.
    await page.waitForFunction(
      () => {
        const field = document.getElementById("pipeline-input");
        const composer = document.getElementById("composer");
        return (
          composer?.classList.contains("is-demo-typing") &&
          field &&
          field.value === ""
        );
      },
      undefined,
      { timeout: 8000 },
    );

    await page.evaluate(() => window.switchView("account"));
    await page.evaluate(() => window.switchView("home"));
    await expect(page.locator("#pipeline-input")).toHaveValue(COMPOSER_DEFAULT_PROMPT);
    await expect(page.locator("#composer")).not.toHaveClass(/is-demo-typing/);
    await expect(page.locator("#hero-send")).toBeEnabled();
  });

  test("a live reduced-motion flip mid-demo stops the typing and restores the prompt", async ({
    page,
  }) => {
    // Watch from navigation commit so the demo cannot finish before the flip.
    await page.goto("/", { waitUntil: "commit" });

    // Catch the demo while it is still early: a short prefix is in the field
    // and the caret class is on. The remaining typing then needs well over a
    // second, so a demo that ignores the flip cannot reach the full prompt
    // inside the assertion's timeout below.
    await page.waitForFunction(
      (expected) => {
        const field = document.getElementById("pipeline-input");
        const composer = document.getElementById("composer");
        return (
          composer?.classList.contains("is-demo-typing") &&
          field &&
          field.value.length > 0 &&
          field.value.length < expected.length / 5
        );
      },
      COMPOSER_DEFAULT_PROMPT,
      { timeout: 8000 },
    );

    // Flip the preference mid-demo: the reduced-motion listener must end the
    // demo right here — cancel its timer, land the complete shipped prompt and
    // retire the caret — exactly like a demo that finished typing.
    await page.emulateMedia({ reducedMotion: "reduce" });

    const field = page.locator("#pipeline-input");
    const composer = page.locator("#composer");

    await expect(field).toHaveValue(COMPOSER_DEFAULT_PROMPT, { timeout: 1000 });
    await expect(composer).not.toHaveClass(/is-demo-typing/);
    await expect(page.locator("#hero-send")).toBeEnabled();

    // The caret is retired, not merely hidden: the ::after that blinks only
    // exists while the composer carries the demo class.
    const caretAnimation = await page.evaluate(
      () =>
        getComputedStyle(document.querySelector("#composer .ghost .typed"), "::after")
          .animationName,
    );
    expect(caretAnimation).toBe("none");

    // Typing really stopped: the prompt holds steady for several frames.
    await page.waitForTimeout(300);
    await expect(field).toHaveValue(COMPOSER_DEFAULT_PROMPT);
    await expect(composer).not.toHaveClass(/is-demo-typing/);
  });

  test("clicking the prompt input shows only the composer's orange focus outline", async ({
    page,
  }) => {
    await page.goto("/");
    const field = page.locator("#pipeline-input");
    const composer = page.locator("#composer");
    await field.fill(COMPOSER_DEFAULT_PROMPT);
    await field.click();

    const fieldStyles = await field.evaluate((el) => {
      const styles = getComputedStyle(el);
      return {
        boxShadow: styles.boxShadow,
        outlineStyle: styles.outlineStyle,
      };
    });
    // The offset light-blue box was the page's generic textarea focus shadow.
    expect(fieldStyles.boxShadow).toBe("none");
    expect(fieldStyles.outlineStyle).toBe("none");

    const composerStyles = await composer.evaluate((el) => {
      const styles = getComputedStyle(el);
      return { borderColor: styles.borderColor, boxShadow: styles.boxShadow };
    });
    const accent = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--accent)";
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    // The surviving outline is the composer's own accent border and ring.
    expect(composerStyles.borderColor).toBe(accent);
    expect(composerStyles.boxShadow).not.toBe("none");
    // Nothing paints the old blue (#3b82f6) ring any more.
    expect(`${composerStyles.borderColor} ${composerStyles.boxShadow}`).not.toMatch(
      /59,\s*130,\s*246/,
    );
  });
});
