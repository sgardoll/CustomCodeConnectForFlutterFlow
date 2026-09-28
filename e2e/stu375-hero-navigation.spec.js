import { test, expect } from "@playwright/test";
import { applyDefaultRoutes } from "./fixtures/apiFixtures.js";

test.beforeEach(async ({ page }) => {
  await applyDefaultRoutes(page);
  await page.addInitScript(() => {
    localStorage.setItem("hasSeenWalkthrough", "true");
  });
});

const viewports = [
  { name: "mobile", width: 360, height: 800 },
  { name: "desktop", width: 1440, height: 900 },
];

for (const { name, width, height } of viewports) {
  test(`${name} viewport shows hero, topbar, composer and has no horizontal scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");

    const topbar = page.locator("header.topbar");
    const hero = page.locator(".hero");
    const composer = page.locator(".composer");

    await expect(topbar).toBeVisible();
    await expect(hero).toBeVisible();
    await expect(composer).toBeVisible();

    const hasOverflow = await page.evaluate(() => {
      const html = document.documentElement;
      return html.scrollWidth > html.clientWidth + 1;
    });
    expect(hasOverflow, "page should not scroll horizontally").toBe(false);
  });
}

test("mobile topbar keeps Home and Account reachable", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");

  const brand = page.locator("header.topbar .brand");
  const avatar = page.locator("#topbar-avatar");
  await expect(brand).toBeVisible();
  await expect(avatar).toBeVisible();

  // The logo is the surviving Home control and offers a 44px touch target.
  const brandBox = await brand.boundingBox();
  expect(brandBox.height, "logo should offer a 44px touch target").toBeGreaterThanOrEqual(44);
  expect(brandBox.width, "logo should offer a 44px touch target").toBeGreaterThanOrEqual(44);

  // Account stays reachable through the avatar; the logo returns Home.
  await avatar.click();
  await expect(page.locator("#account-view")).toBeVisible();

  await brand.click();
  await expect(page.locator("#home-view")).toBeVisible();

  const hasOverflow = await page.evaluate(() => {
    const html = document.documentElement;
    return html.scrollWidth > html.clientWidth + 1;
  });
  expect(hasOverflow, "mobile header should not force horizontal scrolling").toBe(false);
});

test("header shows only the black ribbon mark — no box, no wordmark, no nav", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const topbar = page.locator("header.topbar");
  await expect(topbar).toBeVisible();

  // The four nav links and the Tutorial entry are gone from the header.
  await expect(topbar.locator(".topnav")).toHaveCount(0);
  await expect(topbar.locator("a.nav-link")).toHaveCount(0);
  await expect(page.locator("#wt-reopen")).toHaveCount(0);

  // The brand is the icon alone: one svg, no wordmark, no boxed rect.
  const brand = topbar.locator(".brand");
  await expect(brand).toBeVisible();
  await expect(brand.locator("svg")).toHaveCount(1);
  await expect(brand.locator(".wordmark")).toHaveCount(0);
  await expect(brand.locator("rect")).toHaveCount(0);

  // The mark is painted in the ink colour (black), not a surface-coloured
  // glyph inside a box.
  await expect(brand.locator("path").first()).toHaveAttribute("fill", "currentColor");
  const markColor = await brand.locator("svg").evaluate((el) => getComputedStyle(el).color);
  const ink = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--fg)";
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  expect(markColor).toBe(ink);

  // The header paints no background of its own.
  const background = await topbar.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(["rgba(0, 0, 0, 0)", "transparent"]).toContain(background);
});

test("the avatar reaches Account and the logo returns Home", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await page.click("#topbar-avatar");
  await expect(page.locator("#account-view")).toBeVisible();
  await expect(page.locator("#home-view")).toBeHidden();

  await page.click("header.topbar .brand");
  await expect(page.locator("#home-view")).toBeVisible();
  await expect(page.locator("#account-view")).toBeHidden();
});

test("200% zoom keeps controls readable and on-screen", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto("/");
  await page.evaluate(() => {
    document.body.style.zoom = "2";
  });

  await expect(page.locator("header.topbar")).toBeVisible();
  await expect(page.locator(".composer")).toBeVisible();
  await expect(page.locator(".send")).toBeVisible();

  const hasOverflow = await page.evaluate(() => {
    const html = document.documentElement;
    return html.scrollWidth > html.clientWidth + 1;
  });
  expect(hasOverflow, "page should not scroll horizontally at 200% zoom").toBe(false);

  const sendBox = await page.locator(".send").boundingBox();
  expect(sendBox.width).toBeGreaterThanOrEqual(18);
  expect(sendBox.height).toBeGreaterThanOrEqual(18);
});

test("navigation switches surfaces and hidden surfaces are not focusable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("#home-view")).toBeVisible();

  await page.click("#topbar-avatar");
  await expect(page.locator("#account-view")).toBeVisible();
  await expect(page.locator("#home-view")).toBeHidden();
  await expect(page.locator("#plans-view")).toBeHidden();

  const hiddenFocusableHome = await page.locator("#home-view").evaluate((el) => {
    const focusable = el.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    return Array.from(focusable).filter((n) => !n.hidden && n.offsetParent !== null).length;
  });
  expect(hiddenFocusableHome).toBe(0);

  // Plans has no header entry after STU-445, so its deep link is the
  // surviving navigation path.
  await page.goto("/#plans");
  await expect(page.locator("#plans-view")).toBeVisible();
  await expect(page.locator("#account-view")).toBeHidden();

  const accountInert = await page.locator("#account-view").evaluate((el) => el.inert);
  expect(accountInert).toBe(true);
});

test("keyboard focus follows view navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("#home-view")).toBeVisible();

  // Initial load must leave focus on the document, not steal it into a view.
  const focusedViewOnLoad = await page.evaluate(() => document.activeElement?.closest(".view")?.id ?? null);
  expect(focusedViewOnLoad).toBeNull();

  // Keyboard activation of the account control moves focus into the surface.
  await page.focus("#topbar-avatar");
  await page.keyboard.press("Enter");
  await expect(page.locator("#account-view")).toBeVisible();
  await expect(page.locator("#account-view")).toBeFocused();

  // The hidden surface keeps its controls out of the focus order.
  const hiddenFocusableHome = await page.locator("#home-view").evaluate((el) => {
    const focusable = el.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    return Array.from(focusable).filter((n) => !n.hidden && n.offsetParent !== null).length;
  });
  expect(hiddenFocusableHome).toBe(0);

  // Pointer navigation moves focus into the revealed surface too: the logo
  // returns Home from Account.
  await page.click("header.topbar .brand");
  await expect(page.locator("#home-view")).toBeVisible();
  await expect(page.locator("#home-view")).toBeFocused();

  // Reloading a deep link restores the surface without stealing focus.
  await page.goto("/#plans");
  await expect(page.locator("#plans-view")).toBeVisible();
  await page.reload();
  await expect(page.locator("#plans-view")).toBeVisible();
  const focusedViewAfterReload = await page.evaluate(() => document.activeElement?.closest(".view")?.id ?? null);
  expect(focusedViewAfterReload).toBeNull();
});

test("back, forward and reload restore the current surface", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.click("#topbar-avatar");
  await expect(page.locator("#account-view")).toBeVisible();

  await page.goBack();
  await expect(page.locator("#home-view")).toBeVisible();

  await page.goForward();
  await expect(page.locator("#account-view")).toBeVisible();

  await page.reload();
  await expect(page.locator("#account-view")).toBeVisible();
  await expect(page.locator("#home-view")).toBeHidden();
});
