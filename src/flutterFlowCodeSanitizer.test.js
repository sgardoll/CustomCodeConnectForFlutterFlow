import assert from "node:assert/strict";
import test from "node:test";
import {
  expectedWidgetClassFromFileName,
  findUnbalancedBracketError,
  getDeclaredWidgetClasses,
  sanitizeGeneratedDart,
  widgetFileNameForClass,
} from "./flutterFlowCodeSanitizer.js";

const SIMPLE_WIDGET = [
  "class LiquidGlassOrbs extends StatefulWidget {",
  "  const LiquidGlassOrbs({super.key});",
  "  @override",
  "  State<LiquidGlassOrbs> createState() => _LiquidGlassOrbsState();",
  "}",
].join("\n");

test("sanitizeGeneratedDart leaves plain Dart untouched apart from edge padding", () => {
  assert.equal(sanitizeGeneratedDart(`\n\n${SIMPLE_WIDGET}\n\n`), SIMPLE_WIDGET);
});

test("sanitizeGeneratedDart strips dart-fenced responses", () => {
  assert.equal(
    sanitizeGeneratedDart("```dart\n" + SIMPLE_WIDGET + "\n```"),
    SIMPLE_WIDGET,
  );
});

test("sanitizeGeneratedDart strips bare fences and surrounding prose", () => {
  const raw = [
    "Here is your widget:",
    "",
    "```",
    SIMPLE_WIDGET,
    "```",
    "Let me know if you need changes!",
  ].join("\n");

  assert.equal(sanitizeGeneratedDart(raw), SIMPLE_WIDGET);
});

test("sanitizeGeneratedDart drops prose between multi-block responses", () => {
  // STU-148: the previous sanitizer removed only the fence lines and kept
  // whatever explanatory text sat between the blocks, so the committed file
  // still failed FlutterFlow's formatter.
  const raw = [
    "```dart",
    "class A extends StatelessWidget {}",
    "```",
    "And another:",
    "```dart",
    "class B extends StatelessWidget {}",
    "```",
  ].join("\n");
  const result = sanitizeGeneratedDart(raw);

  assert.equal(result.includes("```"), false);
  assert.equal(result.includes("And another"), false);
  assert.match(result, /class A extends/);
  assert.match(result, /class B extends/);
});

test("STU-147: fences inside triple-quoted strings survive as literal content", () => {
  // A doc string whose example shows markdown fences must not be mistaken for
  // real delimiters: pairing those lines used to slice valid Dart apart.
  const dartWithFenceDoc = [
    "class FenceDoc extends StatelessWidget {",
    "  static const usage = '''",
    "```dart",
    "FenceDoc()",
    "```",
    "''';",
    "}",
  ].join("\n");
  const raw = [
    "Here is your widget:",
    "",
    "```dart",
    dartWithFenceDoc,
    "```",
  ].join("\n");

  assert.equal(sanitizeGeneratedDart(raw), dartWithFenceDoc);
});

test("STU-147: fences inside block comments survive as literal content", () => {
  const dartWithCommentedFences = [
    "/* Generated snippet notes:",
    "```json",
    '{"name": "demo"}',
    "```",
    "*/",
    "class Demo extends StatelessWidget {}",
  ].join("\n");
  const raw = [
    "```dart",
    dartWithCommentedFences,
    "```",
    "Hope that helps!",
  ].join("\n");

  assert.equal(sanitizeGeneratedDart(raw), dartWithCommentedFences);
});

test("sanitizeGeneratedDart drops content after an unclosed trailing fence", () => {
  // A response cut off mid-block cannot be valid Dart; committing its tail
  // would only move the failure to FlutterFlow's formatter.
  const raw = [
    "```dart",
    SIMPLE_WIDGET,
    "```",
    "Second part:",
    "```dart",
    "class Broken extends Stateless",
  ].join("\n");
  const result = sanitizeGeneratedDart(raw);

  assert.equal(result, SIMPLE_WIDGET);
});

test("sanitizeGeneratedDart keeps the code side of a single truncated fence", () => {
  assert.equal(sanitizeGeneratedDart("```\n" + SIMPLE_WIDGET), SIMPLE_WIDGET);
  assert.equal(sanitizeGeneratedDart(SIMPLE_WIDGET + "\n```"), SIMPLE_WIDGET);
});

test("sanitizeGeneratedDart strips a BOM", () => {
  assert.equal(sanitizeGeneratedDart("\uFEFF" + SIMPLE_WIDGET), SIMPLE_WIDGET);
});

test("sanitizeGeneratedDart returns empty for empty or blank input", () => {
  assert.equal(sanitizeGeneratedDart(""), "");
  assert.equal(sanitizeGeneratedDart("   \n\t "), "");
  assert.equal(sanitizeGeneratedDart(null), "");
  assert.equal(sanitizeGeneratedDart(undefined), "");
});

test("getDeclaredWidgetClasses finds public Stateless and Stateful widgets in order", () => {
  const code = [
    "class First extends StatelessWidget {}",
    "class _Private extends StatelessWidget {}",
    "class NotAWidget extends Object {}",
    "class Second extends StatefulWidget {}",
  ].join("\n");

  assert.deepEqual(getDeclaredWidgetClasses(code), ["First", "Second"]);
});

test("getDeclaredWidgetClasses accepts transitive Widget superclasses", () => {
  const code = "class Consumer extends ConsumerStatefulWidget {}";

  assert.deepEqual(getDeclaredWidgetClasses(code), ["Consumer"]);
});

test("getDeclaredWidgetClasses ignores class-shaped prose in comments and strings", () => {
  const code = [
    "// class Fake extends StatelessWidget should not count.",
    "final hint = 'class FakeToo extends StatefulWidget';",
    "class Real extends StatelessWidget {}",
  ].join("\n");

  assert.deepEqual(getDeclaredWidgetClasses(code), ["Real"]);
});

test("findUnbalancedBracketError accepts healthy widget code", () => {
  const code = [
    "class W extends StatelessWidget {",
    "  // braces } in a comment { don't count",
    "  final label = 'text with ) and (';",
    "  @override",
    "  Widget build(BuildContext context) {",
    "    return Text('${user['name']}: {literal}');",
    "  }",
    "}",
  ].join("\n");

  assert.equal(findUnbalancedBracketError(code), null);
});

test("findUnbalancedBracketError reports the line of an unclosed bracket", () => {
  const code = "\n{\n  x();\n";

  const error = findUnbalancedBracketError(code);
  assert.match(error, /"\{" opened on line 2 is never closed/);
});

test("findUnbalancedBracketError reports an extra closer", () => {
  const error = findUnbalancedBracketError("void a() {}\n}");

  assert.match(error, /line 2.*unexpected "\}"/);
});

test("findUnbalancedBracketError reports mismatched pairs precisely", () => {
  const error = findUnbalancedBracketError("void a() {\n]");

  assert.match(error, /"\]" closes nothing - "\{" opened on line 1/);
});

test("findUnbalancedBracketError ignores brackets inside triple-quoted strings", () => {
  const code = [
    "/// Docs:",
    'const doc = """',
    "unclosed { [ ( stuff",
    '""";',
    "void main() {}",
  ].join("\n");

  assert.equal(findUnbalancedBracketError(code), null);
});

test("findUnbalancedBracketError reports an unterminated triple-quoted string", () => {
  const error = findUnbalancedBracketError("const doc = '''\nnever ended {");

  assert.match(error, /unclosed triple-quoted string/);
});

test("STU-148: a runaway quote fails the gate instead of self-healing", () => {
  // A single-quoted string can never legally span lines. The scan still ends
  // the string at the newline so later brackets attribute correctly, but it
  // must surface the break through the gate - silently healing let malformed
  // source reach FlutterFlow and fail with an opaque formatter rejection.
  const error = findUnbalancedBracketError("final x = 'oops;\nvoid main() {}");

  assert.match(error, /line 1: string starting on line 1 is never closed/);
});

test("STU-148: unterminated ordinary string followed by balanced code errors naming its line", () => {
  // The Greptile P1 scenario: "abc on one line, healthy code after - the
  // balanced remainder used to hide the broken string from the gate.
  const code = [
    "class Broken extends StatelessWidget {",
    '  final label = "abc',
    "  void f() {}",
    "}",
  ].join("\n");

  const error = findUnbalancedBracketError(code);
  assert.match(error, /string starting on line 2 is never closed/);
});

test("STU-148: multi-line triple-quoted strings stay legal while open", () => {
  const code = [
    "final doc = '''",
    "line one with ``` fences and { brackets [",
    "line two keeps going",
    "''';",
    "void main() {}",
  ].join("\n");

  assert.equal(findUnbalancedBracketError(code), null);
});

test("STU-148: an unterminated triple-quoted string names its opening line", () => {
  // The old message reported the live line counter at EOF instead of where
  // the string actually opened.
  const code = "var s = 'fine';\n\nvar t = '''\nnever closed";
  const error = findUnbalancedBracketError(code);

  assert.match(error, /unclosed triple-quoted string starting on line 3 was never closed/);
});

test("STU-147: nested block comments stay protected until the real close", () => {
  // Dart nests block comments: the inner */ must not terminate the outer
  // comment, or every later line-leading ``` inside the still-open region is
  // misread as a markdown fence and the source gets dropped/rearranged.
  const nestedCommentDart = [
    "/* outer doc /* inner ``` example */",
    "still-open outer comment",
    "```dart",
    "FenceDoc()",
    "```",
    "*/",
    "class NestedCommentDoc extends StatelessWidget {}",
  ].join("\n");

  // Byte-for-byte survival: no real fences exist, nothing may be stripped.
  assert.equal(sanitizeGeneratedDart(nestedCommentDart), nestedCommentDart);
  assert.equal(findUnbalancedBracketError(nestedCommentDart), null);

  // Protection holds until the true close: once the outer comment really
  // ends, surrounding markdown fences pair up normally around intact content.
  const raw = ["```dart", nestedCommentDart, "```", "Hope that helps!"].join("\n");
  assert.equal(sanitizeGeneratedDart(raw), nestedCommentDart);
});

test("STU-147: an unterminated nested block comment reports its opening line", () => {
  const error = findUnbalancedBracketError("void f() {}\n/* a /* b\nstill open");

  assert.match(error, /unterminated \/\* comment starting on line 2/);
});

test("findUnbalancedBracketError handles nested interpolation strings", () => {
  // items[0]'s brackets sit inside the ${...} interpolation of a string; the
  // nested ['...'] quotes must not terminate the outer string early.
  assert.equal(findUnbalancedBracketError("f('${items[0]}');"), null);
  assert.equal(findUnbalancedBracketError("t('${m['k']} v');"), null);

  // A quote left open inside an interpolation is still a real defect.
  const error = findUnbalancedBracketError("f('${a[');");
  assert.match(error, /unclosed string/);
});

test("STU-148: a raw string ending in a backslash closes at its quote", () => {
  // r'\' holds one literal backslash; treating the backslash as an escape used
  // to skip the closing quote and report every following bracket against it.
  const code = [
    "class BackslashSplitter extends StatelessWidget {",
    "  static final RegExp sep = RegExp(r'\\');",
    "  @override",
    "  Widget build(BuildContext context) => const SizedBox.shrink();",
    "}",
  ].join("\n");

  assert.equal(findUnbalancedBracketError(code), null);
});

test("STU-148: raw triple-quoted strings keep their literal backslashes", () => {
  const code = "final doc = r'''a \\ b { [ (''';\nvoid main() {}";

  assert.equal(findUnbalancedBracketError(code), null);
});

test("STU-148: raw strings do not interpolate so ${ is literal", () => {
  // Interpolation is disabled inside raw strings; pushing an interpolation
  // frame for ${ used to misattribute the braces that follow.
  const code = "final s = r'\${([{';\nvoid main() {}";

  assert.equal(findUnbalancedBracketError(code), null);
});

test("STU-148: uppercase R prefix marks raw strings too", () => {
  const code = "final sep = RegExp(R'\\');\nvoid main() {}";

  assert.equal(findUnbalancedBracketError(code), null);
});

test("escaped backslashes in normal strings still close correctly", () => {
  // 'a\\' is a complete non-raw string holding one backslash; the escape must
  // still be honored outside raw mode.
  assert.equal(findUnbalancedBracketError("final x = 'a\\\\';\nvoid f() {}"), null);

  // ...and a genuinely unterminated non-raw string is still reported.
  const error = findUnbalancedBracketError("final x = 'a\\;");
  assert.match(error, /unclosed string/);
});

test("widget file naming round-trips through FlutterFlow's naive snake_case", () => {
  assert.equal(widgetFileNameForClass("LiquidGlassOrbs"), "liquid_glass_orbs.dart");
  assert.equal(expectedWidgetClassFromFileName("liquid_glass_orbs.dart"), "LiquidGlassOrbs");

  // Acronyms: FF's naive stem puts an underscore before EVERY capital, so the
  // inverse must rebuild "QAReport" from "q_a_report".
  assert.equal(widgetFileNameForClass("QAReport"), "q_a_report.dart");
  assert.equal(expectedWidgetClassFromFileName("q_a_report.dart"), "QAReport");
});

test("STU-147 scenario: fenced response with display-name artifact resolves cleanly", () => {
  // The reported failure: LLM output wrapped in fences, artifact named
  // "Liquid Glass Orbs" (display form), class declared as LiquidGlassOrbs.
  const generated = [
    "```dart",
    SIMPLE_WIDGET,
    "```",
  ].join("\n");
  const artifactName = "Liquid Glass Orbs";

  const code = sanitizeGeneratedDart(generated);
  const [declared] = getDeclaredWidgetClasses(code);
  const fileName = widgetFileNameForClass(declared);

  assert.equal(declared, "LiquidGlassOrbs");
  assert.equal(fileName, "liquid_glass_orbs.dart");
  // The committed name is exactly what FF derives from its own side.
  assert.equal(expectedWidgetClassFromFileName(fileName), declared);
  assert.equal(findUnbalancedBracketError(code), null);
});

test("STU-148: prose tokens before a later block cannot hide that block", () => {
  // An unmatched /* in the prose used to extend a comment range to EOF when
  // the raw response was scanned as Dart, classifying the second block's
  // fences as comment content and silently dropping it.
  const response = [
    "Here is a note with a stray opener: /* not really a comment",
    "",
    "```dart",
    "class First {}",
    "```",
    "And another note with a stray quote: \"",
    "",
    "```dart",
    "class Second {}",
    "```",
  ].join("\n");
  const out = sanitizeGeneratedDart(response);
  assert.ok(out.includes("class First {}"), "first block must survive");
  assert.ok(out.includes("class Second {}"), "second block must survive");
  assert.ok(!out.includes("stray"), "prose must be dropped");
});

test("STU-148: dollar-prefixed raw strings inside interpolation pass the gate", () => {
  // `${r'...'}` sequences used to make the r-prefix look like an identifier
  // tail ($ was in IDENTIFIER_TAIL), so the backslash escaped the closing
  // quote and the gate reported an unclosed string on valid Dart.
  const source = `var s = '\${r'x\\'}';`;
  assert.equal(findUnbalancedBracketError(source), null);
  const fenced = ["```dart", source, "```"].join("\n");
  assert.equal(sanitizeGeneratedDart(fenced).trim(), source);
});
