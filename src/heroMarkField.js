/**
 * Hero mark field — ported from custom-code-connect-hero.html (STU-389).
 *
 * A decorative, pointer-transparent WebGL field of FlutterFlow marks. Falls back
 * to the 2D canvas API when WebGL2 is unavailable. Stops rendering for
 * reduced-motion preference, hidden/offscreen surfaces, page visibility changes,
 * or unsuitable pointer environments, while leaving the static page layout intact.
 */

export function initHeroMarkField() {
  let canvas = document.getElementById("fx-grid");
  if (!canvas) return null;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const noPointer = window.matchMedia("(pointer: none)");

  let gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    powerPreference: "low-power",
  });
  let ctx2d = gl ? null : canvas.getContext("2d");
  if (!gl && !ctx2d) return null;

  /* Official FlutterFlow mark (icon glyph from flutterflow.io's
     images/brand/PrimaryLogo.svg), isolated and embedded so the field is
     self-contained and works offline. */
  const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 6.4 30 30.4" width="256" height="256"><path fill="rgb(255,255,255)" fill-rule="evenodd" clip-rule="evenodd" d="M25.5304 7.46631C26.3902 7.46631 27.186 7.92462 27.5892 8.66966C27.9755 9.38331 27.9591 10.2243 27.5464 10.9223L27.5323 10.9458L23.9146 16.9074C23.5055 17.5816 22.767 18.0023 21.9776 18.0113L21.9518 18.0115L17.8207 18.0114L19.5377 21.8838L19.5446 21.8952L19.5551 21.9135C19.9595 22.6335 19.9496 23.4895 19.5303 24.1987L19.5162 24.2223L15.8985 30.184C15.4893 30.8581 14.7508 31.2789 13.9615 31.2879L13.9357 31.288L8.86521 31.288L5.22012 35.0753L5.21322 35.0823C4.87021 35.4258 4.40676 35.6174 3.92356 35.6174C3.80277 35.6174 3.6819 35.6054 3.56233 35.5814C2.97291 35.4629 2.4832 35.0644 2.24747 34.5149L2.24082 34.4992L0.322582 30.1613L0.312492 30.1447L0.302011 30.1268C0.30027 30.1238 0.298499 30.1206 0.29665 30.1173C-0.10772 29.3974 -0.0979261 28.5414 0.321374 27.8321L0.335502 27.8085L3.8443 22.0263L1.25884 16.1955L1.30622 16.1717L1.3055 16.1682C1.19611 15.6318 1.28417 15.0725 1.56512 14.5826L1.58064 14.556L1.59498 14.532L5.2127 8.57029C5.62186 7.89619 6.36044 7.47543 7.14972 7.46631H7.17548H25.5304ZM6.53453 31.2427L2.69069 31.2426L3.81966 33.8153L3.82244 33.8221C3.84115 33.8682 3.87142 33.8934 3.91648 33.9026C3.95667 33.9107 3.98919 33.9023 4.01994 33.8747L4.02532 33.8696L6.53453 31.2427ZM17.5229 22.3978H5.90385C5.89102 22.3978 5.87819 22.3983 5.86538 22.3991L5.86186 22.3994L9.0477 29.5783H13.9351C14.136 29.5783 14.3296 29.4723 14.4396 29.3021L14.4483 29.2882L18.0713 23.3229C18.1794 23.1449 18.1913 22.9385 18.1057 22.7527C18.0069 22.5384 17.7777 22.3978 17.5229 22.3978ZM4.69605 23.872L1.82063 28.6463C1.70621 28.8363 1.69958 29.0588 1.80204 29.2547L1.81291 29.2746L1.8187 29.2844L1.8303 29.3031L1.8533 29.3367L1.87897 29.3696L1.90353 29.3973L1.90779 29.4018L1.9244 29.4183L1.93883 29.4319C2.02928 29.5127 2.14109 29.5621 2.26441 29.5748L2.29212 29.5771L2.30816 29.5779L2.32848 29.5783H7.20721L4.69605 23.872ZM3.93994 18.023L5.20279 20.8761L5.22739 20.8679C5.44548 20.796 5.6735 20.757 5.90401 20.7535L5.93861 20.7532L17.2012 20.7532L15.9928 18.023L3.93994 18.023ZM25.4983 9.13065H13.8378L17.0246 16.3111H21.9103C22.1116 16.3111 22.3053 16.2051 22.4154 16.0348L22.4241 16.0208L26.0473 10.0556C26.1553 9.87773 26.1673 9.67143 26.0817 9.4858C25.985 9.27595 25.7632 9.13667 25.5146 9.13084L25.4983 9.13065ZM12.0528 9.13065H7.19416C6.99436 9.13065 6.80166 9.23641 6.69203 9.40642L6.68333 9.42035L3.06968 15.3857C2.9618 15.5637 2.94987 15.7705 3.03542 15.9565C3.13178 16.1662 3.35237 16.3051 3.59952 16.3109L3.61568 16.3111H15.2312L12.0528 9.13065Z"/></svg>';

  const VERT = "#version 300 es\nin vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }";

  function fragSource() {
    return [
      "#version 300 es",
      "precision highp float;",
      "out vec4 o;",
      "uniform vec2 res;",
      "uniform vec2 design;",
      "uniform vec2 mouse;",
      "uniform float energy;",
      "uniform float parallax;",
      "uniform float t;",
      "uniform vec3 ink;",
      "uniform sampler2D mark;",
      "uniform vec2 rot;",
      "const float WARP_A = 0.0032;",
      "void main(){",
      "  vec2 px = gl_FragCoord.xy * (design / res);",
      "  vec2 p = vec2(px.x, design.y - px.y);",
      "  vec2 off = vec2(0.0, -parallax) + vec2(sin(t * 0.11), cos(t * 0.09)) * 7.0;",
      "  vec2 g = p + off;",
      "  vec2 gm = mouse + off;",
      "  float base = min(design.x, design.y);",
      "  float spacing = clamp(base / 10.0, 64.0, 118.0);",
      "  vec2 rel = g - gm;",
      "  float rho = length(rel) + 1e-5;",
      "  vec2 dir = rel / rho;",
      "  vec2 pw = gm + dir * (rho + WARP_A * rho * rho);",
      "  vec2 cell = floor(pw / spacing);",
      "  vec2 cw = (cell + 0.5) * spacing - gm;",
      "  float Rc = length(cw) + 1e-5;",
      "  float rhoC = (-1.0 + sqrt(1.0 + 4.0 * WARP_A * Rc)) / (2.0 * WARP_A);",
      "  vec2 c = gm + (cw / Rc) * rhoC;",
      "  float cellSize = spacing / (1.0 + 2.0 * WARP_A * rhoC);",
      "  float sigma = spacing * 2.9;",
      "  float f = exp(-(rhoC * rhoC) / (2.0 * sigma * sigma));",
      "  float scale = mix(0.32, 1.42, f);",
      "  float weight = smoothstep(0.06, 0.80, f);",
      "  float hs = cellSize * 0.26 * scale;",
      "  vec2 uv = (g - c) / hs;",
      "  vec2 ruv = mat2(rot.x, rot.y, -rot.y, rot.x) * uv;",
      "  float cov = 0.0;",
      "  if (abs(ruv.x) <= 1.0 && abs(ruv.y) <= 1.0) cov = texture(mark, ruv * 0.5 + 0.5).a;",
      "  float s = cov * weight * energy * 0.26;",
      "  o = vec4(ink * s, s);",
      "}",
    ].join("\n");
  }

  let prog = null;
  let uRes, uDesign, uMouse, uEnergy, uParallax, uT, uInk, uMark, uRot;

  function compile(type, src) {
    if (!gl) return null;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      if (window.console) console.warn("fx-grid shader: " + gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  }

  if (gl) {
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, fragSource());
    if (vs && fs) {
      prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        if (window.console) console.warn("fx-grid link: " + gl.getProgramInfoLog(prog));
        prog = null;
      }
    }
    if (prog) {
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(prog, "p");
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      uRes = gl.getUniformLocation(prog, "res");
      uDesign = gl.getUniformLocation(prog, "design");
      uMouse = gl.getUniformLocation(prog, "mouse");
      uEnergy = gl.getUniformLocation(prog, "energy");
      uParallax = gl.getUniformLocation(prog, "parallax");
      uT = gl.getUniformLocation(prog, "t");
      uInk = gl.getUniformLocation(prog, "ink");
      uMark = gl.getUniformLocation(prog, "mark");
      uRot = gl.getUniformLocation(prog, "rot");
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0, 0, 0, 0);
    } else {
      // A dead GPU path should not leave the background empty. A canvas that
      // has held a WebGL context refuses to hand back a 2D one, so swap in a
      // clean element before falling back.
      gl = null;
      const replacement = canvas.cloneNode(false);
      canvas.parentNode.replaceChild(replacement, canvas);
      canvas = replacement;
      ctx2d = canvas.getContext("2d");
      if (!ctx2d) return null;
    }
  }

  function cssToRgb(value) {
    if (!value) return null;
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
    if (hex) {
      let h = hex[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return [
        parseInt(h.slice(0, 2), 16) / 255,
        parseInt(h.slice(2, 4), 16) / 255,
        parseInt(h.slice(4, 6), 16) / 255,
      ];
    }
    try {
      const probe = document.createElement("canvas");
      probe.width = 1;
      probe.height = 1;
      const pctx = probe.getContext("2d");
      pctx.fillStyle = "rgb(9, 8, 7)";
      const sentinel = String(pctx.fillStyle);
      pctx.fillStyle = value;
      const out = String(pctx.fillStyle);
      if (out === sentinel) return null;
      const asHex = /^#([0-9a-f]{6})$/i.exec(out);
      if (asHex) {
        const g = asHex[1];
        return [
          parseInt(g.slice(0, 2), 16) / 255,
          parseInt(g.slice(2, 4), 16) / 255,
          parseInt(g.slice(4, 6), 16) / 255,
        ];
      }
      const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(out);
      if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255];
    } catch (_) {}
    return null;
  }

  function readInk() {
    let value = "";
    try {
      const root = getComputedStyle(document.documentElement);
      value = (root.getPropertyValue("--fx-ink") || "").trim() || (root.getPropertyValue("--fg") || "").trim();
    } catch (_) {}
    return cssToRgb(value) || [0.56, 0.68, 0.88];
  }

  const ink = readInk();

  let cw = 1920;
  let ch = 1080;
  let mx = 960;
  let my = 540;
  let tx = 960;
  let ty = 540;
  let energy = 0.66;
  let scrollShift = 0;
  let lastMove = -1e9;
  let seeded = false;
  let ready = false;
  let raf = 0;
  let last = 0;
  let sprite = null;
  let texReady = false;
  let running = false;
  let intersecting = false;

  const FOLLOW_STIFF = 64;
  const FOLLOW_DAMP = 15.2;
  let vx = 0;
  let vy = 0;
  const WARP_A = 0.0032;
  const BASE_ROT = 0;
  const ROT_RIGHT = 0.56;
  const ROT_LEFT = 0.26;
  const ROT_DOWN = 0.32;
  const ROT_UP = 0.16;
  const MAX_ROT = 0.349;
  let rotAngle = BASE_ROT;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const w0 = canvas.clientWidth;
    const h0 = canvas.clientHeight;
    if (!rect.width || !w0 || !h0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const k = Math.max(0.2, Math.min(2, (rect.width / w0) * dpr));
    const w = Math.max(2, Math.round(w0 * k));
    const h = Math.max(2, Math.round(h0 * k));
    if (w !== canvas.width || h !== canvas.height) {
      canvas.width = w;
      canvas.height = h;
      if (gl) gl.viewport(0, 0, w, h);
    }
    cw = w0;
    ch = h0;
    if (!seeded) {
      mx = tx = cw / 2;
      my = ty = ch / 2;
      seeded = true;
    }
  }

  function renderGL(t) {
    if (!prog || !texReady || !gl) return;
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform2f(uDesign, cw, ch);
    gl.uniform2f(uMouse, mx, my);
    gl.uniform1f(uEnergy, energy);
    gl.uniform1f(uParallax, scrollShift);
    gl.uniform2f(uRot, Math.cos(rotAngle), Math.sin(rotAngle));
    gl.uniform1f(uT, t);
    gl.uniform3f(uInk, ink[0], ink[1], ink[2]);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function smoothstep(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  function render2D(t) {
    if (!sprite || !ctx2d) return;
    const ctx = ctx2d;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const k = canvas.width / cw;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.globalAlpha = 1;
    const base = Math.min(cw, ch);
    const spacing = Math.max(64, Math.min(118, base / 10));
    const sigma = spacing * 2.9;
    const twoSigmaSq = 2 * sigma * sigma;
    const offX = Math.sin(t * 0.11) * 7;
    const offY = Math.cos(t * 0.09) * 7 - scrollShift;
    const gmX = mx + offX;
    const gmY = my + offY;
    const cullRho = sigma * Math.sqrt(2 * Math.log(1 / 0.06));
    const cullR = cullRho + WARP_A * cullRho * cullRho + spacing;
    const gx0 = Math.floor((gmX - cullR) / spacing) - 1;
    const gx1 = Math.ceil((gmX + cullR) / spacing) + 1;
    const gy0 = Math.floor((gmY - cullR) / spacing) - 1;
    const gy1 = Math.ceil((gmY + cullR) / spacing) + 1;
    for (let gy = gy0; gy <= gy1; gy++) {
      const cyw = (gy + 0.5) * spacing;
      for (let gx = gx0; gx <= gx1; gx++) {
        const cxw = (gx + 0.5) * spacing;
        const dcx = cxw - gmX;
        const dcy = cyw - gmY;
        const Rc = Math.sqrt(dcx * dcx + dcy * dcy) + 1e-5;
        if (Rc > cullR) continue;
        const rhoC = (-1 + Math.sqrt(1 + 4 * WARP_A * Rc)) / (2 * WARP_A);
        const f = Math.exp(-(rhoC * rhoC) / twoSigmaSq);
        const alpha = smoothstep(0.06, 0.8, f) * energy * 0.26;
        if (alpha < 0.004) continue;
        const hs = (spacing / (1 + 2 * WARP_A * rhoC)) * 0.26 * (0.32 + 1.1 * f);
        const kk = rhoC / Rc;
        const sx = gmX + dcx * kk;
        const sy = gmY + dcy * kk;
        if (sx < -hs * 1.6 || sx > cw + hs * 1.6 || sy < -hs * 1.6 || sy > ch + hs * 1.6) continue;
        ctx.globalAlpha = alpha;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(rotAngle);
        ctx.drawImage(sprite, -hs, -hs, hs * 2, hs * 2);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    if (!running) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    const idle = now - lastMove > 2400;
    const goal = idle ? 0.6 : 1;
    energy += (goal - energy) * Math.min(1, dt * 3.2);
    const h = Math.min(0.05, dt);
    vx += ((tx - mx) * FOLLOW_STIFF - vx * FOLLOW_DAMP) * h;
    vy += ((ty - my) * FOLLOW_STIFF - vy * FOLLOW_DAMP) * h;
    mx += vx * h;
    my += vy * h;
    scrollShift = (window.scrollY || window.pageYOffset || 0) * 0.55;
    const tSec = now / 1000;
    const nx = mx / (cw || 1) - 0.5;
    const ny = my / (ch || 1) - 0.5;
    let lean =
      nx * (nx >= 0 ? ROT_RIGHT : ROT_LEFT) +
      ny * (ny >= 0 ? ROT_DOWN : ROT_UP);
    if (lean > MAX_ROT) lean = MAX_ROT;
    else if (lean < -MAX_ROT) lean = -MAX_ROT;
    rotAngle = BASE_ROT + lean - scrollShift * 0.0006;
    resize();
    if (gl) renderGL(tSec);
    else render2D(tSec);
    raf = requestAnimationFrame(frame);
  }

  function onMove(event) {
    if (!running) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !cw || !ch) return;
    tx = ((event.clientX - rect.left) / rect.width) * cw;
    ty = ((event.clientY - rect.top) / rect.height) * ch;
    lastMove = performance.now();
  }

  function start() {
    if (running || disposed) return;
    if (reduced.matches || noPointer.matches) return;
    if (!intersecting || document.hidden) return;
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

  function onReducedChange() {
    if (reduced.matches) {
      stop();
      canvas.classList.remove("is-ready");
    } else if (intersecting) {
      start();
    }
  }

  function onPointerChange() {
    if (noPointer.matches) stop();
    else if (intersecting) start();
  }

  function onVisibilityChange() {
    if (document.hidden) stop();
    else if (intersecting) start();
  }

  const observer = new IntersectionObserver(
    (entries) => {
      intersecting = entries[0]?.isIntersecting || false;
      if (intersecting) start();
      else stop();
    },
    { threshold: 0 }
  );
  observer.observe(canvas);

  window.addEventListener("pointermove", onMove, { passive: true, capture: true });
  window.addEventListener("resize", resize);
  reduced.addEventListener("change", onReducedChange);
  noPointer.addEventListener("change", onPointerChange);
  document.addEventListener("visibilitychange", onVisibilityChange);

  function buildMark() {
    const d = (ICON_SVG.match(/\sd="([^"]+)"/) || [])[1];
    const surface = document.createElement("canvas");
    surface.width = 256;
    surface.height = 256;
    const sctx = surface.getContext("2d");
    if (d && window.Path2D) {
      const s = Math.min(256 / 30, 256 / 30.4);
      sctx.setTransform(s, 0, 0, s, s + (256 - 30 * s) / 2, -6.4 * s);
      sctx.fillStyle = "rgb(255,255,255)";
      sctx.fill(new Path2D(d), "evenodd");
      sctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    try {
      const img = sctx.getImageData(0, 0, 256, 256);
      const px = img.data;
      for (let i = 3; i < px.length; i += 4) {
        if (px[i] < 8) px[i] = 0;
      }
      sctx.putImageData(img, 0, 0);
    } catch (_) {}
    sctx.clearRect(0, 0, 256, 2);
    sctx.clearRect(0, 254, 256, 2);
    sctx.clearRect(0, 0, 2, 256);
    sctx.clearRect(254, 0, 2, 256);
    if (gl) {
      gl.activeTexture(gl.TEXTURE0);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, surface);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 4);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(uMark, 0);
      texReady = true;
    } else if (ctx2d) {
      sctx.globalCompositeOperation = "source-in";
      sctx.fillStyle =
        "rgb(" +
        Math.round(ink[0] * 255) +
        "," +
        Math.round(ink[1] * 255) +
        "," +
        Math.round(ink[2] * 255) +
        ")";
      sctx.fillRect(0, 0, 256, 256);
      ctx2d.imageSmoothingEnabled = true;
      if ("imageSmoothingQuality" in ctx2d) ctx2d.imageSmoothingQuality = "high";
      sprite = surface;
    }
    ready = true;
    resize();
    canvas.classList.add("is-ready");
    last = 0;
    start();
  }

  let disposed = false;

  try {
    buildMark();
  } catch (err) {
    if (window.console) console.warn("fx-grid: mark could not be rasterised.", err);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
    observer.disconnect();
    window.removeEventListener("pointermove", onMove, { passive: true, capture: true });
    window.removeEventListener("resize", resize);
    reduced.removeEventListener("change", onReducedChange);
    noPointer.removeEventListener("change", onPointerChange);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }

  // Keep the page clean on navigations that tear down the canvas.
  window.addEventListener("pagehide", dispose);

  return {
    dispose,
    isRunning: () => running,
  };
}
