import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("hides the prompt sidebar above mobile Results", () => {
  assert.match(
    html,
    /@media \(max-width: 768px\)[\s\S]*?body\.results-fullscreen \.sidebar,[\s\S]*?body\.results-fullscreen\.results-with-sidebar \.sidebar \{\s*display: none;/,
  );
});

test("splits the action scope sentence under its own button", () => {
  // Each captioned action owns its half of the old combined sentence, in the
  // same column as the control it describes.
  assert.match(
    html,
    /class="results-action results-action-wide"[\s\S]*?id="btn-error-regen-header"[\s\S]*?class="results-action-scope">Acts on the whole bundle</,
  );
  assert.match(
    html,
    /class="results-action"[\s\S]*?id="btn-refine-header"[\s\S]*?class="results-action-scope">Refine &amp; Regenerate acts on the selected artifact</,
  );
  assert.equal((html.match(/class="results-action-scope"/g) || []).length, 2);
  // The orphaned combined sentence is gone.
  assert.doesNotMatch(html, /build-error fixes regenerate/);
});
