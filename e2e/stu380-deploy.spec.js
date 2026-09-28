import { test, expect } from "@playwright/test";
import JSZip from "jszip";
import { applyDefaultRoutes, ENDPOINTS } from "./fixtures/apiFixtures.js";

/**
 * STU-380 — truthful deployment terminal outcomes.
 *
 * A deploy ends in one of four states and the UI must never flatten them:
 * only a confirmed success may say "committed". A refusal issued before any
 * write (403 / file rejection / compile gate) is a failure; a mixed outcome
 * (classes written, rest rejected) is partial; a client wait expiry, a
 * dropped stream, or a server error is unconfirmed. Every
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
      remoteRefusal: true,
      targetIdentity: identity,
      error: "HTTP 403 Forbidden — your FlutterFlow API key lacks write access.",
    });

    const output = page.locator("#step3-output");
    await expect(output).toContainText("FlutterFlow Commit Failed");
    await expect(output).toContainText("403");
    // A definitive rejection must not read as committed.
    await expect(output).not.toContainText("committed");
    await expect(output).not.toContainText("Committed");

    // #step3-output sits in permanently-hidden legacy containers, so the
    // refusal must also reach the shared terminal modal to be visible at all.
    const terminal = page.locator("#commit-terminal-modal");
    await expect(terminal).toBeVisible();
    await expect(terminal).toContainText("Deploy failed");
    await expect(terminal).toContainText("FlutterFlow refused this deploy");
    await expect(terminal).toContainText("403");
    await expect(terminal).toContainText(identity.projectId);
    await expect(terminal).not.toContainText("Committed");
  });

  test("a per-file rejection surfaces each file's error, not a blanket success", async ({ page }) => {
  await render(page, {
    success: false,
    remoteRefusal: true,
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

    // The same per-file outcomes are visible in the shared terminal modal.
    const terminal = page.locator("#commit-terminal-modal");
    await expect(terminal).toBeVisible();
    await expect(terminal).toContainText("Deploy failed");
    await expect(terminal).toContainText("gauge_widget.dart");
    await expect(terminal).toContainText("Duplicate class GaugeWidget");
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

    // The analyzer refusal reaches the visible terminal too — a local gate,
    // so it must not claim FlutterFlow refused a request it never received.
    const terminal = page.locator("#commit-terminal-modal");
    await expect(terminal).toBeVisible();
    await expect(terminal).toContainText("Deploy failed");
    await expect(terminal).toContainText("before FlutterFlow confirmed anything");
    await expect(terminal).not.toContainText("refused this deploy");
    await expect(terminal).toContainText("does not compile");
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
      typeof window.__CCC_PUSH_CODE_WITH_RETRY__ === "function" &&
      typeof window.__CCC_PUSH_CODE_WITH_TIMEOUT__ === "function",
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

  test("a runner failure after the deploy began is unconfirmed, not a refusal", async ({ page }) => {
    await loadDeployHooks(page);
    // The runner answers definitively — but only after the deploy phase
    // started, so classes may already be written.
    await page.route(ENDPOINTS.deployCustomClasses, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body:
          '{"event":"phase","phase":"deploy_start","message":"Deploying 1 custom class to FlutterFlow..."}\n' +
          '{"event":"result","success":false,"error":"FlutterFlow AI DSL deploy failed.","exitCode":1}\n',
      });
    });

    const outcome = await settleAsOutcome(
      page,
      "__CCC_PROVISION_CUSTOM_CLASSES__",
      [{ fileMap: newClassFileMap }],
    );

    expect(outcome.name).toBe("UnconfirmedDeployError");
    expect(outcome.outcome).toBe("unconfirmed");
    expect(outcome.message).toMatch(/after the deploy began/);
  });

  test("a provisioning failure before the deploy phase stays a refusal", async ({ page }) => {
    await loadDeployHooks(page);
    await page.route(ENDPOINTS.deployCustomClasses, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body:
          '{"event":"phase","phase":"verifying","message":"Compiling your custom code..."}\n' +
          '{"event":"result","success":false,"error":"The generated custom code does not compile, so nothing was deployed to FlutterFlow.","analyzerErrors":["bad arg"]}\n',
      });
    });

    const outcome = await settleAsOutcome(
      page,
      "__CCC_PROVISION_CUSTOM_CLASSES__",
      [{ fileMap: newClassFileMap }],
    );

    expect(outcome.name).toBe("Error");
    expect(outcome.message).toMatch(/does not compile/);
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

  test("a push hitting server errors on every endpoint is unconfirmed, not failed", async ({ page }) => {
    await loadDeployHooks(page);
    // Every endpoint answers 500. No response was lost, but a server error can
    // be raised after the write was applied, so it cannot prove a refusal —
    // the outcome stays unknown rather than fabricating a failure.
    await page.route("**/syncCustomCodeChanges", async (route) => {
      await route.fulfill({ status: 500, body: "server error" });
    });

    const outcome = await settleAsOutcome(
      page,
      "__CCC_PUSH_CODE_WITH_RETRY__",
      [{ project_id: "ff-proj-0007", zipped_custom_code: "eA==" }, 1],
    );

    expect(outcome.settled).toBe("rejected");
    expect(outcome.name).toBe("UnconfirmedDeployError");
    expect(outcome.outcome).toBe("unconfirmed");
    expect(outcome.message).toContain("HTTP 500");
  });

  test("a definitive refusal after a lost response is unconfirmed, not failed", async ({ page }) => {
    await loadDeployHooks(page);
    // Production drops the request entirely; staging then answers a clean 403.
    // The refusal is definitive for staging but cannot prove production did
    // not apply the push first — the outcome must stay unknown.
    const outcome = await page.evaluate(async () => {
      let calls = 0;
      window.fetch = (url) => {
        if (!String(url).includes("syncCustomCodeChanges")) {
          return Promise.resolve(new Response("{}", { status: 200 }));
        }
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("connection reset"));
        return Promise.resolve(new Response("forbidden", { status: 403 }));
      };
      try {
        await window.__CCC_PUSH_CODE_WITH_RETRY__(
          { project_id: "ff-proj-0007", zipped_custom_code: "eA==" },
          1,
        );
        return { settled: "resolved", calls };
      } catch (error) {
        return {
          settled: "rejected",
          calls,
          name: error.name,
          outcome: error.outcome,
          message: error.message,
        };
      }
    });

    expect(outcome.settled).toBe("rejected");
    expect(outcome.name).toBe("UnconfirmedDeployError");
    expect(outcome.outcome).toBe("unconfirmed");
    expect(outcome.calls).toBe(2);
  });

  test("a refusal after a server error is unconfirmed — the 5xx may have applied the write", async ({ page }) => {
    await loadDeployHooks(page);
    // Production 500s (maybe post-write); staging then answers 403. The later
    // refusal cannot undo the uncertain first attempt.
    const outcome = await page.evaluate(async () => {
      let calls = 0;
      window.fetch = (url) => {
        if (!String(url).includes("syncCustomCodeChanges")) {
          return Promise.resolve(new Response("{}", { status: 200 }));
        }
        calls += 1;
        const status = calls === 1 ? 500 : 403;
        return Promise.resolve(new Response("err", { status }));
      };
      try {
        await window.__CCC_PUSH_CODE_WITH_RETRY__(
          { project_id: "ff-proj-0007", zipped_custom_code: "eA==" },
          1,
        );
        return { settled: "resolved", calls };
      } catch (error) {
        return {
          settled: "rejected",
          calls,
          name: error.name,
          outcome: error.outcome,
          message: error.message,
        };
      }
    });

    expect(outcome.settled).toBe("rejected");
    expect(outcome.name).toBe("UnconfirmedDeployError");
    expect(outcome.outcome).toBe("unconfirmed");
    expect(outcome.calls).toBe(2);
  });

  test("a server error other than 500 is unconfirmed too — no retry needed to be unsure", async ({ page }) => {
    await loadDeployHooks(page);
    const outcome = await page.evaluate(async () => {
      window.fetch = () =>
        Promise.resolve(new Response("bad gateway", { status: 502 }));
      try {
        await window.__CCC_PUSH_CODE_WITH_RETRY__(
          { project_id: "ff-proj-0007", zipped_custom_code: "eA==" },
          1,
        );
        return { settled: "resolved" };
      } catch (error) {
        return {
          settled: "rejected",
          name: error.name,
          outcome: error.outcome,
          message: error.message,
        };
      }
    });

    expect(outcome.settled).toBe("rejected");
    expect(outcome.name).toBe("UnconfirmedDeployError");
    expect(outcome.outcome).toBe("unconfirmed");
    expect(outcome.message).toContain("HTTP 502");
  });

  test("a discarded 500 response's diagnostic read consumes its own stream", async ({ page }) => {
    await loadDeployHooks(page);
    // Teeing a stalled body with clone() would leave the ORIGINAL branch
    // feeding a reader that doesn't exist — a locked original proves the
    // diagnostic read (and its bound-cancel) releases the real connection.
    const outcome = await page.evaluate(async () => {
      const pushed = [];
      window.fetch = (url) => {
        if (!String(url).includes("syncCustomCodeChanges")) {
          return Promise.resolve(new Response("{}", { status: 200 }));
        }
        const response = new Response(
          new ReadableStream({ start() {} }), // never emits, never closes
          { status: 500 },
        );
        pushed.push(response);
        return Promise.resolve(response);
      };
      try {
        await window.__CCC_PUSH_CODE_WITH_RETRY__(
          { project_id: "ff-proj-0007", zipped_custom_code: "eA==" },
          1,
        );
        return { settled: "resolved" };
      } catch (error) {
        return {
          settled: "rejected",
          name: error.name,
          locked: pushed.map((r) => r.body.locked),
          count: pushed.length,
        };
      }
    });

    expect(outcome.settled).toBe("rejected");
    expect(outcome.name).toBe("UnconfirmedDeployError");
    expect(outcome.count).toBe(2); // production + staging
    expect(outcome.locked).toEqual([true, true]);
  });

  test("a push that never answers settles unconfirmed instead of hanging", async ({ page }) => {
    await loadDeployHooks(page);

    // The request may have landed even though no response ever arrives, so the
    // bounded wait must produce unconfirmed rather than parking the deploy.
    const outcome = await page.evaluate(async () => {
      window.fetch = () => new Promise(() => {});
      try {
        await window.__CCC_PUSH_CODE_WITH_TIMEOUT__(
          { project_id: "ff-proj-0007", zipped_custom_code: "eA==" },
          75,
        );
        return { settled: "resolved" };
      } catch (error) {
        return {
          settled: "rejected",
          name: error.name,
          outcome: error.outcome,
        };
      }
    });

    expect(outcome.settled).toBe("rejected");
    expect(outcome.name).toBe("UnconfirmedDeployError");
    expect(outcome.outcome).toBe("unconfirmed");
  });

  test("a timed-out push issues no further writes once the UI gives up", async ({ page }) => {
    await loadDeployHooks(page);

    // The bound expires mid-attempt; when the stalled request finally answers
    // 500, the loop must not send another POST — the outcome is already
    // reported and the user may have started a new deploy.
    const outcome = await page.evaluate(async () => {
      let calls = 0;
      window.fetch = (url) => {
        if (!String(url).includes("syncCustomCodeChanges")) {
          return Promise.resolve(new Response("{}", { status: 200 }));
        }
        calls += 1;
        return new Promise((resolve) =>
          setTimeout(() => resolve(new Response("err", { status: 500 })), 120),
        );
      };
      try {
        await window.__CCC_PUSH_CODE_WITH_TIMEOUT__(
          { project_id: "ff-proj-0007", zipped_custom_code: "eA==" },
          75,
        );
        return { settled: "resolved", calls };
      } catch (error) {
        // Wait past the retry sleep so a further attempt would have fired.
        await new Promise((r) => setTimeout(r, 1500));
        return {
          settled: "rejected",
          calls,
          name: error.name,
          outcome: error.outcome,
        };
      }
    });

    expect(outcome.settled).toBe("rejected");
    expect(outcome.name).toBe("UnconfirmedDeployError");
    expect(outcome.outcome).toBe("unconfirmed");
    expect(outcome.calls).toBe(1);
  });

  test("a sync body that stalls mid-read is unconfirmed under the same bound", async ({ page }) => {
    await loadDeployHooks(page);

    // Headers arrive and the first bytes flush, then nothing: json() neither
    // resolves nor rejects, so without the bound the deploy would hang even
    // though the accepted write may already be applied.
    const outcome = await page.evaluate(async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"succ'));
        },
      });
      window.fetch = () =>
        Promise.resolve(new Response(body, { status: 200 }));
      try {
        await window.__CCC_PUSH_CODE_WITH_TIMEOUT__(
          { project_id: "ff-proj-0007", zipped_custom_code: "eA==" },
          75,
        );
        return { settled: "resolved" };
      } catch (error) {
        return {
          settled: "rejected",
          name: error.name,
          outcome: error.outcome,
        };
      }
    });

    expect(outcome.settled).toBe("rejected");
    expect(outcome.name).toBe("UnconfirmedDeployError");
    expect(outcome.outcome).toBe("unconfirmed");
  });

  test("a sync response whose body drops mid-read is unconfirmed, not failed", async ({ page }) => {
    await loadDeployHooks(page);

    // A 200 arrives, then the connection resets before the JSON completes:
    // response.json() rejects AND the clone's text() rejects — both share the
    // dead source. The accepted status means the push may have been applied.
    const outcome = await page.evaluate(async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"succ'));
          controller.error(new Error("connection reset"));
        },
      });
      try {
        await window.__CCC_PARSE_PUSH_RESPONSE__(
          new Response(body, { status: 200 }),
        );
        return { settled: "resolved" };
      } catch (error) {
        return {
          settled: "rejected",
          name: error.name,
          outcome: error.outcome,
          message: error.message,
        };
      }
    });

    expect(outcome.settled).toBe("rejected");
    expect(outcome.name).toBe("UnconfirmedDeployError");
    expect(outcome.outcome).toBe("unconfirmed");
  });

  test("a refusal whose body drops mid-read is still a definitive failure", async ({ page }) => {
    await loadDeployHooks(page);

    // A 4xx refusal is definitive even when its body cannot be read — the
    // status alone proves the server rejected the request before any write.
    const outcome = await page.evaluate(async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
          controller.error(new Error("connection reset"));
        },
      });
      try {
        const parsed = await window.__CCC_PARSE_PUSH_RESPONSE__(
          new Response(body, { status: 403 }),
        );
        return { settled: "resolved", parsed };
      } catch (error) {
        return { settled: "rejected", name: error.name, message: error.message };
      }
    });

    expect(outcome.settled).toBe("resolved");
    expect(outcome.parsed.success).toBe(false);
    expect(outcome.parsed.responseCode).toBe(403);
  });

  test("a refusal whose body stalls still reports its status inside the bound", async ({ page }) => {
    await loadDeployHooks(page);

    // A 4xx that sends a byte then keeps the body open is still a definitive
    // refusal — the status alone decides, so the parse must not wait on the
    // body past the diagnostic bound. And the bounded read must cancel the
    // stream, not leave a pending reader holding the connection.
    const outcome = await page.evaluate(async () => {
      let streamCancelled = false;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
          // Never closes — the stalled body must not block classification.
        },
        cancel() {
          streamCancelled = true;
        },
      });
      try {
        const parsed = await window.__CCC_PARSE_PUSH_RESPONSE__(
          new Response(body, { status: 403 }),
          50,
        );
        return { settled: "resolved", parsed, streamCancelled };
      } catch (error) {
        return {
          settled: "rejected",
          name: error.name,
          message: error.message,
          streamCancelled,
        };
      }
    });

    expect(outcome.settled).toBe("resolved");
    expect(outcome.parsed.success).toBe(false);
    expect(outcome.parsed.responseCode).toBe(403);
    expect(outcome.streamCancelled).toBe(true);
  });

  test("a server error with an unreadable body still lands as unconfirmed", async ({ page }) => {
    await loadDeployHooks(page);

    // Every endpoint replies 500 but closes its body early: the statuses were
    // received, so the outcome is unconfirmed because a 5xx cannot prove a
    // refusal — not because a logging read failed, and never a crash.
    const outcome = await page.evaluate(async () => {
      const stubBody = () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("x"));
            controller.error(new Error("connection reset"));
          },
        });
      window.fetch = () =>
        Promise.resolve(new Response(stubBody(), { status: 500 }));
      try {
        await window.__CCC_PUSH_CODE_WITH_RETRY__(
          { project_id: "ff-proj-0007", zipped_custom_code: "eA==" },
          1,
        );
        return { settled: "resolved" };
      } catch (error) {
        return {
          settled: "rejected",
          name: error.name,
          outcome: error.outcome,
          message: error.message,
        };
      }
    });

    expect(outcome.settled).toBe("rejected");
    expect(outcome.name).toBe("UnconfirmedDeployError");
    expect(outcome.outcome).toBe("unconfirmed");
    expect(outcome.message).toContain("HTTP 500");
  });

  test("a non-500 refusal is never sent back through the retry loop", async ({ page }) => {
    await loadDeployHooks(page);

    // A definitive 403 must not be retried — even when its body is unreadable.
    const outcome = await page.evaluate(async () => {
      let calls = 0;
      const stubBody = () =>
        new ReadableStream({
          start(controller) {
            controller.error(new Error("connection reset"));
          },
        });
      window.fetch = () => {
        calls += 1;
        return Promise.resolve(new Response(stubBody(), { status: 403 }));
      };
      try {
        await window.__CCC_PUSH_CODE_WITH_RETRY__(
          { project_id: "ff-proj-0007", zipped_custom_code: "eA==" },
          3,
        );
        return { settled: "resolved", calls };
      } catch (error) {
        return { settled: "rejected", calls, name: error.name };
      }
    });

    expect(outcome.settled).toBe("resolved");
    expect(outcome.calls).toBe(1);
  });

  test("an unconfirmed provisioning drops the cached project snapshot", async ({ page }) => {
    await loadDeployHooks(page);

    const zip = new JSZip();
    zip.file(
      "pubspec.yaml",
      "name: my_app\n\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    const projectZip = await zip.generateAsync({ type: "base64" });

    let exportCalls = 0;
    await page.route("**/exportCode", async (route) => {
      exportCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ value: { project_zip: projectZip } }),
      });
    });
    // The runner accepts the connection but never answers — the outcome is
    // unconfirmed while it may still write the class server-side.
    await page.route(ENDPOINTS.deployCustomClasses, () => new Promise(() => {}));

    // Seed the project-source cache exactly like a deploy's pubspec merge does.
    const seeded = await page.evaluate(() =>
      window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}),
    );
    expect(seeded.remoteFilePaths).toEqual([]);
    expect(exportCalls).toBe(1);

    const outcome = await settleAsOutcome(
      page,
      "__CCC_PROVISION_CUSTOM_CLASSES__",
      [{ fileMap: newClassFileMap, uiTimeoutMs: 60 }],
    );
    expect(outcome.name).toBe("UnconfirmedDeployError");

    // The next deploy must re-export the project — a stale snapshot would lack
    // gauge_model.dart and provision it a second time.
    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(2);
  });

  test("a gateway 502 keeps the project snapshot dirty instead of reporting a refusal", async ({ page }) => {
    await loadDeployHooks(page);

    const zip = new JSZip();
    zip.file(
      "pubspec.yaml",
      "name: my_app\n\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    const projectZip = await zip.generateAsync({ type: "base64" });

    let exportCalls = 0;
    await page.route("**/exportCode", async (route) => {
      exportCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ value: { project_zip: projectZip } }),
      });
    });
    // A gateway 502 can arrive after the provisioning request was forwarded —
    // the runner may still be deploying classes, so this is not a refusal.
    await page.route(ENDPOINTS.deployCustomClasses, async (route) => {
      await route.fulfill({ status: 502, body: "bad gateway" });
    });

    // Seed the project-source cache exactly like a deploy's pubspec merge does.
    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(1);

    const outcome = await settleAsOutcome(
      page,
      "__CCC_PROVISION_CUSTOM_CLASSES__",
      [{ fileMap: newClassFileMap }],
    );
    // The UI must not report a definitive "nothing was written".
    expect(outcome.name).toBe("UnconfirmedDeployError");
    expect(outcome.outcome).toBe("unconfirmed");
    // The cause must be truthful: an HTTP 502 was actually received, so the
    // message names the status and may not claim the connection dropped. The
    // reconcile-before-retry advice stays in both cases.
    expect(outcome.message).toContain("HTTP 502");
    expect(outcome.message).not.toContain("dropped");
    expect(outcome.message).toContain("reconcile");

    // The possibly-written class keeps the snapshot dirty: the next deploy
    // must re-export instead of planning against the cached pre-write snapshot
    // and silently provisioning the class a second time.
    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(2);
  });

  test("a runner failure after deploy began also drops the cached snapshot", async ({ page }) => {
    await loadDeployHooks(page);

    const zip = new JSZip();
    zip.file(
      "pubspec.yaml",
      "name: my_app\n\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    const projectZip = await zip.generateAsync({ type: "base64" });

    let exportCalls = 0;
    await page.route("**/exportCode", async (route) => {
      exportCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ value: { project_zip: projectZip } }),
      });
    });
    // The runner answers definitively, but only after the deploy phase began —
    // classes may have been written, so the snapshot is stale too.
    await page.route(ENDPOINTS.deployCustomClasses, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body:
          '{"event":"phase","phase":"deploy_start","message":"Deploying 1 custom class to FlutterFlow..."}\n' +
          '{"event":"result","success":false,"error":"FlutterFlow AI DSL deploy failed.","exitCode":1}\n',
      });
    });

    const seeded = await page.evaluate(() =>
      window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}),
    );
    expect(exportCalls).toBe(1);

    const outcome = await settleAsOutcome(
      page,
      "__CCC_PROVISION_CUSTOM_CLASSES__",
      [{ fileMap: newClassFileMap }],
    );
    expect(outcome.name).toBe("UnconfirmedDeployError");

    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(2);
  });

  test("a dropped provisioning stream keeps exports uncached until the file is seen", async ({ page }) => {
    await loadDeployHooks(page);

    const zip = new JSZip();
    zip.file(
      "pubspec.yaml",
      "name: my_app\n\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    const projectZip = await zip.generateAsync({ type: "base64" });
    zip.file(
      "lib/custom_code/gauge_model.dart",
      "class GaugeModel { final int value; GaugeModel(this.value); }",
    );
    const projectZipWithClass = await zip.generateAsync({ type: "base64" });

    // The export only shows gauge_model.dart once the runner's write "lands" —
    // before that, every export is a mid-write snapshot that must not cache.
    let gaugeLanded = false;
    let exportCalls = 0;
    await page.route("**/exportCode", async (route) => {
      exportCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          value: { project_zip: gaugeLanded ? projectZipWithClass : projectZip },
        }),
      });
    });
    await page.evaluate(() => {
      const realFetch = window.fetch;
      window.fetch = (url, ...args) => {
        if (String(url).includes("deployCustomClasses")) {
          const body = new ReadableStream({
            start(controller) {
              window.__CCC_PROVISION_STREAM__ = controller;
            },
          });
          return Promise.resolve(
            new Response(body, {
              status: 200,
              headers: { "Content-Type": "application/x-ndjson" },
            }),
          );
        }
        return realFetch(url, ...args);
      };
    });

    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(1);

    const outcome = await settleAsOutcome(
      page,
      "__CCC_PROVISION_CUSTOM_CLASSES__",
      [{ fileMap: newClassFileMap, uiTimeoutMs: 60 }],
    );
    expect(outcome.name).toBe("UnconfirmedDeployError");

    // A follow-up deploy exports fresh but must not cache: the file may land
    // later and leave this snapshot stale forever.
    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(2);

    // Even the request settling proves nothing about the remote write — a
    // dropped stream can precede it — so exports stay uncached.
    await page.evaluate(() => window.__CCC_PROVISION_STREAM__.close());
    await page.waitForTimeout(50);
    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(3);

    // The first export that actually shows the file proves the write landed;
    // the path clears and caching resumes.
    gaugeLanded = true;
    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(4);
    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(4);
  });

  test("a retry's success cannot clear an earlier write that may still land", async ({ page }) => {
    await loadDeployHooks(page);

    const gaugeA = "class GaugeModel { final int value; GaugeModel(this.value); }";
    const gaugeB = "class GaugeModel { final String value; GaugeModel(this.value); }";
    const makeZip = async (content) => {
      const zip = new JSZip();
      zip.file(
        "pubspec.yaml",
        "name: my_app\n\ndependencies:\n  flutter:\n    sdk: flutter\n",
      );
      if (content) zip.file("lib/custom_code/gauge_model.dart", content);
      return zip.generateAsync({ type: "base64" });
    };
    const zipEmpty = await makeZip(null);
    const zipA = await makeZip(gaugeA);
    const zipB = await makeZip(gaugeB);

    // landed controls what the export shows: none → A's content → B's content.
    let landed = "none";
    let exportCalls = 0;
    await page.route("**/exportCode", async (route) => {
      exportCalls += 1;
      const project_zip =
        landed === "a" ? zipA : landed === "b" ? zipB : zipEmpty;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ value: { project_zip } }),
      });
    });
    // First provision hangs past the bound; the second answers success.
    await page.evaluate(() => {
      const realFetch = window.fetch;
      let provisionCalls = 0;
      window.fetch = (url, ...args) => {
        if (String(url).includes("deployCustomClasses")) {
          provisionCalls += 1;
          if (provisionCalls === 1) {
            return Promise.resolve(
              new Response(new ReadableStream({ start() {} }), {
                status: 200,
                headers: { "Content-Type": "application/x-ndjson" },
              }),
            );
          }
          return Promise.resolve(
            new Response(
              '{"event":"result","success":true}\n',
              { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
            ),
          );
        }
        return realFetch(url, ...args);
      };
    });

    const fileMapA = {
      "gauge_model.dart": {
        artifactName: "GaugeModel",
        content: gaugeA,
        type: "C",
        path: "lib/custom_code/gauge_model.dart",
      },
    };
    const fileMapB = {
      "gauge_model.dart": {
        artifactName: "GaugeModel",
        content: gaugeB,
        type: "C",
        path: "lib/custom_code/gauge_model.dart",
      },
    };

    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(1);

    // Provision A times out — its write may still land later.
    const outcomeA = await settleAsOutcome(
      page,
      "__CCC_PROVISION_CUSTOM_CLASSES__",
      [{ fileMap: fileMapA, uiTimeoutMs: 60 }],
    );
    expect(outcomeA.name).toBe("UnconfirmedDeployError");

    // Provision B (edited content, same path) succeeds — it proves only its
    // own write; A's outstanding write stays dirty.
    const outcomeB = await settleAsOutcome(
      page,
      "__CCC_PROVISION_CUSTOM_CLASSES__",
      [{ fileMap: fileMapB, remoteFiles: {} }],
    );
    expect(outcomeB.settled).toBe("resolved");

    // An export showing B's content cannot clear A's write — it can still
    // land afterwards and replace it, so nothing may be cached yet.
    landed = "b";
    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(2);
    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(3); // still uncached — A remains outstanding

    // Only an export carrying A's exact content proves that write landed;
    // then the dirty set empties and caching resumes.
    landed = "a";
    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(4);
    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(4);
  });

  test("an identical retry's success cannot retire the earlier uncertain write", async ({ page }) => {
    await loadDeployHooks(page);

    const gaugeX = "class GaugeModel { final int value; GaugeModel(this.value); }";
    const zip = new JSZip();
    zip.file(
      "pubspec.yaml",
      "name: my_app\n\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    const zipEmpty = await zip.generateAsync({ type: "base64" });
    zip.file("lib/custom_code/gauge_model.dart", gaugeX);
    const zipX = await zip.generateAsync({ type: "base64" });

    let landed = false;
    let exportCalls = 0;
    await page.route("**/exportCode", async (route) => {
      exportCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          value: { project_zip: landed ? zipX : zipEmpty },
        }),
      });
    });
    // First provision hangs past the bound; the retry answers success.
    await page.evaluate(() => {
      const realFetch = window.fetch;
      let provisionCalls = 0;
      window.__CCC_PROVISION_STREAM__ = null;
      window.fetch = (url, ...args) => {
        if (String(url).includes("deployCustomClasses")) {
          provisionCalls += 1;
          if (provisionCalls === 1) {
            const body = new ReadableStream({
              start(controller) {
                window.__CCC_PROVISION_STREAM__ = controller;
              },
            });
            return Promise.resolve(
              new Response(body, {
                status: 200,
                headers: { "Content-Type": "application/x-ndjson" },
              }),
            );
          }
          return Promise.resolve(
            new Response('{"event":"result","success":true}\n', {
              status: 200,
              headers: { "Content-Type": "application/x-ndjson" },
            }),
          );
        }
        return realFetch(url, ...args);
      };
    });

    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(1);

    const outcomeA = await settleAsOutcome(
      page,
      "__CCC_PROVISION_CUSTOM_CLASSES__",
      [{ fileMap: newClassFileMap, uiTimeoutMs: 60 }],
    );
    expect(outcomeA.name).toBe("UnconfirmedDeployError");

    // Identical retry succeeds — it credits one verified write of X, but A's
    // uncertain write is a separate attempt and must stay outstanding.
    const outcomeB = await settleAsOutcome(
      page,
      "__CCC_PROVISION_CUSTOM_CLASSES__",
      [{ fileMap: newClassFileMap, remoteFiles: {} }],
    );
    expect(outcomeB.settled).toBe("resolved");

    // First X-sighting is attributable to the verified retry — A's write can
    // still be in flight, so the snapshot must not cache.
    landed = true;
    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(2);
    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    // The second sighting shows the same unchanged X: it is the same fact as
    // the first, so it cannot retire A's uncertain write. While A can still
    // land, no export may be cached.
    expect(exportCalls).toBe(3);
    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(4);

    // A's own late result is what resolves its write: the uncertain credit
    // converts to a verified one, and the next sighting consumes it — only
    // then does caching resume.
    await page.evaluate(() => {
      const encoder = new TextEncoder();
      window.__CCC_PROVISION_STREAM__.enqueue(
        encoder.encode('{"event":"result","success":true}\n'),
      );
      window.__CCC_PROVISION_STREAM__.close();
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(5);
    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(5);
  });

  test("a push still in flight keeps exports uncached until it settles", async ({ page }) => {
    await loadDeployHooks(page);

    const zip = new JSZip();
    zip.file(
      "pubspec.yaml",
      "name: my_app\n\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    const projectZip = await zip.generateAsync({ type: "base64" });

    let exportCalls = 0;
    await page.route("**/exportCode", async (route) => {
      exportCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ value: { project_zip: projectZip } }),
      });
    });
    // The push hangs past the UI bound; the test releases it afterwards.
    await page.evaluate(() => {
      const realFetch = window.fetch;
      window.__CCC_PUSH_RELEASE__ = null;
      window.fetch = (url, ...args) => {
        if (String(url).includes("syncCustomCodeChanges")) {
          return new Promise((resolve) => {
            window.__CCC_PUSH_RELEASE__ = () =>
              resolve(new Response('{"success":true}', { status: 200 }));
          });
        }
        return realFetch(url, ...args);
      };
    });

    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(1);

    const outcome = await page.evaluate(async () => {
      try {
        await window.__CCC_PUSH_CODE_WITH_TIMEOUT__(
          { project_id: "ff-proj-0007", zipped_custom_code: "eA==" },
          60,
        );
        return { settled: "resolved" };
      } catch (error) {
        return { settled: "rejected", name: error.name };
      }
    });
    expect(outcome.name).toBe("UnconfirmedDeployError");

    // While the push is still in flight its writes can land at any moment —
    // exports must not be cached.
    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(2);
    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(3);

    // Once the request settles, no write can arrive later — the next export
    // is authoritative and caches again.
    await page.evaluate(() => window.__CCC_PUSH_RELEASE__());
    await page.waitForTimeout(50);
    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(4);
    await page.evaluate(() => window.__CCC_RESOLVE_PROJECT_PUBSPEC__({}));
    expect(exportCalls).toBe(4);
  });
});
