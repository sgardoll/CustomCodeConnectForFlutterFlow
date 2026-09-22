const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

let activeModal = null;
let returnTarget = null;
let savedOverflow = "";
const inertState = new Map();

function focusableElements(modal) {
  return [...modal.querySelectorAll(FOCUSABLE)].filter((element) =>
    !element.hidden && element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0
  );
}

function setBackgroundInert(modal) {
  for (const child of document.body.children) {
    if (child === modal || child.tagName === "SCRIPT") continue;
    inertState.set(child, { inert: child.inert, ariaHidden: child.getAttribute("aria-hidden") });
    child.inert = true;
    child.setAttribute("aria-hidden", "true");
  }
}

function restoreBackground() {
  for (const [element, state] of inertState) {
    element.inert = state.inert;
    if (state.ariaHidden === null) element.removeAttribute("aria-hidden");
    else element.setAttribute("aria-hidden", state.ariaHidden);
  }
  inertState.clear();
}

function isDismissible(modal) {
  return modal?.dataset.modalDismissible !== "false" && modal?.getAttribute("aria-busy") !== "true";
}

export function openModal(modalOrId, options = {}) {
  const modal = typeof modalOrId === "string" ? document.getElementById(modalOrId) : modalOrId;
  if (!modal) return false;
  if (activeModal && activeModal !== modal) closeModal(activeModal, { restoreFocus: false, force: true });

  returnTarget = options.trigger || document.activeElement;
  activeModal = modal;
  savedOverflow = document.body.style.overflow;
  setBackgroundInert(modal);
  document.body.style.overflow = "hidden";
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  const content = modal.querySelector(".modal-content");
  if (content) content.style.transform = "scale(1) translateY(0)";

  const focusInitialControl = () => {
    if (activeModal !== modal) return;
    const initial = options.initialFocus
      ? modal.querySelector(options.initialFocus)
      : modal.querySelector("[data-modal-initial-focus]");
    (initial || focusableElements(modal)[0] || modal.querySelector(".modal-content") || modal).focus({ preventScroll: true });
  };
  requestAnimationFrame(focusInitialControl);
  // The exported fade transitions visibility, so retry once it becomes focusable.
  setTimeout(focusInitialControl, 260);
  return true;
}

export function closeModal(modalOrId, options = {}) {
  const modal = typeof modalOrId === "string" ? document.getElementById(modalOrId) : modalOrId;
  if (!modal || (!options.force && !isDismissible(modal))) return false;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  restoreBackground();
  document.body.style.overflow = savedOverflow;
  activeModal = null;
  const target = returnTarget;
  returnTarget = null;
  if (options.restoreFocus !== false && target?.isConnected) target.focus({ preventScroll: true });
  return true;
}

export function setModalPending(modalOrId, pending, message = "Operation in progress") {
  const modal = typeof modalOrId === "string" ? document.getElementById(modalOrId) : modalOrId;
  if (!modal) return;
  modal.dataset.modalDismissible = pending ? "false" : "true";
  modal.setAttribute("aria-busy", String(Boolean(pending)));
  if (pending) modal.setAttribute("aria-label", message);
  else modal.removeAttribute("aria-label");
}

function requestDismiss(modal) {
  if (!isDismissible(modal)) return;
  const handler = modal.dataset.modalCloseHandler;
  if (handler && typeof window[handler] === "function") window[handler]();
  else closeModal(modal);
}

document.addEventListener("keydown", (event) => {
  if (!activeModal) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    requestDismiss(activeModal);
    return;
  }
  if (event.key !== "Tab") {
    event.stopPropagation();
    return;
  }
  const focusable = focusableElements(activeModal);
  if (!focusable.length) {
    event.preventDefault();
    (activeModal.querySelector(".modal-content") || activeModal).focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}, true);

export function initializeModalShells() {
  document.querySelectorAll(".modal-overlay").forEach((modal) => {
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-hidden", modal.classList.contains("open") ? "false" : "true");
    const content = modal.querySelector(".modal-content");
    if (content && !content.hasAttribute("tabindex")) content.tabIndex = -1;
    const title = modal.querySelector("h1, h2, h3");
    if (title) {
      if (!title.id) title.id = `${modal.id}-title`;
      modal.setAttribute("aria-labelledby", title.id);
    }
    modal.querySelectorAll(".modal-close").forEach((button) => {
      if (!button.getAttribute("aria-label")) button.setAttribute("aria-label", "Close dialog");
    });
  });
}
