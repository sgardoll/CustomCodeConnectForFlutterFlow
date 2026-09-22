/**
 * Deterministic, contract-shaped API fixtures for the redesigned Custom Code
 * Connect browser journeys. Every fixture mirrors the response shapes consumed
 * by app.js and the pipeline contracts in src/pipelineContracts.js and
 * src/artifactBundle.js.
 *
 * These are pure data objects. Use `applyDefaultRoutes(page)` to wire them into
 * Playwright request interception, or mix and match individual fixtures with
 * `routeFulfill(page, urlPattern, fixture)`.
 *
 * Routing policy (see applyDefaultRoutes): fixture responses are fulfilled,
 * static assets index.html references are fulfilled with inert stubs,
 * SRI-pinned static assets are fulfilled with byte-identical vendored copies
 * from ./vendor/, and the only requests that reach the network are the
 * same-origin ones served by the local Vite dev server. Every other request
 * is aborted, so an un-fixtured external call — a paid generation, a real
 * project write, a newly added endpoint — fails the test loudly instead of
 * silently escaping to the network.
 */

import { readFileSync } from "node:fs";

const BUILDSHIP_BASE_URL = "https://4tgke4.buildship.run";
const PIPELINE_ENDPOINT = `${BUILDSHIP_BASE_URL}/service/runpipeline`;
const IDENTITY_ENDPOINT = `${BUILDSHIP_BASE_URL}/authUserCheck`;

export const ENDPOINTS = {
  buildship: BUILDSHIP_BASE_URL,
  pipeline: PIPELINE_ENDPOINT,
  identity: IDENTITY_ENDPOINT,
  authSendMagicLink: `${BUILDSHIP_BASE_URL}/auth/send-magic-link`,
  authVerifyMagicLink: `${BUILDSHIP_BASE_URL}/auth/verify-magic-link`,
  authRefreshSession: `${BUILDSHIP_BASE_URL}/auth/refresh-session`,
  getSubscription: `${BUILDSHIP_BASE_URL}/stripe/get-subscription`,
  createCheckout: `${BUILDSHIP_BASE_URL}/stripe/create-checkout-session-intl`,
  createPortal: `${BUILDSHIP_BASE_URL}/stripe/create-portal-session`,
  connectFeedback: `${BUILDSHIP_BASE_URL}/connectFeedback`,
  deployCustomClasses:
    "https://ccc-ffai-runner-y5cyj3473a-uw.a.run.app/deployCustomClasses",
  flutterFlowListProjects: "https://api.flutterflow.io/v2/listProjects",
  flutterFlowLegacyListProjects:
    "https://api.flutterflow.io/v2/l/listProjects",
  flutterFlowExportCode: "https://api.flutterflow.io/v2/exportCode",
  flutterFlowSyncCustomCodeChanges:
    "https://api.flutterflow.io/v2/syncCustomCodeChanges",
  exchangeRates: "https://open.er-api.com/v6/latest/AUD",
};

// Origin of the local Vite dev server that playwright.config.js boots and
// targets (webServer.url / baseURL). Its requests are the only ones allowed
// to reach the network.
const VITE_ORIGIN = "http://localhost:3000";

function ok(body) {
  return { status: 200, body: JSON.stringify(body), contentType: "application/json" };
}

function err(status, body) {
  return { status, body: typeof body === "string" ? body : JSON.stringify(body), contentType: "application/json" };
}

export const guestIdentity = () =>
  ok({
    status: "guest",
    user_id: "guest-test-0001",
    identity_token: null,
    usage_count: 0,
    usage_month: new Date().toISOString().slice(0, 7),
  });

export const freeSubscription = () =>
  ok({
    data: {
      subscription: { status: "active", tier: "free" },
      priceId: null,
      usage_count: 0,
      usage_month: new Date().toISOString().slice(0, 7),
    },
  });

export const professionalSubscription = () =>
  ok({
    data: {
      subscription: {
        status: "active",
        tier: "professional_plan",
        priceId: "price_1T2ldCKszA2slvDXatdeCpbI",
      },
      priceId: "price_1T2ldCKszA2slvDXatdeCpbI",
      usage_count: 12,
      usage_month: new Date().toISOString().slice(0, 7),
    },
  });

export const powerSubscription = () =>
  ok({
    data: {
      subscription: {
        status: "active",
        tier: "power_developer",
        priceId: "price_powerDev_123",
      },
      priceId: "price_powerDev_123",
      usage_count: 47,
      usage_month: new Date().toISOString().slice(0, 7),
    },
  });

export const unresolvedSubscription = () =>
  ok({ error: "Subscription service temporarily unavailable" });

export const signedInSession = () =>
  ok({
    email: "test@example.com",
    sessionToken: "test-session-token-0001",
  });

export const magicLinkSent = () =>
  ok({ success: true, message: "Magic link sent" });

export const checkoutSession = () =>
  ok({ url: "https://checkout.stripe.com/mock-session" });

export const portalSession = () =>
  ok({ url: "https://billing.stripe.com/mock-portal" });

function buildArtifactBundle(artifacts) {
  const mappedArtifacts = artifacts.map((artifact, index) => ({
    id: artifact.id ?? `${artifact.artifactType?.toLowerCase() ?? "file"}-${index + 1}`,
    artifactType: artifact.artifactType ?? "CodeFile",
    artifactName: artifact.artifactName ?? `TestArtifact${index + 1}`,
    fileName: artifact.fileName ?? `${artifact.artifactName ?? `TestArtifact${index + 1}`}.dart`,
    deployPath: artifact.deployPath ?? "",
    description: artifact.description ?? "",
    code: artifact.code ?? "// Test code",
    dependencies: artifact.dependencies ?? [],
    imports: artifact.imports ?? [],
    publicApi: artifact.publicApi ?? [],
    relationships: artifact.relationships ?? [],
    deployStatus: artifact.deployStatus ?? "pending",
    review: artifact.review ?? null,
    metadata: artifact.metadata ?? {},
    codeType: artifact.codeType ?? "C",
  }));

  return {
    schemaVersion: "1.0.0",
    id: "bundle-test-0001",
    title: "Deterministic test bundle",
    description: "Generated by browser fixture",
    artifacts: mappedArtifacts,
    dependencies: [],
    relationships: [],
    // src/artifactBundle.js resolves deployOrder entries against artifact.id,
    // and the deployment planner filters out unknown IDs — so the order must
    // name the artifacts' actual IDs to produce a real deployment plan.
    deployOrder: mappedArtifacts.map((artifact) => artifact.id),
    warnings: [],
    metadata: {},
  };
}

export const oneArtifact = () =>
  ok({
    output: JSON.stringify(
      buildArtifactBundle([
        {
          id: "custom-action-greet-user",
          artifactType: "CustomAction",
          artifactName: "GreetUser",
          code: "import 'package:flutter/material.dart';\nFuture<String> greetUser() async { return 'Hello'; }",
          codeType: "A",
        },
      ]),
    ),
    usage_status: "success",
    usage_count: 1,
    usage_month: new Date().toISOString().slice(0, 7),
  });

export const manyArtifacts = () =>
  ok({
    output: JSON.stringify(
      buildArtifactBundle([
        {
          id: "custom-class-event-model",
          artifactType: "CustomClass",
          artifactName: "AgentEvent",
          code: "class AgentEvent { final String type; AgentEvent(this.type); }",
          codeType: "C",
        },
        {
          id: "custom-action-parse-event",
          artifactType: "CustomAction",
          artifactName: "ParseAgentEvent",
          code:
            "import 'package:flutter/material.dart';\nimport 'agent_event.dart';\nAgentEvent parseEvent(String raw) { return AgentEvent(raw); }",
          codeType: "A",
        },
        {
          id: "custom-widget-agent-view",
          artifactType: "CustomWidget",
          artifactName: "AgentView",
          code:
            "import 'package:flutter/material.dart';\nimport 'agent_event.dart';\nclass AgentView extends StatelessWidget { @override Widget build(BuildContext context) { return Container(); } }",
          codeType: "W",
        },
      ]),
    ),
    usage_status: "success",
    usage_count: 3,
    usage_month: new Date().toISOString().slice(0, 7),
  });

export const missingReviewScore = () =>
  ok({
    output: JSON.stringify({
      status: "pass",
      summary: "Bundle compiles but review score is absent",
      manualActions: [],
      findings: [],
      artifacts: [
        {
          id: "custom-action-greet-user",
          review: { status: "pass", findings: [] },
        },
      ],
    }),
  });

export const rejectedGeneration = () =>
  err(400, {
    error: "Policy violation: prompt requests unsupported platform behavior",
    message: "Generation rejected by model armor",
  });

export const partialDeploy = () =>
  err(207, {
    success: false,
    deployed: ["custom-class-event-model"],
    failed: [
      {
        id: "custom-widget-agent-view",
        error: "Widget signature references unknown parameter type",
      },
    ],
  });

export const unknownDeploy = () =>
  err(500, { message: "Deploy service returned an unrecognized response" });

export const emptyProjectList = () => ok({ success: true, value: JSON.stringify({ entries: [] }) });

export const sampleProjectList = () =>
  ok({
    success: true,
    value: JSON.stringify({
      entries: [
        { id: "proj-abc-123", project: { name: "Test Project Alpha" } },
        { id: "proj-def-456", project: { name: "Test Project Beta" } },
      ],
    }),
  });

export const projectExport = () =>
  ok({
    success: true,
    value: JSON.stringify({
      project_zip: "UEsDBBQACAAIAAAAAAAAAAAAAAAAAAAAAAAIAAAAbWV0YS5Z", // minimal fake zip
    }),
  });

export const customCodeSync = () =>
  ok({
    success: true,
    value: JSON.stringify({ message: "Custom code synced" }),
  });

export const exchangeRates = () =>
  ok({
    result: "success",
    base_code: "AUD",
    rates: { USD: 0.65, EUR: 0.6, GBP: 0.52 },
  });

/**
 * Fulfill a Playwright route with a deterministic fixture response.
 */
export async function routeFulfill(page, urlPredicate, fixture) {
  await page.route(urlPredicate, async (route) => {
    const response = typeof fixture === "function" ? fixture() : fixture;
    await route.fulfill(response);
  });
}

// Inert payloads for the third-party STATIC assets index.html references
// WITHOUT a Subresource Integrity attribute. Aborting them would fail the
// page load with resource errors; loading them for real would make tests
// depend on live CDNs. The app's own inline stylesheet provides the
// `.hidden { display: none !important }` utility the tests rely on, so an
// empty Tailwind payload changes no assertion. Empty stylesheets keep their
// @font-face rules from pulling font files, and an empty document keeps the
// YouTube embeds from loading their player, ad and tracking scripts.
const INERT_SCRIPT = { status: 200, body: "", contentType: "application/javascript" };
const INERT_STYLESHEET = { status: 200, body: "", contentType: "text/css" };
const INERT_DOCUMENT = {
  status: 200,
  body: "<!doctype html><html><body></body></html>",
  contentType: "text/html; charset=utf-8",
};

// [urlPrefix, response] pairs for exactly the third-party assets index.html
// loads at page load without SRI. Matched by prefix so URL normalization
// (trailing slash) and query strings (fonts, YouTube start offsets) cannot
// dodge a stub.
const STATIC_ASSET_STUBS = [
  ["https://cdn.tailwindcss.com", INERT_SCRIPT],
  ["https://fonts.googleapis.com/css2", INERT_STYLESHEET],
  ["https://www.youtube.com/embed/", INERT_DOCUMENT],
];

// The third-party static assets index.html references WITH a Subresource
// Integrity attribute. A stub can never match the pinned digest — the
// browser blocks it with a console error — and app.js needs FingerprintJS
// during page initialization, so these are fulfilled from byte-identical
// local copies in ./vendor/. Because the bytes equal the pinned versions,
// the browser's SRI check passes, the app loads exactly the production
// code, and no request leaves the machine.
//
// Regenerate a vendored copy only when index.html pins a new version:
// download the exact pinned URL, then verify the digest against the
// integrity attribute index.html pins for it and stop on any mismatch.
//
//   curl -fsSL -o e2e/fixtures/vendor/jszip-3.10.1.min.js \
//     https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
//   curl -fsSL -o e2e/fixtures/vendor/highlight-11.9.0.min.js \
//     https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js
//   curl -fsSL -o e2e/fixtures/vendor/highlight-dart-11.9.0.min.js \
//     https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/dart.min.js
//   curl -fsSL -o e2e/fixtures/vendor/highlight-github-dark-11.9.0.css \
//     https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css
//   curl -fsSL -o e2e/fixtures/vendor/fingerprintjs-4.6.2.min.js \
//     https://cdn.jsdelivr.net/npm/@fingerprintjs/fingerprintjs@4.6.2/dist/fp.umd.min.js
//
// SRI check — sha512 for jszip, sha384 for the rest:
//   openssl dgst -sha384 -binary < e2e/fixtures/vendor/highlight-11.9.0.min.js \
//     | openssl base64 -A
//   openssl dgst -sha512 -binary < e2e/fixtures/vendor/jszip-3.10.1.min.js \
//     | openssl base64 -A
function vendoredAsset(fileName, contentType) {
  return {
    status: 200,
    body: readFileSync(new URL(`./vendor/${fileName}`, import.meta.url)),
    contentType,
  };
}

// [urlPrefix, response] pairs for the SRI-pinned assets, matched by prefix
// like STATIC_ASSET_STUBS so URL normalization or query strings cannot
// dodge a match. The bodies are raw Buffers read once at module load —
// byte-identical to the vendored files and to the pinned digests.
const VENDORED_SRI_ASSETS = [
  ["https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js", vendoredAsset("jszip-3.10.1.min.js", "application/javascript")],
  ["https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js", vendoredAsset("highlight-11.9.0.min.js", "application/javascript")],
  ["https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/dart.min.js", vendoredAsset("highlight-dart-11.9.0.min.js", "application/javascript")],
  ["https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css", vendoredAsset("highlight-github-dark-11.9.0.css", "text/css")],
  ["https://cdn.jsdelivr.net/npm/@fingerprintjs/fingerprintjs@4.6.2/dist/fp.umd.min.js", vendoredAsset("fingerprintjs-4.6.2.min.js", "application/javascript")],
];

/**
 * Apply the default route map that isolates the test from every external
 * service, then override specific endpoints to exercise auth, subscription or
 * generation states.
 *
 * Requests are handled in order:
 * 1. A fixture keyed by the exact request URL (default or override) is
 *    fulfilled — the only API responses a test ever sees.
 * 2. A static third-party asset from index.html is fulfilled with an inert
 *    stub, so a page load makes no unnecessary external requests.
 * 3. An SRI-pinned static asset from index.html is fulfilled with its
 *    byte-identical copy vendored in ./vendor/: the bytes match the pinned
 *    digest, so the browser's SRI check passes and the app loads the same
 *    code as in production — without touching the network.
 * 4. A same-origin request is served by the local Vite dev server — the
 *    document, ES modules, Vite internals and public assets — and continues.
 *    Paths under /api are the exception: vite.config.js proxies them to real
 *    AI providers, so they are not local assets and fall through to abort.
 * 5. Anything else is aborted. An un-fixtured external call must fail the
 *    test loudly rather than silently reach a paid generation or a real
 *    project.
 */
export async function applyDefaultRoutes(page, overrides = {}) {
  const routes = {
    [ENDPOINTS.identity]: guestIdentity(),
    [ENDPOINTS.authSendMagicLink]: magicLinkSent(),
    [ENDPOINTS.authVerifyMagicLink]: signedInSession(),
    [ENDPOINTS.authRefreshSession]: signedInSession(),
    [ENDPOINTS.getSubscription]: freeSubscription(),
    [ENDPOINTS.createCheckout]: checkoutSession(),
    [ENDPOINTS.createPortal]: portalSession(),
    [ENDPOINTS.connectFeedback]: ok({ success: true }),
    [ENDPOINTS.deployCustomClasses]: ok({ success: true, deployed: [] }),
    [ENDPOINTS.flutterFlowListProjects]: sampleProjectList(),
    [ENDPOINTS.flutterFlowLegacyListProjects]: sampleProjectList(),
    [ENDPOINTS.flutterFlowExportCode]: projectExport(),
    [ENDPOINTS.flutterFlowSyncCustomCodeChanges]: customCodeSync(),
    [ENDPOINTS.exchangeRates]: exchangeRates(),
    [ENDPOINTS.pipeline]: oneArtifact(),
    ...overrides,
  };

  await page.route("**/*", async (route) => {
    const requestUrl = route.request().url();

    const fixture = routes[requestUrl];
    if (fixture) {
      await route.fulfill(typeof fixture === "function" ? fixture() : fixture);
      return;
    }

    const staticStub = STATIC_ASSET_STUBS.find(([urlPrefix]) => requestUrl.startsWith(urlPrefix));
    if (staticStub) {
      await route.fulfill(staticStub[1]);
      return;
    }

    const vendoredAsset = VENDORED_SRI_ASSETS.find(([urlPrefix]) =>
      requestUrl.startsWith(urlPrefix),
    );
    if (vendoredAsset) {
      await route.fulfill(vendoredAsset[1]);
      return;
    }

    const { origin, pathname } = new URL(requestUrl);
    if (origin === VITE_ORIGIN && !pathname.startsWith("/api")) {
      await route.continue();
      return;
    }

    await route.abort();
  });
}
