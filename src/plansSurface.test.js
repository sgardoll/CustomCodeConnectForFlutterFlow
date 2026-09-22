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
  UNSUPPORTED_PROMISES,
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
const SUPPORTED_CAPABILITIES = new Set([
  "generations per month",
  "code generation models",
  "code review on every run",
  "regenerate from flutterflow build errors",
  "bring your own key (byok)",
]);

// A row counts as a supported capability when its text references one of the
// whitelisted capabilities. Anything else (an API/MCP surface, an unattached
// "early access" claim) is unsupported and must be rejected.
function capabilityOf(row) {
  const normalized = row.toLowerCase();
  if (normalized.includes("generation")) return "generations per month";
  if (normalized.includes("model")) return "code generation models";
  if (normalized.includes("review")) return "code review on every run";
  if (normalized.includes("regenerat")) return "regenerate from flutterflow build errors";
  if (normalized.includes("byok") || normalized.includes("api key")) return "bring your own key (byok)";
  return null;
}

test("criterion 5: every feature row maps to a supported current capability", () => {
  for (const tier of PLAN_TIERS) {
    for (const row of PLAN_FEATURES[tier]) {
      const capability = capabilityOf(row);
      assert.ok(
        capability !== null,
        `feature "${row}" (${tier}) must map to a supported capability`,
      );
      assert.ok(
        SUPPORTED_CAPABILITIES.has(capability),
        `feature "${row}" maps to unsupported capability "${capability}"`,
      );
    }
  }
});

test("criterion 5: no plan card advertises a prototype-only promise", () => {
  for (const tier of PLAN_TIERS) {
    for (const row of PLAN_FEATURES[tier]) {
      const normalized = row.toLowerCase();
      for (const promise of UNSUPPORTED_PROMISES) {
        assert.ok(
          !normalized.includes(promise),
          `"${row}" (${tier}) advertises unsupported promise "${promise}"`,
        );
      }
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
