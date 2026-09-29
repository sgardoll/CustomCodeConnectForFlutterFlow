// The packages the Flutter SDK itself supplies. This list is consulted only
// when there is no pubspec entry to classify - the project's own `sdk:`
// declaration is the authority wherever one exists, so a name declared from
// git stays a git fork. A name missing from the list degrades to a hosted
// lookup, not a wrong answer.
export const FLUTTER_SDK_PACKAGES = new Set([
  "flutter",
  "flutter_test",
  "flutter_driver",
  "flutter_localizations",
  "flutter_web_plugins",
  "integration_test",
  "sky_engine",
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
      // A triple quote opens a multiline string, which ends only at the next
      // matching triple - a lone quote inside it is content, not a delimiter.
      const quote =
        code.slice(i, i + 3) === "'''" || code.slice(i, i + 3) === '"""'
          ? code.slice(i, i + 3)
          : code[i];
      out += quote;
      i += quote.length;
      while (i < code.length && !code.startsWith(quote, i)) {
        if (code[i] === "\\") {
          out += code[i];
          i++;
        }
        out += code[i];
        i++;
      }
      if (i < code.length) {
        out += quote;
        i += quote.length;
      }
    } else {
      out += code[i];
      i++;
    }
  }

  return out;
}

// A directive can carry further URIs in its `if (...)` clauses - each names
// the file imported when the condition holds, so every quoted literal *outside
// the parentheses* is code the class needs. The directive regex
// runs to the closing `;`, stepping over quoted literals whole because a
// string is the one place a `;` is legal - `import 'src/a;b.dart';` names a
// file, and stopping at its `;` would lose the URI. String alternatives
// consume `\x` escape pairs so an escaped quote does not end the literal
// early - `'a\'b.dart'` is one URI, not `a\` followed by a stranded quote.
// A `r` prefix makes a raw string, legal in directives too - the lookahead
// accepts it and the `r` itself rides the bare-char alternative, while the
// literal scans like any other (a valid raw URI cannot contain its own quote,
// so escape handling never changes where one ends). URI literals are read
// with paren awareness rather than a pattern: a string inside an `if (...)`
// condition is a comparison value (`dart.library.io == 'true'`), not a file,
// so only literals outside the parentheses count - and a literal inside is
// still consumed whole, because `== 'a(b'` holds a paren that isn't syntax.
// The apostrophe inside a double-quoted URI (`"src/it's.dart"`) is a filename
// char, not a delimiter, so each literal ends at its own quote type.
const DIRECTIVE_PATTERN =
  /\b(?:import|export)\s+(?=r?['"])(?:'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|[^;'"])*;/g;

// A directive keyword inside a *Dart string* is display text, not a
// directive - `final doc = "export 'package:ghost/ghost.dart';"` must not
// create a `ghost` dependency. The scan therefore steps over every ordinary
// string literal whole: at any position only one alternative can match, so a
// quoted `export` is consumed as string content and its keyword never starts
// a directive. A raw `r"..."` literal needs no alternative of its own - `r`
// matches nothing, and the quote after it opens the string alternative, whose
// escape-aware body ends at the same quote a raw literal would.
// Triple-quoted alternatives come first: a `'`/`"` literal cannot hold a
// newline, so without them `'''example\nimport 'package:x/x.dart';\n'''`
// scans its second line as a directive and invents a dependency on `x`.
// Their bodies are lazy `'`/`"`-tolerant runs to the matching triple quote.
const STRING_PATTERN = /'''(?:\\.|[^\\])*?'''|"""(?:\\.|[^\\])*?"""|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/.source;
const SCAN_PATTERN = new RegExp(`${DIRECTIVE_PATTERN.source}|${STRING_PATTERN}`, "g");

function* directiveMatches(code) {
  const stripped = stripComments(code);
  let match;
  while ((match = SCAN_PATTERN.exec(stripped)) !== null) {
    // A string-literal match starts with a quote; only keyword matches yield.
    if (!/^(?:import|export)\s/.test(match[0])) continue;
    yield match[0];
  }
}

/**
 * Yields the contents of every quoted literal in a directive that names code -
 * the primary URI and the alternative after each `if (...)` clause.
 *
 * @param {string} text - A directive match from DIRECTIVE_PATTERN
 * @yields {string}
 */
function* directiveUriLiterals(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    let raw = false;
    let quoteAt = i;
    if (char === "r") {
      if (text[i + 1] !== "'" && text[i + 1] !== '"') continue;
      raw = true;
      quoteAt = i + 1;
    } else if (char !== "'" && char !== '"') {
      continue;
    }

    // A literal is consumed at every depth so parentheses inside a comparison
    // value (`== 'a(b'`) never count as syntax - only depth-0 literals are
    // yielded, since only they name code.
    const quote = text[quoteAt];
    let end = quoteAt + 1;
    for (; end < text.length; end += 1) {
      // Raw strings take no escape pairs - `r'a\'b'` ends at the quote.
      if (!raw && text[end] === "\\") end += 1;
      else if (text[end] === quote) break;
    }
    if (depth === 0) yield text.slice(quoteAt + 1, end);
    i = end;
  }
}

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

  for (const directive of directiveMatches(code)) {
    for (const uri of directiveUriLiterals(directive)) {
      if (seen.has(uri)) continue;
      seen.add(uri);
      uris.push(uri);
    }
  }

  return uris;
}

/**
 * Returns the package names a class's `package:` URIs belong to.
 *
 * SDK names are included for every caller: verification must see them because
 * `flutter` is not always SDK-sourced, and discovery must see them because a
 * project that never declared `flutter_web_plugins` still needs the merged
 * pubspec to gain `sdk: flutter` - filtering the name out entirely would
 * leave the push missing a package FlutterFlow requires, and treating it as a
 * hosted name instead would write a constraint pub.dev cannot resolve.
 *
 * @param {string} code - Dart source
 * @returns {string[]} Package names, deduplicated
 */
export function extractPackageImports(code = "") {
  const names = [];
  const seen = new Set();
  // `export 'package:x/x.dart'` pulls the package in exactly as `import` does,
  // and an `if (...)` clause's alternative URI does the same when its
  // condition holds, so every package URI in a directive names a dependency.
  const packageUriPattern = /^package:([a-zA-Z0-9_]+)\//;

  for (const directive of directiveMatches(code)) {
    for (const uri of directiveUriLiterals(directive)) {
      const match = packageUriPattern.exec(uri);
      if (!match) continue;
      const name = match[1];
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }

  return names;
}
