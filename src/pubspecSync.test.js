import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeDependenciesIntoYaml,
  parseDependencyBlock,
  parseExistingDependencies,
  parseExistingDependencyNames,
  validateProjectPubspec,
} from "./pubspecSync.js";

const PROJECT_PUBSPEC = `name: my_ff_app
description: A FlutterFlow project.
publish_to: "none"
version: 1.0.0+1

environment:
  sdk: ">=3.5.0 <4.0.0"

dependencies:
  flutter:
    sdk: flutter
  cloud_firestore: 4.17.5
  # pinned deliberately after a regression
  intl: 0.19.0
  provider: ^6.1.2

dev_dependencies:
  flutter_test:
    sdk: flutter

flutter:
  uses-material-design: true
  assets:
    - assets/images/

dependency_overrides: {}
`;

test("reads the declared dependency names, ignoring nested keys", () => {
  assert.deepEqual(parseExistingDependencyNames(PROJECT_PUBSPEC), [
    "flutter",
    "cloud_firestore",
    "intl",
    "provider",
  ]);
});

test("adds only missing packages and preserves the rest of the file", () => {
  const result = mergeDependenciesIntoYaml(PROJECT_PUBSPEC, {
    http: "^1.2.0",
    intl: "^0.20.0",
    flutter: "sdk",
  });

  assert.deepEqual(result.added, ["http"]);
  assert.deepEqual(result.alreadyPresent, ["intl"]);

  // Every pre-existing package survives the merge.
  assert.deepEqual(parseExistingDependencyNames(result.yaml), [
    "flutter",
    "cloud_firestore",
    "intl",
    "provider",
    "http",
  ]);

  // The user's pinned constraint is untouched, and unrelated sections survive.
  assert.match(result.yaml, /^ {2}intl: 0\.19\.0$/m);
  assert.match(result.yaml, /# pinned deliberately after a regression/);
  assert.match(result.yaml, /^ {2}http: \^1\.2\.0$/m);
  assert.match(result.yaml, /^dev_dependencies:$/m);
  assert.match(result.yaml, /- assets\/images\/$/m);
  assert.match(result.yaml, /^dependency_overrides: \{\}$/m);
});

test("inserts new packages inside the dependencies block, not after it", () => {
  const result = mergeDependenciesIntoYaml(PROJECT_PUBSPEC, { http: "^1.2.0" });
  const lines = result.yaml.split("\n");
  const httpIndex = lines.findIndex((line) => line.startsWith("  http:"));
  const devDepsIndex = lines.findIndex((line) => line === "dev_dependencies:");

  assert.ok(httpIndex > -1 && devDepsIndex > -1);
  assert.ok(httpIndex < devDepsIndex);
});

test("returns the file untouched when nothing new is required", () => {
  assert.equal(mergeDependenciesIntoYaml(PROJECT_PUBSPEC, {}).yaml, PROJECT_PUBSPEC);
  assert.equal(
    mergeDependenciesIntoYaml(PROJECT_PUBSPEC, { provider: "^6.0.0" }).yaml,
    PROJECT_PUBSPEC,
  );
});

test("never writes 'any' — writes >=0.0.0 when version is missing", () => {
  const result = mergeDependenciesIntoYaml(PROJECT_PUBSPEC, { http: "" });
  assert.match(result.yaml, /^ {2}http: >=0\.0\.0$/m);
});

test("appends a dependencies block when the file has none", () => {
  const result = mergeDependenciesIntoYaml("name: bare_app\n", { http: "^1.2.0" });
  assert.deepEqual(result.added, ["http"]);
  assert.match(result.yaml, /^dependencies:$/m);
  assert.match(result.yaml, /^ {2}http: \^1\.2\.0$/m);
});

test("respects a four-space indented dependencies block", () => {
  const fourSpace = `name: app
dependencies:
    flutter:
        sdk: flutter
    intl: 0.19.0
`;
  const result = mergeDependenciesIntoYaml(fourSpace, { http: "^1.2.0" });
  assert.deepEqual(parseExistingDependencyNames(result.yaml), ["flutter", "intl", "http"]);
  assert.match(result.yaml, /^ {4}http: \^1\.2\.0$/m);
});

test("accepts a dependencies header carrying a trailing comment", () => {
  const commented = `name: app
dependencies: # Project packages
  flutter:
    sdk: flutter
  intl: 0.19.0
`;
  assert.equal(validateProjectPubspec(commented).valid, true);
  assert.deepEqual(parseExistingDependencyNames(commented), ["flutter", "intl"]);

  const result = mergeDependenciesIntoYaml(commented, { http: "^1.2.0" });
  assert.deepEqual(result.added, ["http"]);
  assert.match(result.yaml, /^dependencies: # Project packages$/m);
  assert.match(result.yaml, /^ {2}http: \^1\.2\.0$/m);
});

test("treats a quoted dependency key as already declared", () => {
  const quoted = `name: app
dependencies:
  flutter:
    sdk: flutter
  "http": ^1.2.0
  'intl': 0.19.0
`;
  assert.deepEqual(parseExistingDependencyNames(quoted), ["flutter", "http", "intl"]);

  // Re-requesting them must not append a second, conflicting declaration.
  const result = mergeDependenciesIntoYaml(quoted, { http: "^1.3.0", intl: "^0.20.0" });
  assert.deepEqual(result.added, []);
  assert.equal(result.yaml, quoted);
});

test("quotes constraints that YAML would otherwise misparse", () => {
  const base = `name: app
dependencies:
  flutter:
    sdk: flutter
`;
  // `>` opens a folded block scalar, so a bare range constraint is a parse error.
  assert.match(
    mergeDependenciesIntoYaml(base, { foo: ">=1.0.0 <2.0.0" }).yaml,
    /^ {2}foo: '>=1\.0\.0 <2\.0\.0'$/m,
  );
  assert.match(mergeDependenciesIntoYaml(base, { foo: "*" }).yaml, /^ {2}foo: '\*'$/m);

  // Ordinary caret and exact constraints stay idiomatic and unquoted.
  assert.match(mergeDependenciesIntoYaml(base, { foo: "^1.2.0" }).yaml, /^ {2}foo: \^1\.2\.0$/m);
  assert.match(mergeDependenciesIntoYaml(base, { foo: "1.2.0+1" }).yaml, /^ {2}foo: 1\.2\.0\+1$/m);
  assert.match(mergeDependenciesIntoYaml(base, { foo: "" }).yaml, /^ {2}foo: >=0\.0\.0$/m);
});

test("accepts a real project pubspec and rejects a synthesized stub", () => {
  assert.equal(validateProjectPubspec(PROJECT_PUBSPEC).valid, true);

  const stub = validateProjectPubspec("name: stub\ndependencies:\n  http: ^1.2.0\n");
  assert.equal(stub.valid, false);
  assert.deepEqual(stub.errors, ["pubspec.yaml missing Flutter SDK dependency"]);

  assert.equal(validateProjectPubspec("").valid, false);
});

test("reads where a block-form dependency comes from", () => {
  const declared = parseExistingDependencies(PROJECT_PUBSPEC);

  // The first own-key is what says whether a package can be reproduced outside
  // the project, so it is read rather than inferred from the package's name.
  assert.equal(declared.get("flutter").sourceKey, "sdk");
  assert.equal(declared.get("flutter").sourceValue, "flutter");
  assert.equal(declared.get("cloud_firestore").sourceKey, null);
  assert.equal(declared.get("cloud_firestore").isScalar, true);
});

test("does not read a following sibling dependency's key as the previous entry's source", () => {
  const pubspec = `dependencies:
  flutter:
    sdk: flutter
  alpha:
  beta: ^2.0.0
`;
  const declared = parseExistingDependencies(pubspec);

  // `alpha` is block form with no mapping under it. Scanning past the entry
  // would reach `beta` and attribute its constraint to `alpha`.
  assert.equal(declared.get("alpha").isScalar, false);
  assert.equal(declared.get("alpha").sourceKey, null);
  assert.equal(declared.get("beta").constraint, "^2.0.0");
});

test("a nested version block is read as a constraint, not as a source", () => {
  const pubspec = `dependencies:
  intl:
    version: ^0.20.3
`;
  const declared = parseExistingDependencies(pubspec);

  assert.equal(declared.get("intl").sourceKey, "version");
  assert.equal(declared.get("intl").sourceValue, "^0.20.3");
});

test("a hosted source is read even when version: is written before it", () => {
  // YAML mapping order is not significant, so this is the same dependency as
  // hosted-then-version. Reading only the first own-key would classify it as a
  // plain constraint and the verification manifest would resolve it from
  // pub.dev instead of the project's own host.
  const pubspec = `dependencies:
  hosted_thing:
    version: ^1.0.0
    hosted:
      name: hosted_thing
      url: https://example.invalid
  plain_thing:
    version: ^2.0.0
`;
  const declared = parseExistingDependencies(pubspec);

  assert.equal(declared.get("hosted_thing").sourceKey, "hosted");
  assert.equal(declared.get("plain_thing").sourceKey, "version");
  assert.equal(declared.get("plain_thing").sourceValue, "^2.0.0");
});

test("a git source keeps only its first key, whatever the nested shape", () => {
  const pubspec = `dependencies:
  private_thing:
    git:
      url: https://example.invalid/private.git
      ref: main
  hosted_thing:
    hosted:
      name: hosted_thing
      url: https://example.invalid
    version: ^1.0.0
`;
  const declared = parseExistingDependencies(pubspec);

  assert.equal(declared.get("private_thing").sourceKey, "git");
  assert.equal(declared.get("hosted_thing").sourceKey, "hosted");
});

test("reads a source from dependency_overrides too", () => {
  const overrides = parseDependencyBlock(
    `dependency_overrides:
  flutter_web_plugins:
    sdk: flutter
`,
    "dependency_overrides",
  );

  assert.equal(overrides.get("flutter_web_plugins").sourceKey, "sdk");
});
