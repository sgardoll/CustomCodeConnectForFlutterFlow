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
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const session = createSuggestionSession();
  let composing = false; // IME composition: suggestions must not fight it
  let submitting = false; // duplicate-submission guard
  let debounceTimer = null;
  let chipTimer = null;

  // Prototype sync(): the send control follows the prompt and the pipeline.
  function syncSend() {
    send.disabled = !canSubmit(field.value, submitting);
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
    syncSend();
  }

  async function doSubmit() {
    if (!canSubmit(field.value, submitting)) return;
    clearSuggestion();
    setBusy(true);
    try {
      await onSubmit();
    } finally {
      setBusy(false);
    }
  }

  // --- Chip fill (prototype fillChip, lines 1816-1829) ---
  // The prompt types itself in behind the demo caret, the chip keeps a settled
  // selected state, and focus lands at the end of the prompt.

  function cancelChipTyping() {
    if (chipTimer) {
      clearInterval(chipTimer);
      chipTimer = null;
    }
    composer.classList.remove("is-demo-typing");
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
    cancelChipTyping();
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
    syncSend();
    composer.classList.add("is-demo-typing");
    let index = 0;
    chipTimer = setInterval(() => {
      index += 1;
      field.value = text.slice(0, index);
      mirrorTyped();
      syncSend();
      if (index >= text.length) {
        cancelChipTyping();
        focusFieldAtEnd();
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

  // The user taking the field back ends the chip's settled state.
  field.addEventListener("pointerdown", () => {
    cancelChipTyping();
    clearChipSelection();
  });

  // Initial state mirrors the shipped example prompt; the send control
  // reflects it. The shipped default value stays exactly as authored.
  mirrorTyped();
  syncSend();
}
