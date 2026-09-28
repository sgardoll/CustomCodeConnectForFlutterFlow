import { parseJsonLike } from "./artifactBundle.js";

const STATUS_RANK = { pass: 0, warning: 1, fail: 2 };
// The REVIEW_SYSTEM prompt on BuildShip defines a typed manualActions contract
// with explicit exclusions and preferEmpty. Scavenging extra key names
// (nextSteps, userActions, etc.) leaks noise past that contract.
const MANUAL_STEP_KEYS = ["manualActions"];

function toObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length > 0) {
      const text = value.filter((item) => typeof item === "string").join("\n");
      if (text) return text;
    }
  }
  return "";
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function parseScore(value) {
  const scoreValue = toObject(value).value ?? value;
  if (
    scoreValue == null
    || (typeof scoreValue === "string" && scoreValue.trim() === "")
  ) {
    return null;
  }

  const direct = Number(scoreValue);
  if (Number.isFinite(direct)) return validScore(direct);
  const match = String(value || "").match(/\bscore\b[^\d]{0,12}(\d{1,3})(?:\s*\/\s*100)?/i);
  return match ? validScore(Number(match[1])) : null;
}

// A review score is only meaningful on the 0-100 scale. Out-of-range or
// non-numeric values (e.g. "Score: 999/100") are malformed, not extreme scores:
// they must surface as UNKNOWN rather than fabricating a pass/fail figure.
function validScore(score) {
  return score >= 0 && score <= 100 ? score : null;
}

function slugify(value) {
  return String(value || "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeReviewStatus(value) {
  const status = String(value || "").toLowerCase();
  if (/(fail|error|critical|block|reject|invalid)/.test(status)) return "fail";
  if (/(warn|attention|manual|partial|incomplete|concern)/.test(status)) return "warning";
  if (/(pass|success|ready|approve|valid|clean|info|notice)/.test(status)) return "pass";
  return null;
}

function worstStatus(...statuses) {
  return statuses
    .filter(Boolean)
    .reduce((worst, status) => (
      STATUS_RANK[status] > STATUS_RANK[worst] ? status : worst
    ), "pass");
}

function normalizeFinding(rawFinding, defaultSeverity = "warning", source = "review") {
  if (typeof rawFinding === "string") {
    return { severity: defaultSeverity, message: rawFinding, suggestion: "", source };
  }

  const finding = toObject(rawFinding);
  const message = firstText(
    finding.message,
    finding.title,
    finding.issue,
    finding.description,
    finding.summary,
  );
  if (!message) return null;

  return {
    severity: normalizeReviewStatus(finding.severity || finding.status || finding.level)
      || defaultSeverity,
    message,
    suggestion: firstText(
      finding.suggestion,
      finding.fix,
      finding.recommendation,
      finding.action,
    ),
    source: finding.source || source,
  };
}

function collectFindings(source, provenance = "review") {
  const object = toObject(source);
  const groups = [
    ["findings", "warning"],
    ["issues", "warning"],
    ["criticalIssues", "fail"],
    ["errors", "fail"],
    ["warnings", "warning"],
    ["recommendations", "warning"],
    ["requiredFixes", "fail"],
    ["suggestions", "warning"],
  ];

  return groups.flatMap(([key, severity]) => (
    asArray(object[key])
      .map((finding) => normalizeFinding(finding, severity, provenance))
      .filter(Boolean)
  ));
}

function normalizeManualStep(rawStep, index, artifactId = null) {
  if (typeof rawStep === "string") {
    return {
      id: `${artifactId || "bundle"}-manual-${index + 1}`,
      title: rawStep,
      detail: "",
      location: "",
      timing: "unspecified",
      artifactId,
      source: "Code Review",
    };
  }

  const step = toObject(rawStep);
  const title = firstText(
    step.title,
    step.action,
    step.step,
    step.message,
    step.name,
    step.description,
  );
  if (!title) return null;

  return {
    id: step.id || `${artifactId || "bundle"}-manual-${index + 1}`,
    title,
    detail: firstText(step.detail, step.instructions, step.description),
    location: firstText(step.location, step.flutterFlowPath, step.path),
    timing: firstText(step.timing, step.phase) || "unspecified",
    artifactId,
    source: firstText(step.source) || "Code Review",
  };
}

function collectManualSteps(source, artifactId = null) {
  const object = toObject(source);
  return MANUAL_STEP_KEYS.flatMap((key) => asArray(object[key]))
    .map((step, index) => normalizeManualStep(step, index, artifactId))
    .filter(Boolean);
}

function unwrapReviewPayload(reviewResult) {
  let value = typeof reviewResult === "string" ? parseJsonLike(reviewResult) : reviewResult;
  if (!value && typeof reviewResult === "string") {
    return { rawText: reviewResult, root: {} };
  }

  const envelope = toObject(value);
  if (typeof envelope.content === "string") {
    value = parseJsonLike(envelope.content) || value;
  }

  const root = toObject(value);
  const nested = toObject(root.reviewResult || root.codeReview || root.result);
  return { rawText: "", root: Object.keys(nested).length ? nested : root };
}

function findArtifactReview(reviewArtifacts, artifact) {
  const candidates = [
    artifact.id,
    artifact.fileName,
    artifact.artifactName,
  ].map(slugify);

  return reviewArtifacts.find((reviewArtifact) => {
    const review = toObject(reviewArtifact);
    return [review.id, review.fileName, review.artifactName, review.name]
      .map(slugify)
      .some((candidate) => candidate && candidates.includes(candidate));
  }) || null;
}

function getPathHint(bundle, artifact) {
  const hints = asArray(bundle?.metadata?.compatibility?.deployHints);
  const match = hints.find((hint) => (
    slugify(hint?.artifactId) === slugify(artifact.id)
      || slugify(hint?.fileName) === slugify(artifact.fileName)
  ));
  return match?.pathHint || "";
}

function getArtifactRelationships(bundle, artifact) {
  return asArray(bundle?.relationships).filter((relationship) => (
    slugify(relationship?.from) === slugify(artifact.id)
      || slugify(relationship?.to) === slugify(artifact.id)
  ));
}

function getCompatibilityFindings(bundle, artifact) {
  return asArray(bundle?.metadata?.compatibility?.findings)
    .filter((finding) => (
      !finding?.artifactId || slugify(finding.artifactId) === slugify(artifact.id)
    ))
    .map((finding) => normalizeFinding(finding, "warning", "Compatibility check"))
    .filter(Boolean);
}

function buildArtifactPresentation(bundle, reviewArtifacts, artifact, index) {
  const rawArtifactReview = findArtifactReview(reviewArtifacts, artifact);
  const review = toObject(rawArtifactReview?.review || rawArtifactReview || artifact.review);
  const hasStructuredReview = Object.keys(review).length > 0;
  const findings = [
    ...collectFindings(review),
    ...getCompatibilityFindings(bundle, artifact),
  ];
  const manualSteps = collectManualSteps(review, artifact.id);
  const explicitStatus = normalizeReviewStatus(
    review.status || review.verdict || review.outcome || review.result,
  );
  const findingStatus = findings.length
    ? worstStatus(...findings.map((finding) => finding.severity))
    : null;
  const status = worstStatus(
    explicitStatus,
    findingStatus,
    hasStructuredReview ? null : "warning",
  );

  return {
    ...artifact,
    index,
    status,
    statusReason: hasStructuredReview
      ? firstText(review.summary, review.overview, review.assessment, review.conclusion)
        || (findings.length ? `${findings.length} review finding${findings.length === 1 ? "" : "s"}` : "No file-level findings")
      : "No file-level verdict was returned",
    reviewComplete: hasStructuredReview,
    findings,
    manualSteps,
    fixedSource: typeof review.fixedSource === "string" && review.fixedSource.trim()
      ? review.fixedSource.trim()
      : null,
    pathHint: getPathHint(bundle, artifact),
    relationships: getArtifactRelationships(bundle, artifact),
  };
}

/**
 * Builds a deployable, user-actionable summary when the review returned no
 * written summary. Never falls back to a useless placeholder: it synthesizes
 * the verdict, per-artifact pass/warn/fail counts, and the manual steps the
 * user must take in their own FlutterFlow project, and calls out when no
 * numeric score was returned so a missing score is never mistaken for a pass.
 */
function buildFallbackSummary({ status, score, artifactPresentations, manualSteps }) {
  const total = artifactPresentations.length;
  if (total === 0 && manualSteps.length === 0) {
    return score == null
      ? "Code review returned no overall summary and no score."
      : `Reviewed bundle with score ${score}/100.`;
  }
  const counts = artifactPresentations.reduce((result, artifact) => {
    result[artifact.status] += 1;
    return result;
  }, { pass: 0, warning: 0, fail: 0 });
  const parts = [];
  if (status) parts.push(`Overall verdict: ${status}.`);
  if (total) {
    parts.push(`${total} artifact${total === 1 ? "" : "s"}: ${counts.pass} pass, ${counts.warning} warn, ${counts.fail} fail.`);
  }
  if (manualSteps.length) {
    parts.push(`Do before deploy: ${manualSteps.map((step) => step.title).join("; ")}.`);
  }
  if (score == null) parts.push("No numeric score (0-100) was returned.");
  return parts.join(" ");
}

export function buildReviewPresentation({ bundle, reviewResult }) {
  const safeBundle = toObject(bundle);
  const artifacts = asArray(safeBundle.artifacts);
  const { root, rawText } = unwrapReviewPayload(reviewResult);
  const overallReview = [
    root.bundleReview,
    root.overallReview,
    root.overall,
    root.bundleSummary,
    root.summaryReview,
    root.review,
  ]
    .map(toObject)
    .find((candidate) => Object.keys(candidate).length) || {};
  const reviewArtifacts = asArray(root.artifacts || root.files || root.reviews);
  const artifactPresentations = artifacts.map((artifact, index) => (
    buildArtifactPresentation(safeBundle, reviewArtifacts, artifact, index)
  ));

  const rootFindings = collectFindings(root);
  const overallFindings = collectFindings(overallReview);
  const findings = [...overallFindings, ...rootFindings];
  const manualSteps = [
    ...collectManualSteps(overallReview),
    ...collectManualSteps(root),
    ...artifactPresentations.flatMap((artifact) => artifact.manualSteps),
  ].filter((step, index, all) => (
    all.findIndex((candidate) => (
      candidate.title === step.title && candidate.artifactId === step.artifactId
    )) === index
  ));
  const explicitStatus = normalizeReviewStatus(
    overallReview.status
      || overallReview.verdict
      || overallReview.overallStatus
      || root.status
      || root.verdict
      || root.overallStatus
      || root.outcome,
  );
  const status = worstStatus(
    explicitStatus,
    ...findings.map((finding) => finding.severity),
    ...artifactPresentations.map((artifact) => artifact.status),
  );
  const rawScore = overallReview.score ?? root.score ?? root.overallScore ?? rawText;
  const scoreValue = parseScore(rawScore);
  const summary = firstText(
    overallReview.headline,
    overallReview.summary,
    overallReview.executiveSummary,
    overallReview.overview,
    overallReview.assessment,
    overallReview.conclusion,
    root.overallSummary,
    root.headline,
    root.summary,
    root.executiveSummary,
    root.overview,
    root.assessment,
    root.conclusion,
    rawText,
  ) || buildFallbackSummary({ status, score: scoreValue, artifactPresentations, manualSteps });
  const counts = artifactPresentations.reduce((result, artifact) => {
    result[artifact.status] += 1;
    return result;
  }, { pass: 0, warning: 0, fail: 0 });

  return {
    title: safeBundle.title || "Generated artifact bundle",
    description: safeBundle.description || "",
    status,
    score: scoreValue,
    summary,
    findings,
    manualSteps,
    artifacts: artifactPresentations,
    counts,
    reviewCoverage: {
      reviewed: artifactPresentations.filter((artifact) => artifact.reviewComplete).length,
      total: artifactPresentations.length,
    },
    deployOrder: asArray(safeBundle.deployOrder),
    relationships: asArray(safeBundle.relationships),
    warnings: asArray(safeBundle.warnings),
    compatibility: toObject(safeBundle.metadata?.compatibility),
  };
}
