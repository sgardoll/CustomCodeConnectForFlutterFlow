// STU-387 — Account Access & data behavioural tests.
//
// Each test pins one acceptance criterion to a concrete regression and is
// written so it FAILS when the behaviour is taken away:
//
//   criterion 1 (sign out): remove the session key or the synchronous
//     identity/plan notification -> the test that asserts the key is gone and
//     the callbacks ran fails.
//   criterion 2 (reauth): drop the duplicate-request guard or swallow the
//     failure -> the duplicate-prevention / error tests fail.
//   criterion 3 (clear cache): add a metering/identity/credential/session key
//     to DISPOSABLE_UI_CACHE_KEYS -> the preservation & no-new-runs tests
//     fail.
//   criterion 4 (delete): flip DELETE_ACCOUNT_SUPPORTED to true -> the
//     truthfulness test fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTH_SESSION_KEY,
  SUBSCRIPTION_CACHE_KEY,
  IDENTITY_KEY,
  USAGE_KEY,
  CREDENTIAL_KEY_PREFIX,
  SESSION_CREDENTIAL_KEY_PREFIX,
  DISPOSABLE_UI_CACHE_KEYS,
  NON_DISPOSABLE_KEYS,
  clearDisposableUiCaches,
  performSignOut,
  createSendLinkController,
  isDeleteAccountSupported,
  DELETE_ACCOUNT_MESSAGE,
} from "./accountAccess.js";

// Minimal in-memory Storage stand-in so the logic is hermetically testable with
// no browser, network, clock dependency, or host-timezone coupling.
function fakeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    _dump() {
      return Object.fromEntries(store);
    },
  };
}

// ---- Criterion 1: sign out clears the session and immediately re-renders ----

test("criterion 1: performSignOut removes the session and subscription cache", () => {
  const storage = fakeStorage({
    [AUTH_SESSION_KEY]: "encrypted-session",
    [SUBSCRIPTION_CACHE_KEY]: "encrypted-sub",
  });
  performSignOut({ storage });
  assert.equal(storage.getItem(AUTH_SESSION_KEY), null);
  assert.equal(storage.getItem(SUBSCRIPTION_CACHE_KEY), null);
});

test("criterion 1: performSignOut clearly signals identity AND plan re-render synchronously", () => {
  const storage = fakeStorage({ [AUTH_SESSION_KEY]: "x" });
  let identityRenders = 0;
  let planRenders = 0;
  performSignOut({
    storage,
    onIdentityChanged() {
      identityRenders += 1;
    },
    onPlanChanged() {
      planRenders += 1;
    },
  });
  // Both must run before performSignOut returns — i.e. immediately, not on a
  // later tick — so the UI flips to signed-out in the same user gesture.
  assert.equal(identityRenders, 1);
  assert.equal(planRenders, 1);
});

test("criterion 1: sign out clears the session but never scrubs identity or usage", () => {
  const storage = fakeStorage({
    [AUTH_SESSION_KEY]: "x",
    [IDENTITY_KEY]: "device-uuid-1",
    [USAGE_KEY]: '{"count":7,"month":"2026-09"}',
  });
  performSignOut({ storage });
  assert.equal(storage.getItem(AUTH_SESSION_KEY), null);
  assert.equal(storage.getItem(IDENTITY_KEY), "device-uuid-1");
  assert.equal(storage.getItem(USAGE_KEY), '{"count":7,"month":"2026-09"}');
});

// ---- Criterion 2: reauth reflects the real response AND failures ----

test("criterion 2: a successful reauth reports pending then sent with the actual response", async () => {
  const states = [];
  const send = createSendLinkController({
    sendLink: async () => ({ code: "sent", message: "Check your email" }),
    getEmail: () => "a@b.com",
    onState: (state) => states.push(state),
  });
  const result = await send();
  assert.equal(states[0].status, "pending");
  assert.equal(result.status, "sent");
  assert.equal(result.data.message, "Check your email");
  assert.equal(states[states.length - 1].status, "sent");
  assert.equal(states[states.length - 1].data.code, "sent");
});

test("criterion 2: a failed reauth surfaces the real failure, not a canned success", async () => {
  const states = [];
  const send = createSendLinkController({
    sendLink: async () => {
      const error = new Error("403 Too Many Requests");
      error.status = 403;
      throw error;
    },
    getEmail: () => "a@b.com",
    onState: (state) => states.push(state),
  });
  const result = await send();
  assert.equal(states[0].status, "pending");
  assert.equal(result.status, "error");
  assert.equal(result.error.message, "403 Too Many Requests");
  assert.equal(states[states.length - 1].status, "error");
});

test("criterion 2: a duplicate reauth while one is in flight is refused and sends once", async () => {
  let sendLinkCalls = 0;
  let release;
  const send = createSendLinkController({
    sendLink: () => {
      sendLinkCalls += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    getEmail: () => "a@b.com",
    onState: () => {},
  });
  const first = send(); // in flight, unresolved
  let firstResult;
  try {
    const second = await send(); // must NOT trigger a second network call
    assert.equal(sendLinkCalls, 1, "the duplicate request must not reach sendLink");
    assert.deepEqual(second, { status: "busy" });
  } finally {
    // Always settle the in-flight request so a failing assertion cannot strand
    // a forever-pending promise and cancel the sibling tests.
    release({ code: "sent" });
  }
  firstResult = await first;
  assert.equal(firstResult.status, "sent");
  assert.equal(sendLinkCalls, 1, "still only one network call after settle");
});

test("criterion 2: after a settle the controller accepts the next send", async () => {
  let sendLinkCalls = 0;
  const send = createSendLinkController({
    sendLink: async () => {
      sendLinkCalls += 1;
      return { code: "sent" };
    },
    getEmail: () => "a@b.com",
    onState: () => {},
  });
  await send();
  const again = await send();
  assert.equal(again.status, "sent");
  assert.equal(sendLinkCalls, 2);
});

// ---- Criterion 3: clear cache preserves authority & identity ----

test("criterion 3: DISPOSABLE_UI_CACHE_KEYS contains only disposable UI flags", () => {
  for (const key of DISPOSABLE_UI_CACHE_KEYS) {
    assert.ok(
      !NON_DISPOSABLE_KEYS.includes(key),
      `${key} must never be treated as a disposable UI cache`,
    );
  }
  // The protected set must cover every authority/identity/credential key.
  for (const key of [
    AUTH_SESSION_KEY,
    SUBSCRIPTION_CACHE_KEY,
    IDENTITY_KEY,
    USAGE_KEY,
    CREDENTIAL_KEY_PREFIX,
    SESSION_CREDENTIAL_KEY_PREFIX,
  ]) {
    assert.ok(NON_DISPOSABLE_KEYS.includes(key));
  }
});

test("criterion 3: clearDisposableUiCaches removes only the named disposable keys", () => {
  const storage = fakeStorage({
    hasSeenWalkthrough: "true",
    [USAGE_KEY]: '{"count":7,"month":"2026-09"}',
    [IDENTITY_KEY]: "device-uuid-1",
    [AUTH_SESSION_KEY]: "enc",
    [CREDENTIAL_KEY_PREFIX + "openai"]: "enc",
    [SESSION_CREDENTIAL_KEY_PREFIX + "openai"]: "enc",
  });
  const removed = clearDisposableUiCaches(storage);
  assert.deepEqual(removed, ["hasSeenWalkthrough"]);
  assert.equal(storage.getItem("hasSeenWalkthrough"), null);
  // Authoritative allowance, identity, session and credentials all survive.
  assert.equal(storage.getItem(USAGE_KEY), '{"count":7,"month":"2026-09"}');
  assert.equal(storage.getItem(IDENTITY_KEY), "device-uuid-1");
  assert.equal(storage.getItem(AUTH_SESSION_KEY), "enc");
  assert.equal(storage.getItem(CREDENTIAL_KEY_PREFIX + "openai"), "enc");
  assert.equal(storage.getItem(SESSION_CREDENTIAL_KEY_PREFIX + "openai"), "enc");
});

test("criterion 3: clearing the disposable cache cannot hand out new runs (allowance unchanged)", () => {
  const storage = fakeStorage({
    hasSeenWalkthrough: "true",
    [USAGE_KEY]: '{"count":2,"month":"2026-09"}',
  });
  const usageBefore = () => JSON.parse(storage.getItem(USAGE_KEY)).count;
  const before = usageBefore();
  clearDisposableUiCaches(storage);
  const after = usageBefore();
  // Runs are gated on allowance = limit - usage. If clearing bumped the
  // allowance, the used count would drop (or the month would reset): neither
  // may happen, so the allowance cannot grant new runs.
  assert.equal(after, before);
  assert.equal(storage.getItem(USAGE_KEY), '{"count":2,"month":"2026-09"}');
});

// ---- Criterion 4: delete capability is truthful ----

test("criterion 4: delete account is honestly reported as unsupported", () => {
  assert.equal(isDeleteAccountSupported(), false);
});

test("criterion 4: the unavailable-delete copy never claims deletion and names the reason", () => {
  assert.match(DELETE_ACCOUNT_MESSAGE, /not available/);
  assert.match(DELETE_ACCOUNT_MESSAGE, /no server-side deletion contract/);
  assert.ok(!/will (?:be )?delete/i.test(DELETE_ACCOUNT_MESSAGE));
  assert.ok(!/has (?:been )?deleted|deleted your/i.test(DELETE_ACCOUNT_MESSAGE));
});
