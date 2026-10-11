import assert from "node:assert/strict";
import test from "node:test";
import { canSubmit } from "./composerAdapter.js";

test("canSubmit refuses empty, whitespace-only and busy input", () => {
  assert.equal(canSubmit("", false), false);
  assert.equal(canSubmit("   \n\t ", false), false);
  assert.equal(canSubmit(null, false), false);
  assert.equal(canSubmit("A progress gauge", true), false);
  assert.equal(canSubmit("A progress gauge", false), true);
});
