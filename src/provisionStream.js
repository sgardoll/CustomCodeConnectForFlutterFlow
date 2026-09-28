import { flushNdjsonBuffer, readNdjsonChunk } from "./ndjsonStream.js";
import { classifyDeployResult, DeployOutcome } from "./deployOutcome.js";

/**
 * Reads the custom class deploy response.
 *
 * The runner streams NDJSON phase events while it works, so the deploy can
 * report where it actually is and say what went wrong when it fails part way
 * through. A runner that predates streaming answers with a single JSON object
 * instead, which this still reads.
 *
 * @param {Response} response - Fetch response from the provisioning endpoint
 * @param {Object} [handlers]
 * @param {function(string): void} [handlers.onPhase] - Called with each phase
 *   message the runner reports
 * @param {function(string): void} [handlers.onLog] - Called with each raw CLI
 *   output line
 * @returns {Promise<Object>} The runner's final result payload, always with a
 *   boolean `success`. `finalResultReceived` is true only when the runner
 *   actually delivered a definitive result event (or a non-streaming JSON
 *   body); it is false when the stream simply ended or the body carried no
 *   decision, which the caller must treat as an unknown remote outcome rather
 *   than a fabricated success or failure.
 */
export async function readProvisionResponse(response, handlers = {}) {
  const { onPhase, onLog } = handlers;
  let finalResult = null;
  let lastPhase = null;
  let buffer = "";

  const handleEvent = (event) => {
    if (event.event === "phase") {
      if (event.phase) lastPhase = event.phase;
      if (event.message && onPhase) onPhase(event.message);
      return;
    }
    if (event.event === "log") {
      if (event.message && onLog) onLog(event.message);
      return;
    }
    // A "result" event, or the whole body from a non-streaming runner.
    finalResult = event;
  };

  // A mid-stream read failure is a dropped connection, not a decision from
  // the runner: it falls through to the no-final-result return below so the
  // caller reports the outcome as unknown rather than throwing a fabricated
  // failure.
  let readError = null;
  try {
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const parsed = readNdjsonChunk(
          buffer,
          decoder.decode(value, { stream: true }),
        );
        buffer = parsed.buffer;
        parsed.events.forEach(handleEvent);
      }
    } else {
      const parsed = readNdjsonChunk("", await response.text());
      buffer = parsed.buffer;
      parsed.events.forEach(handleEvent);
    }
  } catch (error) {
    readError = error;
  }

  // Whatever arrived before the drop may still hold a complete trailing line —
  // the result event itself — so the remainder is flushed before giving up.
  flushNdjsonBuffer(buffer).forEach(handleEvent);

  if (finalResult) {
    return {
      ...finalResult,
      success:
        finalResult.success === true ||
        (finalResult.success === undefined && response.ok),
      finalResultReceived: true,
      // Where the runner was when it answered: streamed runners report phases
      // (and `uploading` proves the write began); non-streaming runners leave
      // this null and only their HTTP status is meaningful.
      runnerPhase: lastPhase,
      httpStatus: response.status,
    };
  }

  return {
    success: false,
    finalResultReceived: false,
    // An explicit non-2xx HTTP response. A 4xx proves the request was turned
    // away before any work, so the caller renders it as FAILED. A 5xx proves
    // no such thing: a gateway can answer 502/503/504 after forwarding the
    // request to the runner, which may already be deploying (or may have
    // deployed) classes — so a 5xx is UNCONFIRMED, exactly like an ok response
    // whose stream dropped before a result.
    httpRejected: !response.ok,
    httpStatus: response.status,
    runnerPhase: lastPhase,
    error: !response.ok
      ? `FlutterFlow custom class provisioning failed (HTTP ${response.status}).`
      : readError
        ? "The connection to the FlutterFlow deploy runner dropped before it reported a result."
        : "The FlutterFlow deploy runner closed the connection before it finished.",
  };
}

// Runner phases that provably precede the first remote write: workspace setup
// and the compile-gate verification all run before the deploy script starts.
const PRE_WRITE_RUNNER_PHASES = new Set([
  "connected",
  "workspace_init",
  "workspace_ready",
  "verifying",
]);

/**
 * Whether a runner-reported failure can be proven to precede the first remote
 * write. A `result` event with success:false only proves the runner finished —
 * the deploy CLI can fail (or time out) after its upload phase already wrote
 * classes, so only these shapes count as definitive pre-write rejections:
 * an explicit `preWrite` marker from the runner, a compile-gate report
 * (`analyzerErrors`), a last-reported phase before `deploy_start`, or — for a
 * non-streaming runner — a 4xx status (request validation, always pre-write).
 *
 * @param {Object} result - The result from `readProvisionResponse`
 * @returns {boolean} True only when the failure is provably pre-write
 */
export function isPreWriteRunnerFailure(result) {
  if (result?.preWrite === true) return true;
  if (Array.isArray(result?.analyzerErrors) && result.analyzerErrors.length > 0) {
    return true;
  }
  if (typeof result?.runnerPhase === "string") {
    return PRE_WRITE_RUNNER_PHASES.has(result.runnerPhase);
  }
  if (typeof result?.httpStatus === "number") {
    return result.httpStatus >= 400 && result.httpStatus < 500;
  }
  return false;
}

/**
 * Maps a provisioning stream result to the single truthful terminal outcome.
 *
 * When the runner delivered a definitive result, the ordinary classifier
 * applies. When it did not (`finalResultReceived === false`), the cases the
 * caller must never flatten are separated: a 4xx response is a definitive
 * refusal — the request was turned away before any write — so it is FAILED,
 * while a 5xx is not proof of anything. A gateway can return 502/503/504
 * after forwarding the request to the runner, so classes may already be
 * deploying; that outcome, an ok response whose stream simply dropped, and a
 * client wait expiry all leave the remote outcome unknown (UNCONFIRMED).
 *
 * This is the decision `provisionMissingCodeFiles` uses in the real deploy
 * path, so a test of this function drives the same code that renders a 403
 * that never streamed a result.
 *
 * @param {Object|null|undefined} result - The result from `readProvisionResponse`
 * @returns {string} One of the DeployOutcome values
 */
export function deployOutcomeOfStreamResult(result) {
  if (result?.finalResultReceived) {
    const outcome = classifyDeployResult(result);
    // A runner-reported failure proves the runner finished, not that nothing
    // was written: it is FAILED only when provably pre-write (verification,
    // request validation). Once the deploy phase began, a CLI failure can
    // follow classes already uploaded — that outcome stays UNCONFIRMED.
    return outcome === DeployOutcome.FAILED && !isPreWriteRunnerFailure(result)
      ? DeployOutcome.UNCONFIRMED
      : outcome;
  }
  if (result?.httpRejected) {
    // Only a 4xx proves the write was refused before it began. A 5xx can come
    // from a gateway after the request reached the runner, so it must stay
    // UNCONFIRMED: reporting it as FAILED would tell the user nothing was
    // written while the runner is still deploying.
    return typeof result.httpStatus === "number" &&
      result.httpStatus >= 400 &&
      result.httpStatus < 500
      ? DeployOutcome.FAILED
      : DeployOutcome.UNCONFIRMED;
  }
  return DeployOutcome.UNCONFIRMED;
}
