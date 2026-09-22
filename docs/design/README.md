# Custom Code Connect — redesign source record

> Linear issue: **STU-371** — Record the canonical redesign sources and production behavior overrides  
> Milestone: Custom Code Connect UI  
> Branch: `sgardoll/stu-371-record-the-canonical-redesign-sources-and-production-behavior-overrides`  
> Base: `codex/redesign-plan` @ `d1dc19cda9ac6fe2fea3f583ae0ff98633938343`

This folder archives the design-to-production contract for the Custom Code Connect UI redesign. It is intended to be read by implementers before they touch `app.js`, `index.html`, or any new component.

## Source archive

The canonical design files live in the read-only handoff folder:

```
/Users/home/Projects/Custom-Code-Connect-redesign/
```

Do not copy the entire archive into `public/`. Reference the specific files and assets documented below, or map them through build-time paths / local-dev symlinks.

## Surface classification

| Surface | File(s) | Role | Production route equivalent |
|---|---|---|---|
| **Hero** | `custom-code-connect-hero.html` | Primary app composition: prompt composer, walkthrough, results. | `/` or `/create` |
| **Journey** | `journey-connect.html` | Supplementary workflow guidance for the multi-step connect flow. | `/journey` or modal/wizard state |
| **Account** | `account-admin.html` | Separate account/product surface (identity, usage, keys, history, security). | `/account` |
| **Plans / monetisation** | `monetisation.html` | Separate plans/pricing surface. | `/plans` or pricing modal |
| **Launcher** | `index.html` | Handoff overview only; **not** a production route. | Excluded |
| **Before/outro/walkthrough variants** | `custom-code-connect-hero-*.html`, `custom-code-connect-logo-outro*.html`, `custom-code-connect-walkthrough.html` | Design process artifacts. | Excluded |
| **Milestone plan** | `MILESTONE-PLAN.html` | Project-management artifact. | Excluded |

See [SOURCE-MANIFEST.json](./SOURCE-MANIFEST.json) for SHA-256 hashes of the canonical files.

## Companion documents

- [TOKENS-AND-ASSETS.md](./TOKENS-AND-ASSETS.md) — extracted design tokens, fonts, and asset paths.
- [RESPONSIVE.md](./RESPONSIVE.md) — viewport matrix, reflow expectations, and layout notes.
- [BEHAVIOR-OVERRIDES.md](./BEHAVIOR-OVERRIDES.md) — production behavior that overrides stale handoff copy.
- [REFERENCE.md](./REFERENCE.md) — how workers access the local handoff folder and screenshot references.
- [TRACEABILITY.md](./TRACEABILITY.md) — requirement-to-ticket/surface mapping.
