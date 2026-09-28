import { test, expect } from "@playwright/test";
import {
  applyDefaultRoutes,
  ENDPOINTS,
  freeSubscription,
  guestIdentity,
  oneArtifact,
  professionalSubscription,
  providerError,
  quotaExhausted,
  reviewPassed,
  safetyBlocked,
} from "./fixtures/apiFixtures.js";

/**
 * Generation progress and recoverable failure states (STU-377).
 *
 * The Architect, Generator and Review stages all POST to the same pipeline
 * endpoint with a `step` field, so every journey here drives the three real
 * stage transitions with deterministic per-stage responses. Nothing is timed:
 * a stage advances only when its response is released by the test.
 */

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

/**
 * Route the pipeline endpoint per stage. `hold` names the stages whose
 * response the test releases by hand; everything else answers immediately.
 */
async function routePipelineStages(page, { responses = {}, hold = [] } = {}) {
  const gates = Object.fromEntries(hold.map((step) => [step, deferred()]));
  const bodies = [];
  await page.route(ENDPOINTS.pipeline, async (route) => {
    const step = stepOf(route);
    bodies.push(JSON.parse(route.request().postData() || "{}"));
    if (gates[step]) await gates[step].promise;
    const entry = responses[step] ?? STAGE_RESPONSES[step];
    if (entry === "abort") {
      await route.abort();
      return;
    }
    await route.fulfill(typeof entry === "function" ? entry() : entry);
  });
  return { release: (step) => gates[step].resolve(), bodies };
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

const stage = (page, step) => page.locator(`#pdot-${step}`);
const failure = (page) => page.locator("#pipeline-failure");

/**
 * Tab forward from wherever focus currently is, recording the id of each
 * focused element, until every wanted id has been seen or `limit` presses
 * have been spent. Elements without an id (and focus that leaves the page)
 * record an empty string, so callers assert containment, not equality.
 */
async function tabFocusOrder(page, wanted, limit = 60) {
  const seen = [];
  for (let i = 0; i < limit && !wanted.every((id) => seen.includes(id)); i += 1) {
    await page.keyboard.press("Tab");
    seen.push(await page.evaluate(() => document.activeElement?.id ?? ""));
  }
  return seen;
}

test.describe("Generation progress binds to real stage events", () => {
  test("walks Architect to Generator to Review and never completes a stage early", async ({ page }) => {
    await openHome(page);
    const pipeline = await routePipelineStages(page, {
      hold: ["architect", "generator", "review"],
    });

    await page.locator("#pipeline-input").fill("A gauge widget");
    await page.locator("#hero-send").click();

    // Stage 1 is busy; nothing downstream claims to have happened.
    await expect(stage(page, 1)).toHaveAttribute("data-state", "active");
    await expect(stage(page, 2)).toHaveAttribute("data-state", "pending");
    await expect(stage(page, 3)).toHaveAttribute("data-state", "pending");
    await expect(stage(page, 3)).toBeDisabled();
    await expect(page.locator("#pipeline-submitted-prompt")).toHaveText("A gauge widget");
    await expect(page.locator("#hero-send")).toBeDisabled();
    await expect(page.locator("#results-view")).not.toHaveClass(/visible/);

    pipeline.release("architect");
    await expect(stage(page, 1)).toHaveAttribute("data-state", "done");
    await expect(stage(page, 2)).toHaveAttribute("data-state", "active");
    await expect(stage(page, 3)).toHaveAttribute("data-state", "pending");

    pipeline.release("generator");
    await expect(stage(page, 2)).toHaveAttribute("data-state", "done");
    await expect(stage(page, 3)).toHaveAttribute("data-state", "active");
    await expect(page.locator("#results-view")).not.toHaveClass(/visible/);

    pipeline.release("review");
    await expect(stage(page, 3)).toHaveAttribute("data-state", "done");
    await expect(page.locator("#results-view")).toHaveClass(/visible/);
    // The panel expands into Results, and the expansion settles on its own.
    await expect(page.locator(".composer-morph")).toHaveCount(0, { timeout: 4000 });
    // The control that started the run is usable again.
    await expect(page.locator("#hero-send")).toBeEnabled();

    // Each stage really ran, in order.
    expect(pipeline.bodies.map((body) => body.step)).toEqual([
      "architect",
      "generator",
      "review",
    ]);
  });

  test("announces the current stage politely and reaches every stage by keyboard", async ({ page }) => {
    await openHome(page);
    const pipeline = await routePipelineStages(page, { hold: ["review"] });

    await page.locator("#hero-send").click();
    const status = page.locator("#pipeline-status");
    await expect(status).toHaveAttribute("aria-live", "polite");
    await expect(status).toContainText("Code Review");

    // Stages that actually ran are reachable, semantic buttons.
    await expect(stage(page, 1)).toHaveJSProperty("tagName", "BUTTON");
    await expect(stage(page, 1)).toBeEnabled();
    // Canonical Step N of 3 is the compact disclosure for stage inspection.
    await page.locator('#progress-stage-count').click();
    await stage(page, 1).click();
    await expect(stage(page, 1)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#progress-title-text")).toContainText("Prompt understood");

    pipeline.release("review");
    await expect(page.locator("#results-view")).toHaveClass(/visible/);
  });

  test("the track eases through each stage's slice instead of jumping", async ({ page }) => {
    await openHome(page);
    const pipeline = await routePipelineStages(page, {
      hold: ["architect", "generator", "review"],
    });

    await page.locator("#pipeline-input").fill("A gauge widget");
    await page.locator("#hero-send").click();
    await expect(stage(page, 1)).toHaveAttribute("data-state", "active");

    // Sample the fill while stage 1 is held: it moves continuously inside
    // the stage's third of the track, never claiming the slice is done.
    const widths = await page.evaluate(async () => {
      const seen = [];
      const deadline = Date.now() + 2500;
      const fill = document.getElementById("pipeline-progress-fill");
      while (Date.now() < deadline) {
        const value = parseFloat(fill.style.width) || 0;
        if (seen[seen.length - 1] !== value) seen.push(value);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return seen;
    });
    expect(widths.length).toBeGreaterThan(1);
    for (let index = 1; index < widths.length; index += 1) {
      expect(widths[index]).toBeGreaterThan(widths[index - 1]);
    }
    expect(widths[widths.length - 1]).toBeLessThan(100 / 3);

    const trackWidth = () =>
      page.evaluate(
        () => parseFloat(document.getElementById("pipeline-progress-fill").style.width) || 0,
      );

    // Completing the stage lands the bar on its real boundary, and the next
    // stage eases forward from there rather than snapping to the end.
    pipeline.release("architect");
    await expect(stage(page, 2)).toHaveAttribute("data-state", "active");
    await expect.poll(trackWidth).toBeGreaterThan(100 / 3 + 0.5);

    pipeline.release("generator");
    await expect(stage(page, 3)).toHaveAttribute("data-state", "active");
    await expect.poll(trackWidth).toBeGreaterThan((200 / 3) + 0.5);

    pipeline.release("review");
    await expect(page.locator("#results-view")).toHaveClass(/visible/);
  });
});

test.describe("Recoverable failure states", () => {
  for (const width of [360, 390]) {
    test(`safety rejection stays readable and actionable at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openHome(page);
      await routePipelineStages(page, { responses: { architect: safetyBlocked } });

      await page.locator("#pipeline-input").fill("Something the safety screen refuses");
      await page.locator("#hero-send").click();

      await expect(failure(page)).toBeVisible();
      await expect(page.locator("#pipeline-failure-title")).toContainText("Prompt Architect");
      await expect(page.locator("#pipeline-failure-message")).toContainText("safety check");
      await expect(
        failure(page).locator('button[data-action="edit"]'),
      ).toBeVisible();
      // A safety block is not fixed by re-sending the same content.
      await expect(failure(page).locator('button[data-action="retry"]')).toHaveCount(0);

      // Persistent: still there a second later, unlike a toast.
      await page.waitForTimeout(1000);
      await expect(failure(page)).toBeVisible();

      // No success result is rendered, and the stage is not marked complete.
      await expect(page.locator("#results-view")).not.toHaveClass(/visible/);
      await expect(stage(page, 1)).toHaveAttribute("data-state", "failed");
      await expect(stage(page, 2)).toHaveAttribute("data-state", "pending");

      // The panel and its actions are inside the viewport, not clipped away.
      await expect(page.locator("#main-stage-container")).toBeVisible();
      const box = await failure(page).boundingBox();
      expect(box.width).toBeLessThanOrEqual(width);
      expect(box.x).toBeGreaterThanOrEqual(0);
    });

    test(`quota rejection offers an upgrade at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openHome(page);
      await routePipelineStages(page, { responses: { generator: quotaExhausted } });

      await page.locator("#hero-send").click();

      await expect(failure(page)).toBeVisible();
      await expect(failure(page)).toHaveAttribute("data-kind", "quota");
      await expect(failure(page).locator('button[data-action="upgrade"]')).toBeVisible();
      await expect(page.locator("#results-view")).not.toHaveClass(/visible/);
      await expect(stage(page, 2)).toHaveAttribute("data-state", "failed");
      await expect(page.locator("#hero-send")).toBeEnabled();
    });
  }

  for (const [step, stageName] of [
    [1, "architect"],
    [3, "review"],
  ]) {
    test(`a ${stageName} quota rejection keeps the upgrade action`, async ({ page }) => {
      await openHome(page);
      await routePipelineStages(page, { responses: { [stageName]: quotaExhausted } });

      await page.locator("#hero-send").click();

      await expect(failure(page)).toBeVisible();
      await expect(failure(page)).toHaveAttribute("data-kind", "quota");
      await expect(failure(page).locator('button[data-action="upgrade"]')).toBeVisible();
      await expect(stage(page, step)).toHaveAttribute("data-state", "failed");
      await expect(failure(page).locator('button[data-action="retry"]')).toHaveCount(0);
    });
  }

  test("a terminated run focuses a usable action and can be walked by keyboard", async ({ page }) => {
    await openHome(page);
    await routePipelineStages(page, { responses: { generator: providerError } });

    await page.locator("#hero-send").click();
    await expect(failure(page)).toBeVisible();

    // Termination leaves keyboard focus on a permitted action.
    const focusedAction = await page.evaluate(() => document.activeElement?.dataset?.action);
    expect(["retry", "edit", "upgrade"]).toContain(focusedAction);

    await page.keyboard.press("Tab");
    const nextAction = await page.evaluate(() => document.activeElement?.dataset?.action);
    expect(nextAction).toBeTruthy();
    expect(nextAction).not.toEqual(focusedAction);
  });

  test("a network failure never renders a result and a retry re-sends the same prompt", async ({ page }) => {
    await openHome(page);
    const firstAttempt = await routePipelineStages(page, {
      responses: { architect: "abort" },
    });

    const prompt = "A signature pad that exports a transparent PNG";
    await page.locator("#pipeline-input").fill(prompt);
    await page.locator("#hero-send").click();

    await expect(failure(page)).toBeVisible();
    await expect(page.locator("#results-view")).not.toHaveClass(/visible/);
    expect(firstAttempt.bodies[0].prompt).toContain(prompt);

    // The service recovers; the retry action re-runs what the user submitted.
    const retry = await routePipelineStages(page);
    await failure(page).locator('button[data-action="retry"]').click();

    await expect(page.locator("#results-view")).toHaveClass(/visible/);
    await expect(failure(page)).toBeHidden();
    expect(retry.bodies[0].prompt).toContain(prompt);
    await expect(page.locator("#pipeline-input")).toHaveValue(prompt);
  });

  test("a generator fallback is reported while the run continues", async ({ page }) => {
    // The fallback model is the free tier's only model, so a fallback can only
    // happen for a plan that can select a different one.
    await page.addInitScript(() => {
      localStorage.setItem(
        "ccc_auth_session",
        JSON.stringify({
          email: "pro@example.com",
          sessionToken: "test-session-token-pro",
        }),
      );
    });
    await openHome(page, { [ENDPOINTS.getSubscription]: professionalSubscription() });
    await page.getByRole('button', { name:'Generation settings', exact:true }).click();
    await page.locator('#composer-settings-model').selectOption('anthropic/claude-opus-5');
    await page.locator('#composer-settings-modal').getByRole('button', { name:'Done',exact:true }).click();
    let generatorCalls = 0;
    await page.route(ENDPOINTS.pipeline, async (route) => {
      const step = stepOf(route);
      if (step === "generator") {
        generatorCalls += 1;
        // The first model fails; app.js retries on the fallback model.
        if (generatorCalls === 1) {
          await route.fulfill(providerError());
          return;
        }
      }
      await route.fulfill(STAGE_RESPONSES[step]());
    });

    await page.locator("#hero-send").click();

    await expect(page.locator("#pipeline-note")).toContainText("Continuing on");
    await expect(page.locator("#results-view")).toHaveClass(/visible/);
    expect(generatorCalls).toBe(2);
  });

  test("editing the prompt returns to the composer with the prompt intact", async ({ page }) => {
    await openHome(page);
    await routePipelineStages(page, { responses: { architect: providerError } });

    const prompt = "A gauge that fills on drag";
    await page.locator("#pipeline-input").fill(prompt);
    await page.locator("#hero-send").click();

    await expect(failure(page)).toBeVisible();
    await failure(page).locator('button[data-action="edit"]').click();

    const composer = page.locator("#pipeline-input");
    await expect(composer).toHaveValue(prompt);
    await expect(composer).toBeFocused();
    await expect(page.locator("#pipeline-failure")).toBeHidden();
  });

  test("a quota refusal on the fallback model still offers an upgrade", async ({ page }) => {
    // The fallback is only reachable on a plan that can pick a non-free model.
    await page.addInitScript(() => {
      localStorage.setItem(
        "ccc_auth_session",
        JSON.stringify({
          email: "pro@example.com",
          sessionToken: "test-session-token-pro",
        }),
      );
    });
    await openHome(page, { [ENDPOINTS.getSubscription]: professionalSubscription() });
    await page.getByRole('button', { name:'Generation settings', exact:true }).click();
    await page.locator('#composer-settings-model').selectOption('anthropic/claude-opus-5');
    await page.locator('#composer-settings-modal').getByRole('button', { name:'Done',exact:true }).click();
    let generatorCalls = 0;
    await page.route(ENDPOINTS.pipeline, async (route) => {
      const step = stepOf(route);
      if (step === "generator") {
        generatorCalls += 1;
        // Primary fails for an ordinary provider reason; the fallback 429s.
        await route.fulfill(generatorCalls === 1 ? providerError() : quotaExhausted());
        return;
      }
      await route.fulfill(STAGE_RESPONSES[step]());
    });

    await page.locator("#hero-send").click();

    // The fallback's quota signal survives: the panel reads as an allowance
    // problem with an upgrade, not a generic failure with a useless retry.
    await expect(failure(page)).toBeVisible();
    await expect(failure(page)).toHaveAttribute("data-kind", "quota");
    await expect(failure(page).locator('button[data-action="upgrade"]')).toBeVisible();
    await expect(failure(page).locator('button[data-action="retry"]')).toHaveCount(0);
    expect(generatorCalls).toBe(2);
  });

  test("a retry re-sends the submitted images unchanged", async ({ page }) => {
    await openHome(page);
    // The image endpoint answers with the external URL the pipeline receives.
    await page.route("**/service/runpipeline-image", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { index: 0, work: { type: "external-url", file: "https://img.example/ref.png" } },
        ]),
      }),
    );
    const pipeline = await routePipelineStages(page, {
      responses: { architect: providerError },
    });

    const uploadDone = page.waitForResponse("**/service/runpipeline-image");
    await page.locator("#prompt-image-input").setInputFiles({
      name: "ref.png",
      mimeType: "image/png",
      buffer: Buffer.from("89504e470d0a1a0a", "hex"),
    });
    await uploadDone;
    // The upload job commits its entry a tick after the response lands.
    await page.waitForTimeout(150);

    await page.locator("#pipeline-input").fill("A dial from the sketch");
    await page.locator("#hero-send").click();
    await expect(failure(page)).toBeVisible();

    // The architect request carried the uploaded image URL.
    expect(pipeline.bodies[0].images).toEqual([{ url: "https://img.example/ref.png" }]);

    const firstAttemptBodies = pipeline.bodies.length;
    await failure(page).locator('button[data-action="retry"]').click();
    await expect(failure(page)).toBeVisible();

    // The retry sent the images as submitted, not whatever the composer holds now.
    expect(pipeline.bodies[firstAttemptBodies].images).toEqual([
      { url: "https://img.example/ref.png" },
    ]);
  });
});

test.describe("Stateful transitions stay isolated per run", () => {
  test("a second submission while a run is in flight is ignored", async ({ page }) => {
    await openHome(page);
    const pipeline = await routePipelineStages(page, { hold: ["review"] });

    await page.locator("#pipeline-input").fill("A countdown ring");
    // Two submissions land inside the same preflight window. The run is
    // claimed before the first await, so the second call must not start a
    // concurrent run beside the first.
    await page.evaluate(() => {
      window.runThinkingPipeline();
      window.runThinkingPipeline();
    });

    await expect(stage(page, 2)).toHaveAttribute("data-state", "done");
    pipeline.release("review");
    await expect(page.locator("#results-view")).toHaveClass(/visible/);

    // Exactly one run's worth of requests ever left the page.
    expect(pipeline.bodies.map((body) => body.step)).toEqual([
      "architect",
      "generator",
      "review",
    ]);
  });

  test("editing mid-run abandons it: the send control is restored and the abandoned run never opens Results", async ({ page }) => {
    await openHome(page);
    const pipeline = await routePipelineStages(page, { hold: ["generator"] });

    const prompt = "A gauge that fills on drag";
    await page.locator("#pipeline-input").fill(prompt);
    await page.locator("#hero-send").click();
    await expect(stage(page, 2)).toHaveAttribute("data-state", "active");

    // Edit while Generator is in flight: the run is abandoned, the request
    // cancelled, and the composer is usable again immediately.
    await page.locator("#pipeline-edit-prompt").click();
    await expect(page.locator("#pipeline-progress")).not.toHaveClass(/visible/);
    await expect(page.locator("#pipeline-input")).toHaveValue(prompt);
    await expect(page.locator("#hero-send")).toBeEnabled();

    // The abandoned run's late response can never reopen Results behind the
    // composer's back — and it never even reaches the next stage.
    pipeline.release("generator");
    await page.waitForTimeout(300);
    await expect(page.locator("#results-view")).not.toHaveClass(/visible/);
    expect(
      pipeline.bodies.filter((body) => body.step === "review"),
    ).toHaveLength(0);

    // Editing freed the pipeline: the same prompt runs cleanly end to end.
    const secondRun = await routePipelineStages(page);
    await page.locator("#hero-send").click();
    await expect(page.locator("#results-view")).toHaveClass(/visible/);
    expect(secondRun.bodies[0].prompt).toContain(prompt);
  });

  test("refinement re-enters at stage 2, leaves Architect skipped, and survives the hide window", async ({ page }) => {
    await openHome(page);
    await routePipelineStages(page);

    await page.locator("#pipeline-input").fill("A progress ring");
    await page.locator("#hero-send").click();
    await expect(page.locator("#results-view")).toHaveClass(/visible/);

    // The refinement's own run gets a fresh gate on Generator so the test
    // controls exactly when its stage advances.
    const refinement = await routePipelineStages(page, { hold: ["generator"] });

    // Refining starts inside the previous run's 400ms hide window: its
    // progress must not be blanked by the earlier run's delayed hide.
    await page.locator("#btn-refine-header").click();

    await expect(page.locator("#pipeline-progress")).toHaveClass(/visible/);
    // Re-entering at stage 2 never paints the untouched Architect as done,
    // and a stage that never ran is not selectable either.
    await expect(stage(page, 1)).toHaveAttribute("data-state", "skipped");
    await expect(stage(page, 1)).toBeDisabled();
    await expect(stage(page, 2)).toHaveAttribute("data-state", "active");
    await expect(stage(page, 3)).toHaveAttribute("data-state", "pending");

    // Well past the 400ms window the refinement run is still on screen.
    await page.waitForTimeout(700);
    await expect(page.locator("#pipeline-progress")).toHaveClass(/visible/);

    refinement.release("generator");
    await expect(page.locator("#results-view")).toHaveClass(/visible/);
    await expect(stage(page, 3)).toHaveAttribute("data-state", "done");
    await expect(stage(page, 1)).toHaveAttribute("data-state", "skipped");
  });

  test("a failed refinement keeps a recoverable failure state and Retry re-runs the refinement", async ({ page }) => {
    await openHome(page);
    await routePipelineStages(page);

    await page.locator("#pipeline-input").fill("A progress ring");
    await page.locator("#hero-send").click();
    await expect(page.locator("#results-view")).toHaveClass(/visible/);

    // The refinement's generator call fails. STU-379: the run must NOT blank
    // the previous result — it stays visible and copyable behind a persistent
    // error + retry banner, never a transient toast over an empty stage.
    await routePipelineStages(page, { responses: { generator: providerError } });
    await page.locator("#btn-refine-header").click();

    await expect(page.locator("#results-view")).toHaveClass(/visible/);
    await expect(page.locator("#results-replacement-error")).not.toBeHidden();
    await expect(page.locator("#results-replacement-error-retry")).toBeVisible();
    await expect(page.locator("#hero-send")).toBeEnabled();

    // Well past the hide window the failure is still on screen — a toast
    // alone would have left behind only the floating result.
    await page.waitForTimeout(700);
    await expect(page.locator("#results-replacement-error")).not.toBeHidden();

    // Retry re-enters the same refinement flow (Generator then Review), not
    // a brand-new pipeline run from the Architect.
    const retryRun = await routePipelineStages(page);
    await page.locator("#results-replacement-error-retry").click();
    await expect(page.locator("#results-view")).toHaveClass(/visible/);
    expect(retryRun.bodies.map((body) => body.step)).toEqual(["generator", "review"]);
  });

  test("editing mid-regeneration restores the regeneration control", async ({ page }) => {
    await openHome(page);
    await routePipelineStages(page);

    await page.locator("#pipeline-input").fill("A progress ring");
    await page.locator("#hero-send").click();
    await expect(page.locator("#results-view")).toHaveClass(/visible/);

    const refinement = await routePipelineStages(page, { hold: ["generator"] });
    await page.locator("#btn-refine-header").click();
    await expect(stage(page, 2)).toHaveAttribute("data-state", "active");

    // Editing abandons the refinement — its trigger must not stay disabled
    // for the results that come after it.
    await page.locator("#pipeline-edit-prompt").click();
    await expect(page.locator("#btn-refine-header")).toBeEnabled();

    // A later run's Results view offers a usable Refine control again.
    await routePipelineStages(page);
    await page.locator("#hero-send").click();
    await expect(page.locator("#results-view")).toHaveClass(/visible/);
    await expect(page.locator("#btn-refine-header")).toBeEnabled();

    // The abandoned run's late response is still discarded.
    refinement.release("generator");
    await page.waitForTimeout(300);
    await expect(page.locator("#results-view")).toHaveClass(/visible/);
  });

  test("a failed pasted-errors regeneration keeps a recoverable failure state", async ({ page }) => {
    await openHome(page);
    await routePipelineStages(page);

    await page.locator("#pipeline-input").fill("A dial");
    await page.locator("#hero-send").click();
    await expect(page.locator("#results-view")).toHaveClass(/visible/);

    await routePipelineStages(page, { responses: { generator: providerError } });
    await page.locator("#btn-error-regen-header").click();
    await page.locator("#ff-error-paste-input").fill("Widget build failed: missing return");
    await page.locator("#btn-fix-from-errors").click();

    // STU-379: a failed replacement keeps the previous result visible and
    // copyable behind a persistent error + retry banner.
    await expect(page.locator("#results-view")).toHaveClass(/visible/);
    await expect(page.locator("#results-replacement-error")).not.toBeHidden();
    await expect(page.locator("#results-replacement-error-retry")).toBeVisible();
  });
});

test.describe("Motion is decorative and settles safely", () => {
  test("reduced motion conveys the same state without any morph overlay", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openHome(page);
    const pipeline = await routePipelineStages(page, { hold: ["review"] });

    await page.locator("#hero-send").click();

    await expect(stage(page, 1)).toHaveAttribute("data-state", "done");
    await expect(stage(page, 3)).toHaveAttribute("data-state", "active");
    await expect(page.locator(".composer-morph")).toHaveCount(0);

    pipeline.release("review");
    await expect(page.locator("#results-view")).toHaveClass(/visible/);
    await expect(page.locator(".composer-morph")).toHaveCount(0);
  });

  test("the composer hands off to the pipeline on the authored 1120ms clock", async ({ page }) => {
    await openHome(page);
    const pipeline = await routePipelineStages(page, { hold: ["architect"] });

    await page.locator("#hero-send").click();

    const ghost = page.locator(".composer-morph");
    await expect(ghost).toHaveCount(1);
    // The outline runs on the --t-morph token, and never covers the panel it
    // is handing over to.
    const details = await page.evaluate(() => {
      const node = document.querySelector(".composer-morph");
      const token = getComputedStyle(document.documentElement).getPropertyValue("--t-morph").trim();
      return {
        token,
        duration: node.getAnimations()[0]?.effect?.getTiming?.().duration,
        ariaHidden: node.getAttribute("aria-hidden"),
      };
    });
    expect(details.token).toBe("1120ms");
    expect(details.duration).toBe(1120);
    expect(details.ariaHidden).toBe("true");
    // Real state is readable while the decoration plays.
    await expect(page.locator("#progress-title-text")).toBeVisible();

    // It settles on its own, leaving nothing behind.
    await expect(ghost).toHaveCount(0, { timeout: 4000 });

    pipeline.release("architect");
    await expect(stage(page, 1)).toHaveAttribute("data-state", "done");
  });

  test("a resize mid-run leaves exactly one active view and no orphaned overlay", async ({ page }) => {
    await openHome(page);
    const pipeline = await routePipelineStages(page, { hold: ["architect"] });

    await page.locator("#hero-send").click();
    // Interrupt the hand-off while it is genuinely mid-flight.
    await expect(page.locator(".composer-morph")).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });

    await expect(page.locator(".composer-morph")).toHaveCount(0);
    await expect(page.locator("#pipeline-progress")).toHaveClass(/visible/);
    await expect(page.locator("#results-view")).not.toHaveClass(/visible/);

    pipeline.release("architect");
    await expect(stage(page, 1)).toHaveAttribute("data-state", "done");
  });
});

test.describe("Holding window matches the canonical pipeline view", () => {
  test("desktop: the mock's layout, type, bar and meta replace the legacy spinner", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHome(page);
    const pipeline = await routePipelineStages(page, { hold: ["architect", "generator"] });

    await page
      .locator("#pipeline-input")
      .fill("A circular progress gauge with an animated percentage label");
    await page.locator("#hero-send").click();
    await expect(stage(page, 1)).toHaveAttribute("data-state", "active");
    // The stage flips to display:flex one animation frame after the run
    // starts; wait for real layout before measuring.
    await expect(page.locator(".pipeline-view")).toBeVisible();

    // The legacy </> spinner is gone; the authored mark is the only glyph.
    await expect(page.locator(".pipeline-progress-icon")).toHaveCount(0);
    await expect(page.locator(".pipeline-glyph.logo-loop")).toHaveCount(1);

    const probe = await page.evaluate(() => {
      const style = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el) : null;
      };
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y) };
      };
      // Counts top-level tracks without splitting inside minmax()/var().
      const trackCount = (value) => {
        let depth = 0;
        let count = 1;
        for (const ch of value) {
          if (ch === "(") depth += 1;
          else if (ch === ")") depth -= 1;
          else if (ch === " " && depth === 0) count += 1;
        }
        return count;
      };
      const tokenProbe = document.createElement("span");
      tokenProbe.style.color = "var(--fg)";
      document.body.appendChild(tokenProbe);
      const fg = getComputedStyle(tokenProbe).color;
      tokenProbe.remove();
      const description = document.querySelector("#progress-description-text");
      const columns = style("#main-stage-container")?.gridTemplateColumns ?? "";
      return {
        columns,
        columnCount: trackCount(columns),
        firstColumn: columns.split(" ")[0] ?? null,
        titleSize: style("#progress-title-text")?.fontSize ?? null,
        titleWeight: style("#progress-title-text")?.fontWeight ?? null,
        description: description ? description.textContent.trim() : null,
        descriptionSize: style("#progress-description-text")?.fontSize ?? null,
        trackHeight: style(".progress-track")?.height ?? null,
        trackRadius: style(".progress-track")?.borderRadius ?? null,
        fillColor: style("#pipeline-progress-fill")?.backgroundColor ?? null,
        metaFont: style("#progress-stage-count")?.fontFamily ?? null,
        metaSize: style("#progress-stage-count")?.fontSize ?? null,
        recapBorder: style(".pipeline-prompt-recap")?.borderRightWidth ?? null,
        activeDot: style("#pdot-1 .progress-dot")?.backgroundColor ?? null,
        fg,
        title: box("#progress-title-text"),
        mark: box(".pipeline-glyph.logo-loop"),
        recap: box(".pipeline-prompt-recap"),
        view: box(".pipeline-view"),
      };
    });

    // Two-column panel: prompt sidebar on the left, stage view in the main
    // column, separated by the mock's hairline.
    expect(probe.columnCount).toBe(2);
    expect(probe.firstColumn).toBe("310px");
    expect(probe.recap).not.toBeNull();
    expect(probe.view).not.toBeNull();
    expect(probe.recap.x).toBeLessThan(probe.view.x);
    expect(probe.recapBorder).toBe("1px");

    // The mark rests on the copy's left edge, as in the mock.
    expect(probe.mark.x).toBe(probe.title.x);

    // The mock's typography and the supporting line from its stage copy.
    expect(probe.titleSize).toBe("34px");
    expect(probe.titleWeight).toBe("500");
    expect(probe.description).toBe("Turning your idea into a clear FlutterFlow specification.");
    expect(probe.descriptionSize).toBe("16px");

    // One 4px pill, fg on the track token - never the indigo gradient.
    expect(probe.trackHeight).toBe("4px");
    expect(probe.trackRadius).toBe("999px");
    expect(probe.fillColor).toBe(probe.fg);

    // The meta line is the mock's mono line, not an 11px sans subtitle.
    expect(probe.metaFont).toContain("DM Mono");
    expect(probe.metaSize).toBe("12px");

    // The stage nav keeps its semantics but paints in the system's ink.
    expect(probe.activeDot).toBe(probe.fg);

    // The visible supporting line follows the mock's stage copy as the run
    // advances, and a completed stage is ink rather than legacy green.
    pipeline.release("architect");
    await expect(stage(page, 2)).toHaveAttribute("data-state", "active");
    await expect(page.locator("#progress-description-text")).toHaveText(
      "Building the Dart source, widget parameters and animation.",
    );
    const doneDot = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--fg)";
      document.body.appendChild(probe);
      const fg = getComputedStyle(probe).color;
      probe.remove();
      return { dot: getComputedStyle(document.querySelector("#pdot-1 .progress-dot")).backgroundColor, fg };
    });
    expect(doneDot.dot).toBe(doneDot.fg);
  });

  test("stacked: the workflow leads and the prompt follows beneath it", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openHome(page);
    const pipeline = await routePipelineStages(page, { hold: ["architect"] });

    await page.locator("#pipeline-input").fill("A gauge widget");
    await page.locator("#hero-send").click();
    await expect(stage(page, 1)).toHaveAttribute("data-state", "active");
    await expect(page.locator(".pipeline-view")).toBeVisible();

    const stacked = await page.evaluate(() => {
      const box = (sel) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
      const view = box(".pipeline-view");
      const recap = box(".pipeline-prompt-recap");
      const round = (r) =>
        r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) } : null;
      return { view: round(view), recap: round(recap) };
    });
    expect(stacked.view).not.toBeNull();
    expect(stacked.recap).not.toBeNull();
    // One column: both blocks share the panel's full width.
    expect(stacked.view.x).toBe(stacked.recap.x);
    expect(stacked.view.w).toBe(stacked.recap.w);
    // The workflow leads; the prompt follows beneath it (the mock's order).
    expect(stacked.view.y).toBeLessThan(stacked.recap.y);
    await expect(page.locator("#pipeline-edit-prompt")).toBeVisible();

    pipeline.release("architect");
    await expect(stage(page, 1)).toHaveAttribute("data-state", "done");
  });

  test("stacked: keyboard focus follows the workflow-then-prompt order", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openHome(page);
    const pipeline = await routePipelineStages(page, { hold: ["architect"] });

    await page.locator("#pipeline-input").fill("A gauge widget");
    await page.locator("#hero-send").click();
    await expect(stage(page, 1)).toHaveAttribute("data-state", "active");
    await expect(page.locator(".pipeline-view")).toBeVisible();

    // Walk the page with Tab until both panel regions have been focused. The
    // active stage button must be reached before the recap's Edit prompt:
    // the workflow is what is displayed first at this width, and CSS order
    // must not make focus jump backward against the screen.
    await page.locator('#progress-stage-count').focus();
    const focusOrder = await tabFocusOrder(page, ["pdot-1", "pipeline-edit-prompt"]);
    expect(focusOrder).toContain("pdot-1");
    expect(focusOrder).toContain("pipeline-edit-prompt");
    expect(focusOrder.indexOf("pdot-1")).toBeLessThan(
      focusOrder.indexOf("pipeline-edit-prompt"),
    );

    // The document order backs the focus order, and it matches the screen.
    const regions = await page.evaluate(() => {
      const view = document.querySelector(".pipeline-view");
      const recap = document.querySelector(".pipeline-prompt-recap");
      return {
        viewBeforeRecap: Boolean(
          view.compareDocumentPosition(recap) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
        viewY: Math.round(view.getBoundingClientRect().y),
        recapY: Math.round(recap.getBoundingClientRect().y),
      };
    });
    expect(regions.viewBeforeRecap).toBe(true);
    expect(regions.viewY).toBeLessThan(regions.recapY);

    pipeline.release("architect");
    await expect(stage(page, 1)).toHaveAttribute("data-state", "done");
  });

  test("desktop: keyboard focus follows the prompt-then-workflow order", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHome(page);
    const pipeline = await routePipelineStages(page, { hold: ["architect"] });

    await page.locator("#pipeline-input").fill("A gauge widget");
    await page.locator("#hero-send").click();
    await expect(stage(page, 1)).toHaveAttribute("data-state", "active");
    await expect(page.locator(".pipeline-view")).toBeVisible();

    // The recap is the left column on desktop, so it leads the DOM and the
    // tab order: Edit prompt is reached before the active stage button, and
    // focus never travels from the right column back to the left.
    // Anchor the walk on a known element rather than blurring: blur() does not
    // move Chromium's sequential-focus-navigation starting point, so the sweep
    // would resume wherever focus last was and wrap around before reaching the
    // recap. The avatar is the last tabbable ahead of the panel, so the walk
    // enters at the recap -- mirroring the stacked test's #progress-stage-count
    // anchor, which is likewise the tabbable just before the first one it wants.
    await page.locator("#topbar-avatar").focus();
    const focusOrder = await tabFocusOrder(page, ["pipeline-edit-prompt", "pdot-1"]);
    expect(focusOrder).toContain("pipeline-edit-prompt");
    expect(focusOrder).toContain("pdot-1");
    expect(focusOrder.indexOf("pipeline-edit-prompt")).toBeLessThan(
      focusOrder.indexOf("pdot-1"),
    );

    // The document order backs the focus order, and it matches the screen.
    const regions = await page.evaluate(() => {
      const view = document.querySelector(".pipeline-view");
      const recap = document.querySelector(".pipeline-prompt-recap");
      return {
        recapBeforeView: Boolean(
          recap.compareDocumentPosition(view) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
        recapX: Math.round(recap.getBoundingClientRect().x),
        viewX: Math.round(view.getBoundingClientRect().x),
      };
    });
    expect(regions.recapBeforeView).toBe(true);
    expect(regions.recapX).toBeLessThan(regions.viewX);

    pipeline.release("architect");
    await expect(stage(page, 1)).toHaveAttribute("data-state", "done");
  });

  test("resizing across the breakpoint keeps focus inside the moved recap", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHome(page);
    const pipeline = await routePipelineStages(page, { hold: ["architect"] });

    await page.locator("#pipeline-input").fill("A gauge widget");
    await page.locator("#hero-send").click();
    await expect(stage(page, 1)).toHaveAttribute("data-state", "active");

    const order = () =>
      page.evaluate(() => {
        const view = document.querySelector(".pipeline-view");
        const recap = document.querySelector(".pipeline-prompt-recap");
        return {
          focusedId: document.activeElement?.id ?? "",
          recapAfterView: Boolean(
            view.compareDocumentPosition(recap) & Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        };
      });

    // Desktop -> stacked: the recap moves behind the view and reparenting must
    // not drop the focus its Edit prompt was holding.
    // Wait for the composer -> pipeline morph: until .pipeline-view is visible
    // the Edit prompt is still 0x0, so focus() lands on nothing and the send
    // button simply blurs to BODY.
    await expect(page.locator(".pipeline-view")).toBeVisible();
    await page.locator("#pipeline-edit-prompt").focus();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(order, { message: "stacked order: view leads, focus retained" })
      .toEqual({ focusedId: "pipeline-edit-prompt", recapAfterView: true });

    // Stacked -> desktop: the recap moves back ahead of the view, still with
    // focus intact.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect
      .poll(order, { message: "desktop order: recap leads, focus retained" })
      .toEqual({ focusedId: "pipeline-edit-prompt", recapAfterView: false });

    pipeline.release("architect");
    await expect(stage(page, 1)).toHaveAttribute("data-state", "done");
  });

  test("stacked: a failure's actions stay ahead of the recap in DOM and focus order", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openHome(page);
    const pipeline = await routePipelineStages(page, {
      hold: ["architect"],
      responses: { architect: providerError },
    });

    await page.locator("#pipeline-input").fill("A gauge widget");
    await page.locator("#hero-send").click();
    await expect(stage(page, 1)).toHaveAttribute("data-state", "active");

    pipeline.release("architect");
    await expect(failure(page)).toBeVisible();
    await expect(failure(page).locator('button[data-action="edit"]')).toBeVisible();

    // Every failure action lives in the workflow region, which still precedes
    // the recap in the document and on screen.
    const regions = await page.evaluate(() => {
      const view = document.querySelector(".pipeline-view");
      const recap = document.querySelector(".pipeline-prompt-recap");
      const edit = document.getElementById("pipeline-edit-prompt");
      const actions = [...document.querySelectorAll("#pipeline-failure-actions button")];
      return {
        viewBeforeRecap: Boolean(
          view.compareDocumentPosition(recap) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
        actionsBeforeRecapEdit: actions.every((action) =>
          Boolean(action.compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING),
        ),
        viewY: Math.round(view.getBoundingClientRect().y),
        recapY: Math.round(recap.getBoundingClientRect().y),
      };
    });
    expect(regions.viewBeforeRecap).toBe(true);
    expect(regions.actionsBeforeRecapEdit).toBe(true);
    expect(regions.viewY).toBeLessThan(regions.recapY);

    // Termination focuses a permitted action; tabbing on reaches the recap's
    // Edit prompt without jumping back up the page.
    const focusedAction = await page.evaluate(() => document.activeElement?.dataset?.action);
    expect(["retry", "edit", "upgrade"]).toContain(focusedAction);
    const afterActions = await tabFocusOrder(page, ["pipeline-edit-prompt"], 4);
    expect(afterActions).toContain("pipeline-edit-prompt");
  });
});
