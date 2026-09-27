import test from "node:test";
import assert from "node:assert/strict";
import { LOGO_POSE_KEYS, LOOP_DURATION, pose, track } from "./logoMotion.js";

/**
 * STU-390 — authored logo animation, behavioural unit coverage.
 *
 * These tests target the pure animation core (`pose`/`track`/`LOOP_DURATION`)
 * so the loop-boundary and brand-geometry guarantees are falsifiable on a
 * clean machine with no browser and no network.
 *
 * Heritage: the pose is ported verbatim from custom-code-connect-hero.html
 * (beat 12 lands exactly on beat 1). Do not "tune" beat keyframes without
 * re-running this suite.
 */

function assertClose(actual, expected, tol, msg) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg ?? "value"}: expected ${expected} +/- ${tol}, got ${actual}`
  );
}

test("LOOP_DURATION is the authored 120-second loop", () => {
  assert.equal(LOOP_DURATION, 120);
});

test("pose(0) and pose(120) are identical on every animated key (seamless loop boundary)", () => {
  const a = pose(0);
  const b = pose(120);
  for (const key of LOGO_POSE_KEYS) {
    assertClose(a[key], b[key], 1e-9, `loop boundary mismatch on "${key}"`);
  }
});

test("the loop boundary is the authored rest pose (brand geometry intact)", () => {
  const rest = pose(0);
  // The mark sits centred over its two interlocked C pieces at identity.
  for (const key of ["x", "y", "rot", "ax", "ay", "ar", "bx", "by", "br", "shd"]) {
    assertClose(rest[key], 0, 1e-9, `rest "${key}" should be 0`);
  }
  for (const key of ["scale", "asc", "bsc", "afade", "bfade", "hfade", "hsc"]) {
    assertClose(rest[key], 1, 1e-9, `rest "${key}" should be 1`);
  }
});

test("pose is finite and bounded for every frame across the whole loop", () => {
  // Sweep in 1/30 s steps (the animation clock's finest practical step) so a
  // bad keyframe cannot hide between beats.
  for (let t = 0; t <= 120.0001; t += 1 / 30) {
    const p = pose(t);
    for (const key of LOGO_POSE_KEYS) {
      const v = p[key];
      assert.ok(Number.isFinite(v), `pose(${t.toFixed(3)}).${key} is ${v}`);
      // Rotations are in degrees and beat 10 is a full 360° orbit, so allow
      // rotational keys up to 400; everything else is a normalised offset.
      const bound = /^(rot|ar|br)$/.test(key) ? 400 : 60;
      assert.ok(Math.abs(v) <= bound, `pose(${t.toFixed(3)}).${key} = ${v}, out of range`);
    }
  }
});

test("track returns exact endpoint values and interpolates between them", () => {
  const keys = [{ t: 0, v: 0 }, { t: 5, v: 10, e: (x) => x }, { t: 10, v: 20, e: (x) => x }];
  assert.equal(track(0, keys), 0);
  assert.equal(track(5, keys), 10);
  assert.equal(track(10, keys), 20);
  // Linear ease -> midpoint lands in the middle.
  assertClose(track(2.5, keys), 5, 1e-9, "mid segment value");
});

test("pose is deterministic and pure (no state leaking between calls)", () => {
  const first = pose(37.25);
  const second = pose(37.25);
  for (const key of LOGO_POSE_KEYS) {
    assert.equal(first[key], second[key], `pose is not pure on "${key}"`);
  }
});
