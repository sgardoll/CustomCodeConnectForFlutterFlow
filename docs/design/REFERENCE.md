# Reference access and screenshots

## Local design folder path

The canonical handoff archive is read-only and lives outside the repo:

```
/Users/home/Projects/Custom-Code-Connect-redesign/
```

## How workers should access it

Do not copy the entire archive into `public/` or `src/assets`. The full folder is large and contains design-process variants and screenshots that should not ship to users. Use one of these approaches:

1. **Build-time reference only.** Read the nine canonical files (`DESIGN-HANDOFF.md`, `DESIGN-MANIFEST.json`, `index.html`, `custom-code-connect-hero.html`, `journey-connect.html`, `account-admin.html`, `monetisation.html`, `fonts/Delight-VF.ttf`, `assets/flutterflow-icon.svg`) from the absolute path during development. The SHA-256 manifest in [SOURCE-MANIFEST.json](./SOURCE-MANIFEST.json) lets CI verify that the files have not changed.

2. **Local dev symlink (optional).** A developer may create a symlink at repo root:
   ```bash
   ln -s /Users/home/Projects/Custom-Code-Connect-redesign design-handoff
   ```
   Add `design-handoff/` to `.gitignore` so it is never committed.

3. **Subset assets only.** If the variable font must be served, copy **only** `fonts/Delight-VF.ttf` into the build output and document the license/subsetting step. The Google Fonts `DM Mono` can remain loaded from the CDN. The FlutterFlow icon SVG is already small and may be copied to `public/` if the favicon path requires it.

## Screenshot references

The handoff contains many PNG screenshots in its root. The most useful ones for visual regression are:

| Screenshot | Purpose |
|---|---|
| `Screenshot-2026-09-18-at-11.16.32-PM.png` | Hero wide-desktop reference |
| `Screenshot-2026-09-18-at-11.44.09-PM.png` | Result panel reference |
| `Screenshot-2026-09-18-at-11.44.23-PM.png` | Walkthrough/progress reference |
| `Screenshot-2026-09-20-at-9.58.57-PM.png` | Mobile hero reference |
| `Screenshot-2026-09-20-at-9.59.35-PM.png` | Journey / workflow reference |
| `Screenshot-2026-09-21-at-5.40.38-AM.png` | Plans surface reference |
| `Screenshot-2026-09-21-at-6.01.41-AM.png` | Account admin reference |

Use Playwright or a similar tool to compare production screenshots against these at the nine viewports listed in [RESPONSIVE.md](./RESPONSIVE.md).

## Design tool artifacts to ignore

The handoff root also contains `drawing-*.png`, `download-*.png`, and `ElevenLabs_*.png`. These are reference mood images and should not be treated as production assets.
