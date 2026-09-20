import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnalysisPubspec,
  classifyCustomClassImports,
  planCustomCodeVerification,
} from "./customCodeVerification.js";

const PROJECT_PUBSPEC = `name: my_app
description: A FlutterFlow project.

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  background_downloader: ^8.5.0
  intl: 0.20.2
  private_thing:
    git:
      url: https://example.invalid/private.git
`;

const SELF_CONTAINED = `import 'package:flutter/foundation.dart';
import 'package:background_downloader/background_downloader.dart';

class BackgroundDownloaderService {}
`;

test("treats dart: and package: imports as resolvable without FlutterFlow", () => {
  assert.deepEqual(classifyCustomClassImports(SELF_CONTAINED), {
    selfContained: true,
    unresolvableImports: [],
  });
});

test("flags imports that only exist inside a generated FlutterFlow app", () => {
  const code = `import 'package:flutter/material.dart';
import '/backend/schema/structs/index.dart';
import '../flutter_flow/lat_lng.dart';

class ModelBundle {}
`;

  assert.deepEqual(classifyCustomClassImports(code), {
    selfContained: false,
    unresolvableImports: [
      "/backend/schema/structs/index.dart",
      "../flutter_flow/lat_lng.dart",
    ],
  });
});

test("an import that appears only in a comment does not make code unverifiable", () => {
  const code = `import 'package:flutter/material.dart';
// import '/backend/schema/structs/index.dart';

class Plain {}
`;

  assert.equal(classifyCustomClassImports(code).selfContained, true);
});

test("analysis pubspec carries the project's own package versions", () => {
  const { yaml, availablePackages } = buildAnalysisPubspec(PROJECT_PUBSPEC);

  assert.match(yaml, /^name: ccc_custom_code_analysis$/m);
  assert.match(yaml, /^ {2}sdk: '>=3\.0\.0 <4\.0\.0'$/m);
  assert.match(yaml, /^ {2}flutter:\n {4}sdk: flutter$/m);
  assert.match(yaml, /^ {2}background_downloader: \^8\.5\.0$/m);
  assert.match(yaml, /^ {2}intl: 0\.20\.2$/m);
  assert.ok(availablePackages.has("background_downloader"));
});

test("a dependency declared in block form is left out rather than guessed at", () => {
  const { yaml, availablePackages } = buildAnalysisPubspec(PROJECT_PUBSPEC);

  assert.doesNotMatch(yaml, /private_thing/);
  assert.equal(availablePackages.has("private_thing"), false);
});

test("plans a real compile for a class whose imports all resolve", () => {
  const plan = planCustomCodeVerification(
    [{ className: "BackgroundDownloaderService", content: SELF_CONTAINED }],
    PROJECT_PUBSPEC,
  );

  assert.deepEqual(plan.sources, [
    {
      fileName: "background_downloader_service.dart",
      content: SELF_CONTAINED,
    },
  ]);
  assert.deepEqual(plan.skipped, []);
});

test("names the file the way FlutterFlow would, an underscore before every capital", () => {
  const plan = planCustomCodeVerification(
    [{ className: "QAService", content: "class QAService {}" }],
    PROJECT_PUBSPEC,
  );

  assert.equal(plan.sources[0].fileName, "q_a_service.dart");
});

test("reports a scaffolding-dependent class as unverified instead of compiling it", () => {
  const content = `import '/backend/schema/structs/index.dart';

class ModelBundle {}
`;
  const plan = planCustomCodeVerification(
    [{ className: "ModelBundle", content }],
    PROJECT_PUBSPEC,
  );

  assert.deepEqual(plan.sources, []);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /ModelBundle/);
  assert.match(plan.skipped[0].reason, /backend\/schema\/structs\/index\.dart/);
});

test("reports a class needing a package the project pins in block form", () => {
  const content = `import 'package:private_thing/private_thing.dart';

class UsesPrivate {}
`;
  const plan = planCustomCodeVerification(
    [{ className: "UsesPrivate", content }],
    PROJECT_PUBSPEC,
  );

  assert.deepEqual(plan.sources, []);
  assert.match(plan.skipped[0].reason, /private_thing/);
});

test("compiles the verifiable classes even when a sibling cannot be verified", () => {
  const plan = planCustomCodeVerification(
    [
      { className: "BackgroundDownloaderService", content: SELF_CONTAINED },
      {
        className: "ModelBundle",
        content:
          "import '/backend/schema/structs/index.dart';\nclass ModelBundle {}",
      },
    ],
    PROJECT_PUBSPEC,
  );

  assert.deepEqual(
    plan.sources.map((source) => source.fileName),
    ["background_downloader_service.dart"],
  );
  assert.equal(plan.skipped.length, 1);
});
