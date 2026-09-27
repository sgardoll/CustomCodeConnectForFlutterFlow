import { test, expect } from "@playwright/test";
import { applyDefaultRoutes, ENDPOINTS } from "./fixtures/apiFixtures.js";

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

  test("a duplicate confirm while a deploy is in flight is ignored (guard)", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("hasSeenWalkthrough", "true");
    });
    await applyDefaultRoutes(page);
    await page.goto("/");
    await page.waitForFunction(
      () =>
        typeof window.__CCC_OPEN_COMMIT_CONFIRM__ === "function" &&
        typeof window.__CCC_SET_DEPLOY_BUSY__ === "function",
    );

    // Put the deploy into its in-flight state, exactly as confirmCommitToFlutterFlow
    // does at the top of a real run, then open the real commit-confirm modal so
    // there is real pending commit data a second (errant) confirm would consume.
    await page.evaluate(() => window.__CCC_SET_DEPLOY_BUSY__(true));
    await page.evaluate(() => window.__CCC_OPEN_COMMIT_CONFIRM__());

    // A second confirm while a deploy is already in flight must be a no-op.
    await page.evaluate(() => window.confirmCommitToFlutterFlow());

    // Guard held: the confirm modal was not closed and no progress overlay was
    // started (both would only happen if a second commit ran).
    await expect(page.locator("#commit-confirm-modal")).toBeVisible();
    await expect(page.locator("#commit-progress-overlay")).toBeHidden();
  });

  test("a terminal state releases the busy lock on the deploy controls (guard release)", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("hasSeenWalkthrough", "true");
    });
    await applyDefaultRoutes(page);
    await page.goto("/");
    await page.waitForFunction(
      () =>
        typeof window.__CCC_OPEN_COMMIT_CONFIRM__ === "function" &&
        typeof window.__CCC_SET_DEPLOY_BUSY__ === "function" &&
        typeof window.__CCC_RENDER_DEPLOY_TERMINAL__ === "function",
    );

    // Busy the deploy controls by driving the exact same setDeployBusy(true)
    // the confirm flow calls at the start of a run.
    await page.evaluate(() => window.__CCC_SET_DEPLOY_BUSY__(true));
    await page.evaluate(() => window.__CCC_OPEN_COMMIT_CONFIRM__());
    await expect(page.locator("#btn-deploy-to-ff")).toBeDisabled();
    await expect(
      page.locator("#commit-confirm-modal button[data-deploy-confirm]"),
    ).toBeDisabled();

    // A terminal outcome must release the busy state through the real terminal
    // renderer (renderCommitTerminal -> setDeployBusy(false)).
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

    await expect(page.locator("#btn-deploy-to-ff")).toBeEnabled();
    await expect(
      page.locator("#commit-confirm-modal button[data-deploy-confirm]"),
    ).toBeEnabled();
  });
});

// --- Transport-level regressions (Devin Review on PR #91) -------------------
// These drive the real provisioning exchange and push retry loop through the
// __CCC_* transport hooks against intercepted routes, so the classification of
// lost/stalled responses is exercised in the code that ships — not a mock of
// the classify step.

async function loadDeployHooks(page) {
  await page.addInitScript(() => {
    localStorage.setItem("hasSeenWalkthrough", "true");
  });
  await applyDefaultRoutes(page);
  await page.goto("/");
  await page.waitForFunction(
    () =>
      typeof window.__CCC_PROVISION_CUSTOM_CLASSES__ === "function" &&
      typeof window.__CCC_PUSH_CODE_WITH_RETRY__ === "function",
  );
}

const newClassFileMap = {
  "gauge_model.dart": {
    artifactName: "GaugeModel",
    content: "class GaugeModel { final int value; GaugeModel(this.value); }",
    type: "C",
    path: "lib/custom_code/gauge_model.dart",
  },
};

async function settleAsOutcome(page, hook, args) {
  return page.evaluate(
    async ({ hook, args }) => {
      try {
        await window[hook](...args);
        return { settled: "resolved" };
      } catch (error) {
        return {
          settled: "rejected",
          name: error.name,
          outcome: error.outcome,
          message: error.message,
        };
      }
    },
    { hook, args },
  );
}

test.describe("STU-380 transport outcome regressions", () => {
  test("a provisioning request that never gets headers hits the UI bound and reports unconfirmed", async ({ page }) => {
    await loadDeployHooks(page);
    // The runner accepts the connection but never flushes response headers —
    // this must still resolve inside the UI bound, not hang the deploy.
    await page.route(ENDPOINTS.deployCustomClasses, () => new Promise(() => {}));

    const outcome = await settleAsOutcome(
      page,
      "__CCC_PROVISION_CUSTOM_CLASSES__",
      [{ fileMap: newClassFileMap, uiTimeoutMs: 60 }],
    );

    expect(outcome.settled).toBe("rejected");
    expect(outcome.name).toBe("UnconfirmedDeployError");
    expect(outcome.outcome).toBe("unconfirmed");
  });

  test("a provisioning stream that ends without a result is unconfirmed, not failed", async ({ page }) => {
    await loadDeployHooks(page);
    await page.route(ENDPOINTS.deployCustomClasses, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: '{"event":"phase","phase":"deploying","message":"Deploying..."}\n',
      });
    });

    const outcome = await settleAsOutcome(
      page,
      "__CCC_PROVISION_CUSTOM_CLASSES__",
      [{ fileMap: newClassFileMap }],
    );

    expect(outcome.name).toBe("UnconfirmedDeployError");
    expect(outcome.outcome).toBe("unconfirmed");
  });

  test("a push that loses every response is unconfirmed, not a fabricated partial/failure", async ({ page }) => {
    await loadDeployHooks(page);
    // Both sync endpoints drop the request without a response — the push may
    // have reached FlutterFlow, so the outcome is unknown.
    await page.route("**/syncCustomCodeChanges", (route) => route.abort());

    const outcome = await settleAsOutcome(
      page,
      "__CCC_PUSH_CODE_WITH_RETRY__",
      [{ project_id: "ff-proj-0007", zipped_custom_code: "eA==" }, 1],
    );

    expect(outcome.settled).toBe("rejected");
    expect(outcome.name).toBe("UnconfirmedDeployError");
    expect(outcome.outcome).toBe("unconfirmed");
  });

  test("a push refused with HTTP errors on every endpoint is a definitive failure", async ({ page }) => {
    await loadDeployHooks(page);
    await page.route("**/syncCustomCodeChanges", async (route) => {
      await route.fulfill({ status: 500, body: "server error" });
    });

    const outcome = await settleAsOutcome(
      page,
      "__CCC_PUSH_CODE_WITH_RETRY__",
      [{ project_id: "ff-proj-0007", zipped_custom_code: "eA==" }, 1],
    );

    expect(outcome.settled).toBe("rejected");
    expect(outcome.name).not.toBe("UnconfirmedDeployError");
    expect(outcome.message).toContain("HTTP 500");
  });
});
