/**
 * Event adapter for the redesigned prompt composer (STU-376).
 *
 * Wires chip fill, the hero typing demo and keyboard handling to the existing
 * generation pipeline. The composer makes no suggestions: autocomplete is out
 * until it is re-scoped in its own milestone.
 *
 * Canonical reference: custom-code-connect-hero.html lines 1769-1835
 * (keyboard, chips, send).
 */

/**
 * STU-445 hero demo: the composer holds for a beat with the blinking orange
 * caret, then types the example prompt in behind it. The hold and typing pace
 * come from the authored HTML, independent of test assertion timeouts. The
 * typed prompt rests long enough to read, then backspaces out at a held-key
 * pace and leaves the empty field on its hint text.
 */
const HERO_DEMO_HOLD_MS = 5200;
const HERO_DEMO_TYPE_MS = 73;
const HERO_DEMO_READ_MS = 1600;
const HERO_DEMO_ERASE_MS = 35;

// The hero demo's media-query listener is tracked per composer element so a
// repeat initComposer on the same DOM replaces the previous instance's
// registration instead of stacking a second listener on it.
const demoMotionRegistrations = new WeakMap();

/** A prompt can only submit when it has non-whitespace text and the pipeline is idle. */
export function canSubmit(value, isBusy) {
  return Boolean(value && value.trim()) && !isBusy;
}

/**
 * Wire the composer to the DOM and the existing pipeline. Call once after the
 * composer markup exists. The ghost layer mirrors the textarea so the demo
 * caret sits at the end of the text, and submissions go through onSubmit —
 * one user action produces one existing pipeline request.
 *
 * @param {object} opts
 * @param {() => void | Promise<void>} opts.onSubmit - the existing pipeline
 *   entry (runThinkingPipeline). Busy state lasts exactly as long as the call.
 */
export function initComposer({ onSubmit }) {
  const composer = document.getElementById("composer");
  const field = document.getElementById("pipeline-input");
  const send = document.getElementById("hero-send");
  if (!composer || !field || !send || typeof onSubmit !== "function") return;

  const typed = composer.querySelector(".ghost .typed");
  const chips = Array.from(document.querySelectorAll("#example-chips .chip"));
  const attachBtn = document.getElementById("btn-add-images");
  const attachInput = document.getElementById("prompt-image-input");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let composing = false; // IME composition: Enter commits the IME, not the prompt
  let submitting = false; // duplicate-submission guard
  let chipTyping = false; // a chip still typing its prompt owns the field
  let heroDemoTyping = false; // the opening demo still typing or erasing its prompt
  let attachmentsPending = false; // image uploads in flight own the run's attachments
  let chipTimer = null;
  let heroDemoTimer = null;
  // The prompt the hero demo types in: whatever the markup ships on the field,
  // so the demo can never invent its own copy. It is never the field's value —
  // the demo erases it again, and the composer rests empty on its hint.
  const demoPrompt = field.dataset.demoPrompt || "";

  function isBusy() {
    return submitting || chipTyping || heroDemoTyping || attachmentsPending;
  }

  // Prototype sync(): the send control follows the prompt and the pipeline.
  // Chip typing, the hero demo and in-flight attachment uploads count as busy:
  // a submit must never carry a half-typed prompt or run without a
  // just-attached image.
  function syncSend() {
    send.disabled = !canSubmit(field.value, isBusy());
  }

  function mirrorTyped() {
    if (typed) typed.textContent = field.value;
  }

  // Prototype generate (lines 1769-1777): the send arrow hands over to the
  // spinner while the pipeline runs, then hands back. The wrapper keeps the
  // busy state honest even when the pipeline exits early, and never touches
  // the prompt or attached images, so an error preserves the user's work.
  function setBusy(busy) {
    submitting = busy;
    composer.classList.toggle("is-busy", busy);
    send.classList.toggle("is-busy", busy);
    send.setAttribute("aria-label", busy ? "Generating" : "Generate");
    // Edits made mid-run can never join it: the prompt and chips stay
    // inert for the whole submitting interval (readOnly keeps the text
    // selectable). An attachment can't join either — its control and file
    // input are disabled too.
    field.readOnly = busy;
    chips.forEach((chip) => {
      chip.disabled = busy;
    });
    if (attachBtn) attachBtn.disabled = busy;
    if (attachInput) attachInput.disabled = busy;
    syncSend();
  }

  async function doSubmit() {
    if (!canSubmit(field.value, isBusy())) return;
    setBusy(true);
    try {
      await onSubmit();
    } finally {
      setBusy(false);
    }
  }

  // --- Hero demo typing (STU-445) ---
  // The hero opens on an empty composer: the example prompt types itself in
  // behind the blinking orange caret, rests a beat, then backspaces back out,
  // leaving the empty field on its grey hint. The example is illustration,
  // never a draft, so every way the demo ends lands the same empty field. It
  // never overwrites text the user owns. Like a real text cursor, the caret
  // holds solid while characters land (is-demo-keying) and blinks only while
  // the field is idle: the hold before typing and the rest before erasing.

  function cancelHeroDemo() {
    if (!heroDemoTyping) return;
    heroDemoTyping = false;
    if (heroDemoTimer) {
      clearTimeout(heroDemoTimer);
      heroDemoTimer = null;
    }
    composer.classList.remove("is-demo-typing", "is-demo-keying");
    field.placeholder = "Describe the widget or action you need";
    syncSend();
  }

  function startHeroDemo() {
    if (reduceMotion.matches) return;
    if (!demoPrompt.trim()) return;
    // Only the home surface owns the hero composer: a deep link straight to
    // Account or Plans must not type behind the hidden view.
    const hash = window.location.hash.replace(/^#/, "");
    if (hash && hash !== "home") return;
    heroDemoTyping = true;
    field.placeholder = "";
    field.value = "";
    mirrorTyped();
    syncSend();
    composer.classList.add("is-demo-typing");
    let index = 0;
    const step = (delta, keying) => {
      index += delta;
      field.value = demoPrompt.slice(0, index);
      mirrorTyped();
      composer.classList.toggle("is-demo-keying", keying);
    };
    // Erasing the last character retires the caret and restores the hint.
    const eraseNext = () => {
      if (!heroDemoTyping) return;
      step(-1, true);
      if (index > 0) heroDemoTimer = setTimeout(eraseNext, HERO_DEMO_ERASE_MS);
      else cancelHeroDemo();
    };
    // The last character lands idle, so the caret blinks while the full
    // example rests.
    const typeNext = () => {
      if (!heroDemoTyping) return;
      const more = index + 1 < demoPrompt.length;
      step(1, more);
      heroDemoTimer = more
        ? setTimeout(typeNext, HERO_DEMO_TYPE_MS)
        : setTimeout(eraseNext, HERO_DEMO_READ_MS);
    };
    heroDemoTimer = setTimeout(typeNext, HERO_DEMO_HOLD_MS);
  }

  // End a running demo early by landing its end state — the empty field on
  // its hint, the caret retired, the send control synced — rather than
  // freezing on whatever prefix the timer reached. Every takeover (a click,
  // focus, a keypress, an input) and every system cancellation (leaving Home,
  // the tab hiding, a reduced-motion flip) lands this one state, so the
  // demo's text can never be submitted or joined by the user's own. Text the
  // user already owns (heroDemoTyping false) is never touched.
  function finishHeroDemo() {
    if (!heroDemoTyping) return;
    field.value = "";
    mirrorTyped();
    cancelHeroDemo();
  }

  // A live flip to reduced motion must end the demo, not just keep it from
  // starting: cancel the timer and land the empty field with the caret
  // retired — the same end state as a finished demo.
  function onReducedMotionChange() {
    if (!reduceMotion.matches) return;
    finishHeroDemo();
    finishChipTyping();
  }

  // --- Chip fill (prototype fillChip, lines 1816-1829) ---
  // The prompt types itself in behind the demo caret — held solid, since
  // characters land the whole time — the chip keeps a settled selected state,
  // and focus lands at the end of the prompt.

  function cancelChipTyping() {
    chipTyping = false;
    if (chipTimer) {
      clearInterval(chipTimer);
      chipTimer = null;
    }
    composer.classList.remove("is-demo-typing", "is-demo-keying");
    syncSend();
  }

  // A takeover lands the fill's end state — the complete chip prompt — rather
  // than freezing mid-type, so a submit after it can never carry a half-typed
  // prompt (the same end state as a fill that finished on its own).
  function finishChipTyping() {
    if (!chipTyping) return;
    field.value =
      chips.find((chip) => chip.classList.contains("is-active"))?.dataset
        .prompt || field.value;
    mirrorTyped();
    cancelChipTyping();
  }

  function clearChipSelection() {
    chips.forEach((chip) => {
      chip.classList.remove("is-active");
      chip.setAttribute("aria-pressed", "false");
    });
  }

  function focusFieldAtEnd() {
    try {
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
    } catch {
      // Setting the selection is best-effort; focus alone is enough.
    }
  }

  function fillChip(chip) {
    const text = chip.dataset.prompt || "";
    cancelHeroDemo();
    cancelChipTyping();
    chips.forEach((other) => {
      const on = other === chip;
      other.classList.toggle("is-active", on);
      other.setAttribute("aria-pressed", String(on));
    });

    if (reduceMotion.matches || !text) {
      field.value = text;
      mirrorTyped();
      syncSend();
      focusFieldAtEnd();
      return;
    }

    field.value = "";
    mirrorTyped();
    chipTyping = true;
    syncSend();
    composer.classList.add("is-demo-typing", "is-demo-keying");
    let index = 0;
    chipTimer = setInterval(() => {
      index += 1;
      field.value = text.slice(0, index);
      mirrorTyped();
      if (index >= text.length) {
        cancelChipTyping();
        focusFieldAtEnd();
      } else {
        syncSend();
      }
    }, 22);
  }

  chips.forEach((chip) => {
    chip.setAttribute("aria-pressed", "false");
    chip.addEventListener("click", () => fillChip(chip));
  });

  // --- Keyboard (prototype keydown, lines 1794-1799) ---
  // Enter submits unless Shift is held or an IME is composing; Tab and Escape
  // keep their native behaviour.
  field.addEventListener("keydown", (event) => {
    // Enter while the hero demo or a chip is still typing is not a
    // submission and not a cancellation: the writer finishes first.
    if (
      (heroDemoTyping || chipTyping) &&
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing &&
      !composing
    ) {
      event.preventDefault();
      return;
    }
    finishHeroDemo();
    finishChipTyping();
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing &&
      !composing
    ) {
      event.preventDefault();
      doSubmit();
    }
  });

  // The demo's text is never a draft: any real edit that reaches the field
  // without a click, focus or keypress first — a drag-dropped snippet, an
  // assistive insert — still ends the demo before it lands, so the user's
  // input starts on an empty field instead of joining the example.
  // beforeinput sees every vector the browser will mutate for; the demo's own
  // programmatic writes never reach it.
  field.addEventListener("beforeinput", () => finishHeroDemo());

  // --- Input (prototype input handler, line 1800) ---
  field.addEventListener("input", () => {
    cancelHeroDemo();
    cancelChipTyping();
    clearChipSelection();
    mirrorTyped();
    syncSend();
  });

  // IME: track composition so Enter commits the IME instead of submitting.
  field.addEventListener("compositionstart", () => {
    composing = true;
  });

  field.addEventListener("compositionend", () => {
    composing = false;
    syncSend();
  });

  // Keep the ghost layer glued to the textarea's scroll position.
  field.addEventListener("scroll", () => {
    if (typed && typed.parentNode) typed.parentNode.scrollTop = field.scrollTop;
  });

  send.addEventListener("click", doSubmit);

  // The user taking the field back ends the chip's settled state. A running
  // hero demo lands its end state instead of freezing mid-type: a bare click,
  // focus or keypress leaves the empty field ready for the user's own prompt.
  field.addEventListener("pointerdown", () => {
    finishHeroDemo();
    finishChipTyping();
    clearChipSelection();
  });

  field.addEventListener("focus", () => finishHeroDemo());

  // The reduced-motion preference can change while the page is open; the
  // listener lives for the document's lifetime — including a trip through the
  // back-forward cache, where no real teardown happens — so a resumed demo
  // still sees a later flip. dispose() removes it for a genuine composer
  // teardown only. A repeat initComposer on the same DOM replaces the dead
  // instance's registration instead of stacking a second listener.
  const previousMotionRegistration = demoMotionRegistrations.get(composer);
  if (previousMotionRegistration) {
    previousMotionRegistration.mql.removeEventListener(
      "change",
      previousMotionRegistration.handler,
    );
  }
  reduceMotion.addEventListener("change", onReducedMotionChange);
  demoMotionRegistrations.set(composer, {
    mql: reduceMotion,
    handler: onReducedMotionChange,
  });

  function dispose() {
    cancelTyping();
    reduceMotion.removeEventListener("change", onReducedMotionChange);
    demoMotionRegistrations.delete(composer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }

  function cancelTyping() {
    // A system cancellation — switching surfaces or the tab hiding — is not a
    // user takeover: land each demo's end state so a half-typed prefix can
    // never sit submittable in the field when the user returns.
    finishHeroDemo();
    finishChipTyping();
  }

  function onVisibilityChange() { if (document.hidden) cancelTyping(); }
  document.addEventListener("visibilitychange", onVisibilityChange);

  // Initial state mirrors the field as authored — empty, on its hint — and
  // the send control reflects it.
  mirrorTyped();
  syncSend();

  // STU-445: play the hero's opening typing demo once, after the initial
  // state is honest.
  startHeroDemo();

  return {
    // app.js marks attachment uploads as pending: submissions are held off
    // until every accepted file has produced an upload URL or failed out.
    setAttachmentsPending(pending) {
      attachmentsPending = Boolean(pending);
      syncSend();
    },
    // Removes the reduced-motion listener; for a genuine composer teardown.
    dispose,
    cancelTyping,
  };
}
