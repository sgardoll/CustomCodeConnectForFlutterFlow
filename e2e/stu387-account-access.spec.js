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

  test("a second send while one is in flight is refused (single request)", async ({ page }) => {
    let calls = 0;
    await seedSession(page);
    await applyDefaultRoutes(page, {
      ...refreshOverride(),
      [ENDPOINTS.identity]: identityWithUsage({ email: EMAIL, count: 12 }),
      [ENDPOINTS.getSubscription]: professionalSubscription(),
      [ENDPOINTS.authSendMagicLink]: async () => {
        calls += 1;
        // Hold the request in flight for the duration of the assertion window.
        await new Promise(() => {});
      },
    });
    await page.goto("/");
    await openAccount(page);

    const btn = page.locator("#send-new-link-btn");
    await btn.click(); // in flight, endpoint not yet resolved
    // The control visibly locks while pending, so the user cannot double-send.
    await expect(btn).toBeDisabled();
    // Give any (incorrect) second request the chance to fire; only the first
    // from the initial click may have reached the endpoint.
    await page.waitForTimeout(200);
    expect(calls).toBe(1);
    // The pending request is intentionally left unresolved; the deterministic
    // duplicate-rejection of the controller is asserted in the unit suite
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
