import { test, expect } from "@playwright/test";
import { applyDefaultRoutes } from "./fixtures/apiFixtures.js";

/**
 * STU-378 — Results Summary and artifact inspection.
 *
 * Asserts the rebuilt Results Summary / artifact tabs against real bundle
 * shapes: stable artifact identities, WAI-ARIA tablist/tab/tabpanel semantics,
 * keyboard (arrow/Home/End) selection that retains focus across re-renders,
 * unknown-vs-fabricated review scores, bundle warnings kept distinct from
 * per-file issues, the equal-prominence ordered result actions, and clipboard
 * copy that surfaces a non-blocking failure when permission is denied.
 */

const artifact = (id, name, type, code, extra = {}) => ({
  id,
  artifactName: name,
  artifactType: type,
  fileName: `${name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).replace(/^_/, "")}.dart`,
  code,
  dependencies: [],
  imports: [],
  publicApi: [],
  ...extra,
});

const mixedBundle = {
  id: "mixed-bundle",
  title: "Mixed FlutterFlow bundle",
  artifacts: [
    artifact("model-event", "AgentEvent", "CustomClass", "class AgentEvent { final String id; AgentEvent(this.id); }", {
      dependencies: [{ name: "equatable", version: "^2.0.5", reason: "Value equality" }],
    }),
    artifact("widget-view", "AgentView", "CustomWidget", "class AgentView extends StatelessWidget { const AgentView({super.key}); }"),
  ],
  warnings: ["Deploy the model before the widget."],
  relationships: [],
  deployOrder: ["model-event", "widget-view"],
  metadata: {},
};

const mixedReview = {
  overallReview: { status: "warning", score: 86, summary: "Two files are ready for inspection." },
  findings: [{ severity: "warning", message: "Bundle API should remain stable." }],
  artifacts: [
    { id: "model-event", review: { status: "pass", findings: [], manualActions: [{ title: "Create the AgentEvent custom data type in FlutterFlow." }] } },
    { id: "widget-view", review: { status: "warning", findings: [{ severity: "warning", message: "Add width and height parameters.", suggestion: "Match the generated constructor." }] } },
  ],
};

async function renderResults(page, bundle, review) {
  // The hook surfaces the Results view itself; navigate to the plain landing
  // (NOT ?debugBundle=multi, which re-renders the debug bundle ~1.6s after
  // load and would clobber the fixture under assertion).
  await page.addInitScript(() => {
    localStorage.setItem("hasSeenWalkthrough", "true");
  });
  await applyDefaultRoutes(page);
  await page.goto("/");
  await page.waitForFunction(() => typeof window.__CCC_RENDER_RESULTS__ === "function");
  await page.evaluate(({ bundle, review }) => window.__CCC_RENDER_RESULTS__(bundle, review), { bundle, review });
  await expect(page.locator("#results-view")).toBeVisible();
}

test("single and mixed bundles show the selected file code and review", async ({ page }) => {
  const single = { ...mixedBundle, id: "single", title: "Single action", warnings: [], artifacts: [artifact("action-greet", "GreetUser", "CustomAction", "Future<String> greetUser() async => 'Hello';")] };
  await renderResults(page, single, { summary: "One action reviewed.", artifacts: [{ id: "action-greet", review: { status: "pass", findings: [] } }] });
  await page.getByRole("tab", { name: /GreetUser/ }).click();
  await expect(page.locator("#results-code-output")).toContainText("greetUser");
  await expect(page.locator("#results-audit-output")).toContainText("No file-specific issues were found");

  await page.evaluate(({ bundle, review }) => window.__CCC_RENDER_RESULTS__(bundle, review), { bundle: mixedBundle, review: mixedReview });
  await page.getByRole("tab", { name: /AgentView/ }).click();
  await expect(page.locator("#results-code-output")).toContainText("class AgentView");
  await expect(page.locator("#results-audit-output")).toContainText("Add width and height parameters");
  await page.getByRole("tab", { name: /AgentEvent/ }).click();
  await expect(page.locator("#results-code-output")).toContainText("class AgentEvent");
  await expect(page.locator("#results-audit-output")).toContainText("Create the AgentEvent custom data type");
  await page.getByText("File details").click();
  await expect(page.locator("#results-audit-output")).toContainText("equatable ^2.0.5");
});

test("arrow navigation selects tabs and retains keyboard focus across rendering", async ({ page }) => {
  await renderResults(page, mixedBundle, mixedReview);
  const summary = page.getByRole("tab", { name: "Summary" });
  await summary.focus();
  await summary.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /AgentEvent/ })).toBeFocused();
  await expect(page.getByRole("tab", { name: /AgentEvent/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /AgentView/ })).toBeFocused();
  await expect(page.locator("#results-code-output")).toContainText("class AgentView");
  await page.keyboard.press("Home");
  await expect(summary).toBeFocused();
  await expect(page.locator("#results-summary-detail")).toBeVisible();
});

test("unknown review scores and bundle warnings are not confused with file issues", async ({ page }) => {
  await renderResults(page, mixedBundle, { ...mixedReview, overallReview: { status: "warning", score: "Score: 999/100", summary: "Review score malformed." } });
  await expect(page.locator(".review-score")).toContainText("Not scored");
  await expect(page.locator(".review-score")).not.toContainText("100");
  const bundleWarnings = page.locator(".summary-bundle-warnings");
  await expect(bundleWarnings).toContainText("Deploy the model before the widget");
  await page.getByRole("tab", { name: /AgentView/ }).click();
  await expect(page.locator("#results-audit-output")).toContainText("Add width and height parameters");
  await expect(page.locator("#results-audit-output")).not.toContainText("Deploy the model before the widget");
});

test("clipboard denial reports a non-blocking failure", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException("Denied", "NotAllowedError")) },
    });
  });
  await renderResults(page, mixedBundle, mixedReview);
  await page.getByRole("tab", { name: /AgentEvent/ }).click();
  await page.locator("#btn-copy-results").click();
  await expect(page.locator("#results-copy-status")).toContainText("permission was denied");
  await expect(page.locator("#artifact-results-split")).toBeVisible();
});

for (const viewport of [{ name: "mobile", width: 390, height: 844 }, { name: "desktop", width: 1440, height: 900 }]) {
  test(`actions, copy, and long code work at ${viewport.name}`, async ({ page, context }) => {
    await page.setViewportSize(viewport);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const longCode = Array.from({ length: 240 }, (_, index) => `final value${index} = ${index};`).join("\n");
    const bundle = { ...mixedBundle, artifacts: [artifact("long-file", "LongFile", "CustomAction", longCode)] };
    await renderResults(page, bundle, { summary: "Long file reviewed.", artifacts: [{ id: "long-file", review: { status: "pass", findings: [] } }] });
    await page.getByRole("tab", { name: /LongFile/ }).click();

    const actions = page.locator(".results-action-bar > button");
    await expect(actions).toHaveCount(3);
    await expect(actions.nth(0)).toContainText("Deploy to FlutterFlow");
    await expect(actions.nth(1)).toContainText("Add FlutterFlow Build Errors & Regenerate");
    await expect(actions.nth(2)).toContainText("Refine & Regenerate");
    await expect(actions.nth(0)).toBeVisible();
    await expect(actions.nth(1)).toBeVisible();
    await expect(actions.nth(2)).toBeVisible();

    await page.locator("#btn-copy-results").click();
    await expect(page.locator("#results-copy-status")).toContainText("copied", { ignoreCase: true });
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(longCode);

    const scroll = await page.locator(".results-panel:first-child .panel-body").evaluate((node) => ({ scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }));
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  });
}
