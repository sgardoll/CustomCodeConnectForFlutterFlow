import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync(
  new URL("../cloud-run/ffai-runner/Dockerfile", import.meta.url),
  "utf8",
);
const runnerSource = readFileSync(
  new URL("../cloud-run/ffai-runner/bin/server.dart", import.meta.url),
  "utf8",
);
const deployScript = readFileSync(
  new URL("../scripts/deploy_cloud_run_ffai.sh", import.meta.url),
  "utf8",
);

function versionParts(version) {
  return version.split(".").map(Number);
}

function compareVersions(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

test("Cloud Run pins a snapshot-compatible FlutterFlow CLI", () => {
  const version = dockerfile.match(
    /^ARG FLUTTERFLOW_CLI_VERSION=(\d+\.\d+\.\d+)$/m,
  )?.[1];

  assert.ok(version, "Dockerfile must explicitly pin FLUTTERFLOW_CLI_VERSION");
  assert.ok(
    compareVersions(version, "0.0.39") >= 0,
    `FlutterFlow CLI ${version} is older than the snapshot minimum 0.0.39`,
  );
  assert.match(
    dockerfile,
    /dart pub global list \| grep -F "flutterflow_cli \$FLUTTERFLOW_CLI_VERSION"/,
    "Docker build must verify the installed CLI version",
  );
});

test("Cloud Run upserts custom classes in one authoritative write", () => {
  assert.match(
    runnerSource,
    /if \(findCustomClass\(project, name: \$name\) == null\)[\s\S]*addCustomClass\([\s\S]*else \{[\s\S]*updateCustomClass\(/,
  );
});

test("Cloud Run gives every custom class a .dart file name FlutterFlow can import", () => {
  // FlutterFlow stores a Code File's identifier WITH the extension, but
  // addCustomClass writes it without one and codegen builds the path from it
  // verbatim - so an extensionless name emits a file no import can resolve.
  assert.match(
    runnerSource,
    /_ensureDartFileName\(project, \$name\);/,
    "the generated DSL must repair the Code File name after every upsert",
  );
  assert.match(
    runnerSource,
    /if \(current\.endsWith\('\.dart'\)\) return;/,
    "a name already ending in .dart must be left alone, so a re-deploy is a no-op",
  );
});

test("Cloud Run compiles generated custom code before pushing it", () => {
  assert.match(
    dockerfile,
    /git clone --depth 1 --branch "\$FLUTTER_CHANNEL"/,
    "analyzing code that imports package:flutter needs the Flutter SDK in the image",
  );
  assert.match(
    runnerSource,
    /'analyze',\s*'--no-fatal-warnings',\s*\.\.\.sourcePaths/,
    "the analyzer must run, scoped to the deployed classes, with warnings non-fatal",
  );
  assert.match(
    runnerSource,
    /\/custom_code/,
    "a class must be written where FlutterFlow files it, so its relative imports resolve",
  );
  assert.match(
    runnerSource,
    /for \(final context in verification\.context\)/,
    "the project's own Dart must be written so scaffolding imports resolve",
  );
  assert.match(
    runnerSource,
    /if \(analysis != null && analysis\.hasErrors\)[\s\S]*?HttpStatus\.unprocessableEntity/,
    "analyzer errors must stop the deploy before the project is written to",
  );
  assert.match(
    runnerSource,
    /_AnalysisOutcome\.skipped\(/,
    "a check that cannot run must report itself skipped rather than as errors",
  );
});

test("Cloud Run never reports an incomplete analyzer run as verified", () => {
  // `flutter analyze` exits non-zero both when it reports errors and when it
  // cannot run, so only a clean exit is a clean bill of health. Treating any
  // other non-zero exit as verified would let a deploy claim the code had been
  // compiled when nothing compiled it.
  assert.match(
    runnerSource,
    /if \(errors\.isEmpty && analyze\.exitCode != 0\)/,
    "a non-zero analyzer exit with nothing parsed must be treated as unverified",
  );
  assert.match(
    runnerSource,
    /Only a clean exit is treated as a clean bill of health/,
  );
});

test("Cloud Run builds the analysis manifest itself rather than running caller-supplied YAML", () => {
  // The runner writes this manifest and runs `pub get` against it on a public
  // route, so a caller-supplied document could name a git or path source and
  // redirect the fetch. Names and constraints only, validated, emitted here.
  assert.match(
    runnerSource,
    /String toPubspec\(\)/,
    "the manifest must be constructed server-side",
  );
  assert.doesNotMatch(
    runnerSource,
    /_stringField\(value, 'pubspec'/,
    "no raw pubspec text may be accepted from the caller",
  );
  assert.match(
    runnerSource,
    /_constraintPattern = RegExp/,
    "constraints must be restricted to a pub version range charset",
  );
  assert.match(
    runnerSource,
    /_packageNamePattern = RegExp/,
    "package names must match the whole string, so no YAML structure can hide in a key",
  );
  assert.match(
    runnerSource,
    /dependency_overrides:/,
    "the project's overrides must be reproduced, or resolution differs",
  );
  // The previous wire format sent pubspec text. It must degrade to
  // "unavailable" rather than being executed, so a cached client neither keeps
  // the vulnerability open nor has its deploys rejected mid-rollout.
  assert.match(
    runnerSource,
    /value\.containsKey\('pubspec'\) && !value\.containsKey\('dependencies'\)/,
    "a legacy manifest must be recognized and skipped, not executed",
  );
  assert.match(
    runnerSource,
    /_VerificationRequest\.unavailable\(/,
    "the legacy path must report itself unavailable",
  );
});

test("Cloud Run deployment reserves enough memory and serializes provisioning", () => {
  assert.match(deployScript, /MEMORY="\$\{MEMORY:-4Gi\}"/);
  assert.match(deployScript, /CONCURRENCY="\$\{CONCURRENCY:-1\}"/);
  assert.match(deployScript, /--memory "\$MEMORY"/);
  assert.match(deployScript, /--concurrency "\$CONCURRENCY"/);
});
