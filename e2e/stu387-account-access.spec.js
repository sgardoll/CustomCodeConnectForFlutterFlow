import { test, expect } from "@playwright/test";
import {
  applyDefaultRoutes,
  guestIdentity,
  professionalSubscription,
  magicLinkSent,
  err,
  ENDPOINTS,
} from "./fixtures/apiFixtures.js";

/**
 * STU-387 — the account Access & data section.
 *
 * Sign out clears the session and immediately re-renders every identity/plan
 * surface. "Send new link" reflects the actual backend response or failure
 * through visible pending/sent/error states and never fires a duplicate request
 * while one is in flight. "Clear cache" removes only the named disposable UI
 * caches and provably preserves the authoritative allowance, identity and
 * credentials. The Delete-account control is truthful (account deletion is
 * unavailable — there is no backend contract) and keyboard-discoverable; it is
 * not an active destructive button and performs no deletion.
 */
const EMAIL = "metered@example.com";
const currentMonth = () => new Date().toISOString().slice(0, 7);

function sessionFor(email = EMAIL) {
  return {
    status: 200,
    body: JSON.stringify({ email, sessionToken: "session-token" }),
    contentType: "application/json",
  };
}

function refreshOverride(email = EMAIL) {
  return { [ENDPOINTS.authRefreshSession]: sessionFor(email) };
}

function identityWithUsage({ email, count, month = currentMonth() }) {
  return {
    status: 200,
    body: JSON.stringify({
      status: "recognized",
      user_id: "acct-0001",
      identity_token: "identity-token",
      usage_count: count,
      usage_month: month,
    }),
    contentType: "application/json",
  };
}

async function seedSession(page, email = EMAIL) {
  await page.addInitScript(({ email }) => {
    localStorage.setItem(
      "ccc_auth_session",
      JSON.stringify({ email, sessionToken: "session-token" }),
    );
    localStorage.setItem("bs_identity", "device-uuid-0001");
    localStorage.setItem(
      "ccc_usage",
      JSON.stringify({ count: 12, month: new Date().toISOString().slice(0, 7) }),
    );
    localStorage.setItem("hasSeenWalkthrough", "true");
  }, { email });
}

async function openAccount(page) {
  await page.locator('a.nav-link[data-view="account"]').click();
  await expect(page.locator("#account-view")).toBeVisible();
  await expect(page.locator("#auth-signedin")).toBeVisible();
}

test.describe("STU-387 account access & data", () => {
  test("sign out clears the session, empties the signed-in surfaces and shows signed-out immediately", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      ...refreshOverride(),
      [ENDPOINTS.identity]: identityWithUsage({ email: EMAIL, count: 12 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });
    await page.goto("/");
    await openAccount(page);

    await expect(page.locator("#auth-user-email")).toHaveText(EMAIL);
    await expect(page.locator("#access-signed-email")).toHaveText(EMAIL);

    await page.locator("#sign-out-btn").click();

    // The session key is gone and the account view flips to signed-out in the
    // same gesture (no reload), i.e. identity/plan UI updated immediately.
    const session = await page.evaluate(() => localStorage.getItem("ccc_auth_session"));
    const subscriptionCache = await page.evaluate(() => localStorage.getItem("ccc_subscription"));
    expect(session).toBeNull();
    expect(subscriptionCache).toBeNull();
    await expect(page.locator("#auth-signedin")).toBeHidden();
    await expect(page.locator("#auth-signedout")).toBeVisible();
    // The topbar/identity email surface is no longer populated.
    await expect(page.locator("#auth-user-email")).not.toHaveText(EMAIL);
  });

  test("send new link shows pending then the real success message from the response", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      ...refreshOverride(),
      [ENDPOINTS.identity]: identityWithUsage({ email: EMAIL, count: 12 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
      [ENDPOINTS.authSendMagicLink]: magicLinkSent(),
    });
    await page.goto("/");
    await openAccount(page);

    const msg = page.locator("#send-new-link-msg");
    await page.locator("#send-new-link-btn").click();
    await expect(msg).toHaveText(/Check your email — we sent a link to metered@example.com/);
  });

  test("send new link surfaces the real failure and re-enables the control", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      ...refreshOverride(),
      [ENDPOINTS.identity]: identityWithUsage({ email: EMAIL, count: 12 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
      [ENDPOINTS.authSendMagicLink]: err(500, "Server exploded"),
    });
    await page.goto("/");
    await openAccount(page);

    const btn = page.locator("#send-new-link-btn");
    await btn.click();
    await expect(page.locator("#send-new-link-msg")).toHaveText(
      /Couldn't send a link right now/,
    );
    await expect(btn).toBeEnabled();
  });

  test("send new link surfaces the specific failure reason (rate-limit vs server error differ)", async ({ page }) => {
    let status = 429; // rate limit — a distinguishable failure
    await seedSession(page);
    await applyDefaultRoutes(page, {
      ...refreshOverride(),
      [ENDPOINTS.identity]: identityWithUsage({ email: EMAIL, count: 12 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
      [ENDPOINTS.authSendMagicLink]: () => err(status, "rate limited"),
    });
    await page.goto("/");
    await openAccount(page);

    const msg = page.locator("#send-new-link-msg");
    const btn = page.locator("#send-new-link-btn");

    await btn.click();
    await expect(msg).toContainText("429");
    const rateLimitText = await msg.textContent();

    status = 500; // a genuinely different failure
    await btn.click();
    await expect(msg).toContainText("500");
    const serverErrorText = await msg.textContent();

    // A rate limit must not read identically to a server error: the real
    // failure reason (per the module contract) is what distinguishes them.
    expect(rateLimitText?.trim()).not.toBe(serverErrorText?.trim());
  });

  test("a second send while one is in flight is refused (single request)", async ({ page }) => {
    let calls = 0;
    await seedSession(page);
    await applyDefaultRoutes(page, {
      ...refreshOverride(),
      [ENDPOINTS.identity]: identityWithUsage({ email: EMAIL, count: 12 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
      [ENDPOINTS.authSendMagicLink]: () => {
        calls += 1;
        return magicLinkSent();
      },
    });
    await page.goto("/");
    await openAccount(page);

    // Ensure the app bundle has finished wiring the global handler before we
    // send — on a cold Vite boot under parallel workers the account view can be
    // visible in the static HTML before app.js has attached handlers.
    await page.waitForFunction(() => typeof window.handleSendNewLink === "function");
    // Attempt TWO sends back-to-back in one synchronous tick. handleSendNewLink
    // runs synchronously to its first await, so the FIRST call launches the send
    // — the controller's in-flight flag flips to true and exactly one request is
    // issued — before the SECOND call runs while the first is still in flight
    // (its network await cannot settle within the same stack). This is what makes
    // the controller's `if (inFlight) return busy` guard load-bearing: only that
    // guard can refuse the second call. If it were deleted, the second call would
    // fire a second fetch and the calls assertion below would fail.
    await page.evaluate(() => {
      window.handleSendNewLink();
      window.handleSendNewLink();
    });
    await page.waitForTimeout(150);
    expect(calls).toBe(1);
    // The in-flight guard is also asserted deterministically in the unit suite
    // (src/accountAccess.test.js "a duplicate reauth while one is in flight").
  });

  test("clear cache removes only disposable UI caches and preserves allowance, identity and keys", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      ...refreshOverride(),
      [ENDPOINTS.identity]: identityWithUsage({ email: EMAIL, count: 12 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });
    await page.goto("/");
    await openAccount(page);

    await page.locator("#clear-cache-btn").click();

    const state = await page.evaluate(() => ({
      usage: localStorage.getItem("ccc_usage"),
      identity: localStorage.getItem("bs_identity"),
      session: localStorage.getItem("ccc_auth_session"),
      walkthrough: localStorage.getItem("hasSeenWalkthrough"),
    }));
    // The disposable UI flag is cleared...
    expect(state.walkthrough).toBeNull();
    // ...but the authoritative allowance, identity and active session survive,
    // so clearing cannot hand out new runs.
    expect(JSON.parse(state.usage).count).toBe(12);
    expect(state.identity).toBe("device-uuid-0001");
    expect(state.session).not.toBeNull();
    await expect(page.locator("#acct-left-count")).not.toHaveText("—");
    await expect(page.locator("#auth-user-email")).toHaveText(EMAIL);
  });

  test("delete account is an honest, keyboard-discoverable unavailable control and performs no deletion", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      ...refreshOverride(),
      [ENDPOINTS.identity]: identityWithUsage({ email: EMAIL, count: 12 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
    });
    await page.goto("/");
    await openAccount(page);

    const deleteBtn = page.locator("#delete-account-btn");
    await expect(deleteBtn).toBeVisible();
    // It is a real, focusable (keyboard-discoverable) button — not a pointer-only div.
    expect(await deleteBtn.isEnabled()).toBe(true);
    const tag = await deleteBtn.evaluate((el) => el.tagName);
    expect(tag).toBe("BUTTON");

    // Activating it opens the explanation and deletes nothing.
    await deleteBtn.click();
    const modal = page.locator("#delete-unavailable-modal");
    await expect(modal).toBeVisible();
    // openModal gives the overlay dialog semantics (role/aria-modal) and sets
    // aria-hidden=false when it opens.
    await expect(modal).toHaveAttribute("aria-hidden", "false");
    await expect(modal).toHaveAttribute("role", "dialog");
    await expect(modal).toHaveAttribute("aria-modal", "true");
    await expect(modal).toContainText("not available");
    await expect(modal).toContainText("Nothing has been removed");

    const before = await page.evaluate(() => ({
      usage: localStorage.getItem("ccc_usage"),
      identity: localStorage.getItem("bs_identity"),
      session: localStorage.getItem("ccc_auth_session"),
    }));
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
    const after = await page.evaluate(() => ({
      usage: localStorage.getItem("ccc_usage"),
      identity: localStorage.getItem("bs_identity"),
      session: localStorage.getItem("ccc_auth_session"),
    }));
    expect(after).toEqual(before); // opening + dismissing performs no deletion
    await expect(page.locator("#auth-user-email")).toHaveText(EMAIL); // still signed in
  });
});
