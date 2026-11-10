# Generation history milestone: research draft

Prepared 10 November 2026 AEDT. Research only; not an approved inventory or authoritative run plan.

## Scope and recovery

Project UUID 20821e77-c5af-4de2-86b0-989a6e3309e3. Milestone 985e8a5a-4c8a-4071-b6ba-0feffb0e397c: “Users should be able to see and redeploy their previous generations”. Live Linear milestone has progress 0 and no description returned. All 40 project issues, including archived issues, were fetched with no pagination remaining: none belongs to this milestone. Therefore there are no original issue acceptance criteria or parent allowances to inherit. Proposed units below need new parent issue mapping before inventory; do not silently adopt unrelated backlog.

Repository main HEAD 8597f55494caa3c62ac2bea28d7e1f5a43aef6f6. Origin https://github.com/sgardoll/CustomCodeConnectForFlutterFlow.git. Git common directory /Users/home/Projects/dreamflowCommandForFlutterFlow/.git. No low-code-loop/runs directory exists here or in the kit common directory. A /Users/home/Projects search found only Read It and disposable pilot Core states, not this scope. Do not use those runs. T3 search for milestone UUID returned only parent b96760e8-e511-42ad-a120-94b81ef10f95. Parent activity positions 6–88 contain prior source research; position 38 preflight failed with “Insufficient account funds”, not a successful test. Positions 104/108 confirm missing matching Core state. Positions 114/117 are T3 checkpoints, not Core state.json.

Existing Git checkpoint namespace: .git/refs/t3/orchestration-v2/checkpoints/ZjYyYmJmNzZjMmI4NzllZDJmMjUzZDZhY2FmMDU1MWQ/ordinal/6, object 08e08221bbe11d77fe70bd8fce2571efe5355ecb. This is a recoverable host checkpoint; it must not be interpreted as approved Core configuration. Parent should preserve this evidence, finish reconciliation of native tasks/schedules, checkpoint this draft using its authorized controller workflow, then arrange fresh independent plan review. No run was initialized by this researcher.

## Current source evidence

- app.js:5125–5159 snapshots/restores successful results in memory; it does not persist history. Retain artifactBundle, raw stage results, bundleReview and selected artifact semantics. Snapshot currently omits prompt/project context, which a durable history record needs explicitly.
- index.html:3671 account history is a placeholder labelled “not saved”. docs/design/BEHAVIOR-OVERRIDES.md and TRACEABILITY.md explicitly omit fabricated history pending real support.
- app.js:5511 runThinkingPipeline, regeneration paths near 5396 and successful result rendering near 5332 are capture integration points. Save only complete usable outcomes; a failed replacement must leave the previous generation intact.
- app.js:6259 sign-out and 6784 renderAccountOverview establish account boundaries. Do not restore credentials from a history record or allow an old asynchronous account request to populate a new session.
- src/artifactBundle.js, src/bundleDeployPlanner.js, src/customCodeVerification.js and src/runStatus.js are existing normalization/deploy safety interfaces. Redeploy should hydrate validated historical input into these paths, never bypass current validation or treat a previous success as present deployment proof.
- Existing deployment records in src/runStatus.js concern provisioning reconciliation, not generation history. Do not equate them.
- DEPLOYMENT.md separates web, Cloud Run runner, BuildShip workflow and manually managed prompts. A source change does not prove provider rollout.

## Proposed outcome and decisions

Recommended product contract: signed-in account history, successful generations only, immutable full bundles and review metadata, explicit Open and Deploy actions, newest first, bounded pagination, current credentials and explicit target selection for redeploy. Never auto-deploy on history selection. No secrets, identity/session tokens or provider keys in records. Attachment retention, retention limits and deletion policy must be chosen before storage implementation.

Owner Stuart: decide account/cloud persistence versus browser-only MVP. Recommend account-backed history because “users” and existing account placement imply continuity; browser-only loses data with storage clearing and cannot satisfy cross-device continuity. Answer here: parent decision response D1. This recommendation is not evidence that a backend already exists.

Owner Stuart: decide eligible tiers, guests, retention/count limit, whether deletion is included, and treatment of original image attachments. Recommend all signed-in tiers, no guest migration, successful outputs plus prompt/review only initially, a stated bounded retention policy, and clear deletion behavior. Answer here: parent decision response D2; do not invent numerical limits.

Owner Stuart: confirm deployment target semantics. Recommend record original project as context but require explicit current target confirmation; re-check current access and current dependency compatibility. Answer here: D3.

Owner controller: identify canonical backend checkout/workflows, authenticated principal verification and writable exact paths before freezing U1/U2. Earlier parent BuildShip tool discovery is historical research, not current server-side authorization proof. Answer here: D4 evidence reference. This is the main dispatch blocker.

## Delivery units and ownership

All units are proposed children of a new milestone scope issue; no actual Linear IDs exist. Exclude subscriptions redesign, model selection, unrelated build errors, provider rollout and production data migration. The parent must preserve one shared repair/time allowance across splits; neither exists yet, so owner approval must set it explicitly.

U1 — Contract and fixture foundation. Own new docs/generation-history-contract.md, src/generationHistoryContract.js, src/generationHistoryContract.test.js, e2e/fixtures/generationHistory.json. Define versioned record/list/detail contract, immutable bundle, owner, timestamp, prompt/review/project metadata, pagination, error shapes, size limits, expired/unsupported entries. Tests reject corrupt/unsupported data and secrets, preserve multi-artifact round trips. Checks: node --test src/generationHistoryContract.test.js. No prerequisites beyond D1–D4. Resource: none. Acceptance: consumers can load one contract without guessing ownership or payload shape.

U2 — Authenticated persistence service. Depends on integrated U1 because identity and schema must match. Exact backend file manifest remains UNRESOLVED until D4; not dispatchable. Backend owner owns persistence, migration/index policy, authenticated list/detail/write/delete as approved, idempotent capture and bounded pagination. Test two accounts, forged owner, expired auth, duplicate writes, oversized bundle, unavailable store, deleted records and pagination stability. Required sandbox provider readback and backend executable commands must be recorded after repository discovery. Client-submitted user_id alone is never ownership proof. Resource: ccc-history-sandbox-store. No production mutations in this milestone implementation without separate authority.

U3 — Client history adapter. Depends on integrated U1; can develop against fixtures in parallel with U2 after its manifest is resolved. Own new src/generationHistory.js, src/generationHistory.test.js. Consume agreed API/session contract; return typed list/detail/save errors, abort stale requests, validate stored record versions, omit secrets. Checks: node --test src/generationHistory.test.js. Resource none. Acceptance: account switching and failed saves cannot leak or destroy existing history. U2 must integrate before live acceptance.

U4 — Capture, account history UI, restore and redeploy integration. Depends on integrated U2/U3. Keep together because all touch app.js and shared pipeline state. Own app.js, index.html, new src/generationHistoryView.js, src/generationHistoryView.test.js, e2e/generation-history.spec.js. Capture initial generation and successful refinements/build-error regeneration exactly once; failed generations do not replace saved output. Show loading/empty/error/paginated history; Open restores every artifact and review, safely renders untrusted strings, prevents stale account state and does not call generation/billing APIs. Deploy uses existing verification and explicit target flow; pending/failed/partial outcomes stay truthful. Browser tests cover refresh, sign-out/in, account switch, corrupt history, multi-artifact selection, unavailable persistence and redeployment without a new generation charge. Checks: node --test src/generationHistory*.test.js; CI=1 CCC_TEST_PORT=3147 npx playwright test e2e/generation-history.spec.js. Resource ccc-browser-port-3147 and ccc-history-sandbox-store.

U5 — Integrated acceptance/documentation. Depends on every prior integrated unit. Own docs/design/BEHAVIOR-OVERRIDES.md, docs/design/TRACEABILITY.md, new docs/generation-history-acceptance.md. Independent reviewer reruns final checks on combined exact SHA and records sandbox journeys and approved retention behavior. Resource sandbox store, explicit non-production FlutterFlow project and exclusive device/browser sessions. A real redeploy into that project needs separately authorized fixture access; mock success alone is insufficient. No edits to product files during read-only acceptance.

## Concurrency and landing

Candidate ready set U1 only; then U2 and U3 may overlap. Critical chain U1 → U2/U3 join → U4 → U5. Do not create more units merely for fanout. U4 owns all app.js/index.html writes; package.json/package-lock.json are excluded unless a reviewed change gives one explicit owner. Recommend cap 2 only after exact native-base preflight and the required disposable parallel pilot; otherwise retain sequential execution. No evidence here establishes a configured existing parallel run or successful native fanout. Parallel integration is reviewed append-only, one landing at a time; sibling combined commits need fresh checks and independent acceptance. Resources remain held through acceptance/repair/landing per PARALLEL.md.

## Preflight and acceptance

Current local Node v26.12.0 satisfies package engines but differs from .nvmrc 22.15.1; report this drift and rerun under pinned runtime before final acceptance. npm test: 413 passed, 0 failed. npm run build: passed, 43 modules, index-DHB_cdT3.js. Logs adjacent to this draft. Browser baseline is running with CI=1 CCC_TEST_PORT=3147 to reject foreign-server reuse. Config uses Chromium only, deterministic fixtures and blocked external DNS; this is not Safari/Android proof.

Final commands: npm ci under Node 22.15.1; npm test; npm run build; CI=1 CCC_TEST_PORT=3147 npm run test:ui; npm run test:accessibility; npm run test:deploy-guard; npm run test:proxies; python3 scripts/scan_bundle_for_leaks.py. Runner commands dart analyze and dart test in cloud-run/ffai-runner apply if its code is changed. Provider storage/security tests must be added with exact backend paths after D4, not claimed covered by frontend mocks.

Device inventory rechecked: local host ready, iOS and Android available. Candidate iPhone 18 Pro 2B6B6C07-9993-4D6F-A173-A8D280CF089A and Pixel_8_Pro emulator-5554 booted; no devices opened by this task. Other devices include a ReadIt verification emulator: do not borrow its session. Inventory proves availability only. Future mobile-browser acceptance must use device_open and its agent-device command, then device_screenshot, with exclusive ownership. No native runtime proof exists, and this repository is a Vite web application rather than a Flutter app build.

## Completed browser baseline

CI=1 CCC_TEST_PORT=3147 npm run test:ui completed successfully: 268 Chromium tests passed, exit 0. Full evidence: browser-tests.log in this directory. Eight tracked screenshots generated by the existing STU-383 test were copied into generated-screenshots/ and restored to their clean pre-run HEAD bytes; final git status is clean. No product edits remain. Device runtime and live provider acceptance were not performed. Independent review remains the parent's next responsibility; this researcher did not dispatch one or mutate Core state.

## Review request

Additional backend evidence discovered during preflight: /Users/home/Projects/buildship at bd3f68515104b46f1136ffbe30e7022d34655952 contains workflows/service-runpipeline-THIN/nodes/verify-pipeline-auth-11e6/main.ts, which verifies HS256 JWT and returns verified_user_id. Three record-generation-stage nodes (f0e9, 212a, 0cba) write ccc-Generations/{request_id} with user_id, user_ref and per-stage input/output metadata. This is explicitly best-effort telemetry, may skip or fail silently relative to generation, and truncates output_text above 500000 characters or a byte budget. Therefore do not assume no backend records exist, nor assume these are complete replayable artifacts. U1/U2 must first evaluate reuse of complete telemetry versus a separate immutable artifact payload; reject truncated records for redeploy. Existing client placeholder text is not authoritative about actual backend storage. The checkout proves source only; workflow bindings, live deployment, historical completeness and account authorization remain unverified. Update D4 to validate this existing implementation before proposing a new store. No backend changes are authorized in this research task.

Additional baseline checks passed: deploy guard 9/9; proxy allowlist 30/30; accessible modal browser checks 7 shells at 360x500; production bundle leak scan found no API key/endpoint leaks. These do not establish backend security or real provider acceptance.

Independent reviewer should specifically challenge persistence scope, missing backend ownership/auth proof, retention decisions, empty Linear scope coverage, capture across every successful replacement path, stale auth races, legacy/single-file bundles, actual redeploy safety, shared fixtures and concurrency feasibility. Until D1–D4 and exact backend checks are resolved, verdict should remain CHANGES_REQUIRED or INCONCLUSIVE for execution readiness. This draft is sufficient for a concrete product/architecture decision, not dispatch approval.

## Independent review disposition — 10 November 2026

Verdict: CHANGES_REQUIRED for execution readiness. Independent reviewer inspected backend authentication/stage writers and reran 62 focused artifact/deployment/status tests successfully under Node 26.12.0. This is a reviewed decision draft, not approved execution scope.

The following amendments supersede conflicting proposed-unit text above:

- Reuse existing BuildShip authentication and Firestore infrastructure. Backend prerequisite is separately controlled in /Users/home/Projects/buildship; it cannot be dispatched as a frontend repository unit. Require its accepted commit, verified workflow bindings, exact node/definition/test manifest and sandbox evidence before frontend integrated acceptance. D4 is an engineering investigation, not an owner product decision.
- Telemetry is mutable, truncated and best-effort. Define owner-bound immutable successful revision IDs, atomic duplicate handling and a complete validated replay payload. Test concurrency, conflicting ownership, duplicate saves and retention of prior revisions. Guarantee prospective history; legacy eligibility remains subject to D1.
- Define successful capture as a complete usable generation outcome independently of review approval; store review status truthfully and preserve current deploy gates. Preserve exact deployable content, including fixedCode, prompt and project context. Distinguish new regeneration revisions from network/save retries. Show unsaved state and allow persistence retry without generation or billing. Test opening history during pending generation and sign-out during pending save.
- Documentation updates belong to the implementation owner before the final candidate is frozen. Independent acceptance is read-only at that resulting SHA. Default execution proposal is sequential; optional parallelism must not become a prerequisite for this milestone.
- Completion proposal is implementation plus sandbox acceptance. Production rollout remains a separate owner decision. Runtime device inventory alone is not acceptance. Repeat required checks under pinned Node 22.15.1 before final acceptance.
- Clean-tree statements above describe the research checkpoint only; this planning document is now a local untracked artifact.

## Consolidated owner decisions — answer in this T3 conversation

D1 — Stuart: account-backed history and historical coverage? Recommend account-backed history for new successful generations; include older telemetry only when completeness and ownership are proven.

D2 — Stuart: tiers, retention, deletion and attachments? Recommend all signed-in tiers, no guest migration, prompt/full outputs/review retained, original attachments excluded initially, and user deletion included. Retention duration or count remains an explicit product choice; no numerical limit has been assumed.

D3 — Stuart: redeploy target behavior? Recommend preserve original project as context and require current target confirmation and current validation each time.

D4 — Engineering/controller: establish backend binding/auth/storage ownership and exact cross-repository prerequisite evidence. No owner answer required for these discoverable technical facts.

Scope — Stuart: implementation and sandbox acceptance first, with production rollout separately authorized? Recommended yes.

After decisions: finish backend discovery, map concrete Linear issues and prerequisite ownership, freeze checks/limits and exact plan digest, and obtain independent execution-readiness verification. No implementation approval is claimed.
