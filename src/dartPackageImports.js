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

// A directive can carry further URIs in its `if (...)` clauses - each names
// the file imported when the condition holds, so every quoted literal inside
// an import/export directive is code the class needs. The directive regex
// runs to the closing `;`, stepping over quoted literals whole because a
// string is the one place a `;` is legal - `import 'src/a;b.dart';` names a
// file, and stopping at its `;` would lose the URI.
const DIRECTIVE_PATTERN =
  /\b(?:import|export)\s+(?=['"])(?:'[^'\n]*'|"[^"\n]*"|[^;'"])*;/g;
const URI_PATTERN = /(['"])([^'"\n]+)\1/g;

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
  const stripped = stripComments(code);
  let directive;

  while ((directive = DIRECTIVE_PATTERN.exec(stripped)) !== null) {
    URI_PATTERN.lastIndex = 0;
    let match;
    while ((match = URI_PATTERN.exec(directive[0])) !== null) {
      const uri = match[2];
      if (seen.has(uri)) continue;
      seen.add(uri);
      uris.push(uri);
    }
  }

  return uris;
}

export function extractPackageImports(code = "") {
  const names = [];
  const seen = new Set();
  // `export 'package:x/x.dart'` pulls the package in exactly as `import` does,
  // and an `if (...)` clause's alternative URI does the same when its
  // condition holds, so every package URI in a directive names a dependency.
  const packageUriPattern = /['"]package:([a-zA-Z0-9_]+)\//g;
  const stripped = stripComments(code);
  let directive;

  while ((directive = DIRECTIVE_PATTERN.exec(stripped)) !== null) {
    packageUriPattern.lastIndex = 0;
    let match;
    while ((match = packageUriPattern.exec(directive[0])) !== null) {
      const name = match[1];
      if (FLUTTER_SDK_PACKAGES.has(name) || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }

  return names;
}
