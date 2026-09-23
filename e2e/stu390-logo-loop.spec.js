import { test, expect } from "@playwright/test";
import {
  applyDefaultRoutes,
  ENDPOINTS,
  freeSubscription,
  guestIdentity,
  oneArtifact,
  quotaExhausted,
  reviewPassed,
} from "./fixtures/apiFixtures.js";

/**
 * STU-390 — the authored logo animation in the pipeline arena.
 *
 * The mark is DECORATIVE: pipeline completion depends only on real backend
 * events, never on this animation. These tests drive the real pipeline stage
 * machine (hermetic fixtures, no timers gating a stage) alongside the loop,
 * and separately measure the loop's rendering lifecycle across hidden-tab,
 * CSS-hidden (display:none) and viewport-offscreen states. `offsetParent`
 * alone is NOT proof of viewport visibility, so the offscreen case is checked
 * through the arena's actual on-screen geometry, not just a hidden attribute.
 */

const DESKTOP = { width: 1440, height: 900 };

const STAGE_RESPONSES = {
  architect: oneArtifact,
  generator: oneArtifact,
  review: reviewPassed,
};

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function stepOf(route) {
  try {
    return JSON.parse(route.request().postData() || "{}").step || "";
  } catch {
    return "";
  }
}

async function routePipelineStages(page, { hold = [], responses = {} } = {}) {
  const gates = Object.fromEntries(hold.map((s) => [s, deferred()]));
  await page.route(ENDPOINTS.pipeline, async (route) => {
    const step = stepOf(route);
    if (gates[step]) await gates[step].promise;
    const entry = responses[step] ?? STAGE_RESPONSES[step];
    if (entry === "abort") {
      await route.abort();
      return;
    }
    await route.fulfill(typeof entry === "function" ? entry() : entry);
  });
  return { release: (s) => gates[s].resolve() };
}

async function openHome(page, overrides = {}) {
  await page.addInitScript(() => {
    localStorage.setItem("hasSeenWalkthrough", "true");
  });
  await applyDefaultRoutes(page, {
    [ENDPOINTS.identity]: guestIdentity(),
    [ENDPOINTS.getSubscription]: freeSubscription(),
    ...overrides,
  });
  await page.goto("/");
  await expect(page.locator("#pipeline-input")).toBeVisible();
}

const running = (page) => page.evaluate(() => window.__pipelineLogo?.isRunning() === true);

// Counts only the logo loop's own painted frames over `ms`. This isolates the
// module from every other requestAnimationFrame consumer on the page (the hero
// mark field animates independently), so a "still turning over" loop cannot be
// mistaken for, or hidden by, unrelated page animation.
async function framesIn(page, ms) {
  const before = await page.evaluate(() => window.__pipelineLogo?.frameCount() ?? 0);
  await page.waitForTimeout(ms);
  const after = await page.evaluate(() => window.__pipelineLogo?.frameCount() ?? 0);
  return after - before;
}

const currentTime = (page) => page.evaluate(() => window.__pipelineLogo?.currentTime() ?? -1);

// Painted frames over `ms` measured from a steady state: a fresh loop is given
// a warm-up before the window opens, so two rate measurements are comparable.
// A leaked second loop would paint ~2x the frames in the same window.
async function steadyFramesIn(page, ms = 500) {
  await page.waitForTimeout(250);
  const before = await page.evaluate(() => window.__pipelineLogo?.frameCount() ?? 0);
  await page.waitForTimeout(ms);
  const after = await page.evaluate(() => window.__pipelineLogo?.frameCount() ?? 0);
  return after - before;
}

// Measures the logo's painted frames against the number of actual display
// frames over the SAME wall-clock window. A single loop paints at most once per
// display frame (ratio ~1); a leaked second loop paints ~2x per display frame
// (ratio ~2). Because both counts share one window, CPU contention sags them
// together and cannot inflate the ratio — unlike comparing two separate window
// counts, which is how a slower CI runner stalls the baseline and trips a
// `framesB < framesA * c` style assertion. This is the load-robust spelling of
// "the loop resumed without accumulating a second loop."
async function framesPerDisplayFrame(page, ms = 500) {
  await page.evaluate(() => {
    if (!window.__displayFrames) {
      window.__displayFrames = 0;
      (function tick() {
        window.__displayFrames += 1;
        requestAnimationFrame(tick);
      })();
    }
  });
  await page.waitForTimeout(250); // let the display counter run at steady rate
  const before = await page.evaluate(() => [
    window.__pipelineLogo?.frameCount() ?? 0,
    window.__displayFrames || 0,
  ]);
  await page.waitForTimeout(ms);
  const after = await page.evaluate(() => [
    window.__pipelineLogo?.frameCount() ?? 0,
    window.__displayFrames || 0,
  ]);
  return { logo: after[0] - before[0], display: after[1] - before[1] };
}

// Bring the pipeline arena onto screen without a backend run. The progress
// panel lives in #generation-stage (hidden until a run begins) inside
// #main-stage-container (opacity 0 unless .visible). showPipelineProgress
// flips all three; we mirror that so the mark truly renders for the test.
async function revealPipeline(page) {
  await page.evaluate(() => {
    const stage = document.getElementById("generation-stage");
    stage.hidden = false;
    stage.inert = false;
    stage.classList.add("is-active");
    document.getElementById("main-stage-container").classList.add("visible");
    document.getElementById("pipeline-progress").classList.add("visible");
  });
  await expect.poll(() => running(page), { timeout: 3000 }).toBe(true);
}

async function hidePipeline(page) {
  await page.evaluate(() => {
    document.getElementById("pipeline-progress").classList.remove("visible");
  });
  await expect.poll(() => running(page), { timeout: 3000 }).toBe(false);
}

test.describe("Decorative mark lifecycle in the pipeline arena", () => {
  test("mark exists in the pipeline arena, is decorative and animates when the pipeline shows", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openHome(page);

    const arena = page.locator(".pipeline-glyph.logo-loop");
    await expect(arena).toHaveCount(1);
    // Decorative: excluded from the accessibility tree (aria-hidden, not focusable).
    await expect(arena).toHaveAttribute("aria-hidden", "true");
    const reachable = await page.evaluate(() => {
      const mark = document.querySelector(".pipeline-glyph.logo-loop");
      const focusable = mark.querySelectorAll('a[href], button, [tabindex], input, select, textarea');
      return focusable.length;
    });
    expect(reachable, "decorative mark must expose no focusable control").toBe(0);

    // Hidden by default (pipeline not running) — no loop.
    await expect.poll(() => running(page), { timeout: 3000 }).toBe(false);

    await revealPipeline(page);
    // While visible it actively renders: a genuine frame metric from the module.
    const frames = await framesIn(page, 500);
    expect(frames, "the mark should animate while its arena is on screen").toBeGreaterThan(5);
  });

  test("hidden browser tab stops rendering and returning resumes a single loop", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openHome(page);
    await revealPipeline(page);

    const framesOn = await steadyFramesIn(page);
    expect(framesOn).toBeGreaterThan(5);

    // Simulate the tab being hidden (document.hidden + visibilitychange).
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => running(page), { timeout: 3000 }).toBe(false);
    const framesHidden = await framesIn(page, 500);
    expect(framesHidden, "no logo frames while the tab is hidden").toBe(0);

    // Restore visibility; the loop must resume, not accumulate a second loop.
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => running(page), { timeout: 3000 }).toBe(true);
    const framesReenter = await steadyFramesIn(page);
    expect(framesReenter, "a restored loop should stay a single loop").toBeGreaterThan(5);
    // If a second loop had leaked in, the painted-frame rate would ~double.
    expect(framesReenter).toBeLessThan(framesOn * 1.6);
  });

  test("CSS-hidden pipeline (display:none) stops rendering with no raf leak", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openHome(page);
    await revealPipeline(page);
    await expect.poll(() => running(page)).toBe(true);
    const framesOn = await steadyFramesIn(page);
    expect(framesOn).toBeGreaterThan(5);

    // display:none -> offsetParent null. This is the CSS-hidden case.
    await hidePipeline(page);
    const framesHidden = await framesIn(page, 500);
    expect(framesHidden, "no logo frames once the pipeline is display:none").toBe(0);

    // Re-enter: still a single loop, never a doubled one.
    await revealPipeline(page);
    const framesBack = await steadyFramesIn(page);
    expect(framesBack).toBeGreaterThan(5);
    expect(framesBack).toBeLessThan(framesOn * 1.7);
  });

  test("viewport-offscreen arena stops rendering even though it is not display:none", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openHome(page);
    await revealPipeline(page);
    await expect.poll(() => running(page)).toBe(true);

    // Move the arena out of the viewport while keeping it in layout (transform,
    // not display:none), so offsetParent stays non-null. Only the Intersection-
    // Observer viewport check can catch this.
    await page.evaluate(() => {
      document.getElementById("pipeline-progress").style.transform = "translateY(4000px)";
    });
    await expect.poll(() => running(page), { timeout: 3000 }).toBe(false);
    const framesOff = await framesIn(page, 500);
    expect(framesOff, "no logo frames once the arena is offscreen").toBe(0);

    // Bring it back on screen — one loop resumes.
    await page.evaluate(() => {
      document.getElementById("pipeline-progress").style.transform = "none";
    });
    await expect.poll(() => running(page), { timeout: 3000 }).toBe(true);
    expect(await framesIn(page, 500)).toBeGreaterThan(5);
  });

  test("live reduced-motion toggle freezes to the static rest frame and stops the loop", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openHome(page);
    await revealPipeline(page);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => running(page), { timeout: 3000 }).toBe(false);
    const framesReduced = await framesIn(page, 500);
    expect(framesReduced, "no logo frames under reduced motion").toBe(0);

    // The clock is frozen while reduced: it must not advance while we wait.
    const before = await currentTime(page);
    await page.waitForTimeout(300);
    const after = await currentTime(page);
    expect(after).toBe(before);
    expect(after).toBeGreaterThanOrEqual(0);

    // Static rest frame is painted (browser serialises "1.000" back to "1").
    const pieces = await page.evaluate(() => ({
      a: parseFloat(document.querySelector(".loop-piece-a").style.opacity),
      b: parseFloat(document.querySelector(".loop-piece-b").style.opacity),
    }));
    expect(pieces.a).toBe(1);
    expect(pieces.b).toBe(1);

    // Live toggle back on resumes without accumulating a second loop. Compare
    // the resumed logo frames against display frames in the same window rather
    // than against a separate baseline window: the ratio is load-invariant
    // (contention slows both counters together), so it cannot trip on a slow CI
    // runner while still failing if the loop genuinely doubled (~2x per frame).
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(() => running(page), { timeout: 3000 }).toBe(true);
    const resumed = await framesPerDisplayFrame(page, 500);
    expect(resumed.logo, "the loop should have resumed painting").toBeGreaterThan(5);
    expect(resumed.display, "the window should contain real display frames").toBeGreaterThan(0);
    // One loop paints at most once per display frame; a doubled loop would ~2x.
    expect(resumed.logo).toBeLessThan(resumed.display * 1.6);
  });
});

test.describe("Progress is independent of the animation position", () => {
  test("a run that is mid-loop still completes when the backend releases every stage", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openHome(page);
    const pipeline = await routePipelineStages(page, { hold: ["architect", "generator", "review"] });

    await page.locator("#pipeline-input").fill("A gauge widget");
    await page.locator("#hero-send").click();

    // Arena is showing and animating while the first stage is held.
    await expect.poll(() => running(page), { timeout: 3000 }).toBe(true);

    // Park the animation at a non-rest beat (t=90, the orbit). Completion must
    // not depend on where the loop is.
    await page.evaluate(() => window.__pipelineLogo.seek(90));

    pipeline.release("architect");
    await expect(page.locator("#pdot-1")).toHaveAttribute("data-state", "done");
    pipeline.release("generator");
    await expect(page.locator("#pdot-2")).toHaveAttribute("data-state", "done");
    pipeline.release("review");
    await expect(page.locator("#results-view")).toHaveClass(/visible/);

    // With Results shown, the arena leaves the screen, so its loop must stop.
    await expect.poll(() => running(page), { timeout: 3000 }).toBe(false);
    const framesAfter = await framesIn(page, 500);
    expect(framesAfter, "no logo frames after the pipeline leaves view").toBe(0);
  });

  test("a mid-loop run still fails honestly when the backend rejects a stage", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openHome(page);
    const pipeline = await routePipelineStages(page, { hold: ["architect"], responses: { generator: quotaExhausted } });

    await page.locator("#pipeline-input").fill("A gauge widget");
    await page.locator("#hero-send").click();

    await expect.poll(() => running(page), { timeout: 3000 }).toBe(true);
    await page.evaluate(() => window.__pipelineLogo.seek(47)); // peek-a-boo beat

    // Let Architect succeed; Generator then answers with a quota rejection.
    pipeline.release("architect");

    const failure = page.locator("#pipeline-failure");
    await expect(failure).toBeVisible();
    await expect(failure).toHaveAttribute("data-kind", "quota");
    await expect(page.locator("#results-view")).not.toHaveClass(/visible/);
    await expect(page.locator("#pdot-1")).toHaveAttribute("data-state", "done");
    await expect(page.locator("#pdot-2")).toHaveAttribute("data-state", "failed");
  });
});

test.describe("Visual review artefacts (human review, not pixel baselines)", () => {
  for (const [name, width, height] of [
    ["mobile", 360, 800],
    ["desktop", 1440, 900],
  ]) {
    test(`captures representative beats for ${name} review`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await openHome(page);
      await revealPipeline(page);
      // Freeze the loop so a seek paints a deterministic, stable beat.
      await page.emulateMedia({ reducedMotion: "reduce" });

      const beats = [
        [0, "rest"],
        [47, "peek-a-boo"],
        [90, "orbit"],
        [120, "rest-boundary"],
      ];
      for (const [beat, label] of beats) {
        await page.evaluate((t) => window.__pipelineLogo.seek(t), beat);
        await page.waitForTimeout(40);
        const pageShot = testInfo.outputPath(`stu390-page-${label}-${name}.png`);
        await page.screenshot({ path: pageShot });
        await testInfo.attach(`page @ ${label} (${name})`, { path: pageShot });
        // Close-up of the two-piece mark itself for brand-geometry review.
        const markShot = testInfo.outputPath(`stu390-mark-${label}-${name}.png`);
        await page.locator(".loop-mark").screenshot({ path: markShot });
        await testInfo.attach(`mark @ ${label} (${name})`, { path: markShot });
      }
    });
  }
});
