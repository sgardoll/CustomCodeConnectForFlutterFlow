import assert from "node:assert/strict";
import test from "node:test";
import {
  HERO_DEMO_ERASE_MS,
  HERO_DEMO_HOLD_MS,
  HERO_DEMO_READ_MS,
  HERO_DEMO_TYPE_MS,
  canSubmit,
  heroDemoFrame,
} from "./composerAdapter.js";

const LENGTH = "A circular progress gauge with a gradient stroke".length;
const TYPED_AT = HERO_DEMO_HOLD_MS + (LENGTH - 1) * HERO_DEMO_TYPE_MS;
const ERASE_AT = TYPED_AT + HERO_DEMO_READ_MS;
const DONE_AT = ERASE_AT + (LENGTH - 1) * HERO_DEMO_ERASE_MS;

test("canSubmit refuses empty, whitespace-only and busy input", () => {
  assert.equal(canSubmit("", false), false);
  assert.equal(canSubmit("   \n\t ", false), false);
  assert.equal(canSubmit(null, false), false);
  assert.equal(canSubmit("A progress gauge", true), false);
  assert.equal(canSubmit("A progress gauge", false), true);
});

test("hero demo holds empty with a blinking caret, then types one character per beat", () => {
  assert.deepEqual(heroDemoFrame(0, LENGTH), {
    chars: 0,
    keying: false,
    done: false,
    next: HERO_DEMO_HOLD_MS,
  });
  assert.equal(heroDemoFrame(HERO_DEMO_HOLD_MS - 1, LENGTH).chars, 0);
  assert.deepEqual(heroDemoFrame(HERO_DEMO_HOLD_MS, LENGTH), {
    chars: 1,
    keying: true,
    done: false,
    next: HERO_DEMO_TYPE_MS,
  });
  assert.equal(heroDemoFrame(HERO_DEMO_HOLD_MS + HERO_DEMO_TYPE_MS, LENGTH).chars, 2);
});

test("hero demo rests on the full example with the caret blinking, then erases", () => {
  assert.deepEqual(heroDemoFrame(TYPED_AT, LENGTH), {
    chars: LENGTH,
    keying: false,
    done: false,
    next: HERO_DEMO_READ_MS,
  });
  assert.equal(heroDemoFrame(ERASE_AT - 1, LENGTH).keying, false);
  assert.deepEqual(heroDemoFrame(ERASE_AT, LENGTH), {
    chars: LENGTH - 1,
    keying: true,
    done: false,
    next: HERO_DEMO_ERASE_MS,
  });
  assert.equal(heroDemoFrame(DONE_AT - 1, LENGTH).chars, 1);
  assert.deepEqual(heroDemoFrame(DONE_AT, LENGTH), {
    chars: 0,
    keying: true,
    done: true,
    next: 0,
  });
  assert.equal(heroDemoFrame(DONE_AT + 60000, LENGTH).done, true);
});

test("a late tick lands everything already due instead of stretching the demo", () => {
  // Ten typing beats plus a little: a timer that fired 700ms late still shows
  // the eleventh character, exactly as an on-time tick would.
  const late = heroDemoFrame(HERO_DEMO_HOLD_MS + 10 * HERO_DEMO_TYPE_MS + 5, LENGTH);
  assert.equal(late.chars, 11);
  assert.equal(late.next, HERO_DEMO_TYPE_MS - 5);
  // A tick that sleeps through the whole erase still ends the demo on time.
  assert.equal(heroDemoFrame(DONE_AT + 1, LENGTH).done, true);
});

test("sampled every millisecond, the demo types up and erases down one character at a time", () => {
  const seen = [];
  for (let elapsed = 0; elapsed <= DONE_AT; elapsed += 1) {
    const frame = heroDemoFrame(elapsed, LENGTH);
    if (seen[seen.length - 1] !== frame.chars) seen.push(frame.chars);
    // `next` always points at the exact moment the frame changes.
    if (!frame.done) {
      assert.ok(frame.next > 0, `next at ${elapsed}ms`);
      assert.notDeepEqual(heroDemoFrame(elapsed + frame.next, LENGTH), frame);
      assert.deepEqual(heroDemoFrame(elapsed + frame.next - 0.5, LENGTH).chars, frame.chars);
    }
  }
  const up = Array.from({ length: LENGTH + 1 }, (_, index) => index);
  const down = up.slice(0, -1).reverse();
  assert.deepEqual(seen, [...up, ...down]);
});
