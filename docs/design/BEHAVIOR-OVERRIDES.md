# Production behavior overrides

The handoff prototype contains demo-only copy and stale pricing. The production implementation must follow these overrides instead of copying the prototype verbatim.

## 1. Runs counter

- **Handoff shows:** topbar credits button labeled `50`, modal reads `50 credits remaining`, and a demo-only note.
- **Production override:**
  - Topbar shows the **real remaining monthly runs** for the current user and period.
  - Clicking the counter opens the usage modal.
  - The modal text changes to the longer-form explanation: `"<used> / <limit> runs this month"` (e.g. `"31 / 50 runs this month"`).
  - The modal contains a **Manage Subscription** button that calls the existing `openCustomerPortal()` function (`app.js:4787`).
- **Rationale:** The backend exposes monthly run allowances, not a credits balance. No new backend is required.

## 2. Tier limits and pricing

Source: current `app.js` at `d1dc19c` (`codex/redesign-plan`).

| Tier | Runs | Price (AUD) |
|---|---|---|
| Free | 2 | — |
| Professional | 50 | A$11 |
| Power | 2,000 | A$49 |

- **Override:** Use the values above.
- **Reject these handoff values:**
  - Power "unlimited" runs.
  - Hero modal A$29 Power price.
- Implementation points:
  - `TIER_LIMITS.free === 2` (`app.js:129`)
  - `TIER_LIMITS.professional === 50` (`app.js:130`)
  - `TIER_LIMITS.power === 2000` (`app.js:131`)
  - `BASE_PRICES_AUD.professional === 11` (`app.js:347`)
  - `BASE_PRICES_AUD.power === 49` (`app.js:347`)

## 3. Suggestions

- **Override:** Use the 13 client-side regex patterns documented in [TOKENS-AND-ASSETS.md](./TOKENS-AND-ASSETS.md). No remote completion service should be introduced.
- If `config.apiKey` is absent, the hero already falls back to the local list (`custom-code-connect-hero.html:1414`). Keep that behavior exactly.

## 4. Unsupported backend capabilities — truthful states only

The handoff shows several demo-only concepts. Production must not fabricate them:

| Do not fabricate | Truthful production state |
|---|---|
| Purchases inside the hero modal | Pricing modal links to Stripe checkout / portal via existing `startCheckout` / `openCustomerPortal`. |
| Connection success animations | Show real connection status; use loading, error, and retry states. |
| Usage breakdown by day/category | Show only the data the backend returns (`used / limit` and current period). |
| Generation history table | Do not add a history table unless the backend endpoint exists and is enabled. |
| Account deletion flow | Do not add account deletion; if unavailable, omit the control or show a disabled / support message. |

## 5. Other production rules

- Keep the brand logomark inline (SVG), not as an external image request.
- Preserve the real copy and labels from the export, but replace any static placeholders with live data equivalents listed above.
- Do not add OpenDesign chrome, preview labels, or design-process annotations to the production UI.
