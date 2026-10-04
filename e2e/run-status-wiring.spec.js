import { test, expect } from "@playwright/test";
import JSZip from "jszip";
import { applyDefaultRoutes, ENDPOINTS } from "./fixtures/apiFixtures.js";

/**
 * E2E proof of the run-status wiring (PR #118) — that the client's generated
 * run id actually changes the outcome of a timed-out deploy.
 *
 * A deploy can outlive the browser UI bound. Before the run-status work, a
 * time-out was always UNCONFIRMED and the user had to go check FlutterFlow by
 * hand. Now the client generates a run id, sends it with the deploy request,
 * and on an unconfirmed provision asks `GET /runStatus/<runId>` what happened.
 * The whole mechanism is identity: the id queried must be the id the deploy
 * carried, or the answer belongs to someone else's run. These tests therefore
 * capture the id in the deploy request body AND the id in the status query and
 * assert they are the same — a spec that stubbed the two independently would
 * pass even if the wiring were broken.
 *
 * The runner's status record is a `{status, phase, message, error, deployed}`
 * object served at `GET /runStatus/<runId>` on the same runner as
 * `/deployCustomClasses`, exactly as `src/runStatus.js` reads it.
 *
 * Three outcomes are proven:
 *   (a) DONE   -> the provision SUCCEEDS (a known success, not unconfirmed)
 *                 and step 3 (the pubspec push) is still reachable.
 *   (b) FAILED at a pre-write phase ("verifying") -> a REAL failure with
 *                 nothing written, not an unconfirmed outcome.
 *   (c) 404    -> an older runner / a run that never arrived: falls back to
 *                 the existing reconcile and still reports unconfirmed —
 *                 backward compatibility, not a crash/fabricated failure.
 *
 * The provisioning transport is driven through the real
 * `__CCC_PROVISION_CUSTOM_CLASSES__` hook (same entry point as stu380-deploy,
 * deploy-timeout-reconcile and finish-deploy), with the deploy stalled past a
 * shortened `uiTimeoutMs` instead of the real 840s bound — exactly how the
 * sibling timeout specs already do it.
 */

const identity = {
  projectId: "ff-proj-0007",
  endpoint: "https://api.flutterflow.io",
  artifactType: "CustomClass",
  artifactName: "GaugeModel",
  fileName: "gauge_widget.dart",
};

// One custom class the runner is asked to write. For the pre-write failure (b)
// nothing lands; for the reconcile fallback (c) it lands so the reconcile can
// report what actually happened.
const attemptedClass = {
  "gauge_model.dart": {
    artifactName: "GaugeModel",
    content: "class GaugeModel { final int value; GaugeModel(this.value); }",
    type: "C",
    path: "lib/custom_code/gauge_model.dart",
  },
};

async function loadDeployHooks(page) {
  await page.addInitScript(() => {
    localStorage.setItem("hasSeenWalkthrough", "true");
  });
  await applyDefaultRoutes(page);
  await page.goto("/");
  await page.waitForFunction(
    () => typeof window.__CCC_PROVISION_CUSTOM_CLASSES__ === "function",
  );
}

// Drive the real provision transport and return the settled outcome exactly as
// the caller sees it: the resolved value for a success, or name/outcome/message
// for a rejection.
async function provision(page, args) {
  return page.evaluate(async (args) => {
    try {
      const result = await window.__CCC_PROVISION_CUSTOM_CLASSES__(args);
      return { settled: "resolved", result };
    } catch (error) {
      return {
        settled: "rejected",
        name: error.name,
        outcome: error.outcome,
        message: error.message,
      };
    }
  }, args);
}

// A project export that already contains the custom class — what exists after
// a pre-write failure is NOT this (nothing is written), but what the reconcile
// fallback re-reads when the class did land.
async function projectZipWithClassLanded() {
  const zip = new JSZip();
  zip.file("pubspec.yaml", "name: my_app\n");
  zip.file(
    "lib/custom_code/gauge_model.dart",
    "class GaugeModel { final int value; GaugeModel(this.value); }",
  );
  return zip.generateAsync({ type: "base64" });
}

test.describe("run-status wiring on a timed-out deploy", () => {
  test("(a) a runner-recorded DONE makes the timed-out provision a known success, queried with the id the deploy sent", async ({ page }) => {
    await loadDeployHooks(page);

    // Capture the run id the deploy request actually carried, then never answer
    // so the provision times out at the shortened bound.
    let deployRunId = null;
    await page.route(ENDPOINTS.deployCustomClasses, async (route) => {
      deployRunId = (JSON.parse(route.request().postData() || "{}").runId) || null;
      await new Promise(() => {}); // stall: the runner never answers on time
    });

    // Route the status endpoint: answer DONE and remember the id it was asked
    // about, so we can prove identity rather than stub the two independently.
    let queriedRunId = null;
    let statusCalls = 0;
    await page.route("**/runStatus/**", async (route) => {
      statusCalls += 1;
      queriedRunId = route.request().url().split("/runStatus/")[1] || null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "done",
          phase: "done",
          message: "done",
          deployed: ["gauge_model.dart"],
          dryRun: false,
        }),
      });
    });

    const outcome = await provision(page, {
      fileMap: attemptedClass,
      uiTimeoutMs: 60,
    });

    // The status request actually went out — the wiring ran, it was not skipped.
    expect(statusCalls).toBeGreaterThan(0);
    // The id the client queried is the same id it sent with the deploy request:
    // this is the whole mechanism, not two independent stubs.
    expect(queriedRunId).toBe(deployRunId);
    expect(deployRunId).toMatch(/^dr_/);
    // DONE upgrades the unconfirmed provision to a KNOWN SUCCESS: it resolves,
    // reports provisionSucceeded, and the flow may proceed to step 3 — it does
    // NOT report an unknown outcome.
    expect(outcome.settled).toBe("resolved");
    expect(outcome.result.provisionSucceeded).toBe(true);
  });

  test("(b) a runner-recorded FAILURE at a pre-write phase surfaces as a real failure, not unconfirmed", async ({ page }) => {
    await loadDeployHooks(page);

    let deployRunId = null;
    await page.route(ENDPOINTS.deployCustomClasses, async (route) => {
      deployRunId = (JSON.parse(route.request().postData() || "{}").runId) || null;
      await new Promise(() => {});
    });

    let queriedRunId = null;
    await page.route("**/runStatus/**", async (route) => {
      queriedRunId = route.request().url().split("/runStatus/")[1] || null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "failed",
          phase: "verifying", // pre-write: the compile gate refused it
          message: "verifying",
          error: "Compile gate refused the widget signature.",
          deployed: [],
          dryRun: false,
        }),
      });
    });

    const outcome = await provision(page, {
      fileMap: attemptedClass,
      uiTimeoutMs: 60,
    });

    // Same-id identity holds for the failure path too.
    expect(queriedRunId).toBe(deployRunId);
    // A pre-write phase failure means nothing was written: it is a REAL failure
    // (a plain Error derived from the runner's answer), NOT an unknown outcome.
    expect(outcome.settled).toBe("rejected");
    expect(outcome.name).toBe("Error");
    expect(outcome.name).not.toBe("UnconfirmedDeployError");
    expect(outcome.outcome).toBeUndefined();
    expect(outcome.message).toContain("Compile gate refused");
  });

  test("(c) a 404 status answer falls back to the reconcile and still reports unconfirmed — backward compatible", async ({ page }) => {
    await loadDeployHooks(page);

    // The class lands in the export, so the reconcile re-read can report it.
    await page.route("**/exportCode", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          value: { project_zip: await projectZipWithClassLanded() },
        }),
      });
    });

    let deployRunId = null;
    await page.route(ENDPOINTS.deployCustomClasses, async (route) => {
      deployRunId = (JSON.parse(route.request().postData() || "{}").runId) || null;
      await new Promise(() => {});
    });

    // The status endpoint answers 404 — an older runner with no run-status
    // endpoint, or a run that never arrived. This is the backward-compat case.
    let queriedRunId = null;
    await page.route("**/runStatus/**", async (route) => {
      queriedRunId = route.request().url().split("/runStatus/")[1] || null;
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ success: false, error: "Unknown run." }),
      });
    });

    const outcome = await provision(page, {
      fileMap: attemptedClass,
      uiTimeoutMs: 60,
    });

    // Even the fallback queried the same id the deploy carried — the wiring
    // attempted the truth before it fell back.
    expect(queriedRunId).toBe(deployRunId);
    // No definitive answer is available: it falls back to the reconcile and
    // reports UNCONFIRMED — it does not crash, and it does not fabricate a
    // failure. The reconcile re-read ran: the message reports the class that
    // actually landed (backward-compatible truthfulness).
    expect(outcome.settled).toBe("rejected");
    expect(outcome.name).toBe("UnconfirmedDeployError");
    expect(outcome.outcome).toBe("unconfirmed");
    expect(outcome.message).toContain("GaugeModel");
    expect(outcome.message).not.toContain("Compile gate refused");
  });
});
