# Traceability — STU-371

> Requirement → milestone ticket → reference surface.

| Requirement | Source surface | Production target | Notes |
|---|---|---|---|
| Record canonical redesign sources and SHA-256 manifest | All handoff files | `docs/design/` | This folder. |
| Identify hero as primary application composition | `custom-code-connect-hero.html` | Primary app route | Composer, walkthrough, results, topbar. |
| Identify journey as supplementary state guidance | `journey-connect.html` | `/journey` or wizard modal | Step rail, workspace, result review. |
| Identify account/plans as separate product surfaces | `account-admin.html`, `monetisation.html` | `/account`, `/plans` | Do not merge into hero. |
| Exclude launcher chrome and before/outro/walkthrough variants | `index.html`, `custom-code-connect-hero-*.html`, `custom-code-connect-logo-outro*.html`, `custom-code-connect-walkthrough.html`, `MILESTONE-PLAN.html` | None | Documented in [SOURCE-MANIFEST.json](./SOURCE-MANIFEST.json) `excludedFromProductionRoutes`. |
| Record every hero token and asset/font path | `custom-code-connect-hero.html` `:root` + `<style>` | Global theme / design tokens | See [TOKENS-AND-ASSETS.md](./TOKENS-AND-ASSETS.md). |
| Capture how workers access local design folder without copying archive | External handoff folder | Dev workflow | See [REFERENCE.md](./REFERENCE.md). |
| Document responsive layout decisions and summary-heading placement | `custom-code-connect-hero.html` line 1288 `translate(67px,-304px)` | CSS grid / flow | See [RESPONSIVE.md](./RESPONSIVE.md). |
| Topbar shows remaining monthly runs | Hero topbar credits | Topbar meter | Bind to `getRunLimit()` and current usage. |
| Usage modal shows used/limit | Hero credits dialog | Usage modal | e.g. `"31 / 50 runs this month"`. |
| Manage Subscription calls existing `openCustomerPortal()` | Hero plan/billing dialogs | Usage modal button | `app.js:4787`. |
| Use real tier limits: Free 2 / Professional 50 / Power 2,000 | `app.js` `TIER_LIMITS` | Pricing/usage logic | `app.js:128-131`. |
| Use real base pricing: A$11 / A$49 | `app.js` `BASE_PRICES_AUD` | Plans display | `app.js:347`. |
| Suggestions use prototype's 13 local patterns | `custom-code-connect-hero.html` `var local=[...]` | Composer autocomplete | No new completion service. |
| No fabricated purchases | Hero plan/billing dialogs | Stripe checkout/portal only | Use existing `startCheckout` / `openCustomerPortal`. |
| No fabricated connection success | Journey / account connection card | Real connection states only | |
| No usage breakdown | Account usage card | Show `used / limit` only | |
| No generation history | Account history table | Omit unless backend endpoint exists | |
| No account deletion | Account security section | Omit or show support message | |
| Nine handoff viewports with reflow expectations | `DESIGN-HANDOFF.md` + manifest | Responsive tests | See [RESPONSIVE.md](./RESPONSIVE.md). |
| Fixed 1920×1080 fit scaling is presentation-only | `custom-code-connect-hero.html` `.stage` | Real fluid layout | See [RESPONSIVE.md](./RESPONSIVE.md). |
