import assert from "node:assert/strict";
import test from "node:test";
import {
  deployOutcomeOfStreamResult,
  readProvisionResponse,
} from "./provisionStream.js";
import { DeployOutcome } from "./deployOutcome.js";

function streamedResponse(chunks, { status = 200 } = {}) {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status });
}

test("reports each streamed phase and returns the result", async () => {
  const phases = [];
  const logs = [];

  const result = await readProvisionResponse(
    streamedResponse([
      '{"event":"phase","phase":"connected","message":"Connected to the FlutterFlow deploy runner."}\n',
      '{"event":"phase","phase":"deploy_start","message":"Deploying DemoClass to FlutterFlow..."}\n{"event":"log","message":"flutterflow_ai 0.0.39"}\n',
      '{"event":"result","success":true,"deployed":[{"className":"DemoClass"}]}\n',
    ]),
    { onPhase: (m) => phases.push(m), onLog: (m) => logs.push(m) },
  );

  assert.deepEqual(phases, [
    "Connected to the FlutterFlow deploy runner.",
    "Deploying DemoClass to FlutterFlow...",
  ]);
  assert.deepEqual(logs, ["flutterflow_ai 0.0.39"]);
  assert.equal(result.success, true);
  assert.deepEqual(result.deployed, [{ className: "DemoClass" }]);
  assert.equal(result.finalResultReceived, true);
});

test("surfaces a failure the runner reports part way through", async () => {
  const phases = [];

  const result = await readProvisionResponse(
    streamedResponse([
      '{"event":"phase","phase":"applying","message":"Applying your custom classes..."}\n',
      '{"event":"result","success":false,"error":"FlutterFlow AI DSL deploy failed.","details":"duplicate name","exitCode":1}\n',
    ]),
    { onPhase: (m) => phases.push(m) },
  );

  assert.deepEqual(phases, ["Applying your custom classes..."]);
  assert.equal(result.success, false);
  assert.equal(result.error, "FlutterFlow AI DSL deploy failed.");
  assert.equal(result.details, "duplicate name");
});

test("fails when the stream ends before a result arrives", async () => {
  const result = await readProvisionResponse(
    streamedResponse([
      '{"event":"phase","phase":"uploading","message":"Saving the changes to FlutterFlow..."}\n',
    ]),
  );

  assert.equal(result.success, false);
  assert.match(result.error, /closed the connection/);
  // The runner never delivered a definitive result: this is an unknown remote
  // outcome, which STU-380 requires the caller to render as unconfirmed
  // rather than a fabricated failure.
  assert.equal(result.finalResultReceived, false);
});

test("reads a non-streaming runner's success response", async () => {
  const result = await readProvisionResponse(
    new Response(JSON.stringify({ success: true, deployed: [] }), {
      status: 200,
    }),
  );

  assert.equal(result.success, true);
});

test("reads a non-streaming runner's error response", async () => {
  const result = await readProvisionResponse(
    new Response(
      JSON.stringify({ success: false, error: "Workspace init failed." }),
      { status: 502 },
    ),
  );

  assert.equal(result.success, false);
  assert.equal(result.error, "Workspace init failed.");
});

test("treats an empty body as a failure", async () => {
  const result = await readProvisionResponse(new Response("", { status: 500 }));

  assert.equal(result.success, false);
  assert.match(result.error, /HTTP 500/);
});

// --- STU-380: an explicit HTTP rejection is FAILED, never UNCONFIRMED --------
// These drive the real stream handler (`readProvisionResponse`) against a true
// Response object with a non-2xx status and no streamed "result" event — the
// exact shape the deploy runner produces when it refuses the request before
// doing any work (API key lacks write access, transient 5xx, …). The
// mislabelling bug lived here: that shape was previously thrown as an
// UnconfirmedDeployError, telling the user to reconcile in FlutterFlow when the
// server had plainly refused the write.

function provisionAtStatus(chunks, status) {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status });
}

test("a 403 with no streamed result is surfaced as an explicit HTTP rejection", async () => {
  const result = await readProvisionResponse(
    provisionAtStatus(
      ['{"event":"phase","phase":"connected","message":"Connected."}\n'],
      403,
    ),
  );

  // The stream handler must not hide the rejection behind a generic drop: it
  // reports the exact HTTP status so the caller can tell "server refused" from
  // "connection disappeared".
  assert.equal(result.finalResultReceived, false);
  assert.equal(result.httpRejected, true);
  assert.equal(result.httpStatus, 403);
  assert.match(result.error, /HTTP 403/);
});

test("an explicit HTTP rejection (403) is a failure, not unconfirmed", async () => {
  const result = await readProvisionResponse(
    provisionAtStatus(
      ['{"event":"phase","phase":"connecting","message":"Connecting..."}\n'],
      403,
    ),
  );
  // The truth: the server refused the write, so the remote outcome is decided
  // — it did not happen. Reporting this as UNCONFIRMED would be a lie.
  assert.equal(
    deployOutcomeOfStreamResult(result),
    DeployOutcome.FAILED,
  );
  // Falsification: flipping the classification to UNCONFIRMED for a rejection
  // must change the outcome (this is the regression that shipped).
  assert.notEqual(DeployOutcome.FAILED, DeployOutcome.UNCONFIRMED);
});

test("a 5xx server error with no streamed result is also FAILED, not unconfirmed", async () => {
  const result = await readProvisionResponse(
    new Response(
      '{"event":"phase","phase":"connecting","message":"Connecting..."}\n',
      { status: 502 },
    ),
  );
  assert.equal(result.httpRejected, true);
  assert.equal(
    deployOutcomeOfStreamResult(result),
    DeployOutcome.FAILED,
  );
});

test("a dropped stream on an OK response stays UNCONFIRMED (outcome truly unknown)", async () => {
  const result = await readProvisionResponse(
    provisionAtStatus(
      ['{"event":"phase","phase":"uploading","message":"Saving..."}\n'],
      200,
    ),
  );
  assert.equal(result.httpRejected, false);
  assert.equal(result.finalResultReceived, false);
  assert.equal(
    deployOutcomeOfStreamResult(result),
    DeployOutcome.UNCONFIRMED,
  );
});

test("a delivered result is classified by the ordinary rule, not the rejection carve-out", async () => {
  const shipped = await readProvisionResponse(
    provisionAtStatus(
      ['{"event":"result","success":true,"deployed":[]}\n'],
      200,
    ),
  );
  assert.equal(deployOutcomeOfStreamResult(shipped), DeployOutcome.COMMITTED);

  const runnerFailed = await readProvisionResponse(
    provisionAtStatus(
      [
        '{"event":"result","success":false,"error":"compile gate failed","exitCode":1}\n',
      ],
      200,
    ),
  );
  assert.equal(
    deployOutcomeOfStreamResult(runnerFailed),
    DeployOutcome.FAILED,
  );
});
