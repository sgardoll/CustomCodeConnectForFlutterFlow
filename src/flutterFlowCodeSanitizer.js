import { deriveIdentifierName } from "./flutterFlowSyncMetadata.js";
import { identifierToFlutterFlowFileStem } from "./flutterFlowArtifactValidation.js";

// LLM responses routinely arrive wrapped in markdown code fences, with a BOM,
// or with prose before/after the Dart. FlutterFlow's push-time formatter
// rejects any of that with "Custom widget code is not formattable", so it must
// be stripped before the code is validated or committed.
const BOM_PATTERN = /^\uFEFF/;

function trimBlankEdgeLines(lines) {
  let start = 0;
  let end = lines.length;

  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;

  return lines.slice(start, end).join("\n");
}

/**
 * Removes markdown artifacts and surrounding junk from generated Dart.
 *
 * Fence recognition is phase-separated. Phase one is purely structural: a
 * fence marker is a line containing nothing but three-or-more backticks and
 * an optional info-string tag. Everything before the first accepted opening
 * marker and after the last accepted closing marker is markdown prose by
 * definition and is NEVER scanned as Dart, so stray tokens in prose (an
 * unmatched `/*`, a stray quote) cannot poison recognition and hide later
 * code blocks (STU-148). Phase two applies Dart awareness only INSIDE a
 * fenced block: a candidate closer is accepted only when the scanner proves
 * the marker sits outside every comment/string span of the accumulated
 * block content, so literal ``` lines inside triple-quoted strings or
 * (nested) block comments survive byte-for-byte (STU-147).
 *
 * Completed pairs are kept and joined; inter-block prose is dropped. An
 * open block at end of input is a truncated response and is dropped:
 * committing cut-off Dart fails formatting anyway. With exactly one fence
 * line (a truncated wrap), whichever side holds more content is kept.
 * Blank edge lines are trimmed so header application downstream starts
 * from clean source.
 * @param {string} rawCode - Raw generated response text
 * @returns {string} Dart-only source, empty when the input has no content
 */
export function sanitizeGeneratedDart(rawCode) {
  const code = String(rawCode ?? "").replace(BOM_PATTERN, "");
  if (!code.trim()) return "";

  const lines = code.split("\n");

  // Structural candidates only: the trimmed line must be a bare fence
  // marker with an optional language tag - nothing else on the line.
  const fenceIndent = (line) => {
    const trimmed = line.trim();
    return /^`{3,}[A-Za-z0-9+#_.-]*$/.test(trimmed)
      ? line.length - line.trimStart().length
      : -1;
  };

  let candidates = 0;
  let firstCandidate = -1;
  const candidateOffsets = [];
  {
    let lineStartOffset = 0;
    for (let index = 0; index < lines.length; index++) {
      const indent = fenceIndent(lines[index]);
      if (indent >= 0) {
        candidates++;
        if (firstCandidate < 0) firstCandidate = index;
        candidateOffsets.push(lineStartOffset + indent);
      }
      lineStartOffset += lines[index].length + 1;
    }
  }

  // No fences: the response is a plain Dart file (possibly padded).
  if (candidates === 0) return trimBlankEdgeLines(lines);

  // Plain-Dart interpretation: when the full source scans without a single
  // lexical problem AND every candidate marker sits inside a comment/string
  // span, none of them is a markdown delimiter - the input is a fence-less
  // Dart file whose doc examples happen to contain backtick lines. Return it
  // untouched instead of pairing literals as fences (STU-147). The
  // error-free requirement keeps prose tokens like a stray `/*` - which
  // would swallow every later marker into one phantom comment span - from
  // spoofing this branch; genuinely broken responses fall through to
  // markdown extraction.
  {
    const wholeScan = scanDartSource(code);
    const allLiteral =
      !wholeScan.error &&
      candidateOffsets.every((offset) =>
        offsetIsInsideCommentOrString(offset, wholeScan.commentAndStringRanges)
      );
    if (allLiteral) return trimBlankEdgeLines(lines);
  }

  // Exactly one fence line means a truncated or partial wrap; keep the side
  // that actually carries code instead of emitting an empty or doubled file.
  if (candidates === 1) {
    const before = trimBlankEdgeLines(lines.slice(0, firstCandidate));
    const after = trimBlankEdgeLines(lines.slice(firstCandidate + 1));
    return after.length >= before.length ? after : before;
  }

  const segments = [];
  let block = null; // accumulated lines of the currently-open fenced block
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const indent = fenceIndent(line);

    if (indent < 0) {
      if (block) block.push(line);
      continue;
    }

    if (block === null) {
      // Opening fence: acceptance is structural - preceding prose is never
      // consulted, so tokens in prose cannot suppress this block.
      block = [];
      continue;
    }

    // Candidate closer inside an open block: accept only when the marker
    // sits outside every comment/string span of the block content itself.
    // The candidate line is part of the scanned text so an open triple-quoted
    // string (whose span runs to end-of-scan) covers the marker position.
    const content = block.join("\n");
    const scanText = `${content}\n${line}`;
    const { commentAndStringRanges } = scanDartSource(scanText);
    const markerOffset = content.length + 1 + indent;
    if (offsetIsInsideCommentOrString(markerOffset, commentAndStringRanges)) {
      block.push(line); // literal ``` inside the block's own strings/comments
      continue;
    }
    segments.push(trimBlankEdgeLines(block));
    block = null; // closing fence accepted; following prose is dropped
  }
  // A block still open at EOF is a truncated response: drop it, along with
  // all leading/trailing prose outside completed pairs.

  const kept = segments.filter((segment) => segment.length > 0);
  if (kept.length === 0) return "";

  return kept.join("\n\n");
}

/**
 * Blanks comments and string literal bodies so name detection never matches
 * prose. Order matters: block comments first (they may contain // and quotes),
 * then line comments, then triple-quoted strings, then ordinary strings.
 * @param {string} code - Dart source
 * @returns {string} Source with comment/string content removed
 */
function stripCommentsAndStringBodies(code) {
  return String(code ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/'''[\s\S]*?'''/g, '""')
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

/**
 * Names of the public widget classes declared in Dart source. FlutterFlow can
 * place any public class whose superclass is a Widget - not only a literal
 * `StatelessWidget`/`StatefulWidget`: `ConsumerStatefulWidget`,
 * `StatelessHookWidget`, and other transitive Widget subclasses place
 * normally, so matching "extends <something>Widget" covers them without
 * false-rejecting a healthy single-file widget. Private (underscore-prefixed)
 * helpers are excluded: FlutterFlow never places them directly.
 * @param {string} code - Dart source
 * @returns {string[]} Declared public widget class names, in declaration order
 */
export function getDeclaredWidgetClasses(code) {
  const stripped = stripCommentsAndStringBodies(code);
  return Array.from(
    stripped.matchAll(/class\s+([A-Z]\w*)\s+extends\s+[A-Za-z_]\w*Widget\b/g),
    (match) => match[1],
  );
}

/**
 * The file name FlutterFlow expects for a widget class: its naive snake_case
 * of the identifier (`LiquidGlassOrbs` -> `liquid_glass_orbs.dart`). FF reads
 * the widget's identity back out of the committed file name, so this is the
 * only name under which the class is findable.
 * @param {string} className - Public widget class name
 * @returns {string} File name to commit the class under
 */
export function widgetFileNameForClass(className) {
  return `${identifierToFlutterFlowFileStem(className)}.dart`;
}

/**
 * The widget class FlutterFlow will look for inside a committed file, derived
 * the same way FF derives it - from the file name alone.
 * @param {string} fileName - Bare file name, e.g. "liquid_glass_orbs.dart"
 * @returns {string} Class name FF resolves, e.g. "LiquidGlassOrbs"
 */
export function expectedWidgetClassFromFileName(fileName) {
  return deriveIdentifierName(fileName, "W");
}

const OPENERS = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = { ")": "(", "]": "[", "}": "{" };
// Identifier characters that disqualify a preceding r/R from starting a raw
// string. `$` is deliberately absent: in `${r'...'}'` the character before
// the prefix can be `$`/`{` interpolation syntax, and treating `$` as an
// identifier tail made valid interpolated raw strings misclassify as
// ordinary strings whose backslash escapes the closing quote (STU-148).
const IDENTIFIER_TAIL = /[A-Za-z0-9_]/;

/**
 * Single lexical pass over Dart source using a frame stack that models
 * nesting: top-level code, bracketed regions, comments, strings, and string
 * interpolations. It produces two things from one walk:
 *
 * - `error`: the first bracket-balance problem, or null when brackets balance.
 *   This is what FlutterFlow's formatter actually fails on - "Custom widget
 *   code is not formattable" - so catching it client-side turns a cryptic
 *   post-push rejection into an actionable pre-commit error.
 * - `commentAndStringRanges`: character spans occupied by comments and string
 *   literals (delimiters included). Consumers use these to tell literal Dart
 *   content apart from structural code - e.g. a ``` marker inside a doc string
 *   is content, not a markdown fence (STU-147).
 *
 * The scan tracks comments, string literals, and `${...}` interpolations so
 * brackets that belong to strings or docs never count, including nested cases
 * like `user['name']` inside an interpolation. Block comments nest the way
 * Dart defines them: every inner comment opener raises the depth and only
 * enough closers bring the span back to zero, so a lone inner closer cannot
 * terminate the comment early (STU-147). Raw strings (`r'...'`, `R'''...'''`) are
 * honored: their backslash escapes nothing and they never interpolate, so a
 * raw string ending in a backslash closes at its quote instead of being
 * misread as an escaped one (STU-148).
 *
 * Unterminated tokens never pass silently: a string frame still open at EOF,
 * or an ordinary string broken by a bare newline (illegal in Dart), is
 * reported through `error` with its opening line - triple-quoted strings stay
 * legal while open mid-source but error if never closed by EOF (STU-148).
 * Tokens still open at end of input have their span closed there, so
 * consumers always see the full extent of unterminated strings/comments even
 * though the scan flags them.
 * @param {string} src - Dart source (any text; never throws)
 * @returns {{error: string|null, commentAndStringRanges: Array<{start: number, end: number}>}}
 */
function scanDartSource(src) {
  // Frames model nesting: top-level code, bracketed regions, comments,
  // strings, and string interpolations. Every frame knows what ends it.
  const frames = [{ kind: "code", opener: null, openedLine: 0 }];
  const commentAndStringRanges = [];
  let line = 1;
  let i = 0;

  // First problem found that does not halt the scan (an unterminated ordinary
  // string broken by a newline). The scan keeps walking so ranges and later
  // bracket attribution stay correct, but this error still blocks the gate.
  let firstError = null;

  // Unterminated tokens still occupy source: close their spans at end of
  // input so consumers always see the full extent of any string/comment still
  // open when the scan stops - on an error or at EOF alike.
  const closeOpenTokenSpans = () => {
    for (const frame of frames) {
      if (
        frame.kind === "string"
        || frame.kind === "block-comment"
        || frame.kind === "line-comment"
      ) {
        commentAndStringRanges.push({ start: frame.startIndex, end: src.length });
      }
    }
  };

  while (i < src.length) {
    const ch = src[i];
    const frame = frames[frames.length - 1];

    if (frame.kind === "line-comment") {
      if (ch === "\n") {
        commentAndStringRanges.push({ start: frame.startIndex, end: i });
        frames.pop();
      } else i++;
      continue;
    }

    if (frame.kind === "block-comment") {
      // Dart block comments nest: each inner /* raises the depth, and the
      // comment only ends once enough */ closers bring it back to zero. A
      // lone inner closer must not end the span - everything up to the real
      // close stays protected content.
      if (ch === "*" && src[i + 1] === "/") {
        frame.depth--;
        if (frame.depth === 0) {
          commentAndStringRanges.push({ start: frame.startIndex, end: i + 2 });
          frames.pop();
        }
        i += 2;
      } else if (ch === "/" && src[i + 1] === "*") {
        frame.depth++;
        i += 2;
      } else {
        if (ch === "\n") line++;
        i++;
      }
      continue;
    }

    if (frame.kind === "string") {
      // A bare newline cannot appear inside a non-triple Dart string: this
      // string is unterminated. End its span at the newline so later lines
      // still scan (and fence recognition still sees them) but surface the
      // break - silently healing used to let malformed source pass the
      // pre-commit gate and fail opaquely inside FlutterFlow (STU-148).
      if (!frame.triple && ch === "\n") {
        commentAndStringRanges.push({ start: frame.startIndex, end: i });
        firstError ??= `line ${line}: string starting on line ${frame.openedLine} is never closed`;
        frames.pop();
        continue;
      }
      if (!frame.raw && ch === "\\") {
        // An escaped newline is a line continuation - keep the line count true.
        if (src[i + 1] === "\n") line++;
        i += 2;
        continue;
      }
      if (!frame.raw && ch === "$" && src[i + 1] === "{") {
        frames.push({ kind: "code", opener: null, interpolation: true });
        i += 2;
        continue;
      }
      const closerLength = frame.triple ? 3 : 1;
      if (
        ch === frame.quote
        && src.slice(i, i + closerLength) === frame.quote.repeat(closerLength)
      ) {
        commentAndStringRanges.push({
          start: frame.startIndex,
          end: i + closerLength,
        });
        frames.pop();
        i += closerLength;
        continue;
      }
      if (ch === "\n") line++;
      i++;
      continue;
    }

    // --- code frame ---
    if (ch === "/" && src[i + 1] === "/") {
      frames.push({ kind: "line-comment", startIndex: i });
      i += 2;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      frames.push({ kind: "block-comment", startIndex: i, openedLine: line, depth: 1 });
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const triple = src.slice(i, i + 3) === ch.repeat(3);
      // r'...' / R'''...''' are raw strings: the r must not be the tail of a
      // longer identifier, or `var bar'` style code would misclassify.
      const prev = i > 0 ? src[i - 1] : "";
      const beforePrev = i > 1 ? src[i - 2] : "";
      const raw =
        (prev === "r" || prev === "R") && !IDENTIFIER_TAIL.test(beforePrev);
      frames.push({ kind: "string", quote: ch, triple, raw, startIndex: i, openedLine: line });
      i += triple ? 3 : 1;
      continue;
    }
    if (OPENERS[ch]) {
      frames.push({ kind: "code", opener: ch, openedLine: line });
      i++;
      continue;
    }
    if (CLOSERS[ch]) {
      if (frame.interpolation && ch === "}") {
        frames.pop();
        i++;
        continue;
      }
      if (frame.opener && OPENERS[frame.opener] === ch) {
        frames.pop();
        i++;
        continue;
      }
      if (frame.opener) {
        closeOpenTokenSpans();
        return {
          error: firstError
            ?? `line ${line}: "${ch}" closes nothing - "${frame.opener}" opened on line ${frame.openedLine} is still open`,
          commentAndStringRanges,
        };
      }
      // A closer can never legitimately reach an interpolation or top-level
      // frame: whatever it closes would have to sit above it in the stack.
      closeOpenTokenSpans();
      return {
        error: firstError ?? `line ${line}: unexpected "${ch}" with no matching opener`,
        commentAndStringRanges,
      };
    }
    if (ch === "\n") line++;
    i++;
  }

  closeOpenTokenSpans();

  let error = firstError;
  if (!error) {
    const remaining = frames[frames.length - 1];
    if (!(remaining.kind === "code" && !remaining.opener && !remaining.interpolation)) {
      if (remaining.kind === "string") {
        error = `unclosed ${remaining.triple ? "triple-quoted " : ""}string starting on line ${remaining.openedLine} was never closed`;
      } else if (remaining.kind === "block-comment") {
        error = `unterminated /* comment starting on line ${remaining.openedLine}`;
      } else if (remaining.kind === "line-comment") {
        error = null; // Ends at end-of-input by definition.
      } else if (remaining.interpolation) {
        const openerFrame = frames.findLast((f) => f.opener);
        const where = openerFrame ? ` opened on line ${openerFrame.openedLine}` : "";
        error = `unclosed "\${" expression${where} was never closed`;
      } else {
        error = `"${remaining.opener}" opened on line ${remaining.openedLine} is never closed`;
      }
    }
  }

  return { error, commentAndStringRanges };
}

/**
 * Reports the first bracket-balance problem in Dart source, or null when the
 * brackets balance. See scanDartSource for the lexical rules.
 * @param {string} code - Dart source
 * @returns {string|null} Precise error message, or null when balanced
 */
export function findUnbalancedBracketError(code) {
  return scanDartSource(String(code ?? "")).error;
}

/**
 * Whether a character offset falls inside any recorded comment or string span.
 * @param {number} offset - Character offset into the scanned source
 * @param {Array<{start: number, end: number}>} ranges - Comment/string spans
 * @returns {boolean} True when the offset lies inside a span
 */
function offsetIsInsideCommentOrString(offset, ranges) {
  return ranges.some(({ start, end }) => offset >= start && offset < end);
}
