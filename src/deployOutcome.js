/**
 * STU-380 — truthful deployment terminal outcomes.
 *
 * A deploy to FlutterFlow can end in four distinct terminal outcomes, and the
 * UI must not flatten them together. Only a confirmed success may say
 * "committed". A client-side wait that expires, or a dropped connection before
 * the runner reports a result, leaves the remote outcome unknown: that is
 * UNCONFIRMED, never a fabricated failure or success. This module is the
 * single source of truth for how a deploy result maps to what the UI tells
 * the user.
 */

export const DeployOutcome = Object.freeze({
  /** The runner and the push both confirmed success. Only this may say "committed". */
  COMMITTED: "committed",
  /** Custom classes were written to FlutterFlow, but the remaining sync failed. */
  PARTIAL: "partial",
  /** A definitive rejection: nothing was confirmed written. */
  FAILED: "failed",
  /** The remote outcome is unknown (UI wait expired or the stream dropped). */
  UNCONFIRMED: "unconfirmed",
});

/**
 * How long the browser keeps a live progress view for a provisioning request
 * before it stops claiming progress and reports UNCONFIRMED.
 *
 * Derivation: Cloud Run's request timeout for the deploy runner is 900s and
 * the runner reports a server-side timeout rather than hanging past it
 * (DEPLOYMENT.md), so a remote write cannot outlive roughly 900s. Observed
 * provision latency is of the order of one to a few minutes. 120s is therefore
 * comfortably longer than a healthy provision yet well below the server
 * deadline, so a normal deploy renders to completion long before this fires
 * and the UI can never out-wait a real server decision. This bound governs
 * only the UI's waiting/rendering: on expiry the UI stops claiming progress,
 * but it never aborts or retries the in-flight remote write.
 */
export const DEPLOY_UI_TIMEOUT_MS = 120_000;

/**
 * Maps a deploy result to its single truthful terminal outcome.
 *
 * Priority: an explicit unconfirmed marker beats everything (a partial outcome
 * is only meaningful once at least one write is confirmed, and a client timeout
 * means we cannot even be sure of that); then partial; then confirmed success;
 * then the default failure for any unconfirmed-negative result.
 *
 * @param {Object|null|undefined} result - A deploy result object
 * @param {boolean} [result.success] - True only when remote writes confirmed success
 * @param {boolean} [result.partial] - True when some writes landed and some failed
 * @param {boolean} [result.unconfirmed] - True when the remote outcome is unknown
 * @returns {string} One of the DeployOutcome values
 */
export function classifyDeployResult(result) {
  if (result?.unconfirmed === true || result?.outcome === DeployOutcome.UNCONFIRMED) {
    return DeployOutcome.UNCONFIRMED;
  }
  if (result?.partial === true || result?.outcome === DeployOutcome.PARTIAL) {
    return DeployOutcome.PARTIAL;
  }
  if (result?.success === true) {
    return DeployOutcome.COMMITTED;
  }
  return DeployOutcome.FAILED;
}

/**
 * A carve-out from the ordinary failure path: the client stopped waiting for
 * (or lost the connection to) a remote write before a decision arrived, so the
 * remote outcome is unknown. This is deliberately *not* a plain failure —
 * nothing may be reported as failed or committed when we cannot know what the
 * server did. Callers recognise it with `instanceof` or the `outcome` field,
 * both of which `classifyDeployResult` maps to UNCONFIRMED.
 */
export class UnconfirmedDeployError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnconfirmedDeployError";
    this.outcome = DeployOutcome.UNCONFIRMED;
  }
}

/**
 * Builds the error thrown when a push to FlutterFlow has retried every
 * endpoint without a definitive answer.
 *
 * The deciding question is whether any attempt *may have reached* the server:
 * a transport error — the fetch rejected before a response arrived — cannot
 * prove the write did not land, because a connection can drop after the server
 * accepted the request. Exhaustion is therefore UNCONFIRMED if any attempt
 * ended that way; only attempts that all came back as HTTP rejections are a
 * definitive refusal and may be reported as failed.
 *
 * @param {Object} [attempts]
 * @param {boolean} [attempts.sawTransportError] - True when at least one
 *   attempt failed without an HTTP response
 * @param {number} [attempts.httpStatus] - Last HTTP status the server
 *   returned, when it returned one
 * @returns {Error} An UnconfirmedDeployError for a lost response, a plain
 *   Error for a definitive refusal
 */
export function exhaustedPushError({ sawTransportError, httpStatus } = {}) {
  if (sawTransportError) {
    return new UnconfirmedDeployError(
      "Every FlutterFlow sync endpoint stopped answering without a definitive " +
        "response. The push may still have been applied — open the FlutterFlow " +
        "project to reconcile before retrying.",
    );
  }
  return new Error(
    `FlutterFlow rejected the code sync${httpStatus ? ` (HTTP ${httpStatus})` : ""} after every retry.`,
  );
}
