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

// Packages the Flutter SDK supplies, declared as `sdk: flutter` rather than
// with a pub version. This mirrors the allowlist the deploy runner enforces,
// so anything named here can be reproduced in the scratch package.
const SDK_DEPENDENCIES = new Set([
  "flutter",
  "flutter_test",
  "flutter_driver",
  "flutter_localizations",
  "integration_test",
]);

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
    if (SDK_DEPENDENCIES.has(name) && !info.isScalar) {
      sdkPackages.add(name);
      continue;
    }
    if (!info.isScalar) {
      // `git:`, `path:`, a nested `hosted:` block - none can be reproduced
      // outside the project, and none can be expressed in the manifest.
      unrepresentable.push(name);
      continue;
    }
    into[name] = unquoteConstraint(info.constraint);
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
 * When the project declares a dependency that cannot be reproduced outside it
 * (a `git:` or `path:` source), nothing is verified: the scratch package would
 * resolve packages differently from the project, and a check against different
 * versions is worse than no check, because it reports a result that does not
 * describe the code that actually ships.
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

    if (unrepresentable.length > 0) {
      skipped.push({
        className,
        reason: `${className} was not compiled before deploying: your project declares ${unrepresentable.join(", ")} from a source that cannot be reproduced outside the project, so package resolution could not be matched exactly.`,
      });
      continue;
    }

    const { unresolvableImports } = classifyCustomClassImports(content);
    const missingPackages = extractPackageImports(content).filter(
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
