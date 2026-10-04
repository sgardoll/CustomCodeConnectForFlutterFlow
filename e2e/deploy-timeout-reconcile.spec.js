import { test, expect } from "@playwright/test";
import JSZip from "jszip";
import { applyDefaultRoutes, ENDPOINTS } from "./fixtures/apiFixtures.js";

/**
 * Item 10 — the slow-runner timeout path and the reconcile message.
 *
 * A provision that outlives the browser UI bound is UNCONFIRMED, never a
 * fabricated failure. Where the old code left the user on "go check
 * FlutterFlow yourself", the reconcile re-read (reconcileUnconfirmedProvision)
 * fetches the project back and says which classes actually landed and what a
 * retry will do. These tests drive the real provisioning transport against a
 * deliberately slow mocked runner (the bound is shortened to milliseconds, not
 * 840 real seconds), then render the reconcile outcome through the real
 * terminal renderer (`__CCC_RENDER_DEPLOY_TERMINAL__`), the same entry point
 * stu380-deploy.spec.js uses.
 *
 * The terminal copy is owned by another agent in this workstream and may be
 * adjusted in parallel, so the rendering assertions here are structural and
 * semantic (the modal appears, it is an unconfirmed outcome rather than a
 * plain fabricated failure, it names the project, tells the user what to do
 * next, and offers the FlutterFlow action control) rather than pinned to any
 * exact sentence.
 */

const identity = {
  projectId: "ff-proj-0007",
  endpoint: "https://api.flutterflow.io",
  artifactType: "CustomClass",
  artifactName: "GaugeModel",
  fileName: "gauge_widget.dart",
};

// One custom class the runner "writes" before the response is lost.
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
    () =>
      typeof window.__CCC_PROVISION_CUSTOM_CLASSES__ === "function" &&
      typeof window.__CCC_RENDER_DEPLOY_TERMINAL__ === "function",
  );
}

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

// A project export that already contains the custom class — what the runner's
// write leaves behind before its response is lost. Reconcile reads this back to
// say the class actually landed.
async function projectZipWithClassLanded() {
  const zip = new JSZip();
  zip.file("pubspec.yaml", "name: my_app\n");
  zip.file(
    "lib/custom_code/gauge_model.dart",
    "class GaugeModel { final int value; GaugeModel(this.value); }",
  );
  return zip.generateAsync({ type: "base64" });
}

// The runner accepts the provisioning connection but never answers, so the
// request times out at the (shortened) UI bound while the class may already be
// written on the server.
async function stallRunner(page) {
  await page.route(ENDPOINTS.deployCustomClasses, () => new Promise(() => {}));
}

test.describe("Item 10 slow-runner timeout + reconcile", () => {
  test("a slow provision past the bound re-reads the project and reports what actually landed", async ({ page }) => {
    await loadDeployHooks(page);
    await page.route("**/exportCode", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          value: { project_zip: await projectZipWithClassLanded() },
        }),
      });
    });
    await stallRunner(page);

    const outcome = await settleAsOutcome(
      page,
      "__CCC_PROVISION_CUSTOM_CLASSES__",
      [{ fileMap: attemptedClass, uiTimeoutMs: 60 }],
    );

    // Losing the response is unconfirmed — never a fabricated failure.
    expect(outcome.settled).toBe("rejected");
    expect(outcome.name).toBe("UnconfirmedDeployError");
    expect(outcome.outcome).toBe("unconfirmed");
    // The reconcile re-read ran: the message names the class that actually
    // landed instead of a dead-end "go check yourself". The class name is data
    // carried by the reconcile, so this is durable against copy edits.
    expect(outcome.message).toContain("GaugeModel");
    // The message offers a concrete next step, not just a verdict.
    expect(outcome.message).not.toContain("has stopped waiting");
  });

  test("the reconcile message renders in an unconfirmed terminal modal that names the project and next steps", async ({ page }) => {
    await loadDeployHooks(page);
    await page.route("**/exportCode", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          value: { project_zip: await projectZipWithClassLanded() },
        }),
      });
    });
    await stallRunner(page);

    // Produce the real reconcile message through the transport, then render it
    // through the real terminal renderer — the exact presentation a user sees.
    const outcome = await settleAsOutcome(
      page,
      "__CCC_PROVISION_CUSTOM_CLASSES__",
      [{ fileMap: attemptedClass, uiTimeoutMs: 60 }],
    );
    expect(outcome.name).toBe("UnconfirmedDeployError");
    await page.evaluate(
      ({ message, targetIdentity }) => {
        window.__CCC_RENDER_DEPLOY_TERMINAL__({
          success: false,
          unconfirmed: true,
          targetIdentity,
          error: message,
        });
      },
      { message: outcome.message, targetIdentity: identity },
    );

    const terminal = page.locator("#commit-terminal-modal");
    // The terminal modal appeared at all.
    await expect(terminal).toBeVisible();
    // It is an unconfirmed outcome, not a fabricated failure: the heading is
    // the unknown-state label, never "Deploy failed" or "Committed".
    await expect(terminal.locator("#terminal-heading")).not.toContainText(
      "Deploy failed",
    );
    await expect(terminal).not.toContainText("Committed");
    // It names the project the user confirmed.
    await expect(terminal).toContainText(identity.projectId);
    // The reconcile message itself is on screen (it carries the landed class).
    await expect(terminal).toContainText("GaugeModel");
    // It tells the user what to do next — the guidance section is rendered.
    await expect(page.locator("#terminal-guidance")).not.toBeEmpty();
    // The action control it offers is present and targets the project.
    await expect(page.locator("#terminal-open-ff-link")).toHaveAttribute(
      "href",
      `https://app.flutterflow.io/project/${identity.projectId}`,
    );
  });
});
