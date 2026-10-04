#!/usr/bin/env node

// Scheduled canary for the FlutterFlow custom-class runner.
//
// Every scheduled run POSTs a *dry-run* deploy to the runner so a regression
// that would break users' deploys is caught the next morning instead of on
// their next deploy. dryRun: true makes the runner go through `ai validate`
// (workspace init, compile gate, DSL validation) but never write to the
// project, so this is safe to run unattended.
//
// It also curls the runner's /healthz when present and reports its versions,
// but never fails on a missing /healthz - another change is adding it in
// parallel and it may not be deployed yet.

const RUNNER_DEFAULT_URL = "https://ccc-ffai-runner-y5cyj3473a-uw.a.run.app";

// The throwaway class and dependencies the canary sends. These are real enough
// to compile: the runner builds a scratch package from the verification
// manifest and fails the deploy if `flutter analyze` reports an error, so a
// canary class that does not compile would fail every run for the wrong reason.
const CANARY_CLASS_NAME = "CanaryProbe";
const CANARY_SOURCE = `import 'package:flutter/widgets.dart';

class ${CANARY_CLASS_NAME} extends StatelessWidget {
  const ${CANARY_CLASS_NAME}({super.key});

  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}`;

function fail(message) {
  console.error(`[canary] FAIL: ${message}`);
  process.exitCode = 1;
}

async function main() {
  const apiKey = process.env.CANARY_FF_API_KEY;
  if (!apiKey) {
    fail(
      "CANARY_FF_API_KEY is not set. Create the repository secret " +
        "CANARY_FF_API_KEY with a FlutterFlow API key (see DEPLOYMENT.md) " +
        "and give this job access to it.",
    );
    return;
  }

  const baseUrl = (process.env.CANARY_RUNNER_URL || RUNNER_DEFAULT_URL).replace(
    /\/+$/,
    "",
  );
  const projectId = process.env.CANARY_PROJECT_ID || "automated-test-miedro";
  const timeoutMs = Number(process.env.CANARY_TIMEOUT_MS || 60000);

  const payload = {
    apiKey,
    projectId,
    commitMessage: "canary dry-run",
    dryRun: true,
    customClasses: [
      { className: CANARY_CLASS_NAME, content: CANARY_SOURCE },
    ],
    verification: {
      sdkConstraint: ">=3.0.0 <4.0.0",
      dependencies: {},
      dependencyOverrides: {},
      sdkPackages: ["flutter_web_plugins"],
      // The runner hard-requires this array: without it _normalizeVerification
      // throws and returns HTTP 400 before anything runs. It is also what the
      // compile gate compiles - an empty sources list skips _verifyCustomCode
      // entirely, so this canary would detect nothing.
      sources: [{ fileName: "canary_probe.dart", content: CANARY_SOURCE }],
    },
  };

  // The SDK-package rejection this canary is meant to catch. The runner
  // currently rejects an invalid SDK name as "Invalid SDK package name: X";
  // an older/newer wording may say "unsupported". Match both so a regression
  // where flutter_web_plugins stops being accepted fails the canary.
  const sdkPackageRejection = /unsupported sdk package|invalid sdk package name/i;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(`${baseUrl}/deployCustomClasses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      fail(
        `request to ${baseUrl}/deployCustomClasses failed: ` +
          `${error?.name === "AbortError" ? "timed out" : error.message}`,
      );
      return;
    }

    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text.slice(0, 500) };
    }

    if (!response.ok) {
      fail(
        `runner returned HTTP ${response.status} on a dry-run deploy for ` +
          `project "${projectId}". ${formatBodyError(body)}`,
      );
      return;
    }

    if (body.success === false) {
      fail(
        `runner reported success:false on a dry-run deploy for project ` +
          `"${projectId}". ${formatBodyError(body)}`,
      );
      return;
    }

    const joined = [
      body.error,
      body.details,
      body.analyzerErrors,
      ...(Array.isArray(body.analyzerErrors) ? body.analyzerErrors : []),
    ]
      .filter(Boolean)
      .join("\n");
    if (sdkPackageRejection.test(joined)) {
      fail(
        `runner rejected the flutter_web_plugins SDK package on a dry-run ` +
          `deploy - a dependency regression users would hit: ${joined}`,
      );
      return;
    }

    console.log(
      `[canary] OK: dry-run deploy for project "${projectId}" accepted at ${baseUrl} ` +
        `(success:${body.success === undefined ? "true" : body.success})`,
    );
  } finally {
    clearTimeout(timer);
  }

  // The /healthz route is being added alongside this canary; do not fail the
  // canary when it is not deployed yet.
  try {
    const health = await fetch(`${baseUrl}/healthz`, {
      signal: AbortSignal.timeout(10000),
    });
    if (health.ok) {
      const healthBody = await health.json().catch(() => ({}));
      console.log(
        `[canary] healthz: HTTP ${health.status}` +
          (healthBody.versions
            ? ` versions=${JSON.stringify(healthBody.versions)}`
            : ` ${JSON.stringify(healthBody)}`),
      );
    } else {
      console.log(
        `[canary] healthz: HTTP ${health.status} (not reported as a failure)`,
      );
    }
  } catch {
    console.log("[canary] healthz: unavailable (not reported as a failure)");
  }
}

function formatBodyError(body) {
  const detail = [
    body.error,
    body.details,
    ...(Array.isArray(body.analyzerErrors) ? body.analyzerErrors : []),
  ]
    .filter(Boolean)
    .join(" | ")
    .slice(0, 1000);
  return detail ? `Details: ${detail}` : "No detail in the response body.";
}

await main();
