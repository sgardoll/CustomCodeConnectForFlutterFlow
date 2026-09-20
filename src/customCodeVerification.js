import {
  extractImportUris,
  extractPackageImports,
} from "./dartPackageImports.js";
import {
  formatConstraint,
  parseEnvironmentConstraints,
  parseExistingDependencies,
} from "./pubspecSync.js";
import { identifierToFlutterFlowFileStem } from "./flutterFlowArtifactValidation.js";

// Throwaway package name for the scratch package the deploy runner compiles
// the generated classes in. Never reaches FlutterFlow.
const ANALYSIS_PACKAGE_NAME = "ccc_custom_code_analysis";

// The Dart SDK range to analyse against when the project's pubspec.yaml does
// not declare one. FlutterFlow always writes an `environment:` block, so this
// only guards a malformed manifest.
const FALLBACK_SDK_CONSTRAINT = ">=3.0.0 <4.0.0";

// Packages the Flutter SDK supplies. They are declared as `sdk: flutter`
// rather than with a pub version, so they never need a version lookup.
const SDK_DEPENDENCIES = new Set([
  "flutter",
  "flutter_test",
  "flutter_localizations",
]);

// Constraints are read back out of the project's pubspec.yaml exactly as
// written, quotes included - `sdk: '>=3.0.0 <4.0.0'` yields `'>=3.0.0 <4.0.0'`.
// Re-quoting that would emit `'''>=3.0.0 <4.0.0'''`, which is not the same
// constraint, so the quoting is undone before formatConstraint reapplies it.
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

/**
 * Builds the pubspec.yaml for the scratch package the classes are compiled in.
 *
 * Every scalar dependency the project declares is carried over at the
 * project's own constraint, so the analyzer sees the same package versions the
 * built app will. A dependency declared in block form (`sdk:`, `git:`,
 * `path:`) cannot be reproduced outside the project, so it is left out and the
 * classes that import it are reported as unverifiable rather than analysed
 * against a version that is not the project's.
 *
 * @param {string} projectPubspecYaml - The project's merged pubspec.yaml
 * @returns {{yaml: string, availablePackages: Set<string>}}
 */
export function buildAnalysisPubspec(projectPubspecYaml) {
  const declared = parseExistingDependencies(projectPubspecYaml);
  const { sdk } = parseEnvironmentConstraints(projectPubspecYaml);
  const availablePackages = new Set(SDK_DEPENDENCIES);

  const lines = [
    `name: ${ANALYSIS_PACKAGE_NAME}`,
    "description: Throwaway package used to compile generated custom code.",
    "publish_to: none",
    "version: 0.0.1",
    "",
    "environment:",
    `  sdk: ${formatConstraint(unquoteConstraint(sdk) || FALLBACK_SDK_CONSTRAINT)}`,
    "",
    "dependencies:",
    "  flutter:",
    "    sdk: flutter",
  ];

  for (const [name, info] of declared) {
    if (SDK_DEPENDENCIES.has(name) || !info.isScalar) continue;
    lines.push(`  ${name}: ${formatConstraint(unquoteConstraint(info.constraint))}`);
    availablePackages.add(name);
  }

  return { yaml: `${lines.join("\n")}\n`, availablePackages };
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
 * @param {Array<{className: string, content: string}>} classes - Classes to deploy
 * @param {string} projectPubspecYaml - The project's merged pubspec.yaml
 * @returns {{pubspec: string, sources: Array<{fileName: string, content: string}>, skipped: Array<{className: string, reason: string}>}}
 */
export function planCustomCodeVerification(classes, projectPubspecYaml) {
  const { yaml, availablePackages } = buildAnalysisPubspec(projectPubspecYaml);
  const sources = [];
  const skipped = [];

  for (const entry of classes) {
    const { className, content } = entry;
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

  return { pubspec: yaml, sources, skipped };
}
