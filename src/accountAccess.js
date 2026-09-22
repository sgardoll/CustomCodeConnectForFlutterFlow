// STU-387 — Account "Access & data" actions.
//
// This module is the single source of truth for the behaviours of the account
// Access & data section: sign out, "Send new link" (reauth), "Clear cache",
// and the Account-deletion capability. Keeping the logic here (with injectable
// storage and link-sending dependencies) is what makes the acceptance criteria
// testable as pure behavioural units rather than screen-scraping the DOM.
//
// The load-bearing invariant of this file: nothing an "access action" does may
// hand out new runs, forget identity, wipe credentials, or end only the
// *cache* while claiming to be authoritative. The authoritative run allowance,
// the identity/metering cookie, and stored credentials are never cleared by
// any control in this section.

// ---------------------------------------------------------------------------
// Key contract
// ---------------------------------------------------------------------------

export const AUTH_SESSION_KEY = "ccc_auth_session";
export const SUBSCRIPTION_CACHE_KEY = "ccc_subscription";
export const IDENTITY_KEY = "bs_identity";
export const USAGE_KEY = "ccc_usage";
export const CREDENTIAL_KEY_PREFIX = "ccc_api_key_";
export const SESSION_CREDENTIAL_KEY_PREFIX = "ccc_session_api_key_";

// The ONLY caches "Clear cache" is allowed to touch: named disposable UI
// caches. Nothing on this list can change the run allowance, the identity, the
// credentials, or the active session. If a new disposable UI flag is added it
// must be added here too, and never a metering/identity/credential key.
export const DISPOSABLE_UI_CACHE_KEYS = Object.freeze([
  // First-run walkthrough dismissal; resetting it simply re-shows the tips.
  "hasSeenWalkthrough",
]);

// Keys that are definitively NOT disposable and must survive "Clear cache",
// asserted in the behavioural test so a later edit cannot silently add one of
// them to the disposable list. Documented here as the contract.
export const NON_DISPOSABLE_KEYS = Object.freeze([
  AUTH_SESSION_KEY, // active session — never cleared by cache clearing
  SUBSCRIPTION_CACHE_KEY, // server-backed subscription cache
  IDENTITY_KEY, // identity / metering cookie
  USAGE_KEY, // authoritative run allowance (metering)
  CREDENTIAL_KEY_PREFIX, // encrypted credential key prefix (and child keys)
  SESSION_CREDENTIAL_KEY_PREFIX, // session-scoped credential keys
]);

/**
 * Remove exactly the named disposable UI caches. Returns the keys removed.
 * Never touches usage, identity, credentials, or the active session, so it
 * cannot grant new runs and cannot erase who you are or what is stored.
 */
export function clearDisposableUiCaches(storage) {
  const removed = [];
  for (const key of DISPOSABLE_UI_CACHE_KEYS) {
    if (storage.getItem(key) !== null) {
      storage.removeItem(key);
      removed.push(key);
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

export function signOutKeys() {
  return [AUTH_SESSION_KEY, SUBSCRIPTION_CACHE_KEY];
}

/**
 * End the authenticated session: remove the session and the subscription cache,
 * then synchronously notify the identity and plan surfaces so they re-render
 * immediately. It deliberately preserves identity, usage, and credentials —
 * signing out ends THIS session, it does not scrub the device or refund runs.
 */
export function performSignOut({ storage, onIdentityChanged, onPlanChanged }) {
  for (const key of signOutKeys()) storage.removeItem(key);
  if (typeof onIdentityChanged === "function") onIdentityChanged();
  if (typeof onPlanChanged === "function") onPlanChanged();
}

// ---------------------------------------------------------------------------
// Send new link (reauth)
// ---------------------------------------------------------------------------

/**
 * Controller for the "Send new link" control. It reflects the ACTUAL backing
 * response or failure via onState(), moves through pending -> sent|error, and
 * hard-blocks a duplicate request while one is still in flight (settle first,
 * then allow the next send).
 */
export function createSendLinkController({ sendLink, getEmail, onState }) {
  let inFlight = false;
  return async function sendNewLink() {
    if (inFlight) return { status: "busy" };
    inFlight = true;
    let result;
    try {
      onState({ status: "pending", error: null });
      const data = await sendLink(getEmail());
      result = { status: "sent", data };
      onState({ status: "sent", data });
      return result;
    } catch (error) {
      result = { status: "error", error };
      onState({ status: "error", error });
      return result;
    } finally {
      inFlight = false;
    }
  };
}

// ---------------------------------------------------------------------------
// Delete account
// ---------------------------------------------------------------------------

// There is no genuine backend deletion contract in this slice. Per the issue,
// the product must therefore expose only a clearly-explained UNAVAILABLE
// Delete-account control — an active destructive button would be a lie. No
// deletion backend is added here.
export const DELETE_ACCOUNT_SUPPORTED = false;

export const DELETE_ACCOUNT_MESSAGE =
  "Account deletion is not available yet. There is no server-side deletion " +
  "contract in this build, so nothing — account, subscription, or generation " +
  "history — could be deleted here. Nothing has been removed.";

export function isDeleteAccountSupported() {
  return DELETE_ACCOUNT_SUPPORTED;
}
