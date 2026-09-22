import assert from "node:assert/strict";
import test from "node:test";
import {
  explainPlusAliasRule,
  getMagicLinkResultMessage,
  isKnownProviderPlusAlias,
  trimEmail,
} from "./authMagicLink.js";

test("detects plus aliases on allowlisted providers (case-insensitive)", () => {
  assert.ok(isKnownProviderPlusAlias("user+tag@gmail.com"));
  assert.ok(isKnownProviderPlusAlias("user+tag@GMAIL.COM"));
  assert.ok(isKnownProviderPlusAlias("u+alias@googlemail.com"));
  assert.ok(isKnownProviderPlusAlias("me+stuff@outlook.com"));
  assert.ok(isKnownProviderPlusAlias("me+stuff@hotmail.com"));
  assert.ok(isKnownProviderPlusAlias("me+stuff@live.com"));
  assert.ok(isKnownProviderPlusAlias("me+stuff@msn.com"));
});

test("does not flag untagged allowlisted addresses", () => {
  assert.equal(isKnownProviderPlusAlias("user@gmail.com"), false);
  assert.equal(isKnownProviderPlusAlias("user@outlook.com"), false);
  assert.equal(isKnownProviderPlusAlias("user@googlemail.com"), false);
});

test("does not flag plus aliases on custom or unrelated domains", () => {
  assert.equal(isKnownProviderPlusAlias("user+tag@example.com"), false);
  assert.equal(isKnownProviderPlusAlias("user+tag@company.io"), false);
  assert.equal(isKnownProviderPlusAlias("user+tag@subdomain.gmail.com"), false);
});

test("trims whitespace before checking", () => {
  assert.ok(isKnownProviderPlusAlias("  user+tag@gmail.com  "));
  assert.equal(trimEmail("  user@example.com  "), "user@example.com");
});

test("explainPlusAliasRule returns an actionable message for blocked aliases", () => {
  const msg = explainPlusAliasRule("user+tag@gmail.com");
  assert.ok(msg.includes("primary email address"));
  assert.ok(msg.includes("gmail.com"));
  assert.ok(msg.includes("user+tag@gmail.com"));
});

test("explainPlusAliasRule returns null for non-blocked addresses", () => {
  assert.equal(explainPlusAliasRule("user@gmail.com"), null);
  assert.equal(explainPlusAliasRule("user+tag@example.com"), null);
});

test("getMagicLinkResultMessage maps server codes to inline messages", () => {
  assert.equal(
    getMagicLinkResultMessage({ code: "MAGIC_LINK_SENT" }, "user@gmail.com"),
    "Check your email — we sent a link to user@gmail.com"
  );

  const rejection = { code: "PLUS_ALIAS_REJECTED", message: "Use primary email." };
  assert.equal(
    getMagicLinkResultMessage(rejection, "user+tag@gmail.com"),
    "Use primary email."
  );

  assert.ok(
    getMagicLinkResultMessage(
      { code: "PLUS_ALIAS_REJECTED" },
      "user+tag@gmail.com"
    ).includes("primary email address")
  );
});

test("getMagicLinkResultMessage treats legacy success responses as sent", () => {
  assert.equal(
    getMagicLinkResultMessage({ message: "Check your email" }, "user@gmail.com"),
    "Check your email — we sent a link to user@gmail.com"
  );
});
