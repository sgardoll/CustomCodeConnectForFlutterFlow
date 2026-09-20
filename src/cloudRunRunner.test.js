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
    /'analyze',\s*'--no-pub'/,
    "the runner must run flutter analyze, not just the DSL's formattable check",
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

test("Cloud Run deployment reserves enough memory and serializes provisioning", () => {
  assert.match(deployScript, /MEMORY="\$\{MEMORY:-4Gi\}"/);
  assert.match(deployScript, /CONCURRENCY="\$\{CONCURRENCY:-1\}"/);
  assert.match(deployScript, /--memory "\$MEMORY"/);
  assert.match(deployScript, /--concurrency "\$CONCURRENCY"/);
});
