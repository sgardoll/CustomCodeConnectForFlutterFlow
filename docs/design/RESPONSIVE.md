# Responsive contract and layout decisions

## Viewport matrix

The handoff lists nine canonical viewports. All must reflow without horizontal overflow.

| Name | Width × Height | Category | Expected reflow |
|---|---|---|---|
| `mobile-compact` | 360 × 800 | mobile | Single column; composer stacks above chips; sidebar becomes horizontal nav; hero uses natural height, not scaled stage. |
| `mobile-standard` | 390 × 844 | mobile | Same as `mobile-compact`, slightly more comfortable gutters. |
| `mobile-large` | 430 × 932 | mobile | Same single-column layout; chips may wrap to two rows. |
| `foldable-small-tablet` | 600 × 960 | foldable-tablet | Two-column shell returns; main content widens; composer can remain centered or left-aligned depending on route context. |
| `tablet-portrait` | 820 × 1180 | tablet | Full two-column shell; result panels use split layout if content fits. |
| `tablet-landscape` | 1024 × 768 | tablet | Collapse any overly-wide result grids to 1–2 columns; keep sidebar visible. |
| `laptop` | 1366 × 768 | desktop | Full layout; composer and hero centered with generous whitespace. |
| `desktop` | 1440 × 900 | desktop | Full layout; hero headline allowed to breathe; max-widths govern content. |
| `wide` | 1920 × 1080 | wide | Reference layout; this is the design-authoring canvas. |

## 1920 × 1080 fit scaling is a presentation harness

The hero source contains:

```css
.stage {
  width: 1920px;
  height: 1080px;
  transform: scale(var(--fit, 1));
}
```

This is the **design-export presentation harness**. It lets the static handoff render on smaller screens by uniformly scaling a fixed artboard. Production code must not adopt this fixed-stage scaling. Instead:

- Use real fluid layouts (`max-width`, `clamp()`, CSS Grid/Flexbox).
- Treat `1920×1080` as the **reference artboard** for wide desktop only.
- At non-wide sizes, unwrap the stage and let elements flow naturally in the viewport.

## Layout intent

| Region | Handoff behavior | Production behavior |
|---|---|---|
| Hero headline | Centered, `80px` on wide | Scale with `clamp(34px, 6.8vw, 80px)`; keep `text-wrap: balance`. |
| Composer | Fixed `760×160px` card on wide | Fluid width up to `760px`; min-height adapts to content; keep `min-height: 148px` on mobile. |
| Chips | Single row on wide | Wrap naturally; `flex-wrap: wrap`; minimum touch target `44px`. |
| Walkthrough panel | Absolute `1420px` centered strip on wide | Use a `max-width` container and let it grow from edges; do not hard-code `translateX(-50%)` centering at the cost of overflow. |
| Summary heading | Authored with `style="transform: translate(67px, -304px)"` (`.result-summary h4` in hero line 1288) | **Do not port this transform.** It is an artifact of the design tool. Place the summary heading using normal document flow and CSS grid placement within the results panel. Reproduce the visual position with semantic spacing, not `translate()`. |
| Sidebar | `264px` sticky column on wide | Keep `264px` at desktop; collapse to a horizontal scrollable nav below `920px`. |

## Accessibility / motion

- Honor `prefers-reduced-motion: reduce`: disable entry animations, WebGL field, and morph transitions; keep state color changes.
- Keep focus outlines (`:focus-visible`) visible; do not suppress them for cosmetic reasons.
