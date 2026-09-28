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

    // A block-form entry's own-keys say where the package comes from (see
    // readSourceDirective). `sdk:` is the Flutter SDK, which the runner
    // reproduces from the name alone as `name: {sdk: flutter}`. A `version:`
    // with no source key beside it is simply a constraint written on its own
    // line.
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
 *   overrides: Object<string, string>,
 *   sdkPackages: string[],
 *   availablePackages: Set<string>,
 *   unrepresentable: string[],
 * }}
 */
export function buildAnalysisManifest(projectPubspecYaml) {
  const sdkPackages = new Set();
  const dependencies = {};
  const overrides = {};

  const unrepresentable = collect(
    parseExistingDependencies(projectPubspecYaml),
    dependencies,
    sdkPackages,
  );
  unrepresentable.push(
    ...collect(
      parseDependencyBlock(projectPubspecYaml, "dependency_overrides"),
      overrides,
      sdkPackages,
    ),
  );

  const availablePackages = new Set([
    ...Object.keys(dependencies),
    ...sdkPackages,
  ]);

  const { sdk } = parseEnvironmentConstraints(projectPubspecYaml);

  return {
    sdkConstraint: unquoteConstraint(sdk) || FALLBACK_SDK_CONSTRAINT,
    dependencies,
    overrides,
    sdkPackages: [...sdkPackages].sort(),
    availablePackages,
    unrepresentable,
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
 * A dependency that cannot be reproduced outside the project - a `git:`,
 * `path:`, or private `hosted:` source - stops every class that resolves
 * packages, not only the ones that name it. The scratch manifest omits the
 * project's source, so `pub get` resolves a different graph, and the
 * difference is not confined to direct importers: the unreproducible package
 * can sit in the transitive closure of anything a class imports, and a
 * `dependency_overrides` entry applies to whatever resolves that name
 * anywhere in the graph. Without the resolved graph there is no way to prove
 * a class is unaffected, so it is left out of `sources` and named in
 * `skipped` rather than compiled against a resolution the project would not
 * produce. A class using only `dart:` resolves nothing through pub and is
 * still verified.
 *
 * @param {Array<{className: string, content: string}>} classes - Classes to deploy
 * @param {string} projectPubspecYaml - The project's merged pubspec.yaml
 * @returns {{manifest: Object, sources: Array<{fileName: string, content: string}>, skipped: Array<{className: string, reason: string}>}}
 */
export function planCustomCodeVerification(classes, projectPubspecYaml) {
  const {
    sdkConstraint,
    dependencies,
    overrides,
    sdkPackages,
    availablePackages,
    unrepresentable,
  } = buildAnalysisManifest(projectPubspecYaml);

  const manifest = { sdkConstraint, dependencies, overrides, sdkPackages };
  const sources = [];
  const skipped = [];

  for (const entry of classes) {
    const { className, content } = entry;

    const importedPackages = extractPackageImports(content);

    // Global, not scoped to this class's imports: the scratch manifest drops
    // the project's source for these packages, so the graph it resolves can
    // differ from the project's anywhere - including a package this class
    // only reaches transitively, or a name a `dependency_overrides` entry
    // redirects for every package that depends on it. Only pubspec.lock -
    // which a deploy never sees - records which packages those are, so any
    // class that resolves packages at all is reported rather than compiled.
    // A class using only `dart:` resolves nothing through pub and is
    // unaffected, so it is still verified.
    const resolvesPackages = extractImportUris(content).some((uri) =>
      uri.startsWith("package:"),
    );

    if (unrepresentable.length > 0 && resolvesPackages) {
      // When the class does name one of these packages itself, the reason
      // says so, because that is the actionable case.
      const unresolvablePackages = importedPackages.filter((name) =>
        unrepresentable.includes(name),
      );
      skipped.push({
        className,
        reason:
          unresolvablePackages.length > 0
            ? `${className} was not compiled before deploying: it imports or exports ${unresolvablePackages.join(", ")}, which your project declares from a source that cannot be reproduced outside it, so package resolution could not be matched exactly.`
            : `${className} was not compiled before deploying: your project declares ${unrepresentable.join(", ")} from a source that cannot be reproduced outside it, and such a source can alter package resolution anywhere in the dependency graph, so resolution could not be matched exactly.`,
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
