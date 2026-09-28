import assert from "node:assert/strict";
import test from "node:test";
import { planDependencyChanges } from "./dependencyResolution.js";
import { applyDependencyOverrides, mergeDependenciesIntoYaml } from "./pubspecSync.js";

const PROJECT_PUBSPEC = `name: my_ff_app
description: A FlutterFlow project.

environment:
  sdk: ">=3.5.0 <4.0.0"
  flutter: ">=3.24.0"

dependencies:
  flutter:
    sdk: flutter
  path_provider: ^2.1.2
  # pinned deliberately after a regression
  intl: 0.19.0
  video_player:
    git:
      url: https://example.com/video_player.git
`;

// name -> constraint, standing in for the pub.dev lookup.
function stubResolver(available) {
  return async (names) =>
    new Map(
      names.map((name) => [
        name,
        available[name]
          ? { constraint: available[name], version: available[name].slice(1), error: null }
          : { constraint: null, version: null, error: "not found on pub.dev" },
      ]),
    );
}

test("reads the project's SDK floors out of the environment block", async () => {
  const plan = await planDependencyChanges(PROJECT_PUBSPEC, {}, {});
  assert.deepEqual(plan.sdk, { dartSdkFloor: "3.5.0", flutterSdkFloor: "3.24.0" });
});

test("rule 3: adds a missing package at the newest SDK-compatible release", async () => {
  const plan = await planDependencyChanges(
    PROJECT_PUBSPEC,
    { record: "", permission_handler: "" },
    { resolveVersions: stubResolver({ record: "^6.2.1", permission_handler: "^11.3.1" }) },
  );

  assert.deepEqual(plan.additions, { record: "^6.2.1", permission_handler: "^11.3.1" });
  assert.deepEqual(plan.overrides, {});
  assert.deepEqual(plan.warnings, []);
});

test("rule 2: a {version: x} pin below the required floor is raised in place", async () => {
  // A version written as a flow member is still a hosted pin - it must not be
  // exempted from the compat check just because the entry is not scalar.
  const pubspec = `name: my_app
dependencies:
  flutter:
    sdk: flutter
  intl: {version: 0.19.0}
  block_pinned:
    version: 0.18.0
`;
  const plan = await planDependencyChanges(pubspec, {
    intl: "0.20.0",
    block_pinned: "0.20.0",
  });

  assert.deepEqual(plan.overrides, { intl: "^0.20.0", block_pinned: "^0.20.0" });

  const merged = applyDependencyOverrides(pubspec, plan.overrides);
  // The member is rewritten where it stands - the flow map keeps its braces
  // and the block entry keeps its `version:` child line.
  assert.match(merged.yaml, /intl: \{version: \^0\.20\.0\}/);
  assert.match(merged.yaml, /block_pinned:\n    version: \^0\.20\.0/);
});

test("rule 2: a quoted range in a version member is replaced whole, comment kept", async () => {
  // A quoted range holds spaces - replacing only up to the first space would
  // leave the old upper bound glued onto the new constraint.
  const pubspec = `name: my_app
dependencies:
  flutter:
    sdk: flutter
  intl: {version: '>=0.19.0 <0.20.0'}
  block_pinned:
    version: '>=0.18.0 <0.20.0'  # deliberate cap
`;
  const plan = await planDependencyChanges(pubspec, {
    intl: "0.20.0",
    block_pinned: "0.20.0",
  });

  assert.deepEqual(plan.overrides, { intl: "^0.20.0", block_pinned: "^0.20.0" });

  const merged = applyDependencyOverrides(pubspec, plan.overrides);
  assert.match(merged.yaml, /intl: \{version: \^0\.20\.0\}/);
  assert.match(merged.yaml, /block_pinned:\n    version: \^0\.20\.0  # deliberate cap/);
});

test("rule 2: a {version: x} pin satisfying the floor is kept", async () => {
  const pubspec = `name: my_app
dependencies:
  flutter:
    sdk: flutter
  intl: {version: ^0.19.0}
`;
  const plan = await planDependencyChanges(pubspec, { intl: "0.19.0" });

  assert.deepEqual(plan.overrides, {});
  assert.deepEqual(plan.kept, [{ name: "intl", constraint: "^0.19.0" }]);
});

test("rule 3: an SDK package missing from the pubspec is added as sdk: flutter", async () => {
  // flutter_web_plugins is not on pub.dev, so a hosted constraint names a
  // source pub cannot resolve. The SDK supplies it, so the merged pubspec
  // gets the same `sdk: flutter` entry the project would have declared.
  let queried = null;
  const plan = await planDependencyChanges(
    PROJECT_PUBSPEC,
    { flutter_web_plugins: "", record: "" },
    {
      resolveVersions: async (names) => {
        queried = names;
        return stubResolver({ record: "^6.2.1" })(names);
      },
    },
  );

  assert.deepEqual(plan.additions.flutter_web_plugins, { sdk: "flutter" });
  assert.deepEqual(plan.additions.record, "^6.2.1");
  assert.deepEqual(queried, ["record"]);
  assert.deepEqual(plan.warnings, []);

  const merged = mergeDependenciesIntoYaml(PROJECT_PUBSPEC, plan.additions);
  assert.match(merged.yaml, /  flutter_web_plugins:\n    sdk: flutter/);
  assert.deepEqual(merged.added.sort(), ["flutter_web_plugins", "record"]);
});

test("rule 3: passes the project's SDK floors to the registry lookup", async () => {
  let seen = null;
  await planDependencyChanges(
    PROJECT_PUBSPEC,
    { record: "" },
    {
      resolveVersions: async (names, sdk) => {
        seen = sdk;
        return new Map(names.map((name) => [name, { constraint: "^6.2.1", error: null }]));
      },
    },
  );
  assert.deepEqual(seen, { dartSdkFloor: "3.5.0", flutterSdkFloor: "3.24.0" });
});

test("rules 1 and 2: keeps the version the project already declares", async () => {
  const plan = await planDependencyChanges(
    PROJECT_PUBSPEC,
    { path_provider: "", intl: "" },
    { resolveVersions: stubResolver({}) },
  );

  assert.deepEqual(plan.additions, {});
  assert.deepEqual(plan.overrides, {});
  assert.deepEqual(plan.kept, [
    { name: "path_provider", constraint: "^2.1.2" },
    { name: "intl", constraint: "0.19.0" },
  ]);
});

test("rules 1 and 2: keeps a constraint that already reaches the required minimum", async () => {
  // ^2.1.2 resolves 2.1.5 on its own; rewriting it would be pointless churn.
  const plan = await planDependencyChanges(
    PROJECT_PUBSPEC,
    { path_provider: "2.1.5" },
    { resolveVersions: stubResolver({}) },
  );
  assert.deepEqual(plan.overrides, {});
  assert.deepEqual(plan.kept, [{ name: "path_provider", constraint: "^2.1.2" }]);
});

test("overrides only a constraint that provably cannot reach the requirement", async () => {
  const plan = await planDependencyChanges(
    PROJECT_PUBSPEC,
    { intl: "0.20.0" },
    { resolveVersions: stubResolver({}) },
  );

  assert.deepEqual(plan.overrides, { intl: "^0.20.0" });
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /pinned to 0\.19\.0/);
  assert.match(plan.warnings[0], /rest of your app/);
});

test("accepts a requirement written as a constraint, not just a bare version", async () => {
  const plan = await planDependencyChanges(
    PROJECT_PUBSPEC,
    { intl: "^0.20.0" },
    { resolveVersions: stubResolver({}) },
  );
  assert.deepEqual(plan.overrides, { intl: "^0.20.0" });
});

test("treats an unreadable requirement as no opinion, not as grounds to rewrite", async () => {
  const plan = await planDependencyChanges(
    PROJECT_PUBSPEC,
    { intl: "latest", path_provider: "any" },
    { resolveVersions: stubResolver({}) },
  );
  assert.deepEqual(plan.overrides, {});
  assert.deepEqual(plan.kept, [
    { name: "intl", constraint: "0.19.0" },
    { name: "path_provider", constraint: "^2.1.2" },
  ]);
});

test("never rewrites a git or path dependency into a version constraint", async () => {
  const plan = await planDependencyChanges(
    PROJECT_PUBSPEC,
    { video_player: "3.0.0" },
    { resolveVersions: stubResolver({}) },
  );

  assert.deepEqual(plan.overrides, {});
  assert.match(plan.warnings[0], /git, path, or SDK source/);
});

test("never emits empty version — uses the AI's version when pub.dev fails", async () => {
  const plan = await planDependencyChanges(
    PROJECT_PUBSPEC,
    { mystery_package: "1.5.0" },
    { resolveVersions: stubResolver({}) },
  );

  // Falls back to ^<requested_version> when pub.dev lookup fails.
  assert.deepEqual(plan.additions, { mystery_package: "^1.5.0" });
  assert.match(plan.warnings[0], /Could not confirm/);
});

test("falls back to >=0.0.0 when pub.dev fails and AI provided no version", async () => {
  const plan = await planDependencyChanges(
    PROJECT_PUBSPEC,
    { mystery_package: "" },
    { resolveVersions: stubResolver({}) },
  );

  assert.deepEqual(plan.additions, { mystery_package: ">=0.0.0" });
  assert.match(plan.warnings[0], /pin a concrete version/);
  assert.doesNotMatch(plan.warnings[0], /\^1\.0\.0/);
});

test("ignores the flutter SDK entry", async () => {
  const plan = await planDependencyChanges(
    PROJECT_PUBSPEC,
    { flutter: "3.24.0" },
    { resolveVersions: stubResolver({}) },
  );
  assert.deepEqual(plan.additions, {});
  assert.deepEqual(plan.overrides, {});
});

test("produces a pubspec carrying real versions end to end", async () => {
  const plan = await planDependencyChanges(
    PROJECT_PUBSPEC,
    { record: "", path_provider: "", intl: "0.20.0" },
    { resolveVersions: stubResolver({ record: "^6.2.1" }) },
  );

  const overridden = applyDependencyOverrides(PROJECT_PUBSPEC, plan.overrides);
  const merged = mergeDependenciesIntoYaml(overridden.yaml, plan.additions);

  assert.match(merged.yaml, /^ {2}record: \^6\.2\.1$/m);
  // The user's own path_provider line is untouched.
  assert.match(merged.yaml, /^ {2}path_provider: \^2\.1\.2$/m);
  // An override keeps the comment explaining the original pin.
  assert.match(merged.yaml, /^ {2}intl: \^0\.20\.0$/m);
  assert.match(merged.yaml, /# pinned deliberately after a regression/);
  assert.doesNotMatch(merged.yaml, /\^1\.0\.0/);
});
