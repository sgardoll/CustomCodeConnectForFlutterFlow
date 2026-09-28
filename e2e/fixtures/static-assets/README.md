# Frozen render assets

Production static assets frozen during the 2026-09-28 exact-HTML preflight.
`manifest.json` records original URLs, response content types, byte lengths and
SHA256 digests. `apiFixtures.js` verifies every digest before serving the bytes.

These fixtures preserve real Tailwind, Google Fonts, vendor scripts and font
metrics while Chromium blocks external DNS. They are test-only; Vite does not
include this directory in the public build. SRI-pinned scripts already in
`../vendor/` remain checked against the production HTML's integrity attributes.

Visual authority: `custom-code-connect-hero.html`, SHA256
`548e628fe94f2b5e647cb4849fbc3200b43dcead60ea53c076f0085aca8917dc`.
Source provenance is also recorded in `docs/design/SOURCE-MANIFEST.json`.

When an intentional upstream asset change requires a refresh, replace its bytes
and manifest entry together after verifying the exact response. Do not replace
render-affecting assets with empty responses to make tests pass.
