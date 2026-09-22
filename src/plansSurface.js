// STU-382 — single source of truth for the plans surface.
//
// These are the canonical tier labels and generation limits shared by every
// surface that surfaces a plan: the topbar, the account badge, the plans
// page, the pricing modal and the paywall/generation gating. Keeping them in
// one place is what makes acceptance criterion 1 ("Free/Pro/Power labels and
// limits agree across surfaces") hold structurally rather than by accident of
// repeated copy/paste.
//
// The feature list also encodes criterion 5: every row must map to a CURRENT
// supported capability of the product. Prototype-only promises (an exposed
// API/MCP surface and a distinct "early access" tier) are deliberately NOT
// listed here — the product exposes no user-facing API/MCP product surface and
// no separate early-access capability, so advertising them in a plan card
// would invent capability the app does not deliver. BYOK is real (the
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
  ]),
});

// Prototype promises that map to NO current capability. The plans surface
// must never advertise these (criterion 5); the test suite asserts both that
// they are absent from the rendered cards and that this contract stays in
// sync with PLAN_FEATURES.
export const UNSUPPORTED_PROMISES = Object.freeze([
  "early access",
  "api & mcp",
]);
