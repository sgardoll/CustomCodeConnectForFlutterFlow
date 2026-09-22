import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnalysisManifest,
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
  flutter_localizations:
    sdk: flutter
  background_downloader: ^8.5.0
  intl: 0.20.2
  private_thing:
    git:
      url: https://example.invalid/private.git

dependency_overrides:
  intl: 0.20.1
`;

const REPRESENTABLE_PUBSPEC = `name: my_app

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  background_downloader: ^8.5.0
  intl: 0.20.2
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

test("the manifest carries the project's own constraints and SDK range", () => {
  const manifest = buildAnalysisManifest(PROJECT_PUBSPEC);

  assert.equal(manifest.sdkConstraint, ">=3.0.0 <4.0.0");
  assert.equal(manifest.dependencies.background_downloader, "^8.5.0");
  assert.equal(manifest.dependencies.intl, "0.20.2");
  assert.ok(manifest.availablePackages.has("background_downloader"));
});

test("the manifest carries dependency_overrides, which change resolved APIs", () => {
  const manifest = buildAnalysisManifest(PROJECT_PUBSPEC);

  assert.deepEqual(manifest.overrides, { intl: "0.20.1" });
});

test("the manifest is structured data, never pubspec.yaml text", () => {
  const manifest = buildAnalysisManifest(PROJECT_PUBSPEC);

  // The runner builds the document, so a caller cannot express a git or path
  // source and point `pub get` at a host of its choosing.
  assert.equal("pubspec" in manifest, false);
  assert.equal(typeof manifest.dependencies, "object");
});

test("an SDK package declared in block form is reproduced, not called unrepresentable", () => {
  const manifest = buildAnalysisManifest(PROJECT_PUBSPEC);

  assert.deepEqual(manifest.sdkPackages, ["flutter", "flutter_localizations"]);
  assert.equal(
    manifest.unrepresentable.includes("flutter_localizations"),
    false,
  );
});

test("a dependency from a git or path source is reported unrepresentable", () => {
  const manifest = buildAnalysisManifest(PROJECT_PUBSPEC);

  assert.deepEqual(manifest.unrepresentable, ["private_thing"]);
});

test("a hosted source stays unrepresentable when version is written first", () => {
  const pubspec = `name: my_app

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  hosted_thing:
    version: ^1.0.0
    hosted:
      name: hosted_thing
      url: https://example.invalid
`;

  const manifest = buildAnalysisManifest(pubspec);

  // YAML mappings are order-independent: reading only the first nested key
  // classified this entry as a plain pub.dev dependency with constraint
  // "^1.0.0", so the scratch manifest would resolve hosted_thing from pub.dev
  // while the project ships it from its own host.
  assert.deepEqual(manifest.unrepresentable, ["hosted_thing"]);
  assert.equal("hosted_thing" in manifest.dependencies, false);
});

test("a package import is skipped beside an unrelated git dependency, and the reason names the dependency", () => {
  const plan = planCustomCodeVerification(
    [{ className: "BackgroundDownloaderService", content: SELF_CONTAINED }],
    PROJECT_PUBSPEC,
  );

  // The project declares `private_thing` from git, which the scratch manifest
  // cannot express, so the graph cannot be matched exactly. This class never
  // imports `private_thing` directly, but it imports `package:` at all, and
  // what it imports may reach `private_thing` transitively - so it is skipped
  // and the reason names the dependency that broke the match.
  assert.deepEqual(plan.sources, []);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].className, "BackgroundDownloaderService");
  assert.match(plan.skipped[0].reason, /private_thing/);
  assert.match(plan.skipped[0].reason, /could not be matched exactly/);
});

test("a class that imports the unreproducible dependency is skipped, and named as the reason", () => {
  const importsPrivateThing = `import 'package:private_thing/private_thing.dart';

class UsesPrivateThing {}
`;

  const plan = planCustomCodeVerification(
    [
      { className: "UsesPrivateThing", content: importsPrivateThing },
      { className: "BackgroundDownloaderService", content: SELF_CONTAINED },
    ],
    PROJECT_PUBSPEC,
  );

  // The direct import keeps its own reason: it names this class's own
  // import, so it says what to do about this class.
  assert.deepEqual(plan.sources, []);
  assert.equal(plan.skipped.length, 2);
  assert.equal(plan.skipped[0].className, "UsesPrivateThing");
  assert.match(plan.skipped[0].reason, /it imports private_thing/);
  // The sibling never imports the git package, but it imports `package:` at
  // all, so it is skipped too - its reason names the unreproducible package.
  assert.match(plan.skipped[1].reason, /private_thing/);
});

test("a package import is skipped when an override elsewhere is unrepresentable, and the reason names it", () => {
  const pubspec = `name: my_app

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  background_downloader: ^8.5.0

dependency_overrides:
  intl:
    git:
      url: https://example.invalid/intl-fork.git
`;

  const plan = planCustomCodeVerification(
    [{ className: "BackgroundDownloaderService", content: SELF_CONTAINED }],
    pubspec,
  );

  // The class imports `background_downloader`, which the manifest can
  // express, and never touches `intl` - but the git override of `intl`
  // cannot be carried, and whether `background_downloader` depends on
  // `intl` transitively is knowable only by resolving the graph. The graph
  // cannot be matched exactly, so the class is skipped and the reason
  // names `intl`.
  assert.deepEqual(plan.sources, []);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /intl/);
});

test("a class compiled from dart: alone still verifies beside a git dependency", () => {
  const plan = planCustomCodeVerification(
    [
      {
        className: "PureDartService",
        content: "import 'dart:convert';\nclass PureDartService {}",
      },
    ],
    PROJECT_PUBSPEC,
  );

  // `dart:` libraries come from the SDK rather than pub resolution, so a
  // class importing nothing from `package:` compiles against exactly what
  // the project will, whatever the project's sources are - it is still
  // checked even while package-importing siblings are skipped.
  assert.deepEqual(
    plan.sources.map((source) => source.fileName),
    ["pure_dart_service.dart"],
  );
  assert.deepEqual(plan.skipped, []);
});

test("a project whose sources are all representable verifies with nothing to disclose", () => {
  const plan = planCustomCodeVerification(
    [{ className: "BackgroundDownloaderService", content: SELF_CONTAINED }],
    REPRESENTABLE_PUBSPEC,
  );

  // Every dependency the project declares can be expressed in the scratch
  // manifest, so the check runs against the project's own graph and nothing
  // is skipped.
  assert.equal(plan.sources.length, 1);
  assert.deepEqual(plan.skipped, []);
});

test("an SDK package no list has heard of is reproduced from its pubspec source", () => {
  // The regression: flutter_web_plugins is a genuine Flutter SDK package that
  // the hand-kept list omitted, so every project declaring it - which is every
  // web-enabled project with a plugin - read as unreproducible and the deploy
  // was refused for a package most of its classes never imported.
  const pubspec = `name: my_app

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  flutter_web_plugins:
    sdk: flutter
  background_downloader: ^8.5.0
`;

  const manifest = buildAnalysisManifest(pubspec);

  assert.equal(manifest.sdkPackages.includes("flutter_web_plugins"), true);
  assert.deepEqual(manifest.unrepresentable, []);

  const plan = planCustomCodeVerification(
    [{ className: "BackgroundDownloaderService", content: SELF_CONTAINED }],
    pubspec,
  );
  assert.equal(plan.sources.length, 1);
  assert.deepEqual(plan.skipped, []);
});

test("a class importing a package the project declares as an SDK package is not missing it", () => {
  const pubspec = `name: my_app

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  flutter_web_plugins:
    sdk: flutter
`;
  const usesWebPlugins = `import 'package:flutter_web_plugins/flutter_web_plugins.dart';

class RegistersPlugin {}
`;

  const plan = planCustomCodeVerification(
    [{ className: "RegistersPlugin", content: usesWebPlugins }],
    pubspec,
  );

  assert.equal(plan.sources.length, 1);
  assert.deepEqual(plan.skipped, []);
});

test("a block-form entry written as a bare version is read as a constraint", () => {
  const pubspec = `name: my_app

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  intl:
    version: ^0.20.3
`;

  const manifest = buildAnalysisManifest(pubspec);

  assert.equal(manifest.dependencies.intl, "^0.20.3");
  assert.deepEqual(manifest.unrepresentable, []);
  assert.deepEqual(manifest.sdkPackages, ["flutter"]);
});

test("plans a real compile for a class whose imports all resolve", () => {
  const plan = planCustomCodeVerification(
    [{ className: "BackgroundDownloaderService", content: SELF_CONTAINED }],
    REPRESENTABLE_PUBSPEC,
  );

  assert.deepEqual(plan.sources, [
    {
      fileName: "background_downloader_service.dart",
      content: SELF_CONTAINED,
    },
  ]);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.manifest.overrides, {});
});

test("names the file the way FlutterFlow would, an underscore before every capital", () => {
  const plan = planCustomCodeVerification(
    [{ className: "QAService", content: "class QAService {}" }],
    "dependencies:\n  flutter:\n    sdk: flutter\n",
  );

  assert.equal(plan.sources[0].fileName, "q_a_service.dart");
});

test("reports a scaffolding-dependent class as unverified instead of compiling it", () => {
  const plan = planCustomCodeVerification(
    [
      {
        className: "ModelBundle",
        content:
          "import '/backend/schema/structs/index.dart';\nclass ModelBundle {}",
      },
    ],
    "dependencies:\n  flutter:\n    sdk: flutter\n",
  );

  assert.deepEqual(plan.sources, []);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /backend\/schema\/structs\/index\.dart/);
});

test("reports a class needing a package the project does not declare", () => {
  const plan = planCustomCodeVerification(
    [
      {
        className: "UsesMissing",
        content: "import 'package:nope/nope.dart';\nclass UsesMissing {}",
      },
    ],
    "dependencies:\n  flutter:\n    sdk: flutter\n",
  );

  assert.deepEqual(plan.sources, []);
  assert.match(plan.skipped[0].reason, /nope/);
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
    REPRESENTABLE_PUBSPEC,
  );

  assert.deepEqual(
    plan.sources.map((source) => source.fileName),
    ["background_downloader_service.dart"],
  );
  assert.equal(plan.skipped.length, 1);
});
