import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewPresentation, normalizeReviewStatus } from "./reviewPresentation.js";

const bundle = {
  title: "NFC bundle",
  description: "Connect NFC scans to a webhook.",
  artifacts: [
    {
      id: "format-payload",
      artifactName: "formatPayload",
      artifactType: "CustomFunction",
      fileName: "format_payload.dart",
      code: "String formatPayload() => '';",
      dependencies: [],
      imports: ["dart:convert"],
    },
    {
      id: "execute-webhook",
      artifactName: "executeWebhook",
      artifactType: "CustomAction",
      fileName: "execute_webhook.dart",
      code: "Future<bool> executeWebhook() async => true;",
      dependencies: [{ name: "http", version: "^1.2.0" }],
      imports: ["package:http/http.dart"],
    },
  ],
  relationships: [
    { from: "execute-webhook", to: "format-payload", type: "calls" },
  ],
  deployOrder: ["format-payload", "execute-webhook"],
  warnings: [],
  metadata: {
    compatibility: {
      valid: true,
      findings: [],
      deployHints: [
        { artifactId: "execute-webhook", pathHint: "actions/" },
      ],
    },
  },
};

test("normalizes common review verdict vocabulary", () => {
  assert.equal(normalizeReviewStatus("approved"), "pass");
  assert.equal(normalizeReviewStatus("needs attention"), "warning");
  assert.equal(normalizeReviewStatus("blocked"), "fail");
  assert.equal(normalizeReviewStatus("unknown"), null);
});

test("builds an overarching summary and status-bearing file presentations", () => {
  const presentation = buildReviewPresentation({
    bundle,
    reviewResult: JSON.stringify({
      overallReview: {
        status: "warning",
        score: 88,
        summary: "Safe to deploy after one FlutterFlow setup step.",
        manualActions: [
          {
            title: "Confirm the http dependency",
            location: "Settings > Project Dependencies",
          },
        ],
      },
      artifacts: [
        {
          id: "format_payload",
          review: { status: "pass", findings: [] },
        },
        {
          fileName: "execute_webhook.dart",
          review: {
            status: "warn",
            findings: [
              { severity: "warning", message: "Confirm endpoint authentication." },
            ],
          },
        },
      ],
    }),
  });

  assert.equal(presentation.status, "warning");
  assert.equal(presentation.score, 88);
  assert.equal(presentation.summary, "Safe to deploy after one FlutterFlow setup step.");
  assert.deepEqual(presentation.counts, { pass: 1, warning: 1, fail: 0 });
  assert.equal(presentation.manualSteps[0].title, "Confirm the http dependency");
  assert.equal(presentation.artifacts[1].pathHint, "actions/");
  assert.equal(presentation.artifacts[1].relationships.length, 1);
});

test("treats missing file review evidence as warning rather than pass", () => {
  const presentation = buildReviewPresentation({
    bundle,
    reviewResult: {
      status: "pass",
      summary: "Bundle compatibility passed.",
      artifacts: [],
    },
  });

  assert.equal(presentation.status, "warning");
  assert.equal(presentation.reviewCoverage.reviewed, 0);
  assert.equal(presentation.counts.warning, 2);
  assert.match(presentation.artifacts[0].statusReason, /No file-level verdict/);
});

test("unwraps a message content envelope and preserves explicit manual steps", () => {
  const presentation = buildReviewPresentation({
    bundle,
    reviewResult: {
      role: "assistant",
      content: JSON.stringify({
        overallSummary: "One blocking issue.",
        status: "fail",
        manualActions: [{ title: "Create the required App State variable." }],
        artifacts: [
          {
            id: "execute_webhook",
            review: {
              status: "fail",
              criticalIssues: ["Missing callback wiring."],
            },
          },
        ],
      }),
    },
  });

  assert.equal(presentation.status, "fail");
  assert.equal(presentation.manualSteps.length, 1);
  assert.equal(presentation.manualSteps[0].source, "Code Review");
  assert.equal(presentation.artifacts[1].findings[0].severity, "fail");
});

test("extracts a prominent score from legacy markdown reviews", () => {
  const presentation = buildReviewPresentation({
    bundle,
    reviewResult: "# Code Review\n\nScore: 74/100\n\nReview completed with warnings.",
  });

  assert.equal(presentation.score, 74);
});

test("treats out-of-range review scores as unknown rather than fabricated", () => {
  const presentation = buildReviewPresentation({
    bundle,
    reviewResult: {
      overallReview: { status: "warning", score: "Score: 999/100", summary: "Score out of range." },
      artifacts: [],
    },
  });

  assert.equal(presentation.score, null);
});

test("treats negative review scores as unknown rather than fabricated", () => {
  const presentation = buildReviewPresentation({
    bundle,
    reviewResult: {
      overallReview: { status: "warning", score: -5, summary: "Negative score." },
      artifacts: [],
    },
  });

  assert.equal(presentation.score, null);
});

test("leaves structured reviews without score fields unscored", () => {
  const presentation = buildReviewPresentation({
    bundle,
    reviewResult: {
      status: "warning",
      summary: "Review completed without a numeric score.",
      artifacts: [],
    },
  });

  assert.equal(presentation.score, null);
});

test("preserves top-level artifact reviews alongside bundleReview", () => {
  const presentation = buildReviewPresentation({
    bundle,
    reviewResult: {
      artifacts: [
        {
          id: "format-payload",
          review: {
            status: "pass",
            findings: [
              {
                severity: "info",
                message: "Formatting logic is valid.",
                suggestion: "No changes required.",
              },
            ],
          },
        },
        {
          id: "execute-webhook",
          review: {
            status: "pass",
            findings: [
              {
                severity: "info",
                message: "Webhook execution is valid.",
                suggestion: "No changes required.",
              },
            ],
          },
        },
      ],
      bundleReview: {
        status: "pass",
        summary: "The complete bundle is ready to deploy.",
        score: 96,
        findings: [
          {
            severity: "info",
            message: "The deploy order is correct.",
            suggestion: "Deploy the files in the supplied order.",
          },
        ],
      },
    },
  });

  assert.equal(presentation.status, "pass");
  assert.equal(presentation.score, 96);
  assert.equal(presentation.summary, "The complete bundle is ready to deploy.");
  assert.equal(presentation.findings[0].message, "The deploy order is correct.");
  assert.deepEqual(presentation.counts, { pass: 2, warning: 0, fail: 0 });
  assert.equal(presentation.reviewCoverage.reviewed, 2);
  assert.equal(presentation.artifacts[0].findings[0].severity, "pass");
});

test("falls back from malformed bundleReview to a valid overallReview", () => {
  for (const bundleReview of [{}, "not a review object"]) {
    const presentation = buildReviewPresentation({
      bundle,
      reviewResult: {
        bundleReview,
        overallReview: {
          status: "pass",
          score: 94,
          summary: "The valid overall review was preserved.",
          findings: [
            {
              severity: "info",
              message: "The bundle structure is valid.",
            },
          ],
        },
        artifacts: [],
      },
    });

    assert.equal(presentation.score, 94);
    assert.equal(presentation.summary, "The valid overall review was preserved.");
    assert.equal(presentation.findings[0].message, "The bundle structure is valid.");
  }
});

test("synthesizes an actionable summary and flags a missing score when none is returned", () => {
  const presentation = buildReviewPresentation({
    bundle,
    reviewResult: JSON.stringify({
      bundleReview: {
        status: "warn",
        manualActions: [{ title: "Add the http package to Project Dependencies" }],
        findings: [{ severity: "warning", message: "Confirm endpoint auth." }],
      },
      artifacts: [
        { id: "format_payload", review: { status: "pass", findings: [] } },
        { id: "execute_webhook", review: { status: "warn", findings: [] } },
      ],
    }),
  });

  assert.equal(presentation.score, null);
  assert.match(presentation.summary, /Overall verdict: warn/i);
  assert.match(presentation.summary, /1 pass, 1 warn, 0 fail/);
  assert.match(presentation.summary, /Add the http package/);
  assert.match(presentation.summary, /No numeric score/);
  assert.doesNotMatch(presentation.summary, /overarching written summary/);
});

test("passes through fixedSource from a review artifact", () => {
  const presentation = buildReviewPresentation({
    bundle,
    reviewResult: {
      artifacts: [
        {
          id: "format-payload",
          review: { status: "pass", findings: [] },
        },
        {
          id: "execute-webhook",
          review: {
            status: "warn",
            fixedSource: "Future<bool> executeWebhook() async => true;",
            findings: [
              {
                severity: "warning",
                message: "Color.withOpacity replaced with Color.withValues.",
              },
            ],
          },
        },
      ],
    },
  });

  assert.equal(presentation.artifacts[0].fixedSource, null);
  assert.equal(
    presentation.artifacts[1].fixedSource,
    "Future<bool> executeWebhook() async => true;",
  );
});

test("ignores empty or whitespace-only fixedSource", () => {
  const presentation = buildReviewPresentation({
    bundle,
    reviewResult: {
      artifacts: [
        {
          id: "format-payload",
          review: { status: "pass", fixedSource: "   ", findings: [] },
        },
      ],
    },
  });

  assert.equal(presentation.artifacts[0].fixedSource, null);
});

test("keeps a supplied score and written summary verbatim", () => {
  const presentation = buildReviewPresentation({
    bundle,
    reviewResult: JSON.stringify({
      bundleReview: {
        status: "pass",
        score: 96,
        summary: "Safe to deploy after adding the http dependency.",
      },
    }),
  });

  assert.equal(presentation.score, 96);
  assert.equal(presentation.summary, "Safe to deploy after adding the http dependency.");
});
