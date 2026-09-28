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
const NEW_KEY = "ff-secret-token-xyz789";
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

// Gate the production projects endpoint: the next request can be held pending
// and released on demand, so a test can let a stale response land only after
// the endpoint changed. Every other production request answers immediately;
// the held request answers with `heldResponse` on release.
async function gateProductionListProjects(page, heldResponse = sampleProjectList) {
  let holdNext = false;
  let releaseHeld = null;
  let markHeld = null;
  const held = new Promise((resolve) => {
    markHeld = resolve;
  });

  await page.route(ENDPOINTS.flutterFlowListProjects, async (route) => {
    if (!holdNext) {
      await route.fulfill(sampleProjectList());
      return;
    }
    holdNext = false;
    markHeld();
    await new Promise((resolve) => {
      releaseHeld = resolve;
    });
    await route.fulfill(heldResponse());
  });

  return {
    holdNext: () => {
      holdNext = true;
    },
    waitForHeld: () => held,
    release: () => releaseHeld(),
  };
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

  test("a late project fetch from the previous endpoint cannot overwrite the new endpoint's list", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      ...signedInContext(),
      [ENDPOINTS.flutterFlowListProjects]: sampleProjectList(),
      [STAGING_LIST]: stagingProjectList(),
    });
    const gate = await gateProductionListProjects(page);

    await page.goto("/");
    await saveKeyThroughModal(page, { key: KEY, project: PROJ });
    await expect(page.locator("#acct-ff-project")).toHaveText(PROJ);

    // Re-open the editor: its production re-fetch is held in flight.
    gate.holdNext();
    await page
      .locator(".acct-connection button", { hasText: "Configure" })
      .first()
      .click();
    await expect(page.locator("#api-keys-modal")).toBeVisible();
    await gate.waitForHeld();

    // Switch to staging while the production response is still pending, so the
    // staging list is what the dropdown must show.
    await page
      .locator("#api-keys-modal summary", { hasText: "Advanced" })
      .click();
    await page
      .locator("#flutterflow-endpoint-select")
      .selectOption("https://api.flutterflow.io/v2-staging/");
    await expect(
      page.locator(`#flutterflow-projects-select option[value="proj-stg-789"]`),
    ).toHaveCount(1);

    // Release the stale production response: it must be discarded, not allowed
    // to replace the staging list the new endpoint already returned.
    const staleSettled = page.waitForResponse(ENDPOINTS.flutterFlowListProjects);
    gate.release();
    await staleSettled;
    await page.waitForTimeout(150);

    await expect(
      page.locator(`#flutterflow-projects-select option[value="proj-stg-789"]`),
    ).toHaveCount(1);
    await expect(
      page.locator(`#flutterflow-projects-select option[value="proj-abc-123"]`),
    ).toHaveCount(0);
    await expect(page.locator("#acct-ff-status")).toHaveText(
      "Connected to FlutterFlow",
    );
    await expect(page.locator("#acct-ff-project")).toHaveText("—");
  });

  test("a late connection check from the previous endpoint cannot overwrite the new endpoint's status", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, {
      ...signedInContext(),
      [ENDPOINTS.flutterFlowListProjects]: sampleProjectList(),
      [STAGING_LIST]: stagingProjectList(),
    });
    // The held check resolves with an empty list: a stale "no-projects"
    // outcome is visibly different from staging's "connected".
    const gate = await gateProductionListProjects(page, emptyProjectList);

    await page.goto("/");
    await saveKeyThroughModal(page, { key: KEY, project: PROJ });

    // Start a production connection check and keep its response pending.
    gate.holdNext();
    await page.evaluate(() => {
      window.validateFlutterFlowConnection();
    });
    await gate.waitForHeld();
    await expect(page.locator("#acct-ff-status")).toHaveText(
      "Checking connection…",
    );

    // Switch to staging while the check is still pending; staging's re-fetch
    // settles the card to connected.
    await page
      .locator(".acct-connection button", { hasText: "Configure" })
      .first()
      .click();
    await expect(page.locator("#api-keys-modal")).toBeVisible();
    await page
      .locator("#api-keys-modal summary", { hasText: "Advanced" })
      .click();
    await page
      .locator("#flutterflow-endpoint-select")
      .selectOption("https://api.flutterflow.io/v2-staging/");
    await expect(page.locator("#acct-ff-status")).toHaveText(
      "Connected to FlutterFlow",
    );

    // Release the stale check with a different outcome: it must not overwrite
    // the staging status or resurrect a target project.
    const staleSettled = page.waitForResponse(ENDPOINTS.flutterFlowListProjects);
    gate.release();
    await staleSettled;
    await page.waitForTimeout(150);

    await expect(page.locator("#acct-ff-status")).toHaveText(
      "Connected to FlutterFlow",
    );
    await expect(page.locator("#acct-ff-project")).toHaveText("—");
    await expect(
      page.locator(`#flutterflow-projects-select option[value="proj-stg-789"]`),
    ).toHaveCount(1);
  });

  test("a connection check started while a dropdown fetch is pending must not strand the dropdown", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, signedInContext());
    const gate = await gateProductionListProjects(page);

    await page.goto("/");
    await saveKeyThroughModal(page, { key: KEY, project: PROJ });
    await expect(page.locator("#acct-ff-project")).toHaveText(PROJ);

    // Re-open the editor: its dropdown re-fetch is held in flight, so the
    // dropdown shows the loading option while the response is pending.
    gate.holdNext();
    await page
      .locator(".acct-connection button", { hasText: "Configure" })
      .first()
      .click();
    await expect(page.locator("#api-keys-modal")).toBeVisible();
    await gate.waitForHeld();
    await expect(page.locator("#flutterflow-projects-select")).toContainText(
      "Loading projects...",
    );

    // Start a connection check for the same key and endpoint while the fetch
    // is still pending. It answers immediately (the gate holds one request);
    // the held fetch is the only response still outstanding.
    await page.evaluate(() => window.validateFlutterFlowConnection());
    await expect(page.locator("#acct-ff-status")).toHaveText(
      "Connected to FlutterFlow",
    );

    // Release the fetch. It belongs to the current key and endpoint, so its
    // response must still populate the dropdown — the check must not have
    // superseded it. If it did, the dropdown would be stranded on
    // "Loading projects..." forever.
    const fetchSettled = page.waitForResponse(ENDPOINTS.flutterFlowListProjects);
    gate.release();
    await fetchSettled;
    await expect(
      page.locator(`#flutterflow-projects-select option[value="${PROJ}"]`),
    ).toHaveCount(1);
    await expect(page.locator("#flutterflow-projects-select")).not.toContainText(
      "Loading projects...",
    );
    await expect(page.locator("#acct-ff-status")).toHaveText(
      "Connected to FlutterFlow",
    );
  });

  test("a late project fetch from the previous key cannot overwrite the new key's list", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, signedInContext());
    // Only the held OLD-key request answers with this list, so a stale
    // response landing after the key was replaced is unmistakable.
    const staleKeyList = () =>
      ok({
        success: true,
        value: JSON.stringify({
          entries: [
            { id: "proj-old-key-111", project: { name: "Old Key Project" } },
          ],
        }),
      });
    const gate = await gateProductionListProjects(page, staleKeyList);

    await page.goto("/");
    await saveKeyThroughModal(page, { key: KEY, project: PROJ });
    await expect(page.locator("#acct-ff-project")).toHaveText(PROJ);

    // Re-open the editor: its fetch with the saved key is held in flight.
    gate.holdNext();
    await page
      .locator(".acct-connection button", { hasText: "Configure" })
      .first()
      .click();
    await expect(page.locator("#api-keys-modal")).toBeVisible();
    await gate.waitForHeld();

    // Replace the key while the old key's fetch is still pending. The blur
    // fetch for the new key answers immediately, so the dropdown now shows
    // the list that belongs to the key being saved.
    const input = page.locator("#flutterflow-api-key-input");
    await input.fill(NEW_KEY);
    await input.blur();
    await expect(
      page.locator(`#flutterflow-projects-select option[value="${PROJ}"]`),
    ).toHaveCount(1);

    await page.locator("#api-keys-modal .bg-blue-500").click();
    await expect(page.locator("#api-keys-modal")).toBeHidden();
    await page.waitForTimeout(1300);
    await dismissOpenModals(page);

    // Release the stale old-key response: it must be discarded, not allowed
    // to replace the new key's list or regress its connection status.
    const staleSettled = page.waitForResponse(ENDPOINTS.flutterFlowListProjects);
    gate.release();
    await staleSettled;
    await page.waitForTimeout(150);

    await expect(
      page.locator(`#flutterflow-projects-select option[value="${PROJ}"]`),
    ).toHaveCount(1);
    await expect(
      page.locator(
        '#flutterflow-projects-select option[value="proj-old-key-111"]',
      ),
    ).toHaveCount(0);
    await expect(page.locator("#acct-ff-status")).toHaveText(
      "Connected to FlutterFlow",
    );
    await expect(page.locator("#acct-ff-project")).toHaveText("—");
  });

  test("replacing the key without choosing a project clears the old target", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, signedInContext());
    await page.goto("/");

    await saveKeyThroughModal(page, { key: KEY, project: PROJ });
    await expect(page.locator("#acct-ff-project")).toHaveText(PROJ);

    // Re-open the editor and replace the key. The dropdown re-selects the
    // stored project when its list loads, but that is not a choice.
    await page
      .locator(".acct-connection button", { hasText: "Configure" })
      .first()
      .click();
    await expect(page.locator("#api-keys-modal")).toBeVisible();
    const input = page.locator("#flutterflow-api-key-input");
    await input.fill(NEW_KEY);
    await input.blur();
    await expect(page.locator("#flutterflow-projects-select")).toHaveValue(PROJ);

    await page.locator("#api-keys-modal .bg-blue-500").click();
    await expect(page.locator("#api-keys-modal")).toBeHidden();
    await page.waitForTimeout(1300);
    await dismissOpenModals(page);

    // The old key's target is gone: nothing a later deploy reads can silently
    // point at it.
    const storedAfter = await page.evaluate(() =>
      localStorage.getItem("ccc_api_key_flutterflow_project_id"),
    );
    expect(storedAfter).toBeNull();
    await expect(page.locator("#acct-ff-project")).toHaveText("—");
    await expect(page.locator("#acct-ff-status")).toHaveText(
      "Connected to FlutterFlow",
    );
  });

  test("a project chosen from the old key's list cannot become the replaced key's target", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, signedInContext());
    await page.goto("/");

    await saveKeyThroughModal(page, { key: KEY, project: PROJ });
    await expect(page.locator("#acct-ff-project")).toHaveText(PROJ);

    // Re-open the editor: the dropdown shows the OLD key's list.
    await page
      .locator(".acct-connection button", { hasText: "Configure" })
      .first()
      .click();
    await expect(page.locator("#api-keys-modal")).toBeVisible();
    await expect(
      page.locator('#flutterflow-projects-select option[value="proj-def-456"]'),
    ).toHaveCount(1);

    // Choose a project from the old key's list before replacing the key. The
    // choice was produced by the old key's completed fetch, so it must not be
    // persisted as the new key's deploy target.
    await page.locator("#flutterflow-projects-select").selectOption("proj-def-456");

    const input = page.locator("#flutterflow-api-key-input");
    await input.fill(NEW_KEY);
    await page.locator("#api-keys-modal .bg-blue-500").click();
    await expect(page.locator("#api-keys-modal")).toBeHidden();
    await page.waitForTimeout(1300);
    await dismissOpenModals(page);

    // No target survives the key replacement: the old-key choice is not the
    // new key's target, and no later read can point at it.
    const storedAfter = await page.evaluate(() =>
      localStorage.getItem("ccc_api_key_flutterflow_project_id"),
    );
    expect(storedAfter).toBeNull();
    await expect(page.locator("#acct-ff-project")).toHaveText("—");
    await expect(page.locator("#acct-ff-status")).toHaveText(
      "Connected to FlutterFlow",
    );

    // The editor requires a fresh selection: the list loaded for the new key,
    // but nothing is selected from it.
    await page
      .locator(".acct-connection button", { hasText: "Configure" })
      .first()
      .click();
    await expect(page.locator("#api-keys-modal")).toBeVisible();
    await expect(
      page.locator(`#flutterflow-projects-select option[value="${PROJ}"]`),
    ).toHaveCount(1);
    await expect(page.locator("#flutterflow-projects-select")).toHaveValue("");
    await page.evaluate(() => window.closeApiKeysModal());

    // The deploy dialog likewise preselects nothing: a target may only come
    // from the list its own completed fetch produced for the current key.
    await page.evaluate(() => window.__CCC_OPEN_COMMIT_CONFIRM__());
    await expect(page.locator("#confirm-project-select")).toHaveValue("");
  });

  test("a stored target the current key's completed list omits is not deployable", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, signedInContext());
    await page.goto("/");

    // Establish a stored, confirmed target.
    await saveKeyThroughModal(page, { key: KEY, project: PROJ });

    // The key's project list changes: a later completed response for the same
    // key no longer lists the stored target.
    await applyDefaultRoutes(page, {
      ...signedInContext(),
      [ENDPOINTS.flutterFlowListProjects]: ok({
        success: true,
        value: JSON.stringify({
          entries: [
            { id: "proj-def-456", project: { name: "Test Project Beta" } },
          ],
        }),
      }),
    });

    // The real deploy dialog's completed fetch does not list the stored
    // target, so it must not be preselected...
    await page.evaluate(() => window.__CCC_OPEN_COMMIT_CONFIRM__());
    await expect(
      page.locator('#confirm-project-select option[value="proj-def-456"]'),
    ).toHaveCount(1);
    await expect(page.locator("#confirm-project-select")).toHaveValue("");

    // ...and confirming must fail before any push: the stored target lost its
    // confirmation with the completed list, so no deploy may target it.
    await page.evaluate(() => window.confirmCommitToFlutterFlow());
    const terminal = page.locator("#commit-terminal-modal");
    await expect(terminal).toBeVisible();
    await expect(terminal).toContainText("not confirmed");
    await expect(terminal).not.toContainText(PROJ);
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

  test("a previewed key's leftover choice cannot erase the stored target on save", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, signedInContext());
    await page.goto("/");

    await saveKeyThroughModal(page, { key: KEY, project: PROJ });
    await expect(page.locator("#acct-ff-project")).toHaveText(PROJ);

    // The preview key answers with a distinct list: its only project is
    // unmistakably the preview key's, never the configured key's. listProjects
    // carries the key in its Authorization header, so the route can tell the
    // two requests apart.
    const previewList = () =>
      ok({
        success: true,
        value: JSON.stringify({
          entries: [
            { id: "proj-prev-999", project: { name: "Preview Only" } },
          ],
        }),
      });
    await page.route(ENDPOINTS.flutterFlowListProjects, async (route) => {
      const auth = route.request().headers()["authorization"] || "";
      await route.fulfill(auth.includes(NEW_KEY) ? previewList() : sampleProjectList());
    });

    // Re-open the editor and preview a different key without saving it: the
    // blur fetch fills the dropdown with the preview key's list, and picking
    // from it binds that choice to the preview key — not the configured one.
    await page
      .locator(".acct-connection button", { hasText: "Configure" })
      .first()
      .click();
    await expect(page.locator("#api-keys-modal")).toBeVisible();
    const input = page.locator("#flutterflow-api-key-input");
    await input.fill(NEW_KEY);
    await input.blur();
    await expect(
      page.locator('#flutterflow-projects-select option[value="proj-prev-999"]'),
    ).toHaveCount(1);
    await page
      .locator("#flutterflow-projects-select")
      .selectOption("proj-prev-999");

    // Clear the key input and save: the configured key stays the stored one,
    // so the dropdown's preview choice is not a selection for it. The stored
    // target must survive instead of being cleared with the preview.
    await input.fill("");
    await page.locator("#api-keys-modal .bg-blue-500").click();
    await expect(page.locator("#api-keys-modal")).toBeHidden();
    await page.waitForTimeout(1300);
    await dismissOpenModals(page);

    const storedAfter = await page.evaluate(() =>
      localStorage.getItem("ccc_api_key_flutterflow_project_id"),
    );
    expect(storedAfter).not.toBeNull();
    await expect(page.locator("#acct-ff-project")).toHaveText(PROJ);
    await expect(page.locator("#acct-ff-status")).toHaveText(
      "Connected to FlutterFlow",
    );

    // The deploy dialog must still offer the stored project: its completed
    // fetch re-confirms the target the preview almost erased.
    await page.evaluate(() => window.__CCC_OPEN_COMMIT_CONFIRM__());
    await expect(page.locator("#confirm-project-select")).toHaveValue(PROJ);
  });

  test("a late dropdown fetch cannot overwrite a newer failed connection check", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, signedInContext());
    await page.goto("/");

    await saveKeyThroughModal(page, { key: KEY, project: PROJ });
    await expect(page.locator("#acct-ff-status")).toHaveText(
      "Connected to FlutterFlow",
    );

    // From here the next projects request (the editor's dropdown fetch) is
    // held pending; the connection check issued behind it answers 401.
    let releaseHeld;
    let markHeld;
    const held = new Promise((resolve) => {
      markHeld = resolve;
    });
    let heldUsed = false;
    await page.route(ENDPOINTS.flutterFlowListProjects, async (route) => {
      if (!heldUsed) {
        heldUsed = true;
        markHeld();
        await new Promise((resolve) => {
          releaseHeld = resolve;
        });
        await route.fulfill(sampleProjectList());
        return;
      }
      await route.fulfill(err(401, { error: "unauthorized" }));
    });

    // Open the editor: its dropdown fetch is the held request.
    await page
      .locator(".acct-connection button", { hasText: "Configure" })
      .first()
      .click();
    await expect(page.locator("#api-keys-modal")).toBeVisible();
    await held;

    // The connection check issues behind the held fetch and settles first:
    // its 401 is the newest shared outcome.
    await page.evaluate(() => window.validateFlutterFlowConnection());
    await expect(page.locator("#acct-ff-status")).toHaveText(
      "API key rejected (401/403) — re-enter your key",
    );

    // Release the older fetch. Its options still populate the dropdown (its
    // own surface), but its connection outcome is stale: it must not flip the
    // card back to connected or re-confirm the stored target over the 401.
    const fetchSettled = page.waitForResponse(ENDPOINTS.flutterFlowListProjects);
    releaseHeld();
    await fetchSettled;
    await page.waitForTimeout(150);

    await expect(
      page.locator(`#flutterflow-projects-select option[value="${PROJ}"]`),
    ).toHaveCount(1);
    await expect(page.locator("#acct-ff-status")).toHaveText(
      "API key rejected (401/403) — re-enter your key",
    );
    await expect(page.locator("#acct-ff-status")).not.toHaveText(
      "Connected to FlutterFlow",
    );
  });

  test("a direct commit issued while the post-reload list is pending still deploys the saved project", async ({ page }) => {
    await seedSession(page);
    await applyDefaultRoutes(page, signedInContext());
    await page.goto("/");

    await saveKeyThroughModal(page, { key: KEY, project: PROJ });
    await expect(page.locator("#acct-ff-project")).toHaveText(PROJ);

    // Reload with the startup check held pending: storage has the saved key +
    // project but the process-local confirmation binding is still empty.
    const gate = await gateProductionListProjects(page);
    gate.holdNext();
    await page.reload({ waitUntil: "domcontentloaded" });
    await gate.waitForHeld();

    // A direct commit must not refuse the saved target merely because the
    // binding is unpopulated: it verifies the stored project against the
    // current key's real list and proceeds. The proof is the deploy reaching
    // the remote pipeline — exportCode is the first call past the target
    // gate, and a refused target never produces it. The fixtures' fake
    // project source fails the later pubspec merge; that downstream error is
    // fine, as long as it is not the target-gate refusal.
    const exported = page.waitForRequest(ENDPOINTS.flutterFlowExportCode);
    const result = await page.evaluate(() =>
      window.commitToFlutterFlow(
        "class TestWidget extends StatelessWidget {}",
        "test_widget.dart",
      ),
    );
    await exported;
    expect(result.error || "").not.toMatch(/not confirmed/i);
    gate.release();
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
