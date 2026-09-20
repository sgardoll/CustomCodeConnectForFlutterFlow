// Flutter SDK packages FlutterFlow's default pubspec.yaml always provides.
// Importing these needs no dependency entry.
const FLUTTER_SDK_PACKAGES = new Set([
  "flutter",
  "flutter_test",
  "flutter_driver",
  "flutter_localizations",
]);

/**
 * Removes `//` and `/* *\/` comments while leaving string literals untouched.
 * An import mentioned only in a comment - `// import 'package:foo/foo.dart';`
 * - must never be mistaken for a real one. Strings must survive intact,
 * unlike stripping for type-declaration detection: the package name an
 * import needs IS inside its string literal.
 * @param {string} code - Dart source
 * @returns {string} Source with comments blanked out, strings untouched
 */
function stripComments(code) {
  let out = "";
  let i = 0;

  while (i < code.length) {
    const pair = code.slice(i, i + 2);

    if (pair === "//") {
      while (i < code.length && code[i] !== "\n") i++;
      out += " ";
    } else if (pair === "/*") {
      i += 2;
      while (i < code.length && code.slice(i, i + 2) !== "*/") i++;
      i += 2;
      out += " ";
    } else if (code[i] === "'" || code[i] === '"') {
      const quote = code[i];
      out += code[i];
      i++;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === "\\") {
          out += code[i];
          i++;
        }
        out += code[i];
        i++;
      }
      if (i < code.length) {
        out += code[i];
        i++;
      }
    } else {
      out += code[i];
      i++;
    }
  }

  return out;
}

/**
 * Scans Dart source for `package:name/...` imports and returns the
 * third-party pub.dev packages it references, in first-seen order.
 *
 * This is what a generated action's real dependencies are - not whatever an
 * AI-authored spec declared alongside it. A declared dependency list can miss
 * a package the code actually imports (a manual edit, a regeneration cycle
 * that added an import without updating the spec), and FlutterFlow rejects a
 * push whose pubspec.yaml omits a package the code imports.
 *
 * @param {string} code - Dart source
 * @returns {string[]} Package names, deduplicated
 */
/**
 * Returns every URI the source imports or exports, in first-seen order.
 *
 * Unlike extractPackageImports this keeps `dart:` URIs and FlutterFlow's own
 * project-relative ones (`/backend/schema/structs/index.dart`), because what
 * decides whether generated code can be compiled in isolation is precisely the
 * URIs a standalone package cannot resolve.
 *
 * @param {string} code - Dart source
 * @returns {string[]} Imported/exported URIs, deduplicated
 */
export function extractImportUris(code = "") {
  const uris = [];
  const seen = new Set();
  const directiveRegex = /\b(?:import|export)\s+(['"])([^'"\n]+)\1/g;
  const stripped = stripComments(code);
  let match;

  while ((match = directiveRegex.exec(stripped)) !== null) {
    const uri = match[2];
    if (seen.has(uri)) continue;
    seen.add(uri);
    uris.push(uri);
  }

  return uris;
}

export function extractPackageImports(code = "") {
  const names = [];
  const seen = new Set();
  const importRegex = /\bimport\s+['"]package:([a-zA-Z0-9_]+)\//g;
  const stripped = stripComments(code);
  let match;

  while ((match = importRegex.exec(stripped)) !== null) {
    const name = match[1];
    if (FLUTTER_SDK_PACKAGES.has(name) || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }

  return names;
}
