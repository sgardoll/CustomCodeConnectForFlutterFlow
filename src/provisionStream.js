import { flushNdjsonBuffer, readNdjsonChunk } from "./ndjsonStream.js";

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
  let buffer = "";

  const handleEvent = (event) => {
    if (event.event === "phase") {
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

  flushNdjsonBuffer(buffer).forEach(handleEvent);

  if (finalResult) {
    return {
      ...finalResult,
      success:
        finalResult.success === true ||
        (finalResult.success === undefined && response.ok),
      finalResultReceived: true,
    };
  }

  return {
    success: false,
    finalResultReceived: false,
    error: response.ok
      ? "The FlutterFlow deploy runner closed the connection before it finished."
      : `FlutterFlow custom class provisioning failed (HTTP ${response.status}).`,
  };
}
