import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDeployResult,
  DeployOutcome,
  DEPLOY_UI_TIMEOUT_MS,
} from "./deployOutcome.js";

// --- Falsification harness -------------------------------------------------
// Every assertion that "this shape maps to THAT outcome" is run twice: once
// against the classifier, and once after a deliberate mutation that must flip
// the outcome. A test that cannot be flipped by breaking the code under test
// would prove nothing about it, so each `flip` writes a value that must change
// the result and asserts it does.
function assertOutcome(result, expected) {
  assert.equal(classifyDeployResult(result), expected);
}

function assertFlip(result, expected, flippedExpectation, flip) {
  assertOutcome(result, expected);
  const mutated = flip(structuredClone(result ?? {}));
  assertOutcome(mutated, flippedExpectation);
}

test("only a confirmed success classifies as committed", () => {
  assertFlip(
    { success: true, message: "Deployed" },
    DeployOutcome.COMMITTED,
    DeployOutcome.FAILED,
    (r) => { r.success = false; return r; },
  );
  // A success that never came from a remote write must not be reported either.
  assertFlip(
    { success: false },
    DeployOutcome.FAILED,
    DeployOutcome.COMMITTED,
    (r) => { r.success = true; return r; },
  );
});

test("a result with no success field and no marker is a failure", () => {
  assertOutcome({ error: "403 Forbidden" }, DeployOutcome.FAILED);
  assertOutcome(undefined, DeployOutcome.FAILED);
  assertOutcome(null, DeployOutcome.FAILED);
});

test("partial marks an outcome where some writes landed and some failed", () => {
  assertFlip(
    { success: false, partial: true, errorMap: { "a.dart": "rejected" } },
    DeployOutcome.PARTIAL,
    DeployOutcome.FAILED,
    (r) => { delete r.partial; return r; },
  );
  // A partial that carries `success:true` is contradictory; the explicit
  // partial marker must still win over a bare success flag.
  assertFlip(
    { success: true, partial: true },
    DeployOutcome.PARTIAL,
    DeployOutcome.COMMITTED,
    (r) => { delete r.partial; return r; },
  );
});

test("an unconfirmed marker beats every other signal", () => {
  // Timeout: success flag absent, neither committed nor failed may be assumed.
  assertFlip(
    { unconfirmed: true, error: "waited too long" },
    DeployOutcome.UNCONFIRMED,
    DeployOutcome.FAILED,
    (r) => { delete r.unconfirmed; return r; },
  );
  // Even a degenerate object claiming success while also unconfirmed must be
  // unconfirmed: we cannot trust a success for an outcome we did not confirm.
  assertFlip(
    { success: true, unconfirmed: true },
    DeployOutcome.UNCONFIRMED,
    DeployOutcome.COMMITTED,
    (r) => { delete r.unconfirmed; return r; },
  );
  // The `outcome` spelling is honored too (exported by the provisioning layer).
  assertFlip(
    { outcome: DeployOutcome.UNCONFIRMED },
    DeployOutcome.UNCONFIRMED,
    DeployOutcome.FAILED,
    (r) => { r.outcome = DeployOutcome.FAILED; return r; },
  );
});

test("the UI waiting bound is finite and below the documented server deadline", () => {
  // Cloud Run's request timeout is 900s; the UI bound must be shorter so the
  // UI never out-waits a real server decision, and positive so it actually
  // fires.
  assert.ok(Number.isFinite(DEPLOY_UI_TIMEOUT_MS));
  assert.ok(DEPLOY_UI_TIMEOUT_MS > 0);
  assert.ok(DEPLOY_UI_TIMEOUT_MS < 900_000);
});
