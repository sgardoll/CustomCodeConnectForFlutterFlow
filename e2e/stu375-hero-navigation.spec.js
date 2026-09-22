import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
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

  await page.click('a[data-view="account"]');
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

  await page.click('a[data-view="plans"]');
  await expect(page.locator("#plans-view")).toBeVisible();
  await expect(page.locator("#account-view")).toBeHidden();

  const accountInert = await page.locator("#account-view").evaluate((el) => el.inert);
  expect(accountInert).toBe(true);
});

test("back, forward and reload restore the current surface", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.click('a[data-view="account"]');
  await expect(page.locator("#account-view")).toBeVisible();

  await page.goBack();
  await expect(page.locator("#home-view")).toBeVisible();

  await page.goForward();
  await expect(page.locator("#account-view")).toBeVisible();

  await page.reload();
  await expect(page.locator("#account-view")).toBeVisible();
  await expect(page.locator("#home-view")).toBeHidden();
});
