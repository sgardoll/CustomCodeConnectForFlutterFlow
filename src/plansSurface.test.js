// STU-382 — the plans surface must present one, internally-consistent set of
// tier labels, limits and supported features, and it must never advertise a
// capability the product does not actually deliver.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_LABELS,
  PLAN_TIERS,
  PLAN_LIMITS,
  PLAN_FEATURES,
  planLabel,
  CONTACT_TO_ACCESS_MARKER,
} from "./plansSurface.js";

// Every surface (topbar, account badge, plans page, usage dialog, gating)
// resolves its label through planLabel() from this one map. Agreement is thus
// structural, not accidental. This test pins the canonical set so a future
// edit to one surface's label cannot silently diverge from the others.
test("criterion 1: all three tiers resolve to one canonical label each", () => {
  assert.equal(planLabel("free"), "Free");
  assert.equal(planLabel("professional"), "Pro");
  assert.equal(planLabel("power"), "Power");
});

test("criterion 1: every tier maps to a distinct, non-empty canonical label", () => {
  const seen = new Set();
  for (const tier of PLAN_TIERS) {
    const label = planLabel(tier);
    assert.ok(label.length > 0, `tier ${tier} must have a non-empty label`);
    assert.ok(!seen.has(label), `label "${label}" must be unique per tier`);
    seen.add(label);
  }
  assert.equal(seen.size, PLAN_TIERS.length);
});

test("criterion 1: limits ascend from free through power and match the gating contract", () => {
  assert.equal(PLAN_LIMITS.free, 2);
  assert.equal(PLAN_LIMITS.professional, 50);
  assert.equal(PLAN_LIMITS.power, 2000);
  assert.ok(PLAN_LIMITS.free < PLAN_LIMITS.professional);
  assert.ok(PLAN_LIMITS.professional < PLAN_LIMITS.power);
});

// The whitelist of capabilities the live product actually delivers. A feature
// row that is not on this list is a prototype promise (criterion 5) and must
// not appear in a plan card.
//
// "API & MCP access" and "early access" are ON this list: the owner confirmed
// both ship. API/MCP access is reached by contacting us rather than through a
// self-serve signup, which is why that row names its access path — but the
// capability is real, so the row must read as available, not as a promise.
const SUPPORTED_CAPABILITIES = new Set([
  "generations per month",
  "code generation models",
  "code review on every run",
  "regenerate from flutterflow build errors",
  "bring your own key (byok)",
  "api & mcp access",
  "early access",
]);

// A row counts as a supported capability when its text references one of the
// whitelisted capabilities. Anything else must be clearly marked not-yet-
// available to be allowed; an unmarked API/MCP surface or unattached "early
// access" claim is a prototype promise and must be rejected.
function capabilityOf(row) {
  const normalized = row.toLowerCase();
  // Checked before the generic "model" rule, because "All models + early
  // access" contains both phrases and its distinguishing capability is the
  // early-access one.
  if (normalized.includes("api & mcp")) return "api & mcp access";
  if (normalized.includes("early access")) return "early access";
  if (normalized.includes("generation")) return "generations per month";
  if (normalized.includes("model")) return "code generation models";
  if (normalized.includes("review")) return "code review on every run";
  if (normalized.includes("regenerat")) return "regenerate from flutterflow build errors";
  if (normalized.includes("byok") || normalized.includes("api key")) return "bring your own key (byok)";
  return null;
}

const NOT_AVAILABLE_WORDING = ["coming soon", "not yet available", "unavailable", "roadmap"];

test("criterion 5: every feature row maps to a capability the product delivers", () => {
  for (const tier of PLAN_TIERS) {
    for (const row of PLAN_FEATURES[tier]) {
      const capability = capabilityOf(row);
      assert.notEqual(
        capability,
        null,
        `feature "${row}" (${tier}) does not map to any supported capability — it would read as a promise`,
      );
      assert.ok(
        SUPPORTED_CAPABILITIES.has(capability),
        `feature "${row}" maps to unsupported capability "${capability}"`,
      );
    }
  }
});

test("product decision: the owner-requested rows are restored and read as available", () => {
  // The owner asked to keep these two rows (STU-382 review decision) and
  // confirmed both capabilities ship. They must render on the Power card and
  // must NOT be marked unavailable — an earlier revision wrongly suffixed
  // them "(coming soon)" on the incorrect inference that no user-facing
  // surface existed in the codebase.
  const power = PLAN_FEATURES.power;
  const joined = power.join(" … ").toLowerCase();

  assert.ok(joined.includes("all models + early access"), 'Power card must keep "All models + early access"');
  assert.ok(
    joined.includes(`api & mcp access ${CONTACT_TO_ACCESS_MARKER.toLowerCase()}`),
    `Power card must present "API & MCP access ${CONTACT_TO_ACCESS_MARKER}" — the capability ships, so it names its access path rather than reading as a promise`,
  );

  for (const row of power) {
    for (const wording of NOT_AVAILABLE_WORDING) {
      assert.ok(
        !row.toLowerCase().includes(wording),
        `Power row "${row}" reads as not-yet-available, but the owner confirmed this capability ships`,
      );
    }
  }
});

test("criterion 5: BYOK — a real capability — is the power-only differentiator", () => {
  const power = PLAN_FEATURES.power.join(" ").toLowerCase();
  const pro = PLAN_FEATURES.professional.join(" ").toLowerCase();
  const free = PLAN_FEATURES.free.join(" ").toLowerCase();
  assert.ok(power.includes("byok"), "Power must advertise BYOK (real capability)");
  assert.ok(!pro.includes("byok"), "BYOK is Power-only, not Pro");
  assert.ok(!free.includes("byok"), "BYOK is Power-only, not Free");
});
