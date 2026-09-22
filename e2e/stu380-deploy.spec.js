import { test, expect } from "@playwright/test";
import { applyDefaultRoutes } from "./fixtures/apiFixtures.js";

/**
 * STU-380 — truthful deployment terminal outcomes.
 *
 * A deploy ends in one of four states and the UI must never flatten them:
 * only a confirmed success may say "committed". 403 / file rejection / compile
 * gate are failures; a mixed outcome (classes written, rest rejected) is
 * partial; a client wait expiry or a dropped stream is unconfirmed. Every
 * terminal state must release the UI busy state and offer safe next actions
 * without concealing the manual FlutterFlow reconciliation step. These tests
 * drive the same presentation the real confirm flow uses
 * (`__CCC_RENDER_DEPLOY_TERMINAL__`), so a fixture map to the DOM without a
 * real remote write — the definitive-committed claim still belongs to STU-392
 * integration acceptance.
 */

// Identity is captured once at confirmation and must survive into every
// terminal state unchanged.
const identity = {
  projectId: "ff-proj-0007",
  endpoint: "https://api.flutterflow.io",
  artifactType: "CustomClass",
  artifactName: "GaugeWidget",
  fileName: "gauge_widget.dart",
};

async function render(page, result) {
  await page.addInitScript(() => {
    localStorage.setItem("hasSeenWalkthrough", "true");
  });
  await applyDefaultRoutes(page);
  await page.goto("/");
  await page.waitForFunction(
    () => typeof window.__CCC_RENDER_DEPLOY_TERMINAL__ === "function",
  );
  // The real flow hides the progress overlay and re-enables the deploy
  // controls itself; start a deploy first so we can prove it was released.
  await page.evaluate(() => window.__CCC_START_DEPLOY_PROGRESS__());
  await page.evaluate(
    ({ result }) => window.__CCC_RENDER_DEPLOY_TERMINAL__(result),
    { result },
  );
}

test.describe("STU-380 deployment terminal outcomes", () => {
  test("only a confirmed success says committed; the success modal carries identity", async ({ page }) => {
    await render(page, {
      success: true,
      message: "Successfully committed gauge_widget.dart to FlutterFlow",
      targetIdentity: identity,
      metadata: {
        projectId: identity.projectId,
        fileName: identity.fileName,
        artifactType: identity.artifactType,
        codeSize: 4096,
      },
      addedDependencies: [],
    });

    const success = page.locator("#commit-success-modal");
    await expect(success).toBeVisible();
    // "committed" appears only here.
    await expect(success).toContainText("Commit Successful");
    await expect(success).toContainText("Successfully committed");
    // Identity carried from confirmation into the terminal state.
    await expect(success).toContainText(identity.projectId);
    await expect(success).toContainText(identity.fileName);
  });

  test("a 403 rejection is a failure that never claims committed", async ({ page }) => {
    await render(page, {
      success: false,
      targetIdentity: identity,
      error: "HTTP 403 Forbidden — your FlutterFlow API key lacks write access.",
    });

    const output = page.locator("#step3-output");
    await expect(output).toContainText("FlutterFlow Commit Failed");
    await expect(output).toContainText("403");
    // A definitive rejection must not read as committed.
    await expect(output).not.toContainText("committed");
    await expect(output).not.toContainText("Committed");
  });

  test("a per-file rejection surfaces each file's error, not a blanket success", async ({ page }) => {
  await render(page, {
    success: false,
    targetIdentity: identity,
    error: "FlutterFlow rejected 1 of 1 files.",
    errorMap: {
      "gauge_widget.dart": [{ errorMessage: "Duplicate class GaugeWidget", isCritical: true }],
    },
  });

    const output = page.locator("#step3-output");
    await expect(output).toContainText("gauge_widget.dart");
    await expect(output).toContainText("Duplicate class GaugeWidget");
    await expect(output).not.toContainText("committed");
  });

  test("a compile gate failure shows the analyzer rejection, never committed", async ({ page }) => {
    await render(page, {
      success: false,
      targetIdentity: identity,
      error: "The generated custom code does not compile, so nothing was deployed to FlutterFlow.",
      details: "named argument 'radius' required by package",
    });

    const output = page.locator("#step3-output");
    await expect(output).toContainText("does not compile");
    await expect(output).not.toContainText("committed");
  });

  test("a partial outcome opens the terminal modal with per-file outcomes and does not claim committed", async ({ page }) => {
    await render(page, {
      success: false,
      partial: true,
      targetIdentity: identity,
      error: "Classes were written, but the sync was rejected.",
      errorMap: {
        "pubspec_merge.dart": [{ errorMessage: "Dependency conflict", isCritical: true }],
      },
    });

    const terminal = page.locator("#commit-terminal-modal");
    await expect(terminal).toBeVisible();
    await expect(terminal).toContainText("Deploy partially applied");
    await expect(terminal).toContainText("not lost");
    // Per-file outcomes rendered.
    await expect(terminal).toContainText("pubspec_merge.dart");
    await expect(terminal).toContainText("Dependency conflict");
    // Identity carried from confirmation.
    await expect(terminal).toContainText(identity.projectId);
    await expect(terminal).toContainText(identity.fileName);
    // Safe next action available.
    await expect(terminal.locator("#terminal-open-ff-link")).toHaveAttribute(
      "href",
      `https://app.flutterflow.io/project/${identity.projectId}`,
    );
    // Truthful: not committed.
    await expect(terminal).not.toContainText("Committed");
  });

  test("a disconnect leaves the outcome unconfirmed with reconciliation guidance, never committed", async ({ page }) => {
    await render(page, {
      success: false,
      unconfirmed: true,
      targetIdentity: identity,
      error: "The connection to the FlutterFlow deploy runner dropped before it reported a result.",
    });

    const terminal = page.locator("#commit-terminal-modal");
    await expect(terminal).toBeVisible();
    await expect(terminal).toContainText("Deploy outcome not yet known");
    // Reconciliation guidance names the manual FlutterFlow step.
    await expect(terminal).toContainText("Open your FlutterFlow project");
    await expect(terminal).toContainText("not cancelled");
    await expect(terminal).not.toContainText("Committed");
    await expect(terminal).not.toContainText("Commit Failed");
    await expect(terminal.locator("#terminal-open-ff-link")).toHaveAttribute(
      "href",
      `https://app.flutterflow.io/project/${identity.projectId}`,
    );
  });

  test("a wait-timeout is unconfirmed, not a fabricated failure", async ({ page }) => {
    await render(page, {
      success: false,
      unconfirmed: true,
      targetIdentity: identity,
      error: "This browser stopped waiting before the server reported a result.",
    });

    const terminal = page.locator("#commit-terminal-modal");
    await expect(terminal).toBeVisible();
    await expect(terminal).toContainText("Deploy outcome not yet known");
    await expect(terminal).toContainText("not cancelled");
    await expect(terminal).not.toContainText("Committed");
  });

  test("every terminal state releases the UI busy state", async ({ page }) => {
    await render(page, {
      success: true,
      targetIdentity: identity,
      metadata: { projectId: identity.projectId, fileName: identity.fileName, artifactType: identity.artifactType, codeSize: 1024 },
      addedDependencies: [],
    });
    // Progress overlay was started, then must be gone in the terminal state.
    await expect(page.locator("#commit-progress-overlay")).toBeHidden();
    await page.evaluate(() => window.closeCommitSuccessModal());

    await page.evaluate(
      ({ identity }) => {
        window.__CCC_RENDER_DEPLOY_TERMINAL__({
          success: false,
          partial: true,
          targetIdentity: identity,
          error: "sync rejected",
        });
      },
      { identity },
    );
    await expect(page.locator("#commit-progress-overlay")).toBeHidden();
  });

  test("a partial/unconfirmed terminal keeps the deploy controls enabled (busy released)", async ({ page }) => {
    await render(page, {
      success: false,
      partial: true,
      targetIdentity: identity,
      error: "sync rejected",
    });
    await expect(page.locator("#commit-terminal-modal")).toBeVisible();
    // The deploy trigger must be re-enabled so a retry is possible.
    await expect(page.locator("#btn-deploy-to-ff")).toBeEnabled();
    await expect(
      page.locator("#commit-confirm-modal button[data-deploy-confirm]"),
    ).toBeEnabled();
  });
});
