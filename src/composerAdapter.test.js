import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_SUGGESTIONS,
  SUGGESTION_DEBOUNCE_MS,
  SUGGESTION_MIN_CHARS,
  canSubmit,
  createSuggestionSession,
  resolveLocalSuggestion,
} from "./composerAdapter.js";

// The 13 local prototype patterns (custom-code-connect-hero.html:1402-1410),
// in prototype order. Earlier patterns win when several could match.
const PROTOTYPE_PATTERNS = [
  [/gradient stroke\s*$/i, " and an animated percentage label"],
  [/gauge\s*$/i, " with a gradient stroke and animated fill"],
  [/rating\s*(bar|widget)?\s*$/i, " with half-star support and haptic feedback"],
  [/list\s*$/i, " with swipe-to-delete and an undo snackbar"],
  [/pad\s*$/i, " that exports a transparent PNG"],
  [/carousel\s*$/i, " with parallax cards and page indicators"],
  [/(button|cta)\s*$/i, " with a loading spinner and success state"],
  [/(chart|graph)\s*$/i, " that animates from a Firestore stream"],
  [/action\s*(that|to)?\s*$/i, " uploads an image to Firebase Storage and returns the URL"],
  [/timer\s*$/i, " with pause, resume and a completion callback"],
  [/map\s*$/i, " with clustered markers and a custom info window"],
  [/^a\s+\w*$/i, " widget that"],
  [/(picker|selector)\s*$/i, " with search and multi-select"],
];

test("carries exactly the thirteen prototype patterns in prototype order", () => {
  assert.equal(LOCAL_SUGGESTIONS.length, 13);
  PROTOTYPE_PATTERNS.forEach(([pattern, suffix], index) => {
    assert.equal(LOCAL_SUGGESTIONS[index][0].source, pattern.source);
    assert.equal(LOCAL_SUGGESTIONS[index][0].flags, pattern.flags);
    assert.equal(LOCAL_SUGGESTIONS[index][1], suffix);
  });
});

test("uses the prototype's debounce and minimum character settings", () => {
  assert.equal(SUGGESTION_DEBOUNCE_MS, 220);
  assert.equal(SUGGESTION_MIN_CHARS, 6);
});

test("matches each prototype pattern with its exact completion", () => {
  const cases = [
    ["A circular progress gauge with a gradient stroke", " and an animated percentage label"],
    ["A progress gauge", " with a gradient stroke and animated fill"],
    ["An animated 5-star rating bar", " with half-star support and haptic feedback"],
    ["A star rating widget", " with half-star support and haptic feedback"],
    ["A scrollable list", " with swipe-to-delete and an undo snackbar"],
    ["A signature pad", " that exports a transparent PNG"],
    ["An image carousel", " with parallax cards and page indicators"],
    ["A submit button", " with a loading spinner and success state"],
    ["A primary CTA", " with a loading spinner and success state"],
    ["A line chart", " that animates from a Firestore stream"],
    ["A bar graph", " that animates from a Firestore stream"],
    ["A custom action that", " uploads an image to Firebase Storage and returns the URL"],
    ["An action to", " uploads an image to Firebase Storage and returns the URL"],
    ["A countdown timer", " with pause, resume and a completion callback"],
    ["A Google map", " with clustered markers and a custom info window"],
    ["a calendar", " widget that"],
    ["A slider", " widget that"],
    ["A date picker", " with search and multi-select"],
    ["A color selector", " with search and multi-select"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(resolveLocalSuggestion(input), expected, `input: ${input}`);
  }
});

test("suggests case-insensitively", () => {
  assert.equal(
    resolveLocalSuggestion("A COUNTDOWN TIMER"),
    " with pause, resume and a completion callback",
  );
});

test("lets earlier patterns win over the generic 'a <word>' pattern", () => {
  // "A gauge" also matches /^a\s+\w*$/i, but the gauge pattern is listed first.
  assert.equal(
    resolveLocalSuggestion("A gauge"),
    " with a gradient stroke and animated fill",
  );
});

test("returns null for missing, empty and whitespace-only input", () => {
  assert.equal(resolveLocalSuggestion(null), null);
  assert.equal(resolveLocalSuggestion(undefined), null);
  assert.equal(resolveLocalSuggestion(""), null);
  assert.equal(resolveLocalSuggestion("   "), null);
  assert.equal(resolveLocalSuggestion(" \n\t "), null);
});

test("returns null below the prototype minimum character count", () => {
  // "a ma" matches /^a\s+\w*$/i but is shorter than the six-character gate.
  assert.equal(resolveLocalSuggestion("a ma"), null);
});

test("returns null after sentence-ending punctuation", () => {
  assert.equal(resolveLocalSuggestion("A widget that spins."), null);
  assert.equal(resolveLocalSuggestion("A widget that spins!"), null);
  assert.equal(resolveLocalSuggestion("A widget that spins?"), null);
  assert.equal(resolveLocalSuggestion("A widget that spins. "), null);
});

test("returns null when nothing matches", () => {
  assert.equal(resolveLocalSuggestion("Generate some code for me please"), null);
});

test("session resolves, accepts and never re-triggers on the accepted text", () => {
  const session = createSuggestionSession();

  const suffix = session.resolve("A progress gauge");
  assert.equal(suffix, " with a gradient stroke and animated fill");
  assert.equal(session.active, suffix);

  const accepted = session.accept("A progress gauge");
  assert.equal(accepted, "A progress gauge with a gradient stroke and animated fill");
  assert.equal(session.active, "");

  // Resolving the accepted text must not loop the suggestion back.
  assert.equal(session.resolve(accepted), "");
  assert.equal(session.active, "");
});

test("session dismiss drops the suggestion so Tab cannot accept it", () => {
  const session = createSuggestionSession();
  session.resolve("A signature pad");
  assert.equal(session.active, " that exports a transparent PNG");

  session.dismiss();
  assert.equal(session.active, "");
  // No active suggestion: Tab must fall through and move focus instead.
  assert.equal(session.accept("A signature pad"), null);
});

test("session accept without an active suggestion is a no-op", () => {
  const session = createSuggestionSession();
  assert.equal(session.accept("A progress gauge"), null);
});

test("session can re-show a dismissed suggestion on the next resolve", () => {
  const session = createSuggestionSession();
  session.resolve("A signature pad");
  session.dismiss();

  // Dismissal is not a permanent block: the same text still matches.
  assert.equal(session.resolve("A signature pad"), " that exports a transparent PNG");
});

test("session keeps serving fresh suggestions after an acceptance", () => {
  const session = createSuggestionSession();
  session.resolve("An image carousel");
  const accepted = session.accept("An image carousel");
  assert.equal(accepted, "An image carousel with parallax cards and page indicators");

  assert.equal(
    session.resolve("A countdown timer"),
    " with pause, resume and a completion callback",
  );
});

test("canSubmit refuses empty, whitespace-only and busy input", () => {
  assert.equal(canSubmit("", false), false);
  assert.equal(canSubmit("   \n\t ", false), false);
  assert.equal(canSubmit(null, false), false);
  assert.equal(canSubmit("A progress gauge", true), false);
  assert.equal(canSubmit("A progress gauge", false), true);
});
