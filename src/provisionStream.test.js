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
// Response object with a non-2xx status and no streamed "result" event. A 4xx
// is the shape the deploy runner produces when it refuses the request before
// doing any work (API key lacks write access, bad request, …): the write was
// turned away, so it is FAILED. A 5xx is not a refusal — a gateway can fail
// after forwarding the request to the runner — so it is UNCONFIRMED.

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

test("a refusal whose body is unreadable still reports its HTTP status", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.error(new Error("connection reset"));
    },
  });
  const result = await readProvisionResponse(
    new Response(body, { status: 403 }),
  );

  // An unreadable body must not reclassify a received refusal as a dropped
  // connection — the status was delivered and still names the reason.
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

test("a 5xx server error with no streamed result is UNCONFIRMED — a gateway can fail after forwarding", async () => {
  const result = await readProvisionResponse(
    new Response(
      '{"event":"phase","phase":"connecting","message":"Connecting..."}\n',
      { status: 502 },
    ),
  );
  assert.equal(result.httpRejected, true);
  assert.equal(result.httpStatus, 502);
  // A 502 can come from a gateway after the request reached the runner, which
  // may be deploying classes already — so it cannot prove nothing was written.
  assert.equal(
    deployOutcomeOfStreamResult(result),
    DeployOutcome.UNCONFIRMED,
  );

  // Every 5xx shares that uncertainty: the server failed, but none of them
  // proves the request was turned away before a write.
  const unavailable = await readProvisionResponse(
    new Response("", { status: 503 }),
  );
  assert.equal(
    deployOutcomeOfStreamResult(unavailable),
    DeployOutcome.UNCONFIRMED,
  );
});

test("a 4xx with no streamed result stays a definitive refusal, not unconfirmed", async () => {
  const result = await readProvisionResponse(
    new Response("no", { status: 400 }),
  );
  // A 4xx is validation/auth — the request was turned away before any work.
  assert.equal(result.httpRejected, true);
  assert.equal(deployOutcomeOfStreamResult(result), DeployOutcome.FAILED);
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

test("a mid-stream read failure is an unknown outcome, not a thrown error", async () => {
  const encoder = new TextEncoder();
  // Error in pull(), not start(): error() discards queued-but-unread chunks,
  // so erroring synchronously would only exercise a drop before the first
  // chunk. Pull-based erroring delivers the phase event, then drops mid-stream.
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          '{"event":"phase","phase":"deploying","message":"Deploying..."}\n',
        ),
      );
    },
    pull(controller) {
      controller.error(new Error("network reset"));
    },
  });

  const phases = [];
  const result = await readProvisionResponse(new Response(body, { status: 200 }), {
    onPhase: (message) => phases.push(message),
  });

  // The phase event was delivered before the drop — this is the mid-stream
  // case, not a connection that never produced data.
  assert.deepEqual(phases, ["Deploying..."]);
  // The connection died mid-work: no result arrived, so the remote outcome is
  // unknown — UNCONFIRMED, never a fabricated failure.
  assert.equal(result.success, false);
  assert.equal(result.finalResultReceived, false);
  assert.equal(result.httpRejected, false);
  assert.match(result.error, /dropped/);
  assert.equal(deployOutcomeOfStreamResult(result), DeployOutcome.UNCONFIRMED);
});

test("an unrecognized streamed event is not a result — the outcome stays unknown", async () => {
  // Heartbeats and other progress noise share the event envelope but are not
  // the runner's answer. Treating any event as the final result would
  // fabricate a success from a message that decides nothing.
  const result = await readProvisionResponse(
    provisionAtStatus(
      ['{"event":"heartbeat"}\n'],
      200,
    ),
  );
  assert.equal(result.finalResultReceived, false);
  assert.equal(deployOutcomeOfStreamResult(result), DeployOutcome.UNCONFIRMED);
});

test("a delivered result is classified by the ordinary rule, not the rejection carve-out", async () => {
  const shipped = await readProvisionResponse(
    provisionAtStatus(
      ['{"event":"result","success":true,"deployed":[]}\n'],
      200,
    ),
  );
  assert.equal(deployOutcomeOfStreamResult(shipped), DeployOutcome.COMMITTED);

  // A compile-gate rejection is a verified pre-write failure: analyzerErrors
  // prove verification ran and the deploy script never started.
  const compileGateFailed = await readProvisionResponse(
    provisionAtStatus(
      [
        '{"event":"phase","phase":"verifying","message":"Compiling..."}\n',
        '{"event":"result","success":false,"error":"The generated custom code does not compile, so nothing was deployed to FlutterFlow.","analyzerErrors":["bad arg"]}\n',
      ],
      200,
    ),
  );
  assert.equal(
    deployOutcomeOfStreamResult(compileGateFailed),
    DeployOutcome.FAILED,
  );
});

// --- STU-380: a runner failure after the deploy began is not a refusal -----
// A streamed `{success:false}` proves the runner finished, not that nothing
// was written: the deploy CLI can die after its upload phase already wrote
// classes. Only provably pre-write failures stay FAILED.

test("a failure after the deploy phase began is unconfirmed, not a clean refusal", async () => {
  const result = await readProvisionResponse(
    provisionAtStatus(
      [
        '{"event":"phase","phase":"deploy_start","message":"Deploying..."}\n',
        '{"event":"result","success":false,"error":"FlutterFlow AI DSL deploy failed.","exitCode":1}\n',
      ],
      200,
    ),
  );

  assert.equal(result.runnerPhase, "deploy_start");
  assert.equal(
    deployOutcomeOfStreamResult(result),
    DeployOutcome.UNCONFIRMED,
  );
});

test("a failure reported during upload is unconfirmed even though the runner answered", async () => {
  const result = await readProvisionResponse(
    provisionAtStatus(
      [
        '{"event":"phase","phase":"deploy_start","message":"Deploying..."}\n',
        '{"event":"phase","phase":"uploading","message":"Saving the changes to FlutterFlow..."}\n',
        '{"event":"result","success":false,"error":"FlutterFlow AI DSL deploy timed out."}\n',
      ],
      200,
    ),
  );

  assert.equal(result.runnerPhase, "uploading");
  assert.equal(
    deployOutcomeOfStreamResult(result),
    DeployOutcome.UNCONFIRMED,
  );
});

test("a runner failure before the deploy phase is a definitive refusal", async () => {
  const result = await readProvisionResponse(
    provisionAtStatus(
      [
        '{"event":"phase","phase":"workspace_init","message":"Preparing..."}\n',
        '{"event":"result","success":false,"error":"FlutterFlow AI workspace initialization failed.","exitCode":1}\n',
      ],
      200,
    ),
  );

  assert.equal(result.runnerPhase, "workspace_init");
  assert.equal(deployOutcomeOfStreamResult(result), DeployOutcome.FAILED);
});

test("a non-streaming runner failure is refused on 4xx, unconfirmed on 5xx", async () => {
  const refused = await readProvisionResponse(
    new Response(
      JSON.stringify({ success: false, error: "verification must be an object." }),
      { status: 400 },
    ),
  );
  assert.equal(deployOutcomeOfStreamResult(refused), DeployOutcome.FAILED);

  const cliFailed = await readProvisionResponse(
    new Response(
      JSON.stringify({ success: false, error: "FlutterFlow AI DSL deploy failed." }),
      { status: 502 },
    ),
  );
  assert.equal(deployOutcomeOfStreamResult(cliFailed), DeployOutcome.UNCONFIRMED);
});
