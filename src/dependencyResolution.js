// Decides the version constraint to write for every package generated code
// needs, given what the project's pubspec.yaml already declares.
//
// Three rules, in order:
//
//   1/2. The package is already declared — by FlutterFlow's own base pubspec
//        or by the user's custom dependencies. Keep their constraint. An
//        exported pubspec draws no line between the two, and either way the
//        project's own choice outranks a generated one.
//        The single exception: the generated code declares a minimum the
//        existing constraint provably cannot resolve. Then the constraint is
//        rewritten, because the alternative is code that cannot compile.
//
//   3.   The package is absent. Add the newest release that the project's
//        declared Dart/Flutter SDK floor can build, read live from pub.dev.
//
// The rule this replaces wrote `^1.0.0` for every package, which pinned new
// dependencies to their first major release.

import {
  parseEnvironmentConstraints,
  parseExistingDependencies,
} from "./pubspecSync.js";
import { constraintCanReach, constraintLowerBound } from "./pubVersions.js";
import { resolveLatestCompatibleVersions } from "./pubRegistry.js";
import { FLUTTER_SDK_PACKAGES } from "./dartPackageImports.js";

/**
 * @typedef {Object} DependencyPlan
 * @property {Object<string, string|{sdk: string}>} additions - name ->
 *   constraint to add, or `{sdk}` for a package the Flutter SDK supplies
 * @property {Object<string, string>} overrides - name -> constraint to rewrite
 * @property {Array<{name: string, constraint: string}>} kept - left as declared
 * @property {string[]} warnings - what the deploying user needs to know
 * @property {{dartSdkFloor: string|null, flutterSdkFloor: string|null}} sdk
 */

/**
 * Works out what each requested package's constraint should be.
 *
 * @param {string} yamlContent - The project's current pubspec.yaml
 * @param {Object<string, string>} requestedDependencies - name -> the minimum
 *   version the generated code genuinely requires, or "" when it has no
 *   opinion and simply needs the package present
 * @param {Object} options
 * @param {Function} options.resolveVersions - Injectable registry lookup
 * @returns {Promise<DependencyPlan>}
 */
export async function planDependencyChanges(
  yamlContent,
  requestedDependencies = {},
  options = {},
) {
  const { resolveVersions = resolveLatestCompatibleVersions } = options;

  const requested = Object.entries(requestedDependencies).filter(
    // The Flutter SDK entry is always present and is never a pub package.
    ([name]) => name && name !== "flutter",
  );

  const environment = parseEnvironmentConstraints(yamlContent);
  const sdk = {
    dartSdkFloor: constraintLowerBound(environment.sdk),
    flutterSdkFloor: constraintLowerBound(environment.flutter),
  };

  const plan = {
    additions: {},
    overrides: {},
    kept: [],
    warnings: [],
    sdk,
  };
  if (requested.length === 0) return plan;

  const declared = parseExistingDependencies(yamlContent);
  const missing = [];
  const missingSdk = [];

  for (const [name, requiredMinimum] of requested) {
    const existing = declared.get(name);
    if (!existing) {
      // An SDK-supplied name absent from the project's pubspec is still
      // SDK-sourced - pub.dev does not carry it, so a hosted constraint would
      // name a source pub cannot resolve. The merged pubspec gets the same
      // `sdk: flutter` entry the project would have declared itself.
      (FLUTTER_SDK_PACKAGES.has(name) ? missingSdk : missing).push(name);
      continue;
    }

    // Rules 1 and 2: the project's own constraint stands.
    //
    // The requirement may arrive as a bare version or as a constraint
    // (`^5.1.2`); either way only its floor matters. Anything unreadable is
    // treated as "no opinion" rather than as grounds to rewrite a working pin.
    const minimum = constraintLowerBound(requiredMinimum);
    if (!minimum) {
      plan.kept.push({ name, constraint: existing.constraint });
      continue;
    }

    // A `version:` own-key - `intl: {version: 0.19.0}` or the same key on a
    // block form's child line - is a hosted pin written in mapping shape, so
    // it has no scalar constraint but still bounds what the project resolves
    // and must be compared like one. Other block sources (git, path, SDK,
    // hosted-without-version) carry no comparable version.
    const effectiveConstraint = existing.isScalar
      ? existing.constraint
      : existing.sourceKey === "version"
        ? existing.sourceValue
        : null;

    // Checked before the constraint itself: a block-form entry has no scalar
    // constraint, and an empty one would read as `any` and look satisfiable.
    if (effectiveConstraint === null) {
      plan.warnings.push(
        `"${name}" is declared in your project from a git, path, or SDK source, but the generated code needs at least ${minimum}. ` +
          "Left as-is — update it yourself if the build fails.",
      );
      plan.kept.push({ name, constraint: existing.constraint });
      continue;
    }

    if (constraintCanReach(effectiveConstraint, minimum)) {
      plan.kept.push({ name, constraint: effectiveConstraint });
      continue;
    }

    plan.overrides[name] = `^${minimum}`;
    plan.warnings.push(
      `"${name}" was pinned to ${effectiveConstraint} in your project, which cannot resolve the ${minimum} the generated code needs. ` +
        `Raising it to ^${minimum} — this changes a dependency the rest of your app also uses.`,
    );
  }

  for (const name of missingSdk) {
    plan.additions[name] = { sdk: "flutter" };
  }

  // Rule 3: everything the project does not have yet.
  if (missing.length > 0) {
    const resolved = await resolveVersions(missing, sdk);
    for (const name of missing) {
      const result = resolved.get(name);
      if (result?.constraint) {
        plan.additions[name] = result.constraint;
        continue;
      }
      // The AI must supply a version for every dependency (see review rules).
      // When pub.dev is unreachable, the AI's version is the best we have.
      const requestedMinimum = requestedDependencies[name] || "";
      if (constraintLowerBound(requestedMinimum)) {
        plan.additions[name] = `^${constraintLowerBound(requestedMinimum)}`;
        plan.warnings.push(
          `Could not confirm "${name}" version on pub.dev (${result?.error || "lookup failed"}). ` +
            `Using ^${constraintLowerBound(requestedMinimum)} from the AI's recommendation — verify this is current.`,
        );
        continue;
      }
      // The AI gave no version and pub.dev is unreachable.
      // `>=0.0.0` is a legal constraint (pub resolves the newest release that
      // fits the project's SDK) but the user must pin a real version.
      plan.additions[name] = ">=0.0.0";
      plan.warnings.push(
        `Could not determine a version for "${name}" (${result?.error || "lookup failed"}) ` +
          "and the AI supplied none. Added with a wide-open >=0.0.0 constraint — " +
          "pin a concrete version in FlutterFlow before deploying.",
      );
    }
  }

  return plan;
}
