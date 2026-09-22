import { test, expect } from "@playwright/test";
import { applyDefaultRoutes, routeFulfill, ok, err, ENDPOINTS } from "./fixtures/apiFixtures.js";

/**
 * STU-388 — Review feedback controls reflect real submission outcomes.
 *
 * Asserts that the up/down reviewers' controls:
 *  - carry an accessible name, aria-pressed, mutual exclusivity and an
 *    aria-live announcement region (keyboard operable native buttons);
 *  - never show a vote as saved when the endpoint returns non-2xx or the
 *    network fails, and that a retry sends the CURRENT generation payload;
 *  - ignore a rapid double-click while a submission is pending (no duplicate
 *    sends for the same generation);
 *  - reset stale vote state (visual, aria-pressed, pending lock, status) when
 *    a new generation renders.
 */

const artifact = (id, name, code) => ({
  id,
  artifactName: name,
  artifactType: "CustomAction",
  fileName: `${name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).replace(/^_/, "")}.dart`,
  code,
  dependencies: [],
  imports: [],
  publicApi: [],
});

const feedbackRequests = (page) => {
  const captured = [];
  page.on("request", (req) => {
    if (req.url().includes("/connectFeedback")) {
      let body = null;
      try {
        body = req.postDataJSON();
      } catch {
        body = req.postData();
      }
      captured.push({ url: req.url(), body });
    }
  });
  return captured;
};
async function renderResults(page, bundle, review) {
  await page.addInitScript(() => {
    localStorage.setItem("hasSeenWalkthrough", "true");
  });
  await page.goto("/");
  await page.waitForFunction(() => typeof window.__CCC_RENDER_RESULTS__ === "function");
  await page.evaluate(({ bundle, review }) => window.__CCC_RENDER_RESULTS__(bundle, review), { bundle, review });
  await expect(page.locator("#results-view")).toBeVisible();
  await expect(page.locator("#btn-feedback-up")).toBeVisible();
}

const bundleA = {
  id: "bundle-a",
  title: "Bundle A",
  artifacts: [artifact("act-a", "GreetUser", "Future<String> greet() async => 'A';")],
};
const reviewA = { summary: "Reviewed A.", artifacts: [{ id: "act-a", review: { status: "pass", findings: [] } }] };

const bundleB = {
  id: "bundle-b",
  title: "Bundle B",
  artifacts: [artifact("act-b", "FarewellUser", "Future<String> farewell() async => 'B';")],
};
const reviewB = { summary: "Reviewed B.", artifacts: [{ id: "act-b", review: { status: "pass", findings: [] } }] };

test("up/down are keyboard operable, mutually exclusive, and announce success", async ({ page }) => {
  await applyDefaultRoutes(page);
  await renderResults(page, bundleA, reviewA);

  const up = page.locator("#btn-feedback-up");
  const down = page.locator("#btn-feedback-down");
  const status = page.locator("#results-feedback-status");

  await expect(up).toHaveAttribute("aria-label", /Yes/);
  await expect(up).toHaveAttribute("aria-pressed", "false");
  await expect(down).toHaveAttribute("aria-pressed", "false");

  // Keyboard operable: focus the native button and activate with Enter.
  await up.focus();
  await expect(up).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(up).toHaveAttribute("aria-pressed", "true");
  await expect(up).toHaveClass(/active-up/);
  await expect(down).toHaveAttribute("aria-pressed", "false");
  await expect(status).toContainText("saved");

  // Mutually exclusive: choosing down clears the up vote.
  await page.keyboard.press("Tab"); // tabs from up to down
  await expect(down).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(down).toHaveAttribute("aria-pressed", "true");
  await expect(down).toHaveClass(/active-down/);
  await expect(up).toHaveAttribute("aria-pressed", "false");
  await expect(up).not.toHaveClass(/active-up/);
});

test("non-2xx is never shown as saved; retry sends the current generation payload", async ({ page }) => {
  const captured = feedbackRequests(page);
  // First attempt fails with HTTP 500.
  await applyDefaultRoutes(page, { [ENDPOINTS.connectFeedback]: err(500, { error: "boom" }) });
  await renderResults(page, bundleA, reviewA);

  const up = page.locator("#btn-feedback-up");
  await up.click();
  // Failed: the vote must NOT appear saved and must remain retry-able.
  await expect(up).toHaveAttribute("aria-pressed", "false");
  await expect(up).not.toHaveClass(/active-up/);
  await expect(up).toBeEnabled();
  await expect(page.locator("#results-feedback-status")).toContainText("retry");
  expect(captured.length).toBe(1);
  expect(captured[0].body.type).toBe("thumbsUp");

  // Retry after the service recovers — must carry the SAME current bundle.
  await routeFulfill(page, (url) => url.toString().includes("/connectFeedback"), ok({ success: true }));
  await up.click();
  await expect(up).toHaveAttribute("aria-pressed", "true");
  await expect(up).toHaveClass(/active-up/);
  await expect(page.locator("#results-feedback-status")).toContainText("saved");
  expect(captured.length).toBe(2);
  const retry = captured[1].body;
  expect(retry.type).toBe("thumbsUp");
  expect(retry.code).toBe(JSON.stringify(bundleA));
});

test("a network failure is never shown as saved; retry re-sends current generation", async ({ page }) => {
  const captured = feedbackRequests(page);
  await applyDefaultRoutes(page);
  // Reject the connectFeedback request at the network layer.
  await page.route((url) => url.toString().includes("/connectFeedback"), (route) => route.abort());
  await renderResults(page, bundleA, reviewA);

  const up = page.locator("#btn-feedback-up");
  await up.click();
  await expect(up).toHaveAttribute("aria-pressed", "false");
  await expect(up).not.toHaveClass(/active-up/);
  await expect(up).toBeEnabled();
  await expect(page.locator("#results-feedback-status")).toContainText("retry");

  // Recover and retry with the current bundle still in hand.
  await page.unroute((url) => url.toString().includes("/connectFeedback"));
  await routeFulfill(page, (url) => url.toString().includes("/connectFeedback"), ok({ success: true }));
  await up.click();
  await expect(up).toHaveAttribute("aria-pressed", "true");
  expect(captured.length).toBe(2);
  expect(captured[1].body.code).toBe(JSON.stringify(bundleA));
});

test("rapid double-click sends only one request while pending", async ({ page }) => {
  await applyDefaultRoutes(page);
  // Hold the response open so the pending lock is active during the second
  // click. Capture posts directly in the route handler (the page.on("request")
  // listener double-counts here because the route also sees the request).
  let release;
  let posts = [];
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route((url) => url.toString().includes("/connectFeedback"), async (route) => {
    posts.push({ url: route.request().url(), body: route.request().postDataJSON() });
    await gate;
    await route.fulfill(ok({ success: true }));
  });
  await renderResults(page, bundleA, reviewA);

  const up = page.locator("#btn-feedback-up");
  await up.click();
  // Second click while the first is in flight: force bypasses the disabled
  // actionability check so we can prove the pending lock swallows it.
  await up.click({ force: true });
  await expect(up).toBeDisabled();
  expect(posts.length).toBe(1);
  release();
  await expect(up).toHaveAttribute("aria-pressed", "true");
  await expect(up).toBeEnabled();
  expect(posts.length).toBe(1); // still exactly one send
});

test("a new generation resets stale feedback state and does not carry a prior vote", async ({ page }) => {
  const captured = feedbackRequests(page);
  await applyDefaultRoutes(page, { [ENDPOINTS.connectFeedback]: ok({ success: true }) });
  await renderResults(page, bundleA, reviewA);

  const up = page.locator("#btn-feedback-up");
  await up.click();
  await expect(up).toHaveAttribute("aria-pressed", "true");
  await expect(up).toHaveClass(/active-up/);

  // Render a NEW generation (different bundle). Stale vote must reset.
  await page.evaluate(({ bundle, review }) => window.__CCC_RENDER_RESULTS__(bundle, review), { bundle: bundleB, review: reviewB });
  await expect(up).toHaveAttribute("aria-pressed", "false");
  await expect(up).not.toHaveClass(/active-up/);
  await expect(page.locator("#btn-feedback-down")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#results-feedback-status")).toHaveText("");

  // A fresh vote on the new generation sends the NEW bundle payload.
  await up.click();
  expect(captured.length).toBe(2);
  expect(captured[1].body.code).toBe(JSON.stringify(bundleB));
  await expect(up).toHaveAttribute("aria-pressed", "true");
});
