/**
 * Client side of the deploy-run record.
 *
 * When a custom-class provisioning request outlives the browser's wait bound or
 * drops its connection, the only way to learn what happened used to be to
 * re-read the whole project and guess. The runner now keeps a per-run record
 * and answers `GET /runStatus/<runId>`: the client generates the run id and
 * sends it with the deploy request, and on a lost outcome asks the runner
 * directly. A 404 for an id the client itself generated is proof the request
 * never reached the runner, so nothing was written and a retry is safe; a
 * definitive `done` or provably pre-write `failed` answer replaces the guess.
 *
 * Everything an older runner predates stays a fallback: a 404, a 5xx, or an
 * unrecognised body resolves to "unknown", and the caller re-reads the project
 * exactly as before.
 */

/** The request header that carries the API key to GET /runStatus. */
export const RUN_STATUS_KEY_HEADER = "x-ff-api-key";

/** Prefix marking an id as client-generated (a runner could never mint these). */
const RUN_ID_PREFIX = "dr_";

/** Allowed: letters, digits, `-` and `_`, up to 120 chars (matches the runner). */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

/**
 * Generates a client-side run id. A random UUID (prefixed so it can never be
 * confused with a runner-minted id) with a small fallback for environments
 * without `crypto.randomUUID`.
 * @returns {string}
 */
export function generateDeployRunId() {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return `${RUN_ID_PREFIX}${cryptoObj.randomUUID()}`;
  }
  return `${RUN_ID_PREFIX}${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * Whether a run id is well-formed enough to place in a URL path and pass to
 * the runner. Everything else is treated as absent.
 * @param {string} id
 * @returns {boolean}
 */
export function isValidRunId(id) {
  return typeof id === "string" && RUN_ID_PATTERN.test(id);
}

/**
 * The status endpoint lives on the same runner as the provision endpoint, so
 * it is derived from it rather than configured separately. The provision
 * endpoint must end in /deployCustomClasses; handle the unusual case of a
 * differently-shaped override by falling back to it unchanged.
 * @param {string} provisionEndpoint
 * @param {string} runId
 * @returns {string}
 */
export function runStatusUrl(provisionEndpoint, runId) {
  const base = String(provisionEndpoint || "").replace(
    /\/deployCustomClasses$/,
    "",
  );
  return `${base}/runStatus/${encodeURIComponent(runId)}`;
}

/**
 * Normalises a run-status response body into the shape the outcome mapper
 * reads, or null when it is not a recognisable record (an older runner, or a
 * malformed body - both must act as "unknown").
 * @param {Object} body - Parsed JSON from the runner
 * @returns {Object|null}
 */
export function readRunStatus(body) {
  if (!body || typeof body !== "object") return null;
  const { status } = body;
  if (status !== "running" && status !== "done" && status !== "failed") {
    return null;
  }
  return {
    status,
    phase: typeof body.phase === "string" ? body.phase : "",
    message: typeof body.message === "string" ? body.message : "",
    error: typeof body.error === "string" ? body.error : null,
    deployed: Array.isArray(body.deployed) ? body.deployed : [],
    dryRun: body.dryRun === true,
  };
}

/**
 * The runner phases that provably precede any write to FlutterFlow, so a
 * failure recorded at one of them is a definitive refusal. A failure at or
 * after `deploy_start` may have landed classes and stays "unknown" - the
 * caller must re-read the project to know what happened.
 */
export const PRE_WRITE_RUN_PHASES = new Set([
  "connected",
  "workspace_init",
  "workspace_ready",
  "verifying",
]);

/**
 * Maps a run-status record to a decision the deploy flow can act on.
 *
 * Returns `{ definitive: "success", deployed }` only when the runner recorded
 * a clean finish; `{ definitive: "failed", error }` only for a failure that
 * provably preceded any write; and `{ definitive: null }` for a run still in
 * progress or a failure whose write state is unknown - in both cases the caller
 * falls back to reconciling by re-reading the project.
 * @param {Object|null} record - From `readRunStatus`
 * @returns {{definitive: (string|null), deployed?: Array, error?: string}}
 */
export function runStatusOutcome(record) {
  if (!record || !record.status) return { definitive: null };
  if (record.status === "done") {
    return {
      definitive: "success",
      deployed: Array.isArray(record.deployed) ? record.deployed : [],
    };
  }
  if (record.status === "failed" && PRE_WRITE_RUN_PHASES.has(record.phase)) {
    return {
      definitive: "failed",
      error:
        record.error || "The deploy failed before writing anything to FlutterFlow.",
    };
  }
  return { definitive: null };
}

/**
 * Fetches the run-status record once. Any non-2xx (404 for a never-arrived or
 * older-runner id, 5xx from an unreachable backend) or a fetch that throws or
 * times out resolves to null - "unknown" - never an exception.
 * @param {Object} opts
 * @param {string} opts.provisionEndpoint
 * @param {string} opts.runId
 * @param {string} opts.apiKey
 * @param {Function} [opts.fetchImpl] - Injectable for tests
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<Object|null>}
 */
export async function fetchRunStatus({
  provisionEndpoint,
  runId,
  apiKey,
  fetchImpl,
  timeoutMs = 8000,
}) {
  if (!isValidRunId(runId)) return null;
  const doFetch = fetchImpl || globalThis.fetch;
  if (!doFetch) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(
      runStatusUrl(provisionEndpoint, runId),
      {
        method: "GET",
        headers: { [RUN_STATUS_KEY_HEADER]: String(apiKey || "") },
        signal: controller.signal,
      },
    );
    if (!response.ok) return null;
    const body = await response.json();
    return readRunStatus(body);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Polls the run-status endpoint under a hard budget until it yields a
 * definitive outcome, or the budget runs out. Used when a provision whose
 * response was lost may still be finishing on the runner - this is the bounded
 * ask that replaces the guess when the record is definitive.
 * @param {Object} opts - As `fetchRunStatus`, plus a budget
 * @param {number} [opts.budgetMs]
 * @param {number} [opts.intervalMs]
 * @returns {Promise<{definitive: (string|null), deployed?: Array, error?: string}>}
 */
export async function queryRunStatusWithinBudget({
  provisionEndpoint,
  runId,
  apiKey,
  fetchImpl,
  budgetMs = 12000,
  intervalMs = 2000,
}) {
  const deadline = Date.now() + budgetMs;
  let nullPolls = 0;
  while (Date.now() < deadline) {
    const record = await fetchRunStatus({
      provisionEndpoint,
      runId,
      apiKey,
      fetchImpl,
    });
    if (record) {
      const outcome = runStatusOutcome(record);
      if (outcome.definitive) return outcome;
      // A recognised but still-running record is worth waiting on: the runner
      // reached back, so its answer is on its way.
      nullPolls = 0;
    } else {
      // A 404 (never arrived, or an older runner with no endpoint) or an
      // unreachable endpoint will not resolve within the budget. A single
      // transient miss is retried once, then the question is left to the caller
      // instead of burning the budget polling an endpoint that cannot answer.
      nullPolls += 1;
      if (nullPolls >= 2) return { definitive: null };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(intervalMs, remaining)),
    );
  }
  return { definitive: null };
}
