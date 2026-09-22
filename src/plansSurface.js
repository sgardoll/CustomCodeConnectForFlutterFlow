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

// Rows that carry a capability which is real but is not self-serve: the
// capability exists, so the row must present it as available, and the access
// path is stated rather than implied. "API & MCP access" is shipped — customers
// reach it by getting in contact, not through a self-serve signup — so it is
// NOT marked unavailable. An earlier revision of this file marked it
// "(coming soon)" on the incorrect inference that no user-facing surface
// existed in the codebase; the owner has since confirmed it ships.
export const CONTACT_TO_ACCESS_MARKER = "(contact us)";

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
    "All models + early access",
    `API & MCP access ${CONTACT_TO_ACCESS_MARKER}`,
  ]),
});
