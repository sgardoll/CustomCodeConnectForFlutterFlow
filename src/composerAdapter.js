/**
 * Event adapter for the redesigned prompt composer (STU-376).
 *
 * Wires the ghost suggestion layer, the local completion patterns, chip fill,
 * and keyboard handling to the existing generation pipeline. Every suggestion
 * comes from the 13 local prototype patterns — no completion provider is
 * contacted, and no network request is made for suggestions.
 *
 * Canonical reference: custom-code-connect-hero.html lines 1374-1426 (ghost
 * suggestion layer and local patterns) and 1769-1835 (keyboard, chips, send).
 */

// The 13 local prototype suggestion patterns, in prototype order (lines
// 1402-1410). Earlier patterns win: "A gauge" matches the gauge completion,
// not the "^a <word>" one.
export const LOCAL_SUGGESTIONS = [
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

/** Prototype defaults: config.debounce and config.minChars. */
export const SUGGESTION_DEBOUNCE_MS = 220;
export const SUGGESTION_MIN_CHARS = 6;

/**
 * STU-445 hero demo: the composer holds for a beat with the blinking orange
 * caret, then types the shipped example prompt in behind it. The per-character
 * pace comes from the authored HTML, independent of test assertion timeouts.
 */
const HERO_DEMO_HOLD_MS = 5200;
const HERO_DEMO_TYPE_MS = 73;

/** A prompt can only submit when it has non-whitespace text and the pipeline is idle. */
export function canSubmit(value, isBusy) {
  return Boolean(value && value.trim()) && !isBusy;
}

/**
 * Resolve the local suggestion suffix for the given input, applying the
 * prototype gates from requestSuggestion (lines 1411-1414): no suggestion on
 * the last accepted text (so acceptance cannot re-trigger in a loop), on
 * inputs shorter than SUGGESTION_MIN_CHARS, or after sentence-ending
 * punctuation. Returns the suffix string, or null when nothing matches.
 */
export function resolveLocalSuggestion(text, lastAccepted = "") {
  if (typeof text !== "string" || !text) return null;
  if (text === lastAccepted) return null;
  if (text.trim().length < SUGGESTION_MIN_CHARS) return null;
  if (/[.!?]\s*$/.test(text)) return null;
  const match = LOCAL_SUGGESTIONS.find(([pattern]) => pattern.test(text));
  return match ? match[1] : null;
}

/**
 * DOM-free state machine behind the ghost layer. resolve() is the debounced
 * input handler, dismiss() is Escape, accept() is Tab — it only accepts while
 * a suggestion is active, and records the accepted text so resolving it again
 * cannot re-trigger the same suggestion in a loop.
 */
export function createSuggestionSession() {
  let active = "";
  let lastAccepted = "";

  return {
    /** The currently active suggestion suffix ("" when none). */
    get active() {
      return active;
    },
    /** Match the input against the local patterns and activate the result. */
    resolve(text) {
      active = resolveLocalSuggestion(text, lastAccepted) ?? "";
      return active;
    },
    /** Escape: drop the active suggestion without touching the input. */
    dismiss() {
      active = "";
    },
    /**
     * Tab: append the active suggestion to the current input. Returns the
     * accepted value, or null when no suggestion is active — the caller must
     * let Tab move focus in that case.
     */
    accept(currentValue) {
      if (!active) return null;
      const acceptedValue = currentValue + active;
      lastAccepted = acceptedValue;
      active = "";
      return acceptedValue;
    },
  };
}

/**
 * Wire the composer to the DOM and the existing pipeline. Call once after the
 * composer markup exists. The ghost layer mirrors the textarea, the local
 * suggestions render inline behind the caret, and submissions go through
 * onSubmit — one user action produces one existing pipeline request.
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
  const suggest = composer.querySelector(".ghost .suggest");
  const accept = document.getElementById("tab-hint");
  const status = document.getElementById("suggest-status");
  const chips = Array.from(document.querySelectorAll("#example-chips .chip"));
  const attachBtn = document.getElementById("btn-add-images");
  const attachInput = document.getElementById("prompt-image-input");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const session = createSuggestionSession();
  let composing = false; // IME composition: suggestions must not fight it
  let submitting = false; // duplicate-submission guard
  let chipTyping = false; // a chip still typing its prompt owns the field
  let heroDemoTyping = false; // the opening demo still typing the shipped prompt
  let attachmentsPending = false; // image uploads in flight own the run's attachments
  let debounceTimer = null;
  let chipTimer = null;
  let heroDemoTimer = null;
  // The prompt the hero demo types in: whatever the markup shipped. Captured
  // before the demo clears the field so the demo can never invent its own copy.
  const shippedPrompt = field.value;

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

  // Prototype clearSuggestion (line 1376): drop the suggestion and its UI.
  function hideSuggestionUi() {
    if (suggest) suggest.textContent = "";
    mirrorTyped();
    composer.classList.remove("has-suggest");
    if (accept) {
      accept.hidden = true;
      accept.tabIndex = -1;
    }
    if (status) status.textContent = "";
  }

  // Prototype showSuggestion (lines 1377-1390): has-suggest reveals the grey
  // completion, the tab hint joins the focus order, and the live region
  // announces the suggestion politely.
  function showSuggestionUi(suffix) {
    if (suggest) suggest.textContent = suffix;
    mirrorTyped();
    composer.classList.add("has-suggest");
    if (accept) {
      accept.hidden = false;
      accept.tabIndex = 0;
      accept.setAttribute("aria-label", "Accept suggestion: " + suffix.trim());
    }
    if (status) status.textContent = "Suggestion: " + suffix + ". Press Tab to accept.";
  }

  function clearSuggestion() {
    session.dismiss();
    hideSuggestionUi();
  }

  // Prototype requestSuggestion, local branch (line 1414): pure pattern
  // matching, no completion provider, no network.
  function requestSuggestion() {
    if (composing || submitting) return;
    const suffix = session.resolve(field.value);
    if (suffix) showSuggestionUi(suffix);
  }

  function scheduleSuggestion() {
    clearTimeout(debounceTimer);
    if (composing) return;
    debounceTimer = setTimeout(requestSuggestion, SUGGESTION_DEBOUNCE_MS);
  }

  // Prototype acceptSuggestion (line 1401): append, record, clear, sync. The
  // lastAccepted record plus the missing input event keep acceptance from
  // re-triggering on the accepted text.
  function acceptSuggestion() {
    const acceptedValue = session.accept(field.value);
    if (acceptedValue === null) return false;
    field.value = acceptedValue;
    hideSuggestionUi();
    syncSend();
    return true;
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
    clearSuggestion();
    setBusy(true);
    try {
      await onSubmit();
    } finally {
      setBusy(false);
    }
  }

  // --- Hero demo typing (STU-445) ---
  // The prototype's hero opens on an empty composer: the shipped example
  // prompt types itself in behind the blinking orange caret, then the field
  // holds the prompt. Any real interaction takes the field over, and the demo
  // never overwrites text the user owns.

  function cancelHeroDemo() {
    if (!heroDemoTyping) return;
    heroDemoTyping = false;
    if (heroDemoTimer) {
      clearTimeout(heroDemoTimer);
      heroDemoTimer = null;
    }
    composer.classList.remove("is-demo-typing");
    composer.classList.remove("is-demo-streaming");
    field.placeholder = "Describe the widget or action you need";
    syncSend();
  }

  function startHeroDemo() {
    if (reduceMotion.matches) return;
    if (!shippedPrompt.trim()) return;
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
    const typeNext = () => {
      if (!heroDemoTyping) return;
      index += 1;
      field.value = shippedPrompt.slice(0, index);
      mirrorTyped();
      if (index >= shippedPrompt.length) {
        // The prompt is fully written: retire the caret and hand the field
        // back exactly as the markup shipped it.
        composer.classList.remove("is-demo-typing");
        heroDemoTimer = setTimeout(() => {
          const suffix = session.resolve(field.value);
          if (!suffix) { cancelHeroDemo(); return; }
          showSuggestionUi(suffix);
          composer.classList.add("is-demo-streaming");
          suggest.textContent = "";
          const words = suffix.split(/(?=\s)/).filter(Boolean);
          let word = 0;
          const stream = () => {
            if (!heroDemoTyping) return;
            const span = document.createElement("span");
            span.textContent = words[word++];
            suggest.appendChild(span);
            span.animate?.([{ opacity:0 }, { opacity:1 }], { duration:240, easing:"cubic-bezier(0.4,0,0.2,1)" });
            if (word < words.length) heroDemoTimer = setTimeout(stream, 130);
            else cancelHeroDemo();
          };
          stream();
        }, 1000);
      } else {
        syncSend();
        heroDemoTimer = setTimeout(typeNext, HERO_DEMO_TYPE_MS);
      }
    };
    heroDemoTimer = setTimeout(typeNext, HERO_DEMO_HOLD_MS);
  }

  // A live flip to reduced motion must end the demo, not just keep it from
  // starting: cancel the timer and land the field on the complete shipped
  // prompt with the caret retired — the same end state as a finished demo.
  // Text the user has taken over (heroDemoTyping already false) is untouched.
  function onReducedMotionChange() {
    if (!reduceMotion.matches) return;
    if (heroDemoTyping) {
      field.value = shippedPrompt;
      clearSuggestion();
      cancelHeroDemo();
    }
    if (chipTyping) {
      field.value = chips.find((chip) => chip.classList.contains("is-active"))?.dataset.prompt || field.value;
      mirrorTyped();
      cancelChipTyping();
    }
  }

  // --- Chip fill (prototype fillChip, lines 1816-1829) ---
  // The prompt types itself in behind the demo caret, the chip keeps a settled
  // selected state, and focus lands at the end of the prompt.

  function cancelChipTyping() {
    chipTyping = false;
    if (chipTimer) {
      clearInterval(chipTimer);
      chipTimer = null;
    }
    composer.classList.remove("is-demo-typing");
    syncSend();
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
    // A suggestion timer pending from earlier typing must not resolve against
    // the half-typed chip text; programmatic fills emit no input events, so
    // the stale timer would survive clearSuggestion() otherwise.
    clearTimeout(debounceTimer);
    debounceTimer = null;
    clearSuggestion();
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
    composer.classList.add("is-demo-typing");
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
  // Tab accepts only an active suggestion and otherwise moves focus; Escape
  // dismisses; Enter submits unless Shift is held or an IME is composing.
  field.addEventListener("keydown", (event) => {
    // Enter while the hero demo or a chip is still typing is not a submission
    // and not a cancellation: the writer finishes the full prompt first.
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
    cancelHeroDemo();
    cancelChipTyping();
    if (event.key === "Tab" && !event.shiftKey && session.active) {
      event.preventDefault();
      acceptSuggestion();
    } else if (event.key === "Escape") {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      clearSuggestion();
    } else if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing &&
      !composing
    ) {
      event.preventDefault();
      doSubmit();
    }
  });

  // --- Input (prototype input handler, line 1800) ---
  field.addEventListener("input", () => {
    cancelHeroDemo();
    cancelChipTyping();
    clearChipSelection();
    clearSuggestion();
    syncSend();
    scheduleSuggestion();
  });

  // IME: mirror and sync during composition, but hold suggestions until the
  // composition settles so the ghost layer never fights the IME.
  field.addEventListener("compositionstart", () => {
    composing = true;
  });

  field.addEventListener("compositionend", () => {
    composing = false;
    clearSuggestion();
    syncSend();
    scheduleSuggestion();
  });

  // Keep the ghost layer glued to the textarea's scroll position.
  field.addEventListener("scroll", () => {
    if (typed && typed.parentNode) typed.parentNode.scrollTop = field.scrollTop;
  });

  if (accept) {
    accept.addEventListener("click", () => {
      acceptSuggestion();
      field.focus({ preventScroll: true });
    });
  }

  send.addEventListener("click", doSubmit);

  // The user taking the field back ends the chip's settled state and stops a
  // running hero demo, leaving whatever it had typed for the user to own.
  field.addEventListener("pointerdown", () => {
    cancelHeroDemo();
    cancelChipTyping();
    clearChipSelection();
  });

  field.addEventListener("focus", () => {
    cancelHeroDemo();
  });

  // The reduced-motion preference can change while the page is open; the
  // listener is registered exactly once here (never per demo start) and is
  // removed by dispose, so a torn-down composer stops reacting to it.
  reduceMotion.addEventListener("change", onReducedMotionChange);

  function dispose() {
    cancelTyping();
    reduceMotion.removeEventListener("change", onReducedMotionChange);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", dispose);
  }

  function cancelTyping() {
    cancelHeroDemo();
    cancelChipTyping();
    clearTimeout(debounceTimer);
  }

  function onVisibilityChange() { if (document.hidden) cancelTyping(); }
  document.addEventListener("visibilitychange", onVisibilityChange);

  window.addEventListener("pagehide", dispose);

  // Initial state mirrors the shipped example prompt; the send control
  // reflects it. The shipped default value stays exactly as authored.
  mirrorTyped();
  syncSend();

  // STU-445: play the hero's opening typing demo once, after the initial
  // state is honest, so the field never claims to be empty in the DOM.
  startHeroDemo();

  return {
    // app.js marks attachment uploads as pending: submissions are held off
    // until every accepted file has produced an upload URL or failed out.
    setAttachmentsPending(pending) {
      attachmentsPending = Boolean(pending);
      syncSend();
    },
    // Removes the reduced-motion listener; also runs on pagehide.
    dispose,
    cancelTyping,
  };
}
