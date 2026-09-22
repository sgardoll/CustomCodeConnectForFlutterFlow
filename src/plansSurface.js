// STU-382 — single source of truth for the plans surface.
//
// These are the canonical tier labels and generation limits shared by every
// surface that surfaces a plan: the topbar, the account badge, the plans
// page, the pricing modal and the paywall/generation gating. Keeping them in
// one place is what makes acceptance criterion 1 ("Free/Pro/Power labels and
// limits agree across surfaces") hold structurally rather than by accident of
// repeated copy/paste.
//
// The feature list also encodes criterion 5: a row must EITHER map to a CURRENT
// supported capability of the product, OR — when the owner has asked the row be
// kept (the "API & MCP access" and "All models + early access" rows) — be
// presented as CLEARLY not-yet-available rather than promised. Anything not
// live yet is suffixed "(coming soon)" so it can never read as a capability the
// app delivers today. This is the single source both the plans page and the
// pricing modal render from, so the two surfaces cannot drift. BYOK is real (the
// "Configure API Keys" surface) and remains listed.
export const PLAN_LABELS = Object.freeze({
  free: "Free",
  professional: "Pro",
  power: "Power",
});

export const PLAN_TIERS = Object.freeze(["free", "professional", "power"]);

export function planLabel(tier) {
  return PLAN_LABELS[tier] || PLAN_LABELS.free;
}

export const PLAN_LIMITS = Object.freeze({
  free: 2,
  professional: 50,
  power: 2000,
});

// A row is only permitted to carry one of these phrases while it is ALSO
// explicitly marked not-yet-available (see UNAVAILABLE_MARKER below). An
// un-marked occurrence is a prototype promise (criterion 5) and the tests
// reject it. The product exposes no user-facing API/MCP surface and no separate
// early-access capability today, so the restored rows must always stay marked.
export const UNSUPPORTED_PROMISES = Object.freeze([
  "early access",
  "api & mcp",
]);

// The exact suffix that marks a not-yet-available row as unavailable rather
// than promised. The test suite requires every row containing an
// UNSUPPORTED_PROMISES phrase to end with this marker; rendering and tests
// read it from here so the wording stays in one place.
export const UNAVAILABLE_MARKER = "(coming soon)";

// The not-yet-available suffix, appended to rows the owner asked to keep that
// do not map to a live capability yet.
const unavailable = (text) => `${text} ${UNAVAILABLE_MARKER}`;

export const PLAN_FEATURES = Object.freeze({
  free: Object.freeze([
    "2 generations/month",
    "Gemini model only",
    "Code Review",
  ]),
  professional: Object.freeze([
    "50 generations/month",
    "All models",
    "Code Regeneration",
    "Code Review",
  ]),
  power: Object.freeze([
    "2000 generations/month",
    "All models",
    "Code Regeneration",
    "Bring your own key (BYOK)",
    "Code Review",
    unavailable("All models + early access"),
    unavailable("API & MCP access"),
  ]),
});
