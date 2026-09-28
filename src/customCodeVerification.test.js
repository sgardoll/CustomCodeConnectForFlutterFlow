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

  assert.deepEqual(manifest.dependencyOverrides, { intl: "0.20.1" });
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

test("a git dependency does not stop a class that never imports it", () => {
  const plan = planCustomCodeVerification(
    [{ className: "BackgroundDownloaderService", content: SELF_CONTAINED }],
    PROJECT_PUBSPEC,
  );

  // The project declares `private_thing` from git, which cannot be reproduced
  // outside it - but this class does not import it, so the scratch package
  // resolves everything it does use to the versions the project will, and the
  // check still describes the code that ships. Deciding this once for the whole
  // project left every class uncompiled over a dependency it never touched.
  assert.deepEqual(plan.sources, [
    {
      fileName: "background_downloader_service.dart",
      content: SELF_CONTAINED,
    },
  ]);
  assert.deepEqual(plan.skipped, []);
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

  assert.deepEqual(
    plan.sources.map((entry) => entry.fileName),
    ["background_downloader_service.dart"],
  );
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].className, "UsesPrivateThing");
  // The reason names this class's own import, not the project's whole
  // dependency set, so it says what to do about this class.
  assert.match(plan.skipped[0].reason, /it imports private_thing/);
});

test("a class that exports the unreproducible dependency is skipped, not refused", () => {
  // `export` pulls the package in exactly as `import` does. If exports were
  // not read, the class would be compiled against a manifest missing the
  // package and the analyzer would refuse the deploy over a URI it could not
  // resolve, instead of the class being reported as unverified.
  const exportsPrivateThing = `export 'package:private_thing/private_thing.dart';

class ReExportsPrivateThing {}
`;

  const plan = planCustomCodeVerification(
    [{ className: "ReExportsPrivateThing", content: exportsPrivateThing }],
    PROJECT_PUBSPEC,
  );

  assert.deepEqual(plan.sources, []);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /it imports private_thing/);
});

test("an unreproducible dependency_overrides entry skips every package-importing class", () => {
  // core_types is overridden from git, so it resolves differently in the
  // project than in the scratch manifest for every package that depends on it.
  // Whether this class reaches it transitively through widget_api is only
  // recorded in pubspec.lock, which a deploy never sees - so the class cannot
  // be verified against the code the project ships.
  const pubspec = `name: my_app

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  widget_api: ^1.0.0

dependency_overrides:
  core_types:
    git: https://example.invalid/core.git
`;
  const importsWidgetApi = `import 'package:widget_api/widget_api.dart';

class UsesWidgetApi {}
`;

  const plan = planCustomCodeVerification(
    [{ className: "UsesWidgetApi", content: importsWidgetApi }],
    pubspec,
  );

  assert.deepEqual(plan.sources, []);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /dependency_overrides/);
  assert.match(plan.skipped[0].reason, /core_types/);
});

test("an unreproducible override skips even a class importing only SDK packages", () => {
  // flutter's own transitive dependencies (collection, meta, ...) resolve
  // through pub and can be redirected by an override, so an SDK-only import is
  // still not guaranteed to compile against the project's code.
  const pubspec = `name: my_app

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter

dependency_overrides:
  collection:
    git: https://example.invalid/collection.git
`;
  const flutterOnly = `import 'package:flutter/material.dart';

class UsesMaterial {}
`;

  const plan = planCustomCodeVerification(
    [{ className: "UsesMaterial", content: flutterOnly }],
    pubspec,
  );

  assert.deepEqual(plan.sources, []);
  assert.equal(plan.skipped.length, 1);
});

test("a dart:-only class still verifies under an unreproducible override", () => {
  // dart: URIs come from the SDK itself, which no dependency_overrides entry
  // can re-source, so nothing the class resolves can be redirected.
  const pubspec = `name: my_app

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter

dependency_overrides:
  core_types:
    git: https://example.invalid/core.git
`;
  const dartOnly = `import 'dart:async';

class SchedulesWork {}
`;

  const plan = planCustomCodeVerification(
    [{ className: "SchedulesWork", content: dartOnly }],
    pubspec,
  );

  assert.equal(plan.sources.length, 1);
  assert.deepEqual(plan.skipped, []);
});

test("a version-constraint override is carried and does not skip anything", () => {
  // PROJECT_PUBSPEC overrides intl to 0.20.1 - a constraint the manifest can
  // express - so resolution already matches the project's and every
  // self-contained class verifies.
  const plan = planCustomCodeVerification(
    [{ className: "BackgroundDownloaderService", content: SELF_CONTAINED }],
    PROJECT_PUBSPEC,
  );

  assert.equal(plan.sources.length, 1);
  assert.deepEqual(plan.skipped, []);
});

test("an sdk: override keeps its own channel instead of duplicating a scalar dependency", () => {
  // A project that declares `flutter_web_plugins: any` and then overrides it
  // to `{sdk: flutter}` must not emit the name under `dependencies:` twice -
  // the generated pubspec would carry a duplicate key and `pub get` would
  // fail, skipping the check over a manifest bug, not the project's code.
  const pubspec = `name: my_app

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  flutter_web_plugins: any

dependency_overrides:
  flutter_web_plugins:
    sdk: flutter
`;

  const manifest = buildAnalysisManifest(pubspec);

  assert.equal(manifest.dependencies.flutter_web_plugins, "any");
  assert.deepEqual(manifest.sdkPackages, ["flutter"]);
  assert.deepEqual(manifest.sdkOverrides, ["flutter_web_plugins"]);
  assert.deepEqual(manifest.dependencyOverrides, {});
  assert.deepEqual(manifest.unrepresentable, []);

  // The name is still importable: the override only changes where it resolves
  // from, not whether a class may name it.
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

test("a conditional import of the unreproducible dependency is skipped, not refused", () => {
  // `if (...)` names a second URI the code needs when the condition holds; a
  // scan that reads only the first URI would send the class to the runner
  // without private_thing in its manifest, and the analyzer's missing-URI
  // diagnostic would refuse the deploy instead of reporting it unverified.
  const conditional = `import 'package:background_downloader/background_downloader.dart' if (dart.library.io) 'package:private_thing/private_thing.dart';

class ConditionallyPrivate {}
`;

  const plan = planCustomCodeVerification(
    [{ className: "ConditionallyPrivate", content: conditional }],
    PROJECT_PUBSPEC,
  );

  assert.deepEqual(plan.sources, []);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /private_thing/);
});

test("an SDK dependency declared inline reproduces instead of breaking the manifest", () => {
  // `flutter_web_plugins: {sdk: flutter}` is the same declaration as the
  // block form; treated as a scalar it would be forwarded as a constraint
  // whose braces the runner rejects, refusing the whole deploy.
  const pubspec = `name: my_app

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  flutter_web_plugins: {sdk: flutter}
  background_downloader: ^8.5.0
`;

  const manifest = buildAnalysisManifest(pubspec);
  assert.ok(manifest.sdkPackages.includes("flutter_web_plugins"));
  assert.deepEqual(manifest.unrepresentable, []);
  assert.equal("flutter_web_plugins" in manifest.dependencies, false);

  const plan = planCustomCodeVerification(
    [{ className: "BackgroundDownloaderService", content: SELF_CONTAINED }],
    pubspec,
  );
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
  assert.deepEqual(plan.manifest.dependencyOverrides, {});
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
