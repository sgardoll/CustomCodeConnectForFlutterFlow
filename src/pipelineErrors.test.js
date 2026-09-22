import assert from "node:assert/strict";
import test from "node:test";
import { resolvePipelineErrorStep, classifyPipelineError } from "./pipelineErrors.js";

const STEP_MAP = { architect: 1, generator: 2, review: 3 };

test("uses the structured pipelineStep when present", () => {
  const error = new Error("anything");
  error.pipelineStep = "review";
  assert.equal(resolvePipelineErrorStep(error, STEP_MAP), 3);
});

test("identifies a generator error from app.js' own prefix", () => {
  const error = new Error("Code Generator failed: primary (x): boom");
  assert.equal(resolvePipelineErrorStep(error, STEP_MAP), 2);
});

test("identifies a review error from app.js' own prefix", () => {
  const error = new Error("Code Review failed: boom");
  assert.equal(resolvePipelineErrorStep(error, STEP_MAP), 3);
});

test("defaults an unknown error to step 1 (Architect)", () => {
  const error = new Error("Prompt Architect failed: boom");
  assert.equal(resolvePipelineErrorStep(error, STEP_MAP), 1);
});

test("does not misattribute a message that merely quotes a provider name", () => {
  // A Gemini error that mentions "Claude" must not be bumped to step 2.
  const error = new Error('Your prompt mentions "Claude" as a reference model');
  assert.equal(resolvePipelineErrorStep(error, STEP_MAP), 1);
});

test("defaults to step 1 for an empty message", () => {
  assert.equal(resolvePipelineErrorStep(new Error(""), STEP_MAP), 1);
  assert.equal(resolvePipelineErrorStep(null, STEP_MAP), 1);
  assert.equal(resolvePipelineErrorStep(undefined, STEP_MAP), 1);
});

test("falls back to step 1 when the message mentions a product but not a step marker", () => {
  // "OpenAI" alone is not a reliable generator signal.
  const error = new Error("OpenAI rate limit exceeded");
  assert.equal(resolvePipelineErrorStep(error, STEP_MAP), 1);
});

// --- classifyPipelineError ---

test("classifies a blocked Model Armor error as safety, retry disabled", () => {
  const error = new Error("Safety screening blocked this pipeline step for hate speech.");
  error.isModelArmor = true;
  error.code = "MODEL_ARMOR_BLOCKED";
  error.userTitle = "Request blocked for safety";
  error.userMessage = "The safety check detected hate speech.";
  error.retryExplanation = "Trying another model would not change this safety decision.";

  const result = classifyPipelineError(error);
  assert.equal(result.kind, "safety");
  assert.equal(result.canRetry, false);
  assert.equal(result.canEdit, true);
  assert.equal(result.canUpgrade, false);
  assert.equal(result.title, "Request blocked for safety");
});

test("classifies an unavailable Model Armor error as safety, retry enabled", () => {
  const error = new Error("Safety screening could not be completed. Please try again.");
  error.isModelArmor = true;
  error.code = "MODEL_ARMOR_UNAVAILABLE";
  error.userTitle = "Safety check unavailable";
  error.userMessage = "The safety service did not finish.";

  const result = classifyPipelineError(error);
  assert.equal(result.kind, "safety");
  assert.equal(result.canRetry, true);
});

test("classifies a usage-limit error as quota, retry disabled, upgrade enabled", () => {
  const error = new Error("Monthly usage limit reached. Upgrade to continue.");
  error.isUsageLimit = true;

  const result = classifyPipelineError(error);
  assert.equal(result.kind, "quota");
  assert.equal(result.canRetry, false);
  assert.equal(result.canUpgrade, true);
});

test("classifies a BuildShip abort as a timeout", () => {
  const error = new Error("BuildShip generator timed out after 120s");
  const result = classifyPipelineError(error);
  assert.equal(result.kind, "timeout");
  assert.equal(result.canRetry, true);
});

test("classifies an unreachable BuildShip host as a network error", () => {
  const error = new Error("BuildShip unreachable: Failed to fetch");
  const result = classifyPipelineError(error);
  assert.equal(result.kind, "network");
  assert.equal(result.canRetry, true);
});

test("classifies an ordinary provider/model-fallback failure as generic", () => {
  const error = new Error(
    "Code Generator failed: primary (gpt-x): boom | fallback (claude-fallback): boom2",
  );
  const result = classifyPipelineError(error);
  assert.equal(result.kind, "generic");
  assert.equal(result.canRetry, true);
  assert.equal(result.message, error.message);
});

test("classifies a missing error as generic without throwing", () => {
  const result = classifyPipelineError(null);
  assert.equal(result.kind, "generic");
  assert.equal(result.canRetry, true);
});
