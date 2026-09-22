import { test, expect } from "@playwright/test";
import {
  applyDefaultRoutes,
  ENDPOINTS,
  ok,
  providerError,
  reviewPassed,
  oneArtifact,
  freeSubscription,
} from "./fixtures/apiFixtures.js";

/**
 * STU-379 — Preserve previous results through refinement and build-error
 * regeneration.
 *
 * Refinement ("Refine & Regenerate") and pasted-build-error regeneration
 * ("Add FlutterFlow Build Errors & Regenerate") must hold the prior
 * successful result — selected artifact, full bundle, prompt, review — until
 * a replacement generation AND review both succeed. A generator failure or a
 * reviewer failure must restore that previous result and keep it inspectable
 * and copyable behind a persistent error + retry affordance; a toast alone is
 * not enough. A successful replacement swaps in the new result and reconciles
 * selection without stale tabs, and cancel/empty build-error input preserves
 * the surrounding context.
 *
 * Every route is deterministic and hermetic: nothing is timed, no wall clock,
 * no live endpoint — each stage advances only when its intercepted response
 * is fulfilled.
 */

const ARTIFACT_ID = "custom-action-greet-user";
const WEEK = new Date().toISOString().slice(0, 7);

function makeBundle(code) {
  return {
    schemaVersion: "1.0.0",
    id: "bundle-test-379",
    title: "Deterministic STU-379 bundle",
    description: "",
    artifacts: [
      {
        id: ARTIFACT_ID,
        artifactType: "CustomAction",
        artifactName: "GreetUser",
        fileName: "greet_user.dart",
        code,
        dependencies: [],
        imports: [],
        publicApi: [],
        relationships: [],
        deployStatus: "pending",
        review: null,
        metadata: {},
        codeType: "A",
      },
    ],
    dependencies: [],
    relationships: [],
    deployOrder: [ARTIFACT_ID],
    warnings: [],
    metadata: {},
  };
}

const generatorFor = (bundle) =>
  ok({
    output: JSON.stringify(bundle),
    usage_status: "success",
    usage_count: 1,
    usage_month: WEEK,
  });

const reviewFor = (summary) =>
  ok({
    output: JSON.stringify({
      overallReview: { status: "pass", score: 99, summary },
      findings: [],
      artifacts: [{ id: ARTIFACT_ID, review: { status: "pass", findings: [] } }],
    }),
  });

const OLD = makeBundle("string oldGreeting() { return 'old'; }");
const NEW = makeBundle("string newGreeting() { return 'new'; }");

function stepOf(route) {
  try {
    return JSON.parse(route.request().postData() || "{}").step || "";
  } catch {
    return "";
  }
}

/**
 * Intercept the shared pipeline endpoint. The Architect stage always answers
 * with the spec fixture. The FIRST generator/review responses establish the
 * initial successful result; subsequent generator/review responses drive the
 * replacement run.
 *
 * @param {object} c
 * @param {object} c.generate - how a replacement generator answers: a bundle,
 *   or `providerError` to force a generator failure.
 * @param {object} c.review - how a replacement review answers: a summary
 *   object, or `providerError` to force a reviewer failure.
 * @returns {{generatorCalls:()=>number, reviewCalls:()=>number}}
 */
async function routePipeline(page, { generate, review }) {
  let gens = 0;
  let revs = 0;
  await page.route(ENDPOINTS.pipeline, async (route) => {
    const step = stepOf(route);
    if (step === "architect") {
      await route.fulfill(oneArtifact());
      return;
    }
    if (step === "generator") {
      gens += 1;
      if (gens === 1) {
        await route.fulfill(generatorFor(OLD));
        return;
      }
      await route.fulfill(typeof generate === "function" ? generate(gens) : generate);
      return;
    }
    if (step === "review") {
      revs += 1;
      if (revs === 1) {
        await route.fulfill(reviewPassed());
        return;
      }
      await route.fulfill(typeof review === "function" ? review(revs) : review);
      return;
    }
    await route.fulfill(oneArtifact());
  });
  return {
    generatorCalls: () => gens,
    reviewCalls: () => revs,
  };
}

async function openHome(page, overrides = {}) {
  await page.addInitScript(() => {
    localStorage.setItem("hasSeenWalkthrough", "true");
  });
  await applyDefaultRoutes(page, {
    [ENDPOINTS.getSubscription]: freeSubscription(),
    ...overrides,
  });
  await page.goto("/");
  await expect(page.locator("#pipeline-input")).toBeVisible();
}

async function establishInitialResult(page, router) {
  await page.locator("#pipeline-input").fill("A greeting action");
  await page.locator("#hero-send").click();
  await expect(page.locator("#results-view")).toHaveClass(/visible/);
  await expect(page.locator("#results-code-output")).toContainText("oldGreeting");
  return router;
}

const refineButton = (page) => page.locator("#btn-refine-header");
const banner = (page) => page.locator("#results-replacement-error");
const retryButton = (page) => page.locator("#results-replacement-error-retry");

test.describe("Refinement preserves the previous successful result", () => {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    test(`successful refinement swaps in the new result without stale tabs (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openHome(page);
      const router = await routePipeline(page, {
        generate: generatorFor(NEW),
        review: reviewFor("new review"),
      });
      await establishInitialResult(page, router);

      await refineButton(page).click();

      // The replacement generation + review both succeeded, so the new code
      // and review own the Results surface.
      await expect(page.locator("#results-code-output")).toContainText("newGreeting");
      await expect(page.locator("#results-code-output")).not.toContainText("oldGreeting");
      await expect(page.locator("#results-summary-detail")).toContainText("new review");
      // No stale tabs: the new bundle defines exactly one artifact, and
      // selecting it shows the re-generated code with the selection reconciled.
      await expect(page.locator("#artifact-tabs .artifact-tab")).toHaveCount(1);
      await page.getByRole("tab", { name: /GreetUser/ }).click();
      await expect(page.locator("#results-code-output")).toContainText("newGreeting");
      await expect(
        page.locator(`#artifact-tab-${ARTIFACT_ID}`),
      ).toHaveAttribute("aria-selected", "true");
      await expect(banner(page)).toBeHidden();

      // Usage accounting unchanged: one generator call per replacement, no
      // double charge from the single click.
      expect(router.generatorCalls()).toBe(2);
    });
  }

  test("a generator failure restores the old code, copyable, with a persistent retry (desktop)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHome(page);
    const router = await routePipeline(page, {
      generate: () => providerError(),
      review: reviewFor("unused"),
    });
    await establishInitialResult(page, router);

    await refineButton(page).click();

    // Old code stays inspectable and copyable behind the persistent error.
    await expect(page.locator("#results-view")).toHaveClass(/visible/);
    await expect(page.locator("#results-code-output")).toContainText("oldGreeting");
    await expect(banner(page)).not.toBeHidden();
    await expect(retryButton(page)).toBeVisible();
    // Persistent, unlike a toast: still present a moment later.
    await page.waitForTimeout(900);
    await expect(banner(page)).not.toBeHidden();
    // Keyboard: a failed replacement lands focus on its retry control.
    await expect(retryButton(page)).toBeFocused();

    expect(router.generatorCalls()).toBe(2);
  });

  test("a reviewer failure restores the old result, not a half-swapped new code (mobile)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openHome(page);
    const router = await routePipeline(page, {
      generate: generatorFor(NEW),
      review: () => providerError(),
    });
    await establishInitialResult(page, router);

    await refineButton(page).click();

    // The generator returned new code, but the review then failed: the old
    // result must be restored — new code must NOT be visible.
    await expect(page.locator("#results-view")).toHaveClass(/visible/);
    await expect(page.locator("#results-code-output")).toContainText("oldGreeting");
    await expect(page.locator("#results-code-output")).not.toContainText("newGreeting");
    await expect(retryButton(page)).toBeVisible();
  });

  test("retrying a failed replacement succeeds and swaps in the new result (desktop)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHome(page);
    const router = await routePipeline(page, {
      generate: (call) => (call === 2 ? providerError() : generatorFor(NEW)),
      review: reviewFor("new review"),
    });
    await establishInitialResult(page, router);

    await refineButton(page).click();
    await expect(retryButton(page)).toBeVisible();
    await expect(page.locator("#results-code-output")).toContainText("oldGreeting");

    await retryButton(page).click();
    await expect(page.locator("#results-code-output")).toContainText("newGreeting");
    await expect(page.locator("#results-code-output")).not.toContainText("oldGreeting");
    await expect(banner(page)).toBeHidden();
  });
});

test.describe("Pasted build-error regeneration", () => {
  test("pasting build errors and fixing them swaps in the new bundle (desktop)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHome(page);
    const router = await routePipeline(page, {
      generate: generatorFor(NEW),
      review: reviewFor("new review"),
    });
    await establishInitialResult(page, router);

    await page.locator("#btn-error-regen-header").click();
    const textarea = page.locator("#ff-error-paste-input");
    await expect(textarea).toBeVisible();
    await expect(textarea).toBeFocused();
    await textarea.fill("Error: 'oldGreeting' is undefined");

    await page.locator("#btn-fix-from-errors").click();

    await expect(page.locator("#results-code-output")).toContainText("newGreeting");
    await expect(page.locator("#results-code-output")).not.toContainText("oldGreeting");
    await expect(banner(page)).toBeHidden();
    expect(router.generatorCalls()).toBe(2);
  });

  test("empty build-error input is rejected without charging and never leaves the previous result (mobile)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openHome(page);
    const router = await routePipeline(page, {
      generate: generatorFor(NEW),
      review: reviewFor("new review"),
    });
    await establishInitialResult(page, router);

    await page.locator("#btn-error-regen-header").click();
    const textarea = page.locator("#ff-error-paste-input");
    await textarea.fill("   ");
    await page.locator("#btn-fix-from-errors").click();

    // No generation ran, no charge, no crash — the previous result is intact.
    expect(router.generatorCalls()).toBe(1);
    await expect(page.locator("#results-code-output")).toContainText("oldGreeting");
    await expect(banner(page)).toBeHidden();
  });

  test("cancelling the build-error input preserves the typed context and the result (mobile)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openHome(page);
    const router = await routePipeline(page, {
      generate: generatorFor(NEW),
      review: reviewFor("new review"),
    });
    await establishInitialResult(page, router);

    await page.locator("#btn-error-regen-header").click();
    const textarea = page.locator("#ff-error-paste-input");
    await textarea.fill("Error: build failed for reason X");

    await page.locator("#btn-error-input-cancel").click();

    await expect(page.locator("#error-input-panel")).toBeHidden();
    // The typed errors are preserved so the user does not retype on reopen.
    await expect(textarea).toHaveValue("Error: build failed for reason X");
    // The previous result stays intact.
    await expect(page.locator("#results-code-output")).toContainText("oldGreeting");
    expect(router.generatorCalls()).toBe(1);
  });
});
