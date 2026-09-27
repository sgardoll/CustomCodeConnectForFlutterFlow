/**
 * Pipeline logo loop (STU-390) — the authored logo animation ported into the
 * pipeline presentation.
 *
 * Source: custom-code-connect-hero.html (`hero pose()/paint()/track()` and the
 * arena lifecycle). This module preserves the hero's two-piece mark geometry
 * and its twelve-beat, seamless 120-second authored motion for the decorative
 * mark that sits in the pipeline arena.
 *
 * It is strictly DECORATIVE: pipeline completion depends only on real backend
 * events, never on this module. The transformation/opacity pose is applied to
 * the same `.loop-*` DOM elements the hero uses, so the two still share one
 * geometry contract.
 *
 * Rendering lifecycle:
 *  - Pauses/stops the clock when the hidden tab, the CSS-hidden pipeline
 *    (`display:none` -> `offsetParent === null`) or the viewport-offscreen
 *    arena (IntersectionObserver) would leave nothing visible on screen.
 *    These are checked separately, not conflated: `offsetParent` alone proves
 *    an element is in layout, not that it is on screen.
 *  - Holds a static rest frame for `prefers-reduced-motion: reduce` and stops
 *    the loop live when the preference changes, without a reload.
 *  - The 120 s loop boundary is exact: `pose(0) === pose(120)` for every
 *    animated key, so the seam is invisible. start() is idempotent, so
 *    leaving and re-entering the pipeline can never accumulate a second
 *    requestAnimationFrame loop.
 *
 * `pose`, `track` and `LOOP_DURATION` are exported pure so their loop-boundary
 * and brand-geometry guarantees are unit-testable under Node.
 */

export const LOOP_DURATION = 120; // seconds, the authored twelve-beat loop length

/* ------------------------------------------------------------------ */
/* Easing + keyframe helpers (pure)                                    */
/* ------------------------------------------------------------------ */

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
function prog(t, a, b) {
  return clamp((t - a) / (b - a), 0, 1);
}
function io(x) {
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}
function out(x) {
  return 1 - Math.pow(1 - x, 3);
}
function back(x, s) {
  s = s === undefined ? 1.7 : s;
  return 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2);
}
function spring(x) {
  return 1 - Math.pow(2, -9 * x) * Math.cos(x * 15);
}

/**
 * Evaluate a keyframe track at local time `t`. Keys are `[{t, v, e}]` and the
 * ease belongs to the segment *ending* at that key.
 */
export function track(t, keys) {
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1];
      const b = keys[i];
      return a.v + (b.v - a.v) * (b.e || io)(prog(t, a.t, b.t));
    }
  }
  return keys[keys.length - 1].v;
}

/* ------------------------------------------------------------------ */
/* The twelve beats                                                    */
/* ------------------------------------------------------------------ */

const REST = {
  /* Defaults are the rest pose, which beat 12 must land on exactly. */
  x: 0, y: 0, rot: 0, scale: 1,
  ax: 0, ay: 0, ar: 0, asc: 1, afade: 1,
  bx: 0, by: 0, br: 0, bsc: 1, bfade: 1,
  hfade: 1, hsc: 1, shd: 0,
};
export const LOGO_POSE_KEYS = Object.freeze(Object.keys(REST));

/**
 * Pose of the mark at loop-local time `t` (seconds, 0..120). Ported verbatim
 * from the canonical hero. Returns a plain object of normalised offsets:
 * mark (x/y/rot/scale), piece A (ax/ay/ar/asc/afade), piece B (bx/by/br/bsc/
 * bfade), halo (hfade/hsc) and shadow (shd). `pose(120) === pose(0)`.
 */
export function pose(t) {
  const outPose = Object.assign({}, REST);
  let x = 0, y = 0, rot = 0, scale = 1;
  let ax = 0, ay = 0, ar = 0, asc = 1, afade = 1;
  let bx = 0, by = 0, br = 0, bsc = 1, bfade = 1;
  let hfade = 1, hsc = 1, shd = 0;

  if (t < 9) {
    /* 01 · Wake up — a swell, a look around, two blinks. */
    scale = track(t, [{ t: 0, v: 1 }, { t: 1.2, v: 1.062, e: back }, { t: 2.9, v: 1 }]);
    x = track(t, [{ t: 0, v: 0 }, { t: 2.6, v: 0.18 }, { t: 3.2, v: 0.03 }, { t: 4.8, v: 0, e: back }]);
    y = track(t, [{ t: 0, v: 0 }, { t: 2.6, v: -0.2 }, { t: 3.2, v: 0.14 }, { t: 4.8, v: 0, e: back }]);
    rot = track(t, [{ t: 0, v: 0 }, { t: 2.6, v: 3.4 }, { t: 3.2, v: -3.8 }, { t: 4.8, v: 0, e: back }]);
    if (Math.abs(t - 4.0) < 0.11 || Math.abs(t - 4.45) < 0.12) { afade = 0.32; bfade = 0.32; }
    hfade = track(t, [{ t: 0, v: 1 }, { t: 4.5, v: 1.9 }, { t: 8.9, v: 1 }]);
    hsc = track(t, [{ t: 0, v: 1 }, { t: 4.5, v: 1.16 }, { t: 8.9, v: 1 }]);
  } else if (t < 19) {
    /* 02 · Glide — two full-width skims across the arena, then a settle run home. */
    const g = t - 9;
    x = track(g, [{ t: 0, v: 0 }, { t: 3.6, v: 1 }, { t: 7.4, v: 0.12 }, { t: 10, v: 0 }]);
    y = track(g, [{ t: 0, v: 0 }, { t: 1.8, v: -0.5 }, { t: 3.6, v: 0 }, { t: 5.5, v: -0.45 }, { t: 7.4, v: 0 }, { t: 8.4, v: -0.18 }, { t: 10, v: 0 }]);
    rot = track(g, [{ t: 0, v: 0 }, { t: 1, v: 7 }, { t: 2.4, v: 0 }, { t: 4.8, v: -7 }, { t: 6.2, v: 0 }, { t: 8.4, v: 3 }, { t: 10, v: 0 }]);
    shd = prog(g, 0, 0.4) * (1 - prog(g, 9.4, 10));
  } else if (t < 23) {
    /* 03 · Rewind — one fast pass right to left, then a snap home. */
    const r = t - 19;
    x = track(r, [{ t: 0, v: 0, e: out }, { t: 1.4, v: 1 }, { t: 2.6, v: 0.08 }, { t: 4, v: 0, e: back }]);
    y = track(r, [{ t: 0, v: 0 }, { t: 1.4, v: -0.35 }, { t: 2.6, v: -0.3 }, { t: 4, v: 0, e: back }]);
    rot = track(r, [{ t: 0, v: 0, e: out }, { t: 1.2, v: -9 }, { t: 2.6, v: 11 }, { t: 4, v: 0, e: back }]);
    shd = prog(r, 0, 0.3) * (1 - prog(r, 3.6, 4));
  } else if (t < 32) {
    /* 04 · Magnet — flung wide each way, then a snap and a recoil. */
    const m = t - 23;
    const fling = track(m, [{ t: 0, v: 0 }, { t: 1.6, v: 0.72 }, { t: 2.2, v: 0.66 }, { t: 3.4, v: 0, e: back }, { t: 4.1, v: -0.07 }, { t: 5.1, v: 0 }]);
    ax = fling; bx = -fling; ar = fling * 26; br = -fling * 26;
    scale = track(m, [{ t: 0, v: 1 }, { t: 1.6, v: 0.94 }, { t: 3.4, v: 1.04, e: back }, { t: 5.1, v: 1 }]);
    hfade = track(m, [{ t: 0, v: 1 }, { t: 1.6, v: 1.8 }, { t: 5.1, v: 1 }]);
    shd = prog(m, 0, 0.3) * (1 - prog(m, 8, 9));
  } else if (t < 42) {
    /* 05 · Breathe — a slow pulse and one small hiccup. */
    const b = t - 32;
    const swell = Math.sin(prog(b, 0, 8) * Math.PI);
    scale = 1 + 0.055 * swell;
    y = -0.12 * swell;
    hfade = 1 + 0.5 * swell;
    if (b > 8.2 && b < 9.4) scale *= 1 - 0.07 * Math.sin(prog(b, 8.2, 9.4) * Math.PI);
  } else if (t < 53) {
    /* 06 · Peek-a-boo — the second C hides, peeks, then ducks back. */
    const k = t - 42;
    bfade = track(k, [{ t: 0, v: 1 }, { t: 2, v: 0 }, { t: 4.2, v: 0 }, { t: 4.6, v: 1 }, { t: 6.8, v: 1 }, { t: 7.4, v: 0 }, { t: 9.4, v: 0 }, { t: 10.6, v: 1 }]);
    bsc = track(k, [{ t: 0, v: 1 }, { t: 2, v: 0.3 }, { t: 4.6, v: 1, e: back }]);
    bx = track(k, [{ t: 0, v: 0 }, { t: 2, v: 0.3 }, { t: 4.6, v: 0.16, e: back }, { t: 10.6, v: 0 }]);
    br = track(k, [{ t: 0, v: 0 }, { t: 2, v: -40 }, { t: 4.6, v: 0, e: back }]);
    ax = track(k, [{ t: 0, v: 0 }, { t: 4.6, v: -0.12 }, { t: 10.6, v: 0 }]);
  } else if (t < 60) {
    /* 07 · Insert coin — both Cs drop in onto the mark. Each fades out first, so the jump
       up to the drop height happens while it is invisible rather than as a visible pop. */
    const c = t - 53;
    afade = track(c, [{ t: 0, v: 1 }, { t: 0.35, v: 0 }, { t: 0.45, v: 0 }, { t: 0.7, v: 1 }]);
    const dropA = prog(c, 0.45, 2.2);
    ay = dropA > 0 ? -2.6 * (1 - spring(dropA)) : 0;
    bfade = track(c, [{ t: 0, v: 1 }, { t: 0.57, v: 0 }, { t: 0.67, v: 0 }, { t: 0.92, v: 1 }]);
    const dropB = prog(c, 0.67, 2.42);
    by = dropB > 0 ? -2.6 * (1 - spring(dropB)) : 0;
    scale = 1 - 0.05 * (Math.sin(prog(c, 1.9, 2.5) * Math.PI) + Math.sin(prog(c, 2.5, 3.1) * Math.PI));
  } else if (t < 74) {
    /* 08 · Pac-chase — a full lap of the arena; the second piece trails the first. */
    const p = t - 60;
    function lap(u) {
      return [
        track(u, [{ t: 0, v: 0 }, { t: 0.25, v: 1 }, { t: 0.5, v: 1 }, { t: 0.72, v: 0.14 }, { t: 0.82, v: 0.14 }, { t: 1, v: 0 }]),
        track(u, [{ t: 0, v: 0 }, { t: 0.08, v: -0.62 }, { t: 0.25, v: -0.62 }, { t: 0.33, v: 0.62 }, { t: 0.7, v: 0.62 }, { t: 0.82, v: -0.62 }, { t: 1, v: -0.62 }]),
      ];
    }
    const settle = 1 - prog(p, 12, 14);
    const head = lap(prog(p, 0, 12));
    const tail = lap(prog(p - 0.5, 0, 12));
    x = head[0] * settle;
    y = (head[1] + 0.05 * Math.sin(p * 7)) * settle;
    ax = (tail[0] - head[0]) * 0.6 * settle;
    ay = (tail[1] - head[1]) * 0.6 * settle;
    br = (tail[0] - head[0]) * 30 * settle;
    shd = prog(p, 0, 0.4) * settle;
  } else if (t < 85.4) {
    /* 09 · Leaning — standing apart, they lean in until one slips. */
    const l = t - 74;
    const apart = track(l, [{ t: 0, v: 0 }, { t: 4, v: 1 }, { t: 8, v: 0.24 }, { t: 9.6, v: 1, e: back }, { t: 11.4, v: 0 }]);
    ax = apart * 0.5; bx = -apart * 0.5;
    ar = track(l, [{ t: 0, v: 0 }, { t: 4, v: 6 }, { t: 8, v: 20 }, { t: 9.6, v: 38, e: back }, { t: 11.4, v: 0 }]);
    br = -ar * 0.7;
    ay = track(l, [{ t: 0, v: 0 }, { t: 8, v: 0 }, { t: 9.6, v: 0.4 }, { t: 11.4, v: 0 }]);
  } else if (t < 96.4) {
    /* 10 · Orbit & clap — one full orbit, then a high five. */
    const o = t - 85.4;
    const orbit = prog(o, 0, 5.6);
    const ret = prog(o, 5.6, 7.6);
    const radius = 0.72 * Math.min(1, o / 0.6) * (1 - ret);
    bx = Math.cos(orbit * Math.PI * 2) * radius;
    by = Math.sin(orbit * Math.PI * 2) * radius * 0.55;
    br = orbit * 360 * (1 - ret);
    const clap = track(o, [{ t: 0, v: 0 }, { t: 7.6, v: 0 }, { t: 8.2, v: 1, e: out }, { t: 8.6, v: 0.55 }, { t: 9.4, v: 0 }]);
    ax = -0.16 * clap;
    bx += 0.16 * clap;
    ar = -6 * clap;
    br += 6 * clap;
    scale = 1 + 0.05 * clap;
    hfade = 1 + 0.9 * clap;
  } else if (t < 108.6) {
    /* 11 · Jelly beans — the mark runs the arena, nibbling as it goes. */
    const j = t - 96.4;
    const settle2 = prog(j, 9.6, 12.2);
    x = track(j, [{ t: 0, v: 0 }, { t: 2.1, v: 1 }, { t: 4.8, v: 0.08 }, { t: 7.5, v: 1 }, { t: 9.6, v: 0 }]) * (1 - settle2);
    y = -0.35 * Math.abs(Math.sin(prog(j, 0, 9.6) * Math.PI * 3)) * (1 - settle2);
    const nibble = Math.sin(j * 6.2) * (1 - settle2);
    asc = 1 + 0.12 * nibble; bsc = 1 - 0.12 * nibble;
    ar = nibble * 8; br = -nibble * 8;
    ax = 0.06 * nibble; bx = -0.06 * nibble;
    shd = prog(j, 0, 0.4) * (1 - settle2);
  } else {
    /* 12 · Goodnight — settle, breathe, drift off. Frame 120 lands on frame 0. */
    const d = t - 108.6;
    const slow = Math.sin(prog(d, 0, 8) * Math.PI);
    const fade = 1 - prog(d, 8, 11.4);
    scale = 1 + 0.04 * slow * fade;
    y = -0.1 * slow * fade;
    rot = 2 * slow * fade;
    hfade = 1 + 0.5 * Math.sin(prog(d, 0, 6) * Math.PI);
    hsc = 1 + 0.1 * Math.sin(prog(d, 0, 6) * Math.PI);
  }

  outPose.x = x; outPose.y = y; outPose.rot = rot; outPose.scale = scale;
  outPose.ax = ax; outPose.ay = ay; outPose.ar = ar; outPose.asc = asc; outPose.afade = afade;
  outPose.bx = bx; outPose.by = by; outPose.br = br; outPose.bsc = bsc; outPose.bfade = bfade;
  outPose.hfade = hfade; outPose.hsc = hsc; outPose.shd = shd;
  return outPose;
}

/* ------------------------------------------------------------------ */
/* Pipeline-arena DOM controller                                       */
/* ------------------------------------------------------------------ */

/**
 * Drive the decorative `.pipeline-glyph.logo-loop` mark inside a pipeline
 * arena. Returns `null` when the arena/mark markup is absent (so the rest of
 * the app is unaffected), otherwise a live controller with
 * `{ isRunning, currentTime, seek, dispose }`.
 */
export function createPipelineLogoLoop(options = {}) {
  const arena = options.arena || document.querySelector(".pipeline-glyph.logo-loop");
  if (!arena) return null;
  const mark = arena.querySelector(".loop-mark");
  const pieceA = arena.querySelector(".loop-piece-a");
  const pieceB = arena.querySelector(".loop-piece-b");
  const halo = arena.querySelector(".loop-halo");
  const shadow = arena.querySelector(".loop-shadow");
  if (!mark || !pieceA || !pieceB || !halo || !shadow) return null;

  const reduce = options.reducedMotion || window.matchMedia("(prefers-reduced-motion: reduce)");
  const DUR = LOOP_DURATION;
  let MARK = 34;
  let TRAVEL = 0;
  let YMAX = 0;

  function measure() {
    MARK = mark.offsetWidth || 34;
    // One-sided travel: 0 is the left edge (where the mark rests) and the 4px
    // right margin leaves the halo room so it never clips against the strip.
    TRAVEL = Math.max(0, arena.offsetWidth - MARK - 4);
    YMAX = Math.max(0, (arena.offsetHeight - MARK) / 2 - 2);
    arena.style.setProperty("--mark-c", MARK / 2 + "px");
  }

  function paint(p) {
    // Clamp to the strip: the settle easings overshoot a hair past the left edge.
    const px = Math.min(1, Math.max(0, p.x)) * TRAVEL;
    const py = p.y * YMAX;
    mark.style.transform =
      "translate3d(" + px.toFixed(2) + "px," + py.toFixed(2) + "px,0) rotate(" + p.rot.toFixed(2) + "deg) scale(" + p.scale.toFixed(3) + ")";
    pieceA.style.transform =
      "translate3d(" + (p.ax * MARK).toFixed(2) + "px," + (p.ay * MARK).toFixed(2) + "px,0) rotate(" + p.ar.toFixed(2) + "deg) scale(" + p.asc.toFixed(3) + ")";
    pieceA.style.opacity = p.afade.toFixed(3);
    pieceB.style.transform =
      "translate3d(" + (p.bx * MARK).toFixed(2) + "px," + (p.by * MARK).toFixed(2) + "px,0) rotate(" + p.br.toFixed(2) + "deg) scale(" + p.bsc.toFixed(3) + ")";
    pieceB.style.opacity = p.bfade.toFixed(3);
    halo.style.transform = "scale(" + p.hsc.toFixed(3) + ")";
    halo.style.opacity = (0.09 * p.hfade).toFixed(3);
    shadow.style.transform = "translateX(" + px.toFixed(2) + "px) scaleX(" + (0.75 + 0.4 * Math.abs(p.x)).toFixed(3) + ")";
    shadow.style.opacity = (p.shd * 0.5).toFixed(3);
  }

  let elapsed = 0;
  let last = 0;
  let raf = 0;
  let running = false;
  let intersecting = false;
  let disposed = false;
  let framesPainted = 0; // test-observable: frames that actually advanced the pose

  /* Every visibility condition is checked independently:
     - `document.hidden`  : hidden browser tab
     - `arena.offsetParent`: CSS-hidden (`display:none` etc. - in layout or not)
     - `intersecting`     : viewport visibility via IntersectionObserver
     `offsetParent` alone is NOT proof of viewport visibility, so all three
     must hold before the loop may run. */
  function shouldRun() {
    if (disposed) return false;
    if (reduce.matches) return false;
    if (document.hidden) return false;
    if (!arena.offsetParent) return false;
    return intersecting;
  }

  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (!shouldRun()) {
      // An edge visibility change that slipped past its listener still cannot
      // leave a loop turning over on an unseen arena.
      stop();
      return;
    }
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    elapsed = (elapsed + Math.min(dt, 0.1)) % DUR;
    framesPainted += 1;
    paint(pose(elapsed));
  }

  function start() {
    if (running || disposed) return;
    if (!shouldRun()) return;
    running = true;
    last = 0;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    last = 0;
  }

  function sync() {
    if (shouldRun()) start();
    else stop();
  }

  function onReduceChange() {
    if (reduce.matches) {
      stop();
      paint(pose(0)); // static rest frame for reduced motion
    } else {
      sync();
    }
  }

  function onResize() {
    measure();
    if (running) paint(pose(elapsed));
  }

  function onVisibility() {
    last = 0;
    sync();
  }

  const observer = new IntersectionObserver(
    (entries) => {
      intersecting = entries[0] ? entries[0].isIntersecting : false;
      sync();
    },
    { threshold: 0 }
  );
  observer.observe(arena);

  window.addEventListener("resize", onResize);
  reduce.addEventListener("change", onReduceChange);
  document.addEventListener("visibilitychange", onVisibility);

  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
    observer.disconnect();
    window.removeEventListener("resize", onResize);
    reduce.removeEventListener("change", onReduceChange);
    document.removeEventListener("visibilitychange", onVisibility);
  }

  window.addEventListener("pagehide", dispose);

  /* A helper to review a specific beat deterministically (also used by
     playwright visual artefacts): paints the pose for `t` without starting the
     loop e.g. `seek(10)`. */
  function seek(t) {
    elapsed = ((t % DUR) + DUR) % DUR;
    paint(pose(elapsed));
  }

  measure();
  paint(pose(0));
  sync();

  return {
    isRunning: () => running,
    currentTime: () => elapsed,
    frameCount: () => framesPainted,
    seek,
    dispose,
  };
}
