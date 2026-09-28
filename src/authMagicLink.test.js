import assert from "node:assert/strict";
import test from "node:test";
import fixtures from "./authMagicLinkFixtures.json" with { type: "json" };
import {
  explainPlusAliasRule,
  getMagicLinkResultMessage,
  isKnownProviderPlusAlias,
  isMagicLinkSuccess,
  trimEmail,
} from "./authMagicLink.js";

const [firstAllowlistedDomain] = fixtures.allowlistedDomains;

test("detects plus aliases on allowlisted providers (case-insensitive)", () => {
  for (const domain of fixtures.allowlistedDomains) {
    assert.ok(isKnownProviderPlusAlias(`user+tag@${domain}`), `user+tag@${domain}`);
  }
  assert.ok(
    isKnownProviderPlusAlias(`user+tag@${firstAllowlistedDomain.toUpperCase()}`)
  );
});

test("does not flag untagged allowlisted addresses", () => {
  for (const domain of fixtures.allowlistedDomains) {
    assert.equal(isKnownProviderPlusAlias(`user@${domain}`), false, `user@${domain}`);
  }
});

test("does not flag plus aliases on custom or unrelated domains", () => {
  assert.equal(isKnownProviderPlusAlias("user+tag@example.com"), false);
  assert.equal(isKnownProviderPlusAlias("user+tag@company.io"), false);
  assert.equal(
    isKnownProviderPlusAlias(`user+tag@subdomain.${firstAllowlistedDomain}`),
    false
  );
});

test("trims whitespace before checking", () => {
  assert.ok(isKnownProviderPlusAlias(`  user+tag@${firstAllowlistedDomain}  `));
  assert.equal(trimEmail("  user@example.com  "), "user@example.com");
});

test("explainPlusAliasRule returns an actionable message for blocked aliases", () => {
  assert.equal(
    explainPlusAliasRule("user+tag@gmail.com"),
    "Please enter your primary email address. Plus aliases (such as user+tag@gmail.com) are not allowed for gmail.com accounts."
  );
});

test("explainPlusAliasRule returns null for non-blocked addresses", () => {
  assert.equal(explainPlusAliasRule(`user@${firstAllowlistedDomain}`), null);
  assert.equal(explainPlusAliasRule("user+tag@example.com"), null);
});

test("getMagicLinkResultMessage maps server codes to inline messages", () => {
  assert.equal(
    getMagicLinkResultMessage({ code: fixtures.successCode }, `user@${firstAllowlistedDomain}`),
    `Check your email — we sent a link to user@${firstAllowlistedDomain}`
  );

  const rejection = { code: fixtures.validationCode, message: "Use primary email." };
  assert.equal(
    getMagicLinkResultMessage(rejection, `user+tag@${firstAllowlistedDomain}`),
    "Use primary email."
  );

  assert.equal(
    getMagicLinkResultMessage(
      { code: fixtures.validationCode },
      "user+tag@gmail.com"
    ),
    "Please enter your primary email address. Plus aliases (such as user+tag@gmail.com) are not allowed for gmail.com accounts."
  );
});

test("getMagicLinkResultMessage treats legacy success responses as sent", () => {
  assert.equal(
    getMagicLinkResultMessage({ message: "Check your email" }, `user@${firstAllowlistedDomain}`),
    `Check your email — we sent a link to user@${firstAllowlistedDomain}`
  );
});

test("isMagicLinkSuccess accepts only the success code or a genuinely success-shaped legacy response", () => {
  assert.equal(isMagicLinkSuccess({ code: fixtures.successCode }), true);
  assert.equal(isMagicLinkSuccess({ success: true, message: "Magic link sent" }), true);
  assert.equal(isMagicLinkSuccess({ message: "Check your email" }), true);

  // The alias rejection is an error despite the HTTP success...
  assert.equal(
    isMagicLinkSuccess({ code: fixtures.validationCode, message: "Use primary email." }),
    false
  );
  // ...and so is any other server error code, which must never read as sent.
  assert.equal(
    isMagicLinkSuccess({ code: "SEND_FAILED", message: "Could not send the link." }),
    false
  );
});

test("isMagicLinkSuccess rejects explicit failures, error fields and empty bodies", () => {
  // A 200 that says it failed is a failure, code or no code — never "sent".
  assert.equal(isMagicLinkSuccess({ success: false }), false);
  assert.equal(
    isMagicLinkSuccess({ success: false, message: "Could not send the link." }),
    false
  );
  assert.equal(
    isMagicLinkSuccess({ success: false, error: "Mail delivery failed" }),
    false
  );
  assert.equal(
    isMagicLinkSuccess({ success: false, code: fixtures.successCode }),
    false
  );

  // A code-less error payload is an error shape, not a legacy success.
  assert.equal(isMagicLinkSuccess({ error: "Mail delivery failed" }), false);

  // Empty or malformed bodies are not success-shaped.
  assert.equal(isMagicLinkSuccess({}), false);
  assert.equal(isMagicLinkSuccess(null), false);
  assert.equal(isMagicLinkSuccess(undefined), false);
  assert.equal(isMagicLinkSuccess("sent"), false);
  assert.equal(isMagicLinkSuccess([]), false);
});

test("getMagicLinkResultMessage stays aligned with the success predicate", () => {
  // A code-less failure must never read as a sent link.
  assert.equal(
    getMagicLinkResultMessage({ success: false }, `user@${firstAllowlistedDomain}`),
    "Something went wrong. Please try again."
  );
  assert.equal(
    getMagicLinkResultMessage(
      { success: false, message: "Could not send the link." },
      `user@${firstAllowlistedDomain}`
    ),
    "Could not send the link."
  );
  assert.equal(
    getMagicLinkResultMessage(
      { error: "Mail delivery failed" },
      `user@${firstAllowlistedDomain}`
    ),
    "Something went wrong. Please try again."
  );
  // Even the success code cannot rescue an explicit failure.
  assert.equal(
    getMagicLinkResultMessage(
      { success: false, code: fixtures.successCode, message: "Delivery failed." },
      `user@${firstAllowlistedDomain}`
    ),
    "Delivery failed."
  );
  assert.equal(
    getMagicLinkResultMessage(null, `user@${firstAllowlistedDomain}`),
    "Something went wrong. Please try again."
  );
});
