import {
  extractImportUris,
  extractPackageImports,
} from "./dartPackageImports.js";
import {
  parseDependencyBlock,
  parseEnvironmentConstraints,
  parseExistingDependencies,
} from "./pubspecSync.js";
import { identifierToFlutterFlowFileStem } from "./flutterFlowArtifactValidation.js";

// The Dart SDK range to analyse against when the project's pubspec.yaml does
// not declare one. FlutterFlow always writes an `environment:` block, so this
// only guards a malformed manifest.
const FALLBACK_SDK_CONSTRAINT = ">=3.0.0 <4.0.0";

// Which packages the Flutter SDK supplies is read from the project's own
// pubspec, never from a list kept here. A block-form entry whose first own-key
// is `sdk:` is an SDK package by definition, so the classification cannot fall
// behind the SDK: when Flutter ships a new package, a project declaring it
// classifies correctly with no change to this file.
//
// The list this replaced could not do that. It omitted `flutter_web_plugins`,
// which turned every project declaring it - every project with web support and
// a plugin - into one whose dependencies could not be reproduced, and refused
// the whole deploy for a package most of its classes never imported.

// Why the verification manifest is sent as structured data rather than as
// pubspec.yaml text: the deploy runner writes the manifest to disk and runs
// `flutter pub get` against it, on a publicly reachable route. A caller-supplied
// YAML document can name a git or path source and make the runner fetch from an
// attacker-chosen host. Sending names and version constraints instead means the
// runner can build the document itself and emit nothing but `name: constraint`
// lines, so no source directive can be expressed at all.

// Constraints are read back out of the project's pubspec.yaml exactly as
// written, quotes included - `sdk: '>=3.0.0 <4.0.0'` yields `'>=3.0.0 <4.0.0'`.
// The runner re-quotes whatever it is given, so the quoting is undone here to
// avoid emitting `'''>=3.0.0 <4.0.0'''`.
function unquoteConstraint(constraint) {
  const text = String(constraint || "").trim();
  const quote = text[0];
  if ((quote !== "'" && quote !== '"') || text[text.length - 1] !== quote) {
    return text;
  }
  return text.slice(1, -1).replaceAll(`${quote}${quote}`, quote);
}

/**
 * Splits a class's imports into the ones a standalone package can resolve and
 * the ones only FlutterFlow's generated app provides.
 *
 * `dart:` and `package:` URIs resolve from a pubspec alone. Anything else -
 * `/backend/schema/structs/index.dart`, `../flutter_flow/lat_lng.dart` - names
 * a file FlutterFlow writes when it generates the app, which does not exist
 * until after the deploy. Such a class cannot be compiled ahead of the push.
 *
 * @param {string} code - Dart source
 * @returns {{selfContained: boolean, unresolvableImports: string[]}}
 */
export function classifyCustomClassImports(code = "") {
  const unresolvableImports = extractImportUris(code).filter(
    (uri) => !uri.startsWith("dart:") && !uri.startsWith("package:"),
  );
  return {
    selfContained: unresolvableImports.length === 0,
    unresolvableImports,
  };
}

function collect(declared, into, sdkPackages) {
  const unrepresentable = [];
  for (const [name, info] of declared) {
    if (info.isScalar) {
      into[name] = unquoteConstraint(info.constraint);
      continue;
    }

    // A block-form entry's first own-key says where the package comes from.
    // `sdk:` is the Flutter SDK, which the runner reproduces from the name
    // alone as `name: {sdk: flutter}`. A nested `version:` is simply a
    // constraint written on its own line.
    if (info.sourceKey === "sdk") {
      sdkPackages.add(name);
      continue;
    }
    if (info.sourceKey === "version") {
      into[name] = unquoteConstraint(info.sourceValue);
      continue;
    }

    // `git:`, `path:`, a nested `hosted:` block - none can be reproduced
    // outside the project, and none can be expressed in a manifest that
    // carries names and constraints only.
    unrepresentable.push(name);
  }
  return unrepresentable;
}

/**
 * Builds the dependency manifest the deploy runner compiles against.
 *
 * Carries the project's own version constraints, its `dependency_overrides`,
 * and its Dart SDK constraint, so the scratch package resolves the same
 * versions the built app will. Dropping overrides in particular would let the
 * scratch `pub get` resolve a different version than the real project, which
 * makes the gate approve code the project rejects - or reject code it accepts.
 *
 * @param {string} projectPubspecYaml - The project's merged pubspec.yaml
 * @returns {{
 *   sdkConstraint: string,
 *   dependencies: Object<string, string>,
 *   dependencyOverrides: Object<string, string>,
 *   sdkPackages: string[],
 *   sdkOverrides: string[],
 *   availablePackages: Set<string>,
 *   unrepresentable: string[],
 *   unrepresentableOverrides: string[],
 * }}
 */
export function buildAnalysisManifest(projectPubspecYaml) {
  const sdkPackages = new Set();
  const sdkOverrides = new Set();
  const dependencies = {};
  const dependencyOverrides = {};

  // The two blocks are kept apart: a direct dependency only reaches a class
  // that names it, but a dependency_overrides entry rewrites resolution for
  // every package in the graph that depends on the overridden name, so the
  // consequences of dropping one are much wider than dropping the other. SDK
  // entries are kept apart too: the runner emits sdkPackages under
  // `dependencies:` and sdkOverrides under `dependency_overrides:`, and an
  // `sdk:` override sharing a name with a scalar dependency must land in the
  // second list or the generated pubspec declares the name twice.
  const unrepresentableDependencies = collect(
    parseExistingDependencies(projectPubspecYaml),
    dependencies,
    sdkPackages,
  );
  const unrepresentableOverrides = collect(
    parseDependencyBlock(projectPubspecYaml, "dependency_overrides"),
    dependencyOverrides,
    sdkOverrides,
  );
  const unrepresentable = [
    ...unrepresentableDependencies,
    ...unrepresentableOverrides,
  ];

  const availablePackages = new Set([
    ...Object.keys(dependencies),
    ...sdkPackages,
  ]);

  const { sdk } = parseEnvironmentConstraints(projectPubspecYaml);

  return {
    sdkConstraint: unquoteConstraint(sdk) || FALLBACK_SDK_CONSTRAINT,
    dependencies,
    dependencyOverrides,
    sdkPackages: [...sdkPackages].sort(),
    sdkOverrides: [...sdkOverrides].sort(),
    availablePackages,
    unrepresentable,
    unrepresentableOverrides,
  };
}

function skipReason(className, unresolvableImports, missingPackages) {
  if (unresolvableImports.length > 0) {
    return `${className} imports ${unresolvableImports.join(", ")}, which FlutterFlow only generates once the app is built, so it could not be compiled before the deploy.`;
  }
  return `${className} imports ${missingPackages.join(", ")}, which your project's pubspec.yaml does not declare with a version constraint, so it could not be compiled before the deploy.`;
}

/**
 * Plans the compile check that runs before custom classes are pushed.
 *
 * Classes whose imports all resolve from a pubspec are compiled for real by
 * the deploy runner, so a call to an API that does not exist - a named
 * argument a package never declared, say - is caught before it reaches
 * FlutterFlow. Classes that depend on the generated app are reported in
 * `skipped` so the deploy can say plainly what it did not verify.
 *
 * A dependency that cannot be reproduced outside the project - a `git:` or
 * `path:` source - still shapes the resolved graph even for classes that
 * never import it, because its own pubspec's version constraints apply to
 * every package it shares with them. A `dependency_overrides` entry is
 * broader still: it rewrites resolution for every package depending on the
 * overridden name, imported or not. Which packages an omitted entry would
 * have constrained is only recorded in the project's pubspec.lock, which a
 * deploy never sees, so no per-class rule can separate the reachable from
 * the unreachable. An unreproducible entry therefore skips every class that
 * imports a `package:` URI at all; a class using only `dart:` resolves
 * nothing through pub and is still verified, and a class importing the entry
 * by name gets a reason that says so.
 *
 * That breadth is the point of the change, not a retreat to the old
 * project-wide skip: the misread that motivated it was classification, not
 * scope. An SDK package no name list had heard of (`flutter_web_plugins`)
 * used to read as unreproducible and leave every class uncompiled; now the
 * source is read from the pubspec, so a genuinely unreproducible entry is
 * rare - and when one exists, skipping is what keeps a clean analysis from
 * approving code the project cannot build.
 *
 * @param {Array<{className: string, content: string}>} classes - Classes to deploy
 * @param {string} projectPubspecYaml - The project's merged pubspec.yaml
 * @returns {{manifest: Object, sources: Array<{fileName: string, content: string}>, skipped: Array<{className: string, reason: string}>}}
 */
export function planCustomCodeVerification(classes, projectPubspecYaml) {
  const {
    sdkConstraint,
    dependencies,
    dependencyOverrides,
    sdkPackages,
    sdkOverrides,
    availablePackages,
    unrepresentable,
    unrepresentableOverrides,
  } = buildAnalysisManifest(projectPubspecYaml);

  const manifest = {
    sdkConstraint,
    dependencies,
    dependencyOverrides,
    sdkPackages,
    sdkOverrides,
  };
  const sources = [];
  const skipped = [];

  for (const entry of classes) {
    const { className, content } = entry;

    // SDK names must reach the unrepresentable check: a project can declare
    // `flutter` or `flutter_localizations` from git or hosted, and a name
    // filtered out here would slip past that check and reach the analyzer as
    // a missing-URI error, refusing the deploy instead of reporting the class
    // unverified.
    const importedPackages = extractPackageImports(content);

    // Scoped to this class's own imports. A dependency the project declares
    // from a source the manifest cannot express is only a problem for a class
    // that actually imports it.
    const unresolvablePackages = importedPackages.filter((name) =>
      unrepresentable.includes(name),
    );

    if (unresolvablePackages.length > 0) {
      skipped.push({
        className,
        reason: `${className} was not compiled before deploying: it imports ${unresolvablePackages.join(", ")}, which your project declares from a source that cannot be reproduced outside it, so package resolution could not be matched exactly.`,
      });
      continue;
    }

    // An entry the manifest cannot express poisons the whole resolution
    // graph, not just classes that name it. A git/path/hosted dependency's
    // own pubspec still constrains every package it shares with the ones a
    // class imports, and a dependency_overrides entry rewrites resolution for
    // every dependent - so dropping either can make the scratch package
    // resolve different versions than the project, and a clean analysis then
    // approves code the project cannot build. Which packages drift is only
    // recorded in pubspec.lock, which a deploy never sees, so any class that
    // resolves packages at all is reported instead of compiled. `dart:`-only
    // classes need no package resolution and are unaffected.
    if (
      unrepresentable.length > 0 &&
      extractImportUris(content).some((uri) => uri.startsWith("package:"))
    ) {
      const depNames = unrepresentable.filter(
        (name) => !unrepresentableOverrides.includes(name),
      );
      const described = [
        depNames.length > 0
          ? `your project's pubspec.yaml declares ${depNames.join(", ")} from a source that cannot be reproduced outside it`
          : null,
        unrepresentableOverrides.length > 0
          ? `your project's dependency_overrides redirects ${unrepresentableOverrides.join(", ")} to a source that cannot be reproduced outside it`
          : null,
      ]
        .filter(Boolean)
        .join(", and ");
      skipped.push({
        className,
        reason: `${className} was not compiled before deploying: ${described}, and an entry like that can change what every package depending on it resolves to - including packages this class reaches transitively - so package resolution could not be matched exactly.`,
      });
      continue;
    }

    const { unresolvableImports } = classifyCustomClassImports(content);
    const missingPackages = importedPackages.filter(
      (name) => !availablePackages.has(name),
    );

    if (unresolvableImports.length > 0 || missingPackages.length > 0) {
      skipped.push({
        className,
        reason: skipReason(className, unresolvableImports, missingPackages),
      });
      continue;
    }

    sources.push({
      fileName: `${identifierToFlutterFlowFileStem(className)}.dart`,
      content,
    });
  }

  return { manifest, sources, skipped };
}
