# Plan: 5 Review Logic Gaps — Back-End-Only Fixes

## Principle

The user's constraint: **validation logic must live on the back-end** (BuildShip `REVIEW_SYSTEM` prompt), not duplicated in the browser bundle (`app.js`). A stale client must not bypass rules.

## Architecture

```
Browser (app.js)                        BuildShip (service-runpipeline-THIN)
─────────────────                       ─────────────────────────────────────
validateFileMap                          REVIEW_SYSTEM prompt (d32928b7)
  └─ validateDartFile (deploy gate)        ├─ Widget rules (required, non-nullable, unsupported types)
     ├─ forbiddenPatterns ✗                ├─ CustomAction file name (naive snake_case)
     ├─ import validation ✗               ├─ CustomAction return type
     ├─ getBlockingWidgetErrors ✗          ├─ CodeFile naming (info only)
     ├─ getCustomActionReturnTypeError ✗   ├─ manualActions contract
     └─ getCustomActionFileNameError ✗     ├─ Asset-without-anchor (warning)
                                           ├─ dispose() checks
                                           ├─ MediaQuery vs LayoutBuilder
                                           ├─ Duplicate FF import header
                                           ├─ Image.asset with param path
                                           ├─ onPanStart without onPanCancel
                                           └─ MISSING: forbiddenPatterns, import validation
```

## Gap 1: Widget Rules Duplicated Client-Side

**What:** `getBlockingWidgetErrors(content)` at `app.js:2450` runs the same `WIDGET_RULES` (required-public-param, non-nullable-public-field, unsupported-param-type) that the `REVIEW_SYSTEM` prompt already covers.

**Fix:** Remove the `getBlockingWidgetErrors` call and the `CodeType.WIDGET` block from `validateDartFile`. The review runs server-side before the Deploy button is visible; a widget that fails review never reaches the deploy gate.

**Files changed:**
- `app.js`: Delete lines 2446-2451 (the `CodeType.WIDGET` block calling `getBlockingWidgetErrors`)
- `app.js`: Remove the import of `getBlockingWidgetErrors` at the top of the file

## Gap 2: CustomAction Return Type Duplicated Client-Side

**What:** `getCustomActionReturnTypeError` at `app.js:2454-2458` duplicates the REVIEW_SYSTEM rule "Mark the artifact fail when a CustomAction returns an arbitrary CustomClass, Code File class, or CustomEnum."

**Fix:** Remove the `returnTypeError` check and the `CodeType.ACTION` block from `validateDartFile`.

**Files changed:**
- `app.js`: Delete lines 2453-2466 (the entire `CodeType.ACTION` block)

## Gap 3: CustomAction File Name Duplicated Client-Side

**What:** `getCustomActionFileNameError` at `app.js:2460-2465` duplicates the REVIEW_SYSTEM rule about FlutterFlow's naive snake_case.

**Fix:** Covered by the same deletion as Gap 2 (same `CodeType.ACTION` block).

## Gap 4: Forbidden Patterns + Import Validation Only Client-Side

**What:** `forbiddenPatterns` (main, runApp, MaterialApp, Scaffold) and import validation exist ONLY in `validateDartFile` (`app.js:2380-2431`). The REVIEW_SYSTEM prompt never checks for these. If the client is removed, these checks disappear entirely.

**Fix A (chosen):** Add forbidden-pattern and import-validation rules to the REVIEW_SYSTEM prompt on BuildShip. These are deterministic mechanical checks an LLM can perform reliably. Once the prompt is deployed, remove the checks from `app.js`.

**Fix B (rejected):** Keep them in `validateDartFile` — violates the "back-end only" constraint.

**Server-side text to add to REVIEW_SYSTEM:**
```
- Mark a CustomWidget fail when it declares main(), calls runApp(), or instantiates MaterialApp or Scaffold. FlutterFlow hosts the widget inside its own widget tree; these top-level app constructs conflict with the host and prevent compilation.
- Check imports for correctness: a CustomFunction may only import dart:* (no packages); a CustomWidget/CustomAction must not import from unknown paths. Flag a non-dart: import in a CustomFunction as fail, and flag an import path that is neither dart:, package:flutter/, /flutter_flow/, /custom_code/, nor /backend/ as a warning (the project's own import tree resolves differently).
```

**Files changed:**
- BuildShip `REVIEW_SYSTEM` prompt: Add forbidden-patterns + import-validation rules
- `app.js`: Delete lines 2380-2431 (forbiddenPatterns + import validation)

## Gap 5: manualSteps Scavenger Harvests Unbounded Keys

**What:** `reviewPresentation.js` `MANUAL_STEP_KEYS` (line 4-15) scavenges 10 key names from model output: `manualSteps`, `manualActions`, `requiredActions`, `flutterFlowSteps`, `flutterFlowActions`, `requiredUserActions`, `requiredFlutterFlowActions`, `flutterFlowSetup`, `userActions`, `nextSteps`. The REVIEW_SYSTEM prompt now has a typed `manualActions` contract with 4 exclusions and `preferEmpty`. But `nextSteps` and `userActions` are generic dumping grounds that can leak noise past the contract.

**Fix:** Reduce `MANUAL_STEP_KEYS` to only the contracted key: `["manualActions"]`. The REVIEW_SYSTEM prompt already defines this field precisely. The other 9 keys were scavenged from an era when the contract didn't exist.

**Files changed:**
- `src/reviewPresentation.js`: Reduce `MANUAL_STEP_KEYS` from 10 keys to `["manualActions"]`

## What Remains in validateDartFile

After all removals, `validateDartFile` becomes:
```javascript
function validateDartFile(fileName, content, codeType, declaredTypes, artifactName) {
  return { valid: true, errors: [] };
}
```

This is a no-op. The function can be deleted and `validateFileMap` simplified to only check:
- Empty files (mechanical, not code-level)
- File size > 100KB (mechanical)
- pubspec.yaml validation (separate validator)

Or: `validateDartFile` can be kept as a stub that checks the review result's `compatibility.valid` flag — a "was this reviewed and did it pass?" gate rather than re-running individual rules.

**Decision needed:** Keep the stub or delete `validateDartFile` entirely?

## Status

- [x] Gap 1: Widget rules client-side duplicate removed (`app.js` — `getBlockingWidgetErrors` call deleted)
- [x] Gap 2: CustomAction return type client-side duplicate removed (`app.js` — `getCustomActionReturnTypeError` call deleted)
- [x] Gap 3: CustomAction file name client-side duplicate removed (`app.js` — `getCustomActionFileNameError` call deleted)
- [x] Gap 4 client-side: Forbidden patterns + import validation removed from `app.js`
- [x] Gap 4 server-side: `REVIEW_SYSTEM` on BuildShip `service-runpipeline-THIN` matches `BUILDSHIP_REVIEW_SYSTEM_PROMPT_UPDATED.txt` (checked 2026-09-20 against the BuildShip checkout's recorded value). The prompts are node inputs, not workflow code: they are pasted into the BuildShip editor by hand, a workflow push over the MCP does not carry them, and they are deliberately untracked in this public repository — their source of truth is the private BuildShip workflow. See [DEPLOYMENT.md](DEPLOYMENT.md)
- [x] Gap 5: MANUAL_STEP_KEYS narrowed to `["manualActions"]` in `reviewPresentation.js`
- [x] Gap 6: Surgical server-side code fixes — review stage returns `fixedSource` for mechanical issues; deploy planner prefers `fixedCode` over `code`

## What validateDartFile Does Now

```javascript
function validateDartFile(fileName, content, codeType, declaredTypes, artifactName) {
  const errors = [];
  const hasWidgetClass = WIDGET_CLASS_REGEX.test(content);
  const hasStateClass = STATE_CLASS_REGEX.test(content);

  // Only remaining gate: structural check the server cannot reliably
  // verify — the code must contain a recognizable widget class.
  if (codeType === CodeType.WIDGET && !hasWidgetClass && !hasStateClass) {
    errors.push(
      "No widget class definition found (must extend StatelessWidget or StatefulWidget)",
    );
  }

  return { valid: errors.length === 0, errors };
}
```

All code-level validation (widget params, return types, file names, forbidden patterns, imports) now lives exclusively in the REVIEW_SYSTEM prompt on BuildShip. The review stage also applies surgical mechanical fixes (Color.withOpacity, duplicate headers, wrong import paths, main/runApp/MaterialApp/Scaffold removal, missing dispose/onPanCancel stubs) and returns corrected code via `fixedSource`, which the deploy planner uses in preference to the original.

## Implementation Order

1. **Gap 5** — DONE
2. **Gaps 1-4 client-side** — DONE
3. **Gap 6** (surgical fixes) — DONE
4. **Gap 4 server-side** — DONE: `BUILDSHIP_REVIEW_SYSTEM_PROMPT_UPDATED.txt` matches BuildShip `service-runpipeline-THIN` node `d32928b7` (REVIEW_SYSTEM) as recorded in the BuildShip checkout (checked 2026-09-20). Reminder: this prompt is a node input pasted in the BuildShip editor, not workflow code — the MCP push does not deploy it, and it is intentionally untracked here (public repo)
5. **No final cleanup needed** — `validateDartFile` is now minimal (one structural check)

## Verification

- `npm test` — 205 tests pass, 0 fail
- `npm run build` — bundle compiles (392.23 KB)
- BuildShip `REVIEW_SYSTEM` matches `BUILDSHIP_REVIEW_SYSTEM_PROMPT_UPDATED.txt` as recorded in the BuildShip checkout (checked 2026-09-20). Deployment targets are listed in [DEPLOYMENT.md](DEPLOYMENT.md) — the three step prompts (Architect, Generator, Review) are updated by hand in the BuildShip editor and are deliberately not tracked in this public repository
- `reviewPresentation.js` — tests pass, no regressions
- `bundleDeployPlanner.js` — `fixedCode` preference tests pass
