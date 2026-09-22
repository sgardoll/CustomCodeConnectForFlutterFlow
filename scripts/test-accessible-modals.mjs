// @ts-nocheck -- assertions execute in Playwright's browser realm.
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const origin = "http://127.0.0.1:4178";
const preview = spawn(process.platform === "win32" ? "npm.cmd" : "npm", [
  "run", "preview", "--", "--host", "127.0.0.1", "--port", "4178",
], { stdio: "ignore" });

async function waitForPreview() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(origin)).ok) return; } catch {}
    await delay(100);
  }
  throw new Error("Vite preview did not start.");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function openFromTrigger(page, modalId, expression) {
  await page.evaluate(({ modalId, expression }) => {
    document.getElementById("modal-test-trigger")?.remove();
    const trigger = document.createElement("button");
    trigger.id = "modal-test-trigger";
    trigger.textContent = `Open ${modalId}`;
    document.body.append(trigger);
    trigger.focus();
    Function(`return (${expression})`)()();
  }, { modalId, expression });
  const modal = page.locator(`#${modalId}`);
  await modal.waitFor({ state: "visible" });
  await page.waitForFunction((id) => document.getElementById(id)?.contains(document.activeElement), modalId, { timeout: 3000 });
  const semantics = await modal.evaluate((element) => ({
    role: element.getAttribute("role"),
    modal: element.getAttribute("aria-modal"),
    labelledBy: element.getAttribute("aria-labelledby"),
    focusInside: element.contains(document.activeElement),
  }));
  assert(semantics.role === "dialog" && semantics.modal === "true", `${modalId} lacks dialog semantics`);
  assert(Boolean(semantics.labelledBy), `${modalId} is not labelled`);
  assert(semantics.focusInside, `${modalId} did not receive initial focus`);

  for (let index = 0; index < 12; index++) {
    await page.keyboard.press("Tab");
    assert(await modal.evaluate((element) => element.contains(document.activeElement)), `${modalId} leaked focus`);
  }
  await page.keyboard.press("Escape");
  if (modalId === "api-keys-modal" && await page.locator("#walkthrough-modal").evaluate((element) => element.classList.contains("open"))) {
    await page.keyboard.press("Escape");
  }
  await modal.waitFor({ state: "hidden" });
  assert(await page.locator("#modal-test-trigger").evaluate((element) => element === document.activeElement), `${modalId} did not return focus`);
}

try {
  await waitForPreview();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 360, height: 500 } });
  await page.addInitScript(() => {
    localStorage.setItem("hasSeenWalkthrough", "true");
    globalThis.hljs = { configure() {}, highlight(code) { return { value: String(code) }; } };
  });
  await page.route("https://**/*", (route) => route.abort());
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.openApiKeysModal === "function");

  const cases = [
    ["api-keys-modal", "window.openApiKeysModal"],
    ["walkthrough-modal", "window.openWalkthroughModal"],
    ["signin-modal", "window.openSignInModal"],
    ["pricing-modal", "window.openPricingModal"],
    ["commit-confirm-modal", `() => window.openCommitConfirmModal({fileName:'test.dart',artifactType:'CustomAction',content:'void test() {}'}, {warnings:[]}, null)`],
    ["commit-success-modal", `() => window.showCommitSuccessModal({success:true,message:'Done',metadata:{projectId:'test',fileName:'test.dart',artifactType:'CustomAction',codeSize:14}})`],
  ];
  for (const [id, expression] of cases) {
    console.log(`Checking ${id}...`);
    await openFromTrigger(page, id, expression);
  }

  await page.evaluate(() => {
    window.__backgroundKeys = 0;
    window.addEventListener("keydown", () => window.__backgroundKeys++);
    window.commitProgress.start();
  });
  const progress = page.locator("#commit-progress-overlay");
  await progress.waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.keyboard.press("x");
  assert(await progress.isVisible(), "Pending modal was dismissible");
  assert(await page.evaluate(() => window.__backgroundKeys === 0), "A modal keypress leaked to the background");
  await page.evaluate(() => window.commitProgress.stop());

  await page.waitForTimeout(400);
  const responsive = await page.evaluate(() => {
    const modal = document.getElementById("pricing-modal");
    window.openPricingModal();
    const content = modal.querySelector(".modal-content");
    const controls = [...modal.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
    return {
      classes: modal.className,
      transform: getComputedStyle(content).transform,
      fits: content.getBoundingClientRect().height <= innerHeight - 16,
      scrollable: getComputedStyle(content).overflowY !== "visible",
      touchTargets: controls.filter((rect) => rect.width > 0 || rect.height > 0).every((rect) => rect.height >= 44 && rect.width >= 44),
      controlSizes: controls.map((rect) => [rect.width, rect.height]),
    };
  });
  assert(responsive.fits && responsive.scrollable, "Dialog does not fit and scroll in a small-height viewport");
  assert(responsive.touchTargets, `Dialog controls do not all provide 44px touch targets: ${JSON.stringify(responsive)}`);

  const states = await page.evaluate(() => {
    const button = document.querySelector("#pricing-modal button");
    const input = document.getElementById("signin-email-input");
    return {
      buttonMinHeight: parseFloat(getComputedStyle(button).minHeight),
      inputMinHeight: parseFloat(getComputedStyle(input).minHeight),
      focusOutline: getComputedStyle(button, ":focus-visible").outlineStyle,
    };
  });
  assert(states.buttonMinHeight >= 44 && states.inputMinHeight >= 44, "Shared control sizing is missing");

  await browser.close();
  console.log("Accessible modal browser checks passed (7 shells, 360x500 viewport).");
} finally {
  preview.kill("SIGTERM");
}
