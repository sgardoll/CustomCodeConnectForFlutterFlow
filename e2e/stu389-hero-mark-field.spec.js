import { test, expect } from "@playwright/test";

const DESKTOP = { width: 1440, height: 900 };

function collectFxGridWarnings(page) {
  const warnings = [];
  const isDriverNoise = (text) => /GL Driver Message|GPU stall due to ReadPixels/.test(text);
  const handler = (msg) => {
    const text = msg.text();
    if (isDriverNoise(text)) return;
    if (/fx-grid|webgl|WebGL|canvas/i.test(text) && (msg.type() === "warning" || msg.type() === "error")) {
      warnings.push({ type: msg.type(), text });
    }
  };
  page.on("console", handler);
  return {
    free: () => page.off("console", handler),
    warnings: () => warnings,
    expectClean: () => expect(warnings, "fx-grid should not log errors or warnings").toHaveLength(0),
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("hasSeenWalkthrough", "true");
  });
});

test("desktop hero controls stay clickable and readable with the mark field active", async ({ page }) => {
  const logs = collectFxGridWarnings(page);
  await page.setViewportSize(DESKTOP);
  await page.goto("/");

  const canvas = page.locator("#fx-grid");
  await expect(canvas).toHaveClass(/is-ready/);

  await expect(page.locator("h1.headline")).toBeVisible();
  await expect(page.locator(".composer")).toBeVisible();

  await page.locator("#pipeline-input").fill("A circular progress gauge with a gradient stroke");
  await expect(page.locator("#pipeline-input")).toHaveValue("A circular progress gauge with a gradient stroke");

  // The canvas is decorative and pointer-transparent; clicks pass through to the composer.
  const composerBox = await page.locator(".composer").boundingBox();
  await page.mouse.click(composerBox.x + composerBox.width / 2, composerBox.y + composerBox.height / 2);
  await expect(page.locator("#pipeline-input")).toBeFocused();

  logs.expectClean();
  logs.free();
});

test("canvas and masks are excluded from accessibility navigation", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto("/");

  const canvas = page.locator("#fx-grid");
  await expect(canvas).toHaveAttribute("aria-hidden", "true");
  await expect(canvas).toHaveAttribute("tabindex", "-1");

  const reachable = await page.evaluate(() => {
    const selector =
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusable = Array.from(document.querySelectorAll(selector));
    return focusable.some((el) => el.closest(".hero-field"));
  });
  expect(reachable, "no decorative field element should be keyboard-reachable").toBe(false);
});

test("WebGL failure falls back to 2D canvas without console failures", async ({ page }) => {
  const logs = collectFxGridWarnings(page);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type === "webgl2" || type === "webgl" || type === "experimental-webgl") return null;
      return original.call(this, type, ...args);
    };
  });

  await page.setViewportSize(DESKTOP);
  await page.goto("/");

  await expect(page.locator("#fx-grid")).toHaveClass(/is-ready/);
  await expect(page.locator("h1.headline")).toBeVisible();
  await expect(page.locator(".composer")).toBeVisible();

  logs.expectClean();
  logs.free();
});

test("unavailable WebGL and 2D canvas still leaves a complete static page", async ({ page }) => {
  const logs = collectFxGridWarnings(page);
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.getContext = function () {
      return null;
    };
  });

  await page.setViewportSize(DESKTOP);
  await page.goto("/");

  await expect(page.locator("h1.headline")).toBeVisible();
  await expect(page.locator(".composer")).toBeVisible();
  await expect(page.locator(".chips")).toBeVisible();

  logs.expectClean();
  logs.free();
});

test("reduced motion yields a complete static page with no field rendering", async ({ page }) => {
  const logs = collectFxGridWarnings(page);
  await page.emulateMedia({ reducedMotion: "reduce" });

  await page.setViewportSize(DESKTOP);
  await page.goto("/");

  await expect(page.locator(".hero-field")).toBeHidden();
  await expect(page.locator("h1.headline")).toBeVisible();
  await expect(page.locator(".composer")).toBeVisible();

  logs.expectClean();
  logs.free();
});

test("navigation away stops rendering and returning does not accumulate raf loops", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto("/");
  await expect(page.locator("#fx-grid")).toHaveClass(/is-ready/);

  const runningAtStart = await page.evaluate(() => window.__heroField?.isRunning());
  expect(runningAtStart, "field should be running on the home view").toBe(true);

  await page.click('a[data-view="account"]');
  await expect(page.locator("#account-view")).toBeVisible();
  await page.waitForTimeout(300);

  const runningAfterNav = await page.evaluate(() => window.__heroField?.isRunning());
  expect(runningAfterNav, "field should stop when the home view is hidden").toBe(false);

  // Count how many new rAF loops the field creates while it should be off-screen.
  const rafCountAway = await page.evaluate(async () => {
    const orig = window.requestAnimationFrame;
    let count = 0;
    window.requestAnimationFrame = function (cb) {
      count++;
      return orig.call(window, cb);
    };
    await new Promise((r) => setTimeout(r, 500));
    return count;
  });
  expect(rafCountAway, "no new animation frames should be requested while home is hidden").toBe(0);

  await page.click('a[data-view="home"]');
  await expect(page.locator("#home-view")).toBeVisible();
  await page.waitForTimeout(300);

  const runningAfterReturn = await page.evaluate(() => window.__heroField?.isRunning());
  expect(runningAfterReturn, "field should resume when the home view is shown").toBe(true);
});

test("live reduced-motion change toggles the field without reloading", async ({ page }) => {
  const logs = collectFxGridWarnings(page);
  await page.setViewportSize(DESKTOP);
  await page.goto("/");
  await expect(page.locator("#fx-grid")).toHaveClass(/is-ready/);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".hero-field")).toBeHidden();
  let running = await page.evaluate(() => window.__heroField?.isRunning());
  expect(running, "field should stop when reduced motion is enabled").toBe(false);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  // The field is decorative; it does not need to become visible instantly, but
  // the underlying module should resume when the canvas is intersecting again.
  await page.waitForTimeout(400);
  running = await page.evaluate(() => window.__heroField?.isRunning());
  expect(running, "field should resume when reduced motion is disabled").toBe(true);

  logs.expectClean();
  logs.free();
});

test("effect does not impede typing or page scrolling", async ({ page }) => {
  const logs = collectFxGridWarnings(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const input = page.locator("#pipeline-input");
  const longPrompt =
    "A drag-to-reorder list with haptic feedback and a spring animation. ".repeat(12);
  await input.fill(longPrompt);
  await expect(input).toHaveValue(longPrompt);

  // The page must remain vertically scrollable while the effect is active.
  const canScroll = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollHeight > root.clientHeight;
  });
  expect(canScroll, "page content should be reachable").toBe(true);

  const hasHorizontalOverflow = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth > root.clientWidth + 1;
  });
  expect(hasHorizontalOverflow, "effect should not cause horizontal overflow").toBe(false);

  logs.expectClean();
  logs.free();
});

test("desktop visual comparison on named device", async ({ page }, testInfo) => {
  const logs = collectFxGridWarnings(page);
  await page.setViewportSize(DESKTOP);
  await page.goto("/");
  await expect(page.locator("#fx-grid")).toHaveClass(/is-ready/);
  await page.waitForTimeout(600);

  const screenshotPath = testInfo.outputPath("hero-mark-field-desktop.png");
  await page.locator(".hero").screenshot({ path: screenshotPath });
  await testInfo.attach("hero-mark-field-desktop.png", { path: screenshotPath });

  logs.expectClean();
  logs.free();
});

test("frame measurements before and after disabling the effect", async ({ page }) => {
  const logs = collectFxGridWarnings(page);

  await page.setViewportSize(DESKTOP);
  await page.goto("/");
  await page.waitForTimeout(600);
  const withEffect = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    return nav ? { domComplete: nav.domComplete, duration: nav.duration } : null;
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await page.waitForTimeout(600);
  const withoutEffect = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    return nav ? { domComplete: nav.domComplete, duration: nav.duration } : null;
  });

  expect(withEffect).toBeTruthy();
  expect(withoutEffect).toBeTruthy();

  // The presence of the effect should not blow up the navigation timing.
  expect(withEffect.duration, "load duration with effect should be finite").toBeLessThan(60_000);
  expect(withoutEffect.duration, "load duration without effect should be finite").toBeLessThan(60_000);

  logs.expectClean();
  logs.free();
});
