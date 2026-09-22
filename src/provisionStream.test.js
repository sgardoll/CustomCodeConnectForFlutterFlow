import assert from "node:assert/strict";
import test from "node:test";
import { readProvisionResponse } from "./provisionStream.js";

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
