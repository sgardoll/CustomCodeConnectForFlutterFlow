/**
 * Resolves which pipeline step (1 = Architect, 2 = Generator, 3 = Review) an
 * error belongs to, so the UI can highlight the right step.
 *
 * The authoritative signal is a structured `error.pipelineStep` (a step label
 * such as "architect" | "generator" | "review"), set on model-armor errors by
 * `createModelArmorError`. We map that through `stepMap` first.
 *
 * When no structured step is present (e.g. plain network/provider errors
 * wrapped by the `run*` helpers), we fall back to the step-name prefixes that
 * app.js itself stamps onto those errors ("Prompt Architect failed:",
 * "Code Generator failed:", "Code Review failed:"). Matching only our own
 * reliable markers avoids the fragility of substring-matching raw provider
 * names (a Gemini error quoting "Claude" would otherwise be misattributed).
 *
 * @param {Error} error
 * @param {Record<string, number>} stepMap - label -> step index
 * @returns {number} 1 | 2 | 3 (defaults to 1)
 */
export function resolvePipelineErrorStep(error, stepMap = {}) {
  const pipelineStep = error?.pipelineStep;
  if (pipelineStep != null && stepMap[pipelineStep] != null) {
    return stepMap[pipelineStep];
  }

  const message = error?.message || "";
  if (message.includes("Code Generator")) return 2;
  if (message.includes("Code Review")) return 3;
  return 1;
}

/**
 * Classifies a pipeline failure into a UI-ready shape: what to title it, what
 * to tell the user, and which recovery actions make sense.
 *
 * Kinds:
 * - "safety"  — Model Armor blocked or could not complete the safety check.
 *               Editing the prompt is the only useful recovery; retrying the
 *               same content will not change the safety decision.
 * - "quota"   — the monthly run allowance is exhausted. Retrying won't help;
 *               only upgrading will.
 * - "timeout" — the BuildShip request was aborted after exceeding its budget.
 * - "network" — the request never reached BuildShip (offline, CORS, DNS).
 * - "generic" — any other failure (provider error, malformed response, a
 *               generator run that exhausted its model fallback, etc).
 *
 * @param {Error} error
 * @returns {{kind: string, title: string, message: string, detail: string, canRetry: boolean, canEdit: boolean, canUpgrade: boolean}}
 */
export function classifyPipelineError(error) {
  if (!error) {
    return {
      kind: "generic",
      title: "Generation failed",
      message: "An unknown error occurred. Please try again.",
      detail: "",
      canRetry: true,
      canEdit: true,
      canUpgrade: false,
    };
  }

  if (error.isModelArmor) {
    const blocked = error.code === "MODEL_ARMOR_BLOCKED";
    return {
      kind: "safety",
      title: error.userTitle || "Request blocked for safety",
      message: error.userMessage || error.message,
      detail: error.retryExplanation || "",
      // A blocked request needs different content, not a bare retry.
      canRetry: !blocked,
      canEdit: true,
      canUpgrade: false,
    };
  }

  if (error.isUsageLimit) {
    return {
      kind: "quota",
      title: "Monthly limit reached",
      message: error.message || "You've used all your generations for this period.",
      detail: "",
      canRetry: false,
      canEdit: false,
      canUpgrade: true,
    };
  }

  const message = error.message || "";

  if (/timed out after/i.test(message)) {
    return {
      kind: "timeout",
      title: "Request timed out",
      message: "The generation service took too long to respond.",
      detail: message,
      canRetry: true,
      canEdit: true,
      canUpgrade: false,
    };
  }

  if (/unreachable|failed to fetch|load failed|cors/i.test(message)) {
    return {
      kind: "network",
      title: "Connection problem",
      message: "We couldn't reach the generation service. Check your connection and try again.",
      detail: message,
      canRetry: true,
      canEdit: true,
      canUpgrade: false,
    };
  }

  return {
    kind: "generic",
    title: "Generation failed",
    message: message || "An unexpected error occurred.",
    detail: "",
    canRetry: true,
    canEdit: true,
    canUpgrade: false,
  };
}
