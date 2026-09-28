import { test, expect } from "@playwright/test";
import {
  applyDefaultRoutes,
  guestIdentity,
  signedInSession,
  freeSubscription,
  ok,
  err,
  sampleProjectList,
  stagingProjectList,
  emptyProjectList,
  ENDPOINTS,
} from "./fixtures/apiFixtures.js";

/**
 * STU-384 — account connection + single provider-key editor.
 *
 * The account connection card is the canonical, single editor surface for the
 * FlutterFlow key, endpoint and target project. Every entry point
 * (page/settings/account) opens the same api-keys modal and writes through the
 * same encrypted storage, so there is exactly one value across save, reload and
 * removal. The "connected" claim is only ever derived from a real projects
 * response — never from stored bytes and never the placeholder "set" — and no
 * key material (raw or masked) is rendered into a status label.
 */
const KEY = "ff-secret-token-abc123";
const PROJ = "proj-abc-123";
const EMAIL = "metered@example.com";
const STAGING_LIST = "https://api.flutterflow.io/v2-staging/listProjects";

const sessionFor = (email = EMAIL) => ({
  status: 200,
  body: JSON.stringify({ email, sessionToken: "session-token" }),
  contentType: "application/json",
});

function signedInContext(email = EMAIL) {
  return {
    [ENDPOINTS.identity]: {
      status: 200,
      body: JSON.stringify({
        status: "recognized",
        user_id: "acct-0001",
        identity_token: "identity-token",
        usage_count: 2,
        usage_month: new Date().toISOString().slice(0, 7),
      }),
      contentType: "application/json",
    },
    [ENDPOINTS.authRefreshSession]: sessionFor(email),
    [ENDPOINTS.getSubscription]: freeSubscription(),
  };
}

async function seedSession(page, email = EMAIL) {
  await page.addInitScript(({ email }) => {
    localStorage.setItem(
      "ccc_auth_session",
      JSON.stringify({ email, sessionToken: "session-token" }),
    );
  }, { email });
}

async function openAccount(page) {
  await dismissOpenModals(page);
  await page.locator('a.nav-link[data-view="account"]').click();
  await expect(page.locator("#account-view")).toBeVisible();
}

// Saving through the api-keys modal closes it and (existing behaviour) reopens
// the walkthrough over the page. Close it through the app's own handler so the
// sharedControls background-inert state is restored; a raw classList removal
// would leave the background inert and block every later click.
async function dismissOpenModals(page) {
  await page.evaluate(() => {
    const open = document.querySelector(".modal-overlay.open");
    if (!open) return;
    if (open.id === "walkthrough-modal" && window.closeWalkthroughModal) {
      window.closeWalkthroughModal();
    }
  });
}

async function saveKeyThroughModal(page, { key, project } = {}) {
  // Open the canonical editor from the account connection card.
  await openAccount(page);
  await page
    .locator(".acct-connection button", { hasText: "Configure" })
    .first()
    .click();
  await expect(page.locator("#api-keys-modal")).toBeVisible();

  const input = page.locator("#flutterflow-api-key-input");
  await input.fill(key);

  // Blur triggers a real listProjects fetch that populates the dropdown.
  await input.blur();
  if (project) {
    await expect(
      page.locator(`#flutterflow-projects-select option[value="${project}"]`),
    ).toHaveCount(1);
    await page.locator("#flutterflow-projects-select").selectOption(project);
  }

  await page.locator("#api-keys-modal .bg-blue-500").click();
  await expect(page.locator("#api-keys-modal")).toBeHidden();
  // saveApiKeys closes the modal and (existing behaviour) reopens the
  // walkthrough inside a 1s timeout; wait it out, then clear the overlay once.
  await page.waitForTimeout(1300);
  await dismissOpenModals(page);
}

test.describe("STU-384 account connection", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("hasSeenWalkthrough", "true");
    });
  });

  test("not-configured state is shown when no key is stored", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, signedInContext());
    await page.goto("/");
    await openAccount(page);

    await expect(page.locator("#acct-ff-status")).toHaveText(
      "Not connected — add your FlutterFlow API key",
    );
  });

  test("connected only from a real response; saves and reloads share one stored value", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, signedInContext());
    await page.goto("/");

    await saveKeyThroughModal(page, { key: KEY, project: PROJ });

    // Connected is claimed only after the projects endpoint responds.
    await expect(page.locator("#acct-ff-status")).toHaveText(
      "Connected to FlutterFlow",
    );
    await expect(page.locator("#acct-ff-project")).toHaveText(PROJ);
    await expect(page.locator("#acct-ff-dot")).toHaveClass(/ok/);

    // The status label and card never expose the raw or a masked key.
    const card = page.locator(".acct-card.acct-connection");
    await expect(card).not.toContainText(KEY);
    await expect(page.locator("#acct-ff-status")).not.toContainText("••••");

    // Reload: the account card revalidates the same stored key -> connected.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openAccount(page);
    await expect(page.locator("#acct-ff-status")).toHaveText(
      "Connected to FlutterFlow",
    );
    await expect(page.locator("#acct-ff-project")).toHaveText(PROJ);
  });

  test("empty project list is distinct from an auth failure", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      ...signedInContext(),
      [ENDPOINTS.flutterFlowListProjects]: emptyProjectList(),
    });
    await page.goto("/");
    await saveKeyThroughModal(page, { key: KEY, project: undefined });

    // A successful but empty response is "no-projects", not an auth error.
    await expect(page.locator("#acct-ff-status")).toHaveText(
      "Key accepted — no projects found",
    );
  });

  test("401/403 renders an unauthorized state, distinct from empty/network", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      ...signedInContext(),
      [ENDPOINTS.flutterFlowListProjects]: err(403, '{"message":"Forbidden"}'),
    });
    await page.goto("/");
    await saveKeyThroughModal(page, { key: KEY, project: undefined });

    await expect(page.locator("#acct-ff-status")).toHaveText(
      "API key rejected (401/403) — re-enter your key",
    );
    await expect(page.locator("#acct-ff-dot")).toHaveClass(/bad/);
  });

  test("network error state, then a retry recovers to connected", async ({ page }) => {
    await seedSession(page);
    // First all FlutterFlow project calls fail (network error).
    await applyDefaultRoutes(page, {
      ...signedInContext(),
      [ENDPOINTS.flutterFlowListProjects]: err(503, "boom"),
    });
    await page.goto("/");
    await saveKeyThroughModal(page, { key: KEY, project: undefined });

    await expect(page.locator("#acct-ff-status")).toHaveText(
      "Could not reach FlutterFlow — check your network",
    );
    await expect(page.locator("#acct-ff-dot")).toHaveClass(/bad/);

    // Failure retry: subsequent success flips the state to connected. A later
    // registered route takes precedence in Playwright, so the sample fixture
    // now wins over the earlier 503 route.
    await applyDefaultRoutes(page, {
      ...signedInContext(),
      [ENDPOINTS.flutterFlowListProjects]: sampleProjectList(),
    });
    await page.evaluate(() => window.validateFlutterFlowConnection());
    await expect(page.locator("#acct-ff-status")).toHaveText(
      "Connected to FlutterFlow",
    );
  });

  test("endpoint change invalidates stale project selection and re-fetches", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      ...signedInContext(),
      [ENDPOINTS.flutterFlowListProjects]: sampleProjectList(),
      // A deliberately DIFFERENT list on staging: the test only passes if the
      // re-fetch actually hits the staging host. Returning the same list on
      // both hosts (as before) could not tell production from staging.
      [STAGING_LIST]: stagingProjectList(),
    });
    await page.goto("/");
    await saveKeyThroughModal(page, { key: KEY, project: PROJ });

    await expect(page.locator("#acct-ff-project")).toHaveText(PROJ);
    const storedBefore = await page.evaluate(() =>
      localStorage.getItem("ccc_api_key_flutterflow_project_id"),
    );
    expect(storedBefore).not.toBeNull();

    // Switch to staging — the stored project no longer belongs to this
    // endpoint, so the selection must be invalidated and the list re-fetched.
    // We are already on the account view (the modal opened from it).
    await dismissOpenModals(page);
    await page
      .locator(".acct-connection button", { hasText: "Configure" })
      .first()
      .click();
    await expect(page.locator("#api-keys-modal")).toBeVisible();
    // The endpoint picker lives inside the collapsed "Advanced" disclosure.
    await page
      .locator("#api-keys-modal summary", { hasText: "Advanced" })
      .click();
    await page.locator("#flutterflow-endpoint-select").selectOption(
      "https://api.flutterflow.io/v2-staging/",
    );

    const storedAfter = await page.evaluate(() =>
      localStorage.getItem("ccc_api_key_flutterflow_project_id"),
    );
    expect(storedAfter).toBeNull();
    await expect(page.locator("#acct-ff-project")).toHaveText("—");
    await expect(page.locator("#acct-ff-status")).toHaveText(
      "Connected to FlutterFlow",
    );

    // The re-fetch must have hit the STAGING host: only the staging project is
    // offered and no production-only project remains. If the client fell back
    // to the production endpoint, proj-stg-789 would never appear.
    await expect(
      page.locator(
        `#flutterflow-projects-select option[value="proj-stg-789"]`,
      ),
    ).toHaveCount(1);
    await expect(
      page.locator(`#flutterflow-projects-select option[value="proj-def-456"]`),
    ).toHaveCount(0);
  });

  test("removing the key flips the connection card back to not-configured", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, signedInContext());
    await page.goto("/");

    await saveKeyThroughModal(page, { key: KEY, project: PROJ });
    await expect(page.locator("#acct-ff-status")).toHaveText(
      "Connected to FlutterFlow",
    );
    await expect(page.locator("#acct-ff-project")).toHaveText(PROJ);

    // Re-open the canonical editor for the account card and clear every key.
    await page
      .locator(".acct-connection button", { hasText: "Configure" })
      .first()
      .click();
    await expect(page.locator("#api-keys-modal")).toBeVisible();

    // Accept the destructive confirm, then close the modal through the app's
    // own handler so the sharedControls background-inert state is restored.
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .locator("#api-keys-modal button", { hasText: "Clear All Keys" })
      .click();
    await page.evaluate(() => window.closeApiKeysModal());

    // The card must flip back to not-configured: no stale "connected" state
    // may survive removal, and no target project may linger.
    await expect(page.locator("#acct-ff-status")).toHaveText(
      "Not connected — add your FlutterFlow API key",
    );
    await expect(page.locator("#acct-ff-project")).toHaveText("—");
    await expect(page.locator("#acct-ff-dot")).not.toHaveClass(/ok/);

    // No masked or raw key material may remain in any account card label.
    const card = page.locator(".acct-card.acct-connection");
    await expect(card).not.toContainText(KEY);
    await expect(page.locator("#acct-ff-status")).not.toContainText("••••");
  });

  test("signed-out entry can still save the key without a connection card", async ({ page }) => {
    // No session seeded: the account view shows the signed-out prompt.
    await applyDefaultRoutes(page, {
      [ENDPOINTS.identity]: guestIdentity(),
    });
    await page.goto("/");

    await page.locator('a.nav-link[data-view="account"]').click();
    await expect(page.locator("#auth-signedout")).toBeVisible();
    await expect(page.locator("#account-view #auth-signedin")).toBeHidden();

    // The canonical editor stays reachable from the home settings entry point.
    await page.locator('a.nav-link[data-view="home"]').click();
    await page.locator('button.settings-link', { hasText: "Configure API Keys" }).click();
    await expect(page.locator("#api-keys-modal")).toBeVisible();
    await page.locator("#flutterflow-api-key-input").fill(KEY);
    await page.locator("#api-keys-modal .bg-blue-500").click();
    await expect(page.locator("#api-keys-modal")).toBeHidden();

    // Reload reads the saved key from the same storage (one value).
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('button.settings-link', { hasText: "Configure API Keys" }).click();
    await expect(page.locator("#flutterflow-api-key-input")).toHaveAttribute(
      "placeholder",
      /Key saved/,
    );
  });
});
