# Tokens and assets — hero primary surface

Source: `custom-code-connect-hero.html` (`548e628f...8917dc`)  
Companion account/plans/journey files share the same token names but declare hex equivalents (`#F1F4F9`, `#FFFFFF`, `#0F172A`) for tooling that does not yet support `oklch()`. Implementers should use the OKLCH tokens from the hero as the canonical set.

## Color tokens

| Token | Value | Usage |
|---|---|---|
| `--bg` | `oklch(96.65% 0.0074 260.73)` | Page background |
| `--surface` | `oklch(100% 0 0)` | Cards, composer, panels |
| `--surface-translucent` | `oklch(100% 0 0 / 0.65)` | Translucent chrome |
| `--surface-glass` | `oklch(100% 0 0 / 0.72)` | Glass panels |
| `--surface-sunken` | `oklch(98.4% 0.004 260)` | Code panel / inset surfaces |
| `--fg` | `oklch(20.77% 0.0398 265.75)` | Primary ink |
| `--muted` | `oklch(48% 0.02 260)` | Secondary text |
| `--muted-2` | `oklch(68% 0.018 260)` | Placeholder / tertiary text |
| `--on-dark` | `oklch(100% 0 0)` | Text on dark surfaces |
| `--border` | `oklch(90% 0.012 260)` | Hairlines |
| `--border-strong` | `oklch(80% 0.02 260)` | Strong borders |
| `--fill-hover` | `color-mix(in oklch, var(--fg) 5%, var(--surface))` | Hover fill |
| `--fill-subtle` | `color-mix(in oklch, var(--fg) 6%, var(--surface))` | Subtle pressed/selected fill |
| `--fill-selected` | `color-mix(in oklch, var(--fg) 4%, var(--surface))` | Selected fill |
| `--track` | `color-mix(in oklch, var(--fg) 7%, var(--surface))` | Progress track |
| `--avatar` | `oklch(88% 0.02 260)` | Avatar placeholder |
| `--accent` | `oklch(63% 0.22 32)` | Hot coral-orange accent |
| `--accent-soft` | `oklch(from var(--accent) l c h / 0.18)` | Focus ring / soft bloom |
| `--accent-ring` | `oklch(from var(--accent) l c h / 0.45)` | Ring emphasis |
| `--fx-ink` | `oklch(70% 0.13 250)` | Interactive field ink |
| `--ok` / `--ok-soft` | `oklch(52% 0.11 165)` / `... / 0.12` | Success / pass |
| `--warn` / `--warn-soft` | `oklch(66% 0.13 70)` / `... / 0.14` | Warning |
| `--bad` / `--bad-soft` | `oklch(55% 0.19 25)` / `... / 0.1` | Error / danger |
| `--disabled-bg` | `oklch(88% 0.015 260)` | Disabled background |
| `--disabled-fg` | `oklch(58% 0.02 260)` | Disabled text |

## Typography tokens

| Token | Value |
|---|---|
| `--font-display` | `"Delight", "Outfit", "DM Sans", system-ui, sans-serif` |
| `--font-body` | `"Delight", "Outfit", "DM Sans", system-ui, sans-serif` |
| `--font-mono` | `"DM Mono", ui-monospace, SFMono-Regular, Menlo, monospace` |
| `--fw-ui` | `560` |
| `--fw-bold` | `620` |
| `--fw-black` | `700` |
| `--ls-display` | `-0.04em` |
| `--ls-heading` | `-0.03em` |
| `--ls-mono` | `0.13em` |
| `--fs-display` | `54px` (hero headline is authored at `80px` for impact) |
| `--fs-h2` | `28px` |
| `--fs-h3` | `22px` |
| `--fs-h4` | `18px` |
| `--fs-lead` | `17px` |
| `--fs-body` | `14.5px` |
| `--fs-small` | `13.5px` |
| `--fs-caption` | `12.5px` |
| `--fs-mono` | `11.5px` |
| `--fs-micro` | `10.5px` |
| `--lh-display` | `1.04` |
| `--lh-heading` | `1.15` |
| `--lh-body` | `1.6` |

## Geometry tokens

| Token | Value | Note |
|---|---|---|
| `--radius-xl` | `22px` | Dialogs |
| `--radius-lg` | `20px` | Composer, large cards |
| `--radius-md` | `16px` | Cards |
| `--radius-sm` | `14px` | Inline panels |
| `--radius-control` | `12px` | Buttons, inputs |
| `--radius-nav` | `11px` | Nav items |
| `--radius-icon` | `10px` | Icon buttons |
| `--radius-chip` | `999px` | Pills / chips |
| `--radius-badge` | `7px` | Badges |
| `--shadow-sm` | `0 1px 2px oklch(20% 0.03 260 / 0.06)` | |
| `--shadow-md` | `0 1px 2px oklch(20% 0.03 260 / 0.06), 0 18px 46px -22px oklch(20% 0.03 260 / 0.3)` | |
| `--shadow-control` | `0 2px 6px oklch(20% 0.03 260 / 0.22)` | |
| `--shadow-composer` | `0 0 0 3px var(--accent-soft), 0 1px 2px oklch(20% 0.03 260 / 0.06), 0 0 44px -8px oklch(63% 0.22 32 / 0.16), 0 20px 52px -20px oklch(63% 0.22 32 / 0.18)` | Composer focus |
| `--touch` | `44px` | Minimum touch target |
| `--control-h` | `46px` | Default control height |
| `--measure-prose` | `62ch` | Max reading measure |
| `--measure-lead` | `68ch` | Max lead paragraph measure |

## Motion tokens

| Token | Value |
|---|---|
| `--ease` | `cubic-bezier(0.2, 0, 0, 1)` |
| `--ease-overshoot` | `cubic-bezier(0.32, 1.38, 0.5, 1)` |
| `--t-fast` | `150ms` |
| `--t-enter` | `220ms` |
| `--t-reveal` | `500ms` |
| `--t-progress` | `700ms` |
| `--t-ring` | `900ms` |
| `--t-morph` | `1120ms` |

## Assets / font paths

| Asset | Path in handoff | Production guidance |
|---|---|---|
| Display font | `fonts/Delight-VF.ttf` | Load as a variable font (`font-weight: 100 900`). The Google Fonts fallback `DM Sans`/`Outfit` must stay in the stack for FOUT. Do not ship the 79 KB TTF to `public/` unless a build step subsets it. |
| Monospace font | Google Fonts `DM Mono:wght@400;500` | Keep the existing `<link>` preload pattern. |
| Brand icon | `assets/flutterflow-icon.svg` | Use for favicon / launcher only. The hero uses an inline SVG logomark; do not replace it with an `<img>` that needs a network round-trip. |

## Suggestion patterns (hero local completion)

The hero uses a client-side rule list. These 13 patterns must be preserved; no new completion backend is required.

| Regex trigger | Suggested continuation |
|---|---|
| `gradient stroke$` | ` and an animated percentage label` |
| `gauge$` | ` with a gradient stroke and animated fill` |
| `rating (bar\|widget)?$` | ` with half-star support and haptic feedback` |
| `list$` | ` with swipe-to-delete and an undo snackbar` |
| `pad$` | ` that exports a transparent PNG` |
| `carousel$` | ` with parallax cards and page indicators` |
| `(button\|cta)$` | ` with a loading spinner and success state` |
| `(chart\|graph)$` | ` that animates from a Firestore stream` |
| `action (that\|to)?$` | ` uploads an image to Firebase Storage and returns the URL` |
| `timer$` | ` with pause, resume and a completion callback` |
| `map$` | ` with clustered markers and a custom info window` |
| `^a \w*$` | ` widget that` |
| `(picker\|selector)$` | ` with search and multi-select` |
