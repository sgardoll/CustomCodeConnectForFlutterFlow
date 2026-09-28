import assert from "node:assert/strict";
import test from "node:test";
import fixtures from "./authMagicLinkFixtures.json" with { type: "json" };
import {
  explainPlusAliasRule,
  getMagicLinkResultMessage,
  isKnownProviderPlusAlias,
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
