import { deriveIdentifierName } from "./flutterFlowSyncMetadata.js";

const SUPPORTED_TYPES = new Set([
  "CustomWidget",
  "CustomAction",
  "CustomFunction",
  "CustomClass",
  "CodeFile",
]);

const TYPE_FILE_HINTS = {
  CustomWidget: "custom_code/widgets/",
  CustomAction: "custom_code/actions/",
  CustomFunction: "flutter_flow/custom_functions.dart",
  CustomClass: "custom_code/",
  CodeFile: "custom_code/",
};

// Types FlutterFlow exposes in the Custom Action "Return Value" selector
// (Integer, Double, Boolean, String, Image/Video/Audio Path, Color, Document,
// Document Reference, JSON, DateTime, TimestampRange, plus the List option).
// Importing a package class does not make it selectable, so anything else -
// an imported package class, a Code File class, a CustomEnum - is rejected by
// FlutterFlow at push time and must be caught before deploy.
//
// Map is deliberately NOT included: FlutterFlow documents "JSON" as a
// supported return category, but its push-time parser rejects the literal
// annotation `Future<Map<String, dynamic>>` with "Unable to process return
// parameter" (confirmed by multiple FlutterFlow community reports). The
// working form for a JSON/freeform return is `Future<dynamic>`, which is
// already in this list.
const SUPPORTED_RETURN_TYPES = new Set([
  "void",
  "dynamic",
  "String", // also Image Path, Video Path, Audio Path
  "int",
  "double",
  "num",
  "bool",
  "Color",
  "DateTime",
  "DateTimeRange", // TimestampRange
  "LatLng",
  "FFPlace",
  "FFUploadedFile",
  "DocumentReference",
  "List",
]);

// Data Types generate as "<Name>Struct" and Firestore Documents as
// "<Collection>Record", so both suffixes are selectable return values.
const SUPPORTED_RETURN_TYPE_SUFFIXES = ["Struct", "Record"];

// Unset FlutterFlow "Define Parameters" fields are OMITTED from the constructor
// call FlutterFlow emits, not passed as null. So a `required` parameter, or a
// non-nullable field with no constructor default, makes that call fail to
// compile and the widget cannot be placed at all.
//
// Both rules are scoped to public Stat*Widget classes on purpose: private
// helpers and painters are not placeable from the FlutterFlow panel and use
// `required` legitimately. Judging the whole file instead flags healthy widgets.
const WIDGET_RULES = [
  {
    id: "required-public-param",
    severity: "error",
    message:
      "CustomWidget constructor uses `required` on a parameter FlutterFlow can leave unset. "
      + "FlutterFlow omits unset Define Parameters fields from the constructor call, so the widget "
      + "will not compile when placed. Make the parameter optional and nullable (`this.value` with "
      + "`final double? value`), or give it a constructor default (`this.value = 0.0`).",
    detect: (stripped) => getPublicWidgetSpans(stripped)
      .some((span) => /\brequired\s+this\.\w+/.test(span)),
    pos: "class W extends StatefulWidget { const W({required this.value}); final double value; }",
    neg: "class _P { const _P({required this.t}); final double t; }\n"
      + "class W extends StatefulWidget { const W({this.value}); final double? value; }",
  },
  {
    id: "non-nullable-public-field",
    severity: "error",
    message:
      "CustomWidget declares a non-nullable field with no constructor default. FlutterFlow omits "
      + "unset Define Parameters fields, so the emitted call cannot supply it. Make the field "
      + "nullable (`final double? value`) or give the parameter a default (`this.value = 0.0`).",
    // Each class is judged against its OWN body. A field's default has to come
    // from the constructor that builds that widget; a sibling widget in the
    // same file declaring `this.value = 0.0` says nothing about this one.
    detect: (stripped) => getPublicWidgetSpans(stripped).some((span) => {
      const fieldPattern = /^\s*final\s+(?:double|int|String|bool|Color|num)\s+(\w+)\s*;/gm;
      let match;

      while ((match = fieldPattern.exec(span)) !== null) {
        const field = match[1];
        // Two forms keep a blank panel constructible: a default on the
        // parameter (`this.x = 0.0`), and an initializer list entry
        // (`const W() : x = 1`, `const W({double? v}) : x = v ?? 1.0`), where
        // the widget supplies the value itself and never exposes a parameter
        // at all.
        const hasDefault = new RegExp(`this\\.${field}\\s*=(?!=)`).test(span)
          || new RegExp(`[:,]\\s*${field}\\s*=(?!=)`).test(span);
        if (!hasDefault) return true;
      }

      return false;
    }),
    // Multi-line on purpose: the detector anchors `^\s*final`, so a single-line
    // control never matches and would void the rule.
    pos: "class W extends StatefulWidget {\n  const W({required this.value});\n  final double value;\n}",
    neg: "class _P {\n  const _P({required this.t});\n  final double t;\n}\n"
      + "class W extends StatefulWidget {\n  const W({this.value = 1.0});\n  final double value;\n}",
  },
  {
    id: "asset-without-anchor",
    severity: "warning",
    message:
      "CustomWidget calls Image.asset with a path arriving as a String parameter. An asset reaches "
      + "the build only when a FlutterFlow widget NODE references it - a filename passed as a "
      + "parameter does not count, so the image renders as a broken-image icon on device. "
      + "\"Download Unused Project Assets\" does not fix it (FlutterFlow issues 522, 2271, 3799). "
      + "Keep something in the UI referencing the file, or load it over the network instead.",
    detect: (stripped) =>
      /Image\.asset\s*\(/.test(stripped) && /final\s+String\??\s+\w*[Pp]ath\b/.test(stripped),
    pos: "class W extends StatefulWidget { final String? imagePath; }\nvar x = Image.asset(widget.imagePath);",
    neg: "class W extends StatefulWidget { final String? imagePath; }\nvar x = Image.network(widget.imagePath);",
  },
  {
    id: "unsupported-param-type",
    severity: "error",
    message:
      "CustomWidget exposes a Flutter data type FlutterFlow cannot express as a Define Parameter: "
      + "TextStyle, BoxShadow, FontWeight, FontStyle, TextDirection, TextAlign, EdgeInsets, Offset, "
      + "Alignment/AlignmentGeometry, Border, BorderRadius, BoxDecoration, BoxConstraints, BorderSide, "
      + "Gradient, or ThemeData. FlutterFlow's supported data types "
      + "(docs.flutterflow.io/resources/data-representation/data-types) are only int, double, bool, "
      + "string, Color, Image, DateTime, Json, LatLng, and the FF objects, so this parameter cannot be "
      + "configured in the editor and the widget will not place or compile. Expose primitives instead "
      + "(color, fontSize as double?, fontWeight via a custom enum, doubles for spacing).",
    // Scoped to the public placeable widget's OWN parameters. A private
    // painter's TextStyle, or TextDirection.ltr feeding a TextPainter, is
    // ordinary safe Flutter code - it only breaks the build on a genuine
    // name collision elsewhere in the project, which no text-based check
    // (this one or an LLM prompt) can see. Flagging the literal itself was a
    // false-positive generator; only the unsupported-parameter-type case is
    // deterministically detectable.
    detect: (stripped) => getPublicWidgetSpans(stripped).some((span) =>
      /final\s+(TextStyle|BoxShadow|FontWeight|FontStyle|TextDirection|TextAlign|EdgeInsets|Offset|Alignment(?:Geometry)?|Border(?:Radius|Side)?|BoxDecoration|BoxConstraints|Gradient|LinearGradient|RadialGradient|ThemeData)\??\s+\w+\s*;/.test(span)),
    // Scoped to the public placeable widget: a local EdgeInsets.all(...) or a
    // private painter's TextStyle is fine and must stay unflagged.
    pos: "class W extends StatefulWidget {\n"
      + "  const W({this.textStyle});\n"
      + "  final TextStyle? textStyle;\n"
      + "  @override _S createState() => _S();\n"
      + "}\n"
      + "class _S extends State<W> { @override Widget build(BuildContext c) => const SizedBox(); }",
    neg: "class W extends StatefulWidget {\n"
      + "  const W({this.width});\n"
      + "  final double? width;\n"
      + "  @override _S createState() => _S();\n"
      + "}\n"
      + "class _S extends State<W> { @override Widget build(BuildContext c) => Padding(padding: const EdgeInsets.all(8), child: const SizedBox()); }",
  },
];

function createFinding(artifact, severity, message) {
  return {
    artifactId: artifact.id,
    artifactName: artifact.artifactName,
    artifactType: artifact.artifactType,
    severity,
    message,
  };
}

/**
 * Removes comments and string literals so type detection never matches a name
 * that only appears in prose or in a quoted string.
 * @param {string} code - Dart source
 * @returns {string} Source with comments and string bodies blanked out
 */
function stripCommentsAndStrings(code) {
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
      i++;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === "\\") i++;
        i++;
      }
      i++;
      out += '""';
    } else {
      out += code[i];
      i++;
    }
  }

  return out;
}

/**
 * Reads a balanced generic argument list starting at an opening angle bracket.
 * Handles arbitrary nesting, which a regex cannot.
 * @param {string} code - Source to scan
 * @param {number} start - Index of the opening "<"
 * @returns {{inner: string, end: number}|null} Inner text and index past the ">"
 */
function readBalancedGeneric(code, start) {
  let depth = 0;

  for (let i = start; i < code.length; i++) {
    if (code[i] === "<") depth++;
    else if (code[i] === ">") {
      depth--;
      if (depth === 0) return { inner: code.slice(start + 1, i), end: i + 1 };
    }
  }

  return null;
}

/**
 * Returns the brace-matched body of `class <name> ... { ... }`, which a regex
 * cannot do - a widget body contains nested braces on every build method.
 * @param {string} code - Source with comments and strings removed
 * @param {string} className - Class to extract
 * @returns {string|null} Full `class ... { ... }` text, or null
 */
function readClassSpan(code, className) {
  const header = new RegExp(`class\\s+${className}\\b[^{]*\\{`).exec(code);
  if (!header) return null;

  let depth = 0;

  for (let i = header.index + header[0].length - 1; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return code.slice(header.index, i + 1);
  }

  return null;
}

/**
 * Returns the body of every PUBLIC Stat*Widget class in the source, one entry
 * per class - the only code FlutterFlow's Define Parameters panel can emit a
 * constructor call for. Private helpers (`_Row extends StatelessWidget`),
 * painters, and plain data classes are excluded: they are not placeable, so
 * `required` is fine there.
 *
 * Kept separate rather than concatenated because a rule that asks "does this
 * field have a default?" must ask it of one class. Joined, a sibling widget's
 * `this.value = 0.0` answers for a different widget's unsupplied `value`, and
 * a widget FlutterFlow genuinely cannot construct passes validation.
 * @param {string} code - Source with comments and strings removed
 * @returns {string[]} One class body per public widget
 */
function getPublicWidgetSpans(code) {
  const spans = [];
  const declarations = code.matchAll(/class\s+([A-Z]\w*)\s+extends\s+Stat(?:eless|eful)Widget/g);

  for (const declaration of declarations) {
    const span = readClassSpan(code, declaration[1]);
    if (span) spans.push(span);
  }

  return spans;
}

/**
 * Proves a rule can see the defect it claims to detect before it is allowed to
 * report. A rule must flag its positive control and stay silent on its negative
 * one; otherwise it is unusable and its silence proves nothing.
 * @param {object} rule - Rule with detect/pos/neg
 * @returns {{id: string, positiveOk: boolean, negativeOk: boolean, usable: boolean}}
 */
export function calibrateRule(rule) {
  const positiveOk = rule.detect(stripCommentsAndStrings(rule.pos)) === true;
  const negativeOk = rule.detect(stripCommentsAndStrings(rule.neg)) === false;

  return { id: rule.id, positiveOk, negativeOk, usable: positiveOk && negativeOk };
}

export function calibrateWidgetRules() {
  return WIDGET_RULES.map(calibrateRule);
}

// Calibrated once at load: a rule broken by a later edit is suppressed rather
// than silently reporting every widget as clean.
const USABLE_WIDGET_RULES = WIDGET_RULES.filter((rule) => calibrateRule(rule).usable);

/**
 * Runs the calibrated CustomWidget pattern rules over Dart source.
 * @param {string} code - Dart source
 * @returns {Array<{id: string, severity: string, message: string}>} Triggered rules
 */
export function getWidgetRuleFindings(code = "") {
  const stripped = stripCommentsAndStrings(code);

  return USABLE_WIDGET_RULES
    .filter((rule) => rule.detect(stripped))
    .map(({ id, severity, message }) => ({ id, severity, message }));
}

/**
 * The CustomWidget rule messages that must stop a deploy - the defects that
 * make FlutterFlow's generated constructor call fail to compile, so the widget
 * cannot be placed at all. Warnings (a broken asset path, say) still deploy.
 * @param {string} code - Dart source
 * @returns {string[]} Blocking messages, empty when the widget is placeable
 */
export function getBlockingWidgetErrors(code = "") {
  return getWidgetRuleFindings(code)
    .filter((finding) => finding.severity === "error")
    .map((finding) => finding.message);
}

/**
 * Finds every `Future<...> name(` signature in already-stripped Dart source.
 * @param {string} code - Source with comments and strings removed
 * @returns {Array<{functionName: string, returnType: string|null}>}
 */
function findFutureSignatures(code) {
  const signatures = [];
  const futureMatches = code.matchAll(/\bFuture\b/g);

  for (const match of futureMatches) {
    let i = match.index + "Future".length;
    let returnType = null;

    const beforeSpace = i;
    while (i < code.length && /\s/.test(code[i])) i++;
    const hadSpaceAfterFuture = i > beforeSpace;

    if (code[i] === "<") {
      const generic = readBalancedGeneric(code, i);
      if (!generic) continue;
      returnType = generic.inner.replace(/\s+/g, " ").trim();
      i = generic.end;

      // A generic return type must still be separated from the name.
      if (!/\s/.test(code[i] || "")) continue;
      while (i < code.length && /\s/.test(code[i])) i++;
    } else if (!hadSpaceAfterFuture) {
      continue;
    }

    const nameMatch = /^([A-Za-z_]\w*)\s*\(/.exec(code.slice(i));
    if (!nameMatch) continue;

    signatures.push({ functionName: nameMatch[1], returnType });
  }

  return signatures;
}

// Artifact names reach us as display names ("Write NFC Tag") as often as Dart
// identifiers ("writeNfcTag"), so names are compared loosely.
function normalizeFunctionName(name = "") {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Picks the signature FlutterFlow will treat as the action entry point.
 * Prefers the function matching the artifact name, else the first Future found.
 * @param {string} code - Dart source
 * @param {string} functionName - Artifact name (display name or identifier)
 * @returns {{functionName: string, returnType: string|null}|null}
 */
export function getCustomActionSignature(code = "", functionName = "") {
  const signatures = findFutureSignatures(stripCommentsAndStrings(code));
  if (signatures.length === 0) return null;

  const wanted = normalizeFunctionName(functionName);
  const named = signatures.find(
    (signature) => normalizeFunctionName(signature.functionName) === wanted,
  );
  if (named) return named;

  // Without a name match, a private helper is never the entry point
  // FlutterFlow calls, so it must not be mistaken for the action's signature.
  const isPublic = (signature) => !signature.functionName.startsWith("_");
  return signatures.find(isPublic) || signatures[0];
}

export function getDeclaredDartTypes(code = "") {
  return Array.from(
    stripCommentsAndStrings(code).matchAll(/\b(?:class|enum)\s+([A-Za-z_]\w*)/g),
    (match) => match[1],
  );
}

export function getCustomActionReturnType(code = "", functionName = "") {
  return getCustomActionSignature(code, functionName)?.returnType || null;
}

/**
 * Converts a PascalCase (or camelCase) identifier to snake_case - the form
 * FlutterFlow expects a Custom Class file to be named after its declared
 * class.
 * @param {string} name - PascalCase or camelCase identifier
 * @returns {string} snake_case form
 */
function pascalCaseToSnakeCase(name) {
  return String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Checks whether a CustomClass/CodeFile's file name is the snake_case form of a
 * class or enum it declares. This is a convention, NOT a FlutterFlow
 * requirement: a Code File's path is a free-text field in the FlutterFlow
 * editor, so `q_a_service.dart` holding `class QAService` is perfectly valid.
 * It stays worth surfacing because provisioning derives the Code File's name
 * from the file name (see flutterFlowCodeFileProvisioning.js), so agreeing
 * names keep the FlutterFlow entry recognisable - which makes this advice, not
 * a blocker.
 * @param {string} fileName - Bare name or full path, e.g.
 *   "pipedream_integration_model.dart" or "lib/custom_code/pipedream_integration_model.dart"
 * @param {string} code - Dart source
 * @returns {string|null} Advisory message, or null if a declared type matches
 */
export function getCustomClassFileNameError(fileName, code) {
  const declaredTypes = getDeclaredDartTypes(code);
  if (declaredTypes.length === 0) return null;

  const baseName = String(fileName || "").split("/").pop();
  const actualStem = baseName.replace(/\.dart$/, "");
  const matchesSomeDeclaredType = declaredTypes.some(
    (name) => pascalCaseToSnakeCase(name) === actualStem,
  );
  if (matchesSomeDeclaredType) return null;

  // A file that groups several classes/enums (a shared models file, say) is
  // legitimately named after the collection rather than any single type it
  // holds - picking one declared type and suggesting the file be renamed
  // after it is bad advice, not a real naming mismatch. Only advise a rename
  // when there is exactly one type to name the file after.
  if (declaredTypes.length > 1) return null;

  const [primary] = declaredTypes;
  const suggestedFileName = `${pascalCaseToSnakeCase(primary)}.dart`;
  return `File name "${fileName}" does not match declared class "${primary}". FlutterFlow accepts this, but naming the file "${suggestedFileName}" keeps the Code File recognisable in the editor.`;
}

/**
 * Converts a Dart identifier to the file name FlutterFlow files it under -
 * an underscore before every capital, all lowercase.
 * @param {string} name - Dart identifier, e.g. "initQAAnalytics"
 * @returns {string} File stem, e.g. "init_q_a_analytics"
 */
export function identifierToFlutterFlowFileStem(name) {
  return String(name || "")
    .replace(/([A-Z])/g, "_$1")
    .toLowerCase()
    .replace(/^_/, "");
}

/**
 * Checks that a CustomAction's file name yields the function the code actually
 * declares. FlutterFlow reads the action's identity back out of the file name
 * and then looks for that exact declaration, so an acronym written the human
 * way ("init_qa_analytics.dart" for `initQAAnalytics`) resolves to a name that
 * is nowhere in the file and the commit fails with
 * `Action "initQaAnalytics" declaration not found.`
 * @param {string} fileName - Bare name or full path
 * @param {string} code - Dart source
 * @param {string} [artifactName] - Action name, used to pick the entry point
 * @returns {string|null} Error message, or null when the names agree
 */
export function getCustomActionFileNameError(fileName, code, artifactName = "") {
  const declaredName = getCustomActionSignature(code, artifactName)?.functionName;
  // No Future function at all is a separate finding, not a naming problem.
  if (!declaredName) return null;

  const baseName = String(fileName || "").split("/").pop();
  const derivedName = deriveIdentifierName(baseName, "A");
  if (derivedName === declaredName) return null;

  const expectedFileName = `${identifierToFlutterFlowFileStem(declaredName)}.dart`;
  return `File name "${baseName}" does not match Action "${declaredName}". FlutterFlow derives the action from the file name, so it looks for "${derivedName}" and reports Action "${derivedName}" declaration not found. Rename the file to "${expectedFileName}" - FlutterFlow puts an underscore before every capital - or rename the function to "${derivedName}".`;
}

function hasCustomActionFutureFunction(code = "", functionName = "") {
  return getCustomActionSignature(code, functionName) !== null;
}

/**
 * Returns the identifiers in a return type FlutterFlow cannot accept.
 * Data Types (*Struct) and Documents (*Record) are accepted only when they
 * are NOT declared in this push - a real FlutterFlow project type is never
 * defined via `class`/`enum` in a pushed Code File, so a declared *Struct/
 * *Record name is a local Dart class wearing the naming convention, not the
 * real thing, and FlutterFlow still cannot process it as a return value.
 * @param {string|null} returnType - Return type text, e.g. "List<NfcTag>"
 * @param {Set<string>} [declaredTypes] - Types declared in this push
 * @returns {string[]} Unsupported type identifiers
 */
export function getUnsupportedReturnTypeIdentifiers(returnType, declaredTypes = new Set()) {
  const identifiers = returnType?.match(/[A-Za-z_]\w*/g) || [];

  return identifiers.filter((identifier) => {
    if (SUPPORTED_RETURN_TYPES.has(identifier)) return false;

    const looksLikeProjectType = SUPPORTED_RETURN_TYPE_SUFFIXES.some((suffix) =>
      identifier.endsWith(suffix),
    );
    return !looksLikeProjectType || declaredTypes.has(identifier);
  });
}

export function getCustomActionReturnTypeError(
  code,
  { functionName = "", declaredTypes = new Set() } = {},
) {
  const returnType = getCustomActionReturnType(code, functionName);
  const unsupported = getUnsupportedReturnTypeIdentifiers(returnType, declaredTypes);
  if (unsupported.length === 0) return null;

  const [offending] = unsupported;
  let detail;
  if (declaredTypes.has(offending)) {
    detail = `uses Code File type "${offending}", which FlutterFlow cannot process as an Action Return Value`;
  } else if (returnType === offending) {
    detail = "is not a FlutterFlow Action Return Value";
  } else {
    detail = `uses type "${offending}", which is not a FlutterFlow Action Return Value`;
  }

  return `CustomAction return type "${returnType}" ${detail}. Return JSON (Future<dynamic>) or an existing FlutterFlow Data Type (*Struct) instead.`;
}

export function validateArtifactCompatibility(artifact, options = {}) {
  const findings = [];
  const fileName = artifact.fileName || "";
  const code = artifact.code || "";

  if (!SUPPORTED_TYPES.has(artifact.artifactType)) {
    findings.push(createFinding(
      artifact,
      "error",
      `Unsupported artifact type "${artifact.artifactType}".`,
    ));
  }

  if (!fileName.endsWith(".dart")) {
    findings.push(createFinding(artifact, "error", "FlutterFlow custom code artifacts must use .dart files."));
  }

  if (!code.trim()) {
    findings.push(createFinding(artifact, "warning", "Generated artifact has no Dart code yet."));
    return findings;
  }

  if (artifact.artifactType === "CustomWidget") {
    if (!/class\s+\w+\s+extends\s+(StatelessWidget|StatefulWidget)/.test(code)) {
      findings.push(createFinding(
        artifact,
        "warning",
        "CustomWidget code should declare a widget class extending StatelessWidget or StatefulWidget.",
      ));
    }

    for (const rule of getWidgetRuleFindings(code)) {
      findings.push(createFinding(artifact, rule.severity, rule.message));
    }
  }

  if (
    artifact.artifactType === "CustomAction"
    && !hasCustomActionFutureFunction(code, artifact.artifactName)
  ) {
    findings.push(createFinding(
      artifact,
      "warning",
      "CustomAction code should expose an async Future function callable from FlutterFlow.",
    ));
  }

  if (artifact.artifactType === "CustomAction") {
    const declaredTypes = options.declaredTypes || new Set(getDeclaredDartTypes(code));
    const returnTypeError = getCustomActionReturnTypeError(code, {
      functionName: artifact.artifactName,
      declaredTypes,
    });
    if (returnTypeError) {
      findings.push(createFinding(artifact, "error", returnTypeError));
    }

    const fileNameError = getCustomActionFileNameError(
      fileName,
      code,
      artifact.artifactName,
    );
    if (fileNameError) {
      findings.push(createFinding(artifact, "error", fileNameError));
    }
  }

  if (artifact.artifactType === "CustomFunction" && /class\s+\w+\s+extends\s+(StatelessWidget|StatefulWidget)/.test(code)) {
    findings.push(createFinding(
      artifact,
      "warning",
      "CustomFunction should be a callable function, not a widget class.",
    ));
  }

  if (artifact.artifactType === "CustomClass" || artifact.artifactType === "CodeFile") {
    const fileNameError = getCustomClassFileNameError(fileName, code);
    if (fileNameError) {
      // A Code File's path is author-controlled in FlutterFlow, so a name that
      // does not match its class is a convention nit, not something to flag
      // for attention - "info", not "warning".
      findings.push(createFinding(artifact, "info", fileNameError));
    }
  }

  return findings;
}

export function validateBundleCompatibility(bundle) {
  const artifacts = Array.isArray(bundle?.artifacts) ? bundle.artifacts : [];
  const declaredTypes = new Set(
    artifacts.flatMap((artifact) => getDeclaredDartTypes(artifact.code || "")),
  );
  const findings = artifacts.flatMap((artifact) => validateArtifactCompatibility(
    artifact,
    { declaredTypes },
  ));
  const deployHints = artifacts.map((artifact) => ({
    artifactId: artifact.id,
    fileName: artifact.fileName,
    pathHint: TYPE_FILE_HINTS[artifact.artifactType] || TYPE_FILE_HINTS.CodeFile,
  }));

  return {
    valid: findings.every((finding) => finding.severity !== "error"),
    findings,
    deployHints,
  };
}
