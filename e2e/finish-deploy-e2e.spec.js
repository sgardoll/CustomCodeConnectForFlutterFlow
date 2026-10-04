import { test, expect } from "@playwright/test";
import JSZip from "jszip";
import {
  applyDefaultRoutes,
  ENDPOINTS,
  customCodeSync,
} from "./fixtures/apiFixtures.js";

/**
 * E2E proof of the "finish deploy" action (hardening/finish-deploy-e2e).
 *
 * The stated done criterion — "a simulated step-2 timeout ends with classes AND
 * pubspec both present" — was previously only exercised through the pure
 * decision helpers (isDeployFinishable, buildFinishPushFileMap). Here it is
 * proven through the actual handlers that perform the work:
 *
 *   1. A provisioning request to the runner stalls past a shortened UI bound
 *      while the class it was writing HAS landed in the project export.
 *      __CCC_PROVISION_CUSTOM_CLASSES__ drives the real provision transport
 *      (fetch -> stream read -> UI bound -> reconcile), which is the same real
 *      code path the terminal combos above already rely on; the real browser
 *      "confirm deploy" entry point is unreachable without a full generate ->
 *      review -> confirm journey, so the transport hook is used to start the
 *      flow, exactly as stu380-deploy.spec.js and deploy-timeout-reconcile.spec.js
 *      already do.
 *   2. The reconcile proves every class landed, so the terminal offers
 *      "Finish deploy". The error's finishDeploy context is merged exactly as
 *      app.js does (mergeFinishDeployContext) and shown through
 *      window.showCommitUnconfirmedModal — the same dispatch the real
 *      renderCommitTerminal uses for an UNCONFIRMED outcome — which arms the
 *      real window.finishProvisionedDeploy action behind the on-screen button.
 *   3. Running that action performs step 3 only. We assert on the INTERCEPTED
 *      syncCustomCodeChanges request body (serialized_yaml carries the merged
 *      dependency), that NO second request reaches /deployCustomClasses (the
 *      landed class is not re-provisioned), and that the terminal ends in a
 *      finished state rather than still-unknown.
 */

const identity = {
  projectId: "ff-proj-0007",
  endpoint: "https://api.flutterflow.io",
  artifactType: "CustomClass",
  artifactName: "GaugeWidget",
  fileName: "gauge_widget.dart",
};

// The single class the runner "writes" before its response is lost.
const attemptedClass = {
  "gauge_widget.dart": {
    artifactName: "GaugeWidget",
    content:
      "class GaugeWidget { final int value; GaugeWidget(this.value); }",
    type: "C",
    path: "lib/custom_code/gauge_widget.dart",
  },
};

// The pubspec the deploy merged locally before provisioning — the one the
// finish push must carry to FlutterFlow (step 3).
const mergedPubspec = `name: my_app
environment:
  sdk: ">=3.0.0 <4.0.0"
dependencies:
  flutter:
    sdk: flutter
  http: ^1.2.0
`;

test("an interrupted deploy finishes via the real step-3 push, pushes the merged pubspec, and does not re-provision the landed class", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("hasSeenWalkthrough", "true");
  });
  await applyDefaultRoutes(page);

  // The project export after the timeout contains the class the runner wrote —
  // what reconcile reads back to decide every class landed.
  const zip = new JSZip();
  zip.file("pubspec.yaml", mergedPubspec);
  zip.file(
    "lib/custom_code/gauge_widget.dart",
    attemptedClass["gauge_widget.dart"].content,
  );
  const projectZip = await zip.generateAsync({ type: "base64" });
  await page.route("**/exportCode", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ value: { project_zip: projectZip } }),
    });
  });

  // The runner accepts the connection but never answers: provisioning times
  // out at the (shortened) UI bound while the class may already be written.
  // Every hit is counted so we can prove the finish action adds no further one.
  let provisionCalls = 0;
  await page.route(ENDPOINTS.deployCustomClasses, () => {
    provisionCalls += 1;
    return new Promise(() => {});
  });

  // Capture the step-3 push request exactly as it leaves the page.
  let pushBody = null;
  await page.route("**/syncCustomCodeChanges", async (route) => {
    pushBody = JSON.parse(route.request().postData() || "{}");
    await route.fulfill(customCodeSync());
  });

  await page.goto("/");
  await page.waitForFunction(
    () =>
      typeof window.__CCC_PROVISION_CUSTOM_CLASSES__ === "function" &&
      typeof window.showCommitUnconfirmedModal === "function",
  );

  // Drive the real provision transport to an unconfirmed timeout, then arm the
  // real finish-deploy terminal exactly as the production flow does.
  const reconcile = await page.evaluate(
    async ({ fileMap, pubspecYaml, uiTimeoutMs, identity }) => {
      let error;
      try {
        await window.__CCC_PROVISION_CUSTOM_CLASSES__({
          fileMap,
          pubspecYaml,
          uiTimeoutMs,
        });
        return { settled: "resolved" };
      } catch (e) {
        error = e;
      }
      const fd = error.finishDeploy;
      if (!fd) {
        return { settled: "rejected", name: error.name, finishable: false };
      }
      // Mirror app.js mergeFinishDeployContext: gives the finished terminal the
      // identity and the "Deploy finished" message a normal deploy would show.
      const merged = {
        ...fd,
        result: {
          targetIdentity: identity,
          metadata: {
            artifactType: identity.artifactType,
            artifactName: identity.artifactName,
            fileName: identity.fileName,
            projectId: identity.projectId,
          },
          message: `Deploy finished: ${identity.artifactName || "custom classes"} and their dependencies are now in FlutterFlow.`,
          addedDependencies: [],
          unverified: [],
          approximate: [],
          warnings: [],
          elapsedTime: 0,
        },
      };
      window.showCommitUnconfirmedModal({
        success: false,
        unconfirmed: true,
        targetIdentity: identity,
        error: error.message,
        finishDeploy: merged,
      });
      return {
        settled: "rejected",
        name: error.name,
        finishable: true,
        mergedYamlHasDep: fd.serializedYaml.includes("http: ^1.2.0"),
        landedPaths: fd.landed.map((entry) => entry.path),
      };
    },
    { fileMap: attemptedClass, pubspecYaml: mergedPubspec, uiTimeoutMs: 60, identity },
  );

  // The provision timed out unconfirmed and the reconcile deemed it finishable.
  expect(reconcile.settled).toBe("rejected");
  expect(reconcile.name).toBe("UnconfirmedDeployError");
  expect(reconcile.finishable).toBe(true);
  expect(reconcile.landedPaths).toEqual(["lib/custom_code/gauge_widget.dart"]);
  // The finish context keeps the merged pubspec — this is what step 3 must push.
  expect(reconcile.mergedYamlHasDep).toBe(true);
  // Only the original stalled provision reached the runner so far.
  expect(provisionCalls).toBe(1);

  // The unconfirmed terminal appears with the finish action, and it names the
  // landed class rather than leaving the outcome unknown.
  const terminal = page.locator("#commit-terminal-modal");
  await expect(terminal).toBeVisible();
  await expect(terminal.locator("#terminal-heading")).toContainText(
    "Deploy almost complete",
  );
  await expect(terminal).toContainText("GaugeWidget");
  await expect(page.locator("#terminal-finish-deploy")).toBeVisible();

  // Run the action — the real window.finishProvisionedDeploy behind the button.
  await page.click("#terminal-finish-deploy");

  // The finished terminal replaces the unknown one with a success claim.
  const success = page.locator("#commit-success-modal");
  await expect(success).toBeVisible();
  await expect(page.locator("#success-message")).toContainText("Deploy finished");

  // Assertion 1: the step-3 push really carried the merged pubspec dependency.
  expect(pushBody).not.toBeNull();
  expect(pushBody.serialized_yaml).toContain("http: ^1.2.0");
  // The landed class is excluded from the finish-push file map (only the
  // pubspec dependency entry remains, and it travels via serialized_yaml, not
  // the file_map), so the push carries no entry for the already-landed class.
  expect(JSON.stringify(pushBody.file_map)).not.toContain("gauge_widget.dart");

  // Assertion 2: finishing did not re-provision the landed class.
  expect(provisionCalls).toBe(1);
});
