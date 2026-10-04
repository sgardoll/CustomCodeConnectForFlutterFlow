import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync(
  new URL("../cloud-run/ffai-runner/Dockerfile", import.meta.url),
  "utf8",
);
// Request validation lives in lib/request_validation.dart (server.dart imports
// it), so the contract assertions must read both the entrypoint and the module.
const runnerSource = [
  "../cloud-run/ffai-runner/bin/server.dart",
  "../cloud-run/ffai-runner/lib/request_validation.dart",
]
  .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
  .join("\n");
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
  assert.match(
    runnerSource,
    /value\['sdkOverrides'\]/,
    "sdk-sourced overrides must ride their own channel - merged into sdkPackages they land under dependencies: and duplicate a same-named scalar key",
  );
  assert.match(
    runnerSource,
    /for \(final name in sdkOverrides[\s\S]*?sdk: flutter/,
    "an sdk: override must be emitted under dependency_overrides, preserving override precedence",
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
    /VerificationRequest\.unavailable\(/,
    "the legacy path must report itself unavailable",
  );
});

test("Cloud Run deployment reserves enough memory and serializes provisioning", () => {
  assert.match(deployScript, /MEMORY="\$\{MEMORY:-4Gi\}"/);
  assert.match(deployScript, /CONCURRENCY="\$\{CONCURRENCY:-1\}"/);
  assert.match(deployScript, /--memory "\$MEMORY"/);
  assert.match(deployScript, /--concurrency "\$CONCURRENCY"/);
});

// The image is only exercised at deploy time and nothing builds it in CI, so a
// missing COPY is invisible until a real deploy fails. It already happened once:
// request validation moved to lib/, the Dockerfile still copied only bin/, and
// the container could not start at all.
test("the image copies every directory the entrypoint imports", () => {
  const copied = new Set(
    [...dockerfile.matchAll(/^COPY\s+(\S+)\s/gm)].map((match) =>
      match[1].replace(/\/$/, ""),
    ),
  );
  // `package:ccc_ffai_runner/x.dart` resolves inside the package's lib/, so a
  // module imported this way only exists in the container if lib/ is copied in.
  const imported = [
    ...runnerSource.matchAll(/package:ccc_ffai_runner\/([A-Za-z0-9_/]+\.dart)/g),
  ].map((match) => match[1]);

  assert.ok(
    imported.length > 0,
    "server.dart must import from package:ccc_ffai_runner/ (otherwise this guard is vacuous)",
  );
  for (const modulePath of imported) {
    assert.ok(
      existsSync(
        new URL(`../cloud-run/ffai-runner/lib/${modulePath}`, import.meta.url),
      ),
      `package:ccc_ffai_runner/${modulePath} must resolve to a file under lib/`,
    );
  }
  for (const directory of ["bin", "lib"]) {
    assert.ok(
      copied.has(directory),
      `the Dockerfile must COPY ${directory}/ — the entrypoint imports it, and without it the image cannot start`,
    );
  }
});

// The runner reports minFlutterflowCli at its health route so a version drift is
// visible. If the two ever disagree, it reports a minimum the image does not
// actually satisfy, which is worse than not reporting one at all.
test("the health route reports the same required CLI version the image pins", () => {
  const pinned = dockerfile.match(
    /^ARG FLUTTERFLOW_CLI_VERSION=(\d+\.\d+\.\d+)$/m,
  )?.[1];
  const reported = runnerSource.match(/const minCliVersion = '([^']+)'/)?.[1];

  assert.ok(pinned, "Dockerfile must pin FLUTTERFLOW_CLI_VERSION");
  assert.ok(
    reported,
    "server.dart must declare the minimum CLI version it reports",
  );
  assert.equal(
    reported,
    pinned,
    "minCliVersion must match the pinned FLUTTERFLOW_CLI_VERSION",
  );
});

// A merged runner fix that never shipped is the failure this guards: the health route
// has to be able to answer which revision is live, so the deploy must actually
// pass the SHA through.
test("the deploy passes the built revision to the runner for /healthz", () => {
  assert.match(
    deployScript,
    /RUNNER_GIT_SHA="\$\{RUNNER_GIT_SHA:-\$\(git rev-parse/,
    "the deploy script must derive RUNNER_GIT_SHA from its checkout",
  );
  assert.match(
    deployScript,
    /--set-env-vars "[^"]*RUNNER_GIT_SHA=\$RUNNER_GIT_SHA/,
    "RUNNER_GIT_SHA must reach the service, or the health route reports an empty SHA",
  );
});

// Cloud Run's front end answers /healthz itself, so the request never reaches
// the container. That shipped once: the endpoint was dead in production
// however well it worked locally. The path is therefore checked, not assumed.
test("the health route is not a path Cloud Run reserves", () => {
  const path = runnerSource.match(/const healthPath = '([^']+)'/)?.[1];

  assert.ok(path, "the runner must declare the health route it serves");
  assert.notEqual(
    path,
    "/healthz",
    "Cloud Run's front end answers /healthz, so the container never sees it",
  );
  assert.match(
    runnerSource,
    /request\.uri\.path == healthPath/,
    "the route must be matched through the shared constant, not a literal",
  );
});
