import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateDeployRunId,
  isValidRunId,
  runStatusUrl,
  readRunStatus,
  runStatusOutcome,
  fetchRunStatus,
  queryRunStatusWithinBudget,
  PRE_WRITE_RUN_PHASES,
  RUN_STATUS_KEY_HEADER,
} from "./runStatus.js";

describe("runStatus — id plumbing", () => {
  it("generates a valid, prefixed run id", () => {
    const id = generateDeployRunId();
    assert.ok(id.startsWith("dr_"));
    assert.ok(isValidRunId(id));
  });

  it("rejects invalid and over-long ids", () => {
    assert.equal(isValidRunId(""), false);
    assert.equal(isValidRunId("has a space"), false);
    assert.equal(isValidRunId("a".repeat(121)), false);
    assert.equal(isValidRunId(null), false);
  });

  it("derives the status url from the provision endpoint", () => {
    assert.equal(
      runStatusUrl("https://runner.example/deployCustomClasses", "dr_123"),
      "https://runner.example/runStatus/dr_123",
    );
    assert.equal(
      runStatusUrl("/api/ffai-runner/deployCustomClasses", "dr_123"),
      "/api/ffai-runner/runStatus/dr_123",
    );
  });
});

describe("runStatus — response-to-outcome mapping", () => {
  it("accepts only recognisable records", () => {
    assert.equal(readRunStatus({ status: "bogus" }), null);
    assert.equal(readRunStatus("not an object"), null);
    assert.equal(readRunStatus(null), null);
  });

  it("maps a done record to a definitive success with deployed classes", () => {
    const outcome = runStatusOutcome(
      readRunStatus({
        status: "done",
        deployed: [{ className: "GaugeWidget", artifactId: "g" }],
      }),
    );
    assert.deepEqual(outcome, {
      definitive: "success",
      deployed: [{ className: "GaugeWidget", artifactId: "g" }],
    });
  });

  it("maps a pre-write failure to a definitive failure", () => {
    const outcome = runStatusOutcome(
      readRunStatus({
        status: "failed",
        phase: "verifying",
        error: "does not compile",
      }),
    );
    assert.deepEqual(outcome, {
      definitive: "failed",
      error: "does not compile",
    });
  });

  it("leaves a running record unknown", () => {
    const outcome = runStatusOutcome(
      readRunStatus({ status: "running", phase: "uploading" }),
    );
    assert.equal(outcome.definitive, null);
  });

  it("leaves a post-write failure unknown so the caller reconciles", () => {
    assert.ok(PRE_WRITE_RUN_PHASES.has("verifying"));
    assert.ok(!PRE_WRITE_RUN_PHASES.has("deploy_start"));
    const outcome = runStatusOutcome(
      readRunStatus({ status: "failed", phase: "uploading" }),
    );
    assert.equal(outcome.definitive, null);
  });
});

describe("runStatus — client fallback when the endpoint is absent or 404s", () => {
  // A never-arrived request is a 404 the client can distinguish from "unknown":
  // it generated the id itself, so not finding it proves nothing was written.
  it("resolves a 404 to unknown, never a failure", async () => {
    const fetchImpl = async () => ({ ok: false, status: 404 });
    const outcome = await queryRunStatusWithinBudget({
      provisionEndpoint: "https://runner.example/deployCustomClasses",
      runId: "dr_never-sent",
      apiKey: "key",
      fetchImpl,
      budgetMs: 50,
      intervalMs: 10,
    });
    assert.equal(outcome.definitive, null);
  });

  it("sends the api key in the run-status header", async () => {
    let sentHeader = null;
    let sentUrl = null;
    const fetchImpl = async (url, opts) => {
      sentUrl = url;
      sentHeader = opts.headers[RUN_STATUS_KEY_HEADER];
      return { ok: true, json: async () => ({ status: "done", deployed: [] }) };
    };
    const outcome = await queryRunStatusWithinBudget({
      provisionEndpoint: "https://runner.example/deployCustomClasses",
      runId: "dr_123",
      apiKey: "the-key",
      fetchImpl,
      budgetMs: 50,
    });
    assert.equal(sentUrl, "https://runner.example/runStatus/dr_123");
    assert.equal(sentHeader, "the-key");
    assert.equal(outcome.definitive, "success");
  });

  it("returns a definitive success even if the first poll sees it running", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: true, json: async () => ({ status: "running", phase: "uploading" }) };
      }
      return { ok: true, json: async () => ({ status: "done", deployed: [] }) };
    };
    const outcome = await queryRunStatusWithinBudget({
      provisionEndpoint: "https://runner.example/deployCustomClasses",
      runId: "dr_123",
      apiKey: "key",
      fetchImpl,
      budgetMs: 500,
      intervalMs: 10,
    });
    assert.equal(outcome.definitive, "success");
  });

  it("ignores a malformed body (older runner) and falls back to unknown", async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ event: "heartbeat" }) });
    const outcome = await queryRunStatusWithinBudget({
      provisionEndpoint: "https://runner.example/deployCustomClasses",
      runId: "dr_123",
      apiKey: "key",
      fetchImpl,
      budgetMs: 50,
      intervalMs: 10,
    });
    assert.equal(outcome.definitive, null);
  });

  it("does not throw the app when a network error lands mid-poll", async () => {
    const fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    const outcome = await queryRunStatusWithinBudget({
      provisionEndpoint: "https://runner.example/deployCustomClasses",
      runId: "dr_123",
      apiKey: "key",
      fetchImpl,
      budgetMs: 50,
      intervalMs: 10,
    });
    assert.equal(outcome.definitive, null);
  });

  it("returns 404-unknown via fetchRunStatus for a never-arrived id", async () => {
    const fetchImpl = async () => ({ ok: false, status: 404 });
    const record = await fetchRunStatus({
      provisionEndpoint: "https://runner.example/deployCustomClasses",
      runId: "dr_never",
      apiKey: "key",
      fetchImpl,
    });
    assert.equal(record, null);
  });
});
