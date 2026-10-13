import { test, expect } from '@playwright/test';
import { applyDefaultRoutes, ENDPOINTS, oneArtifact, reviewPassed, professionalSubscription, providerError } from './fixtures/apiFixtures.js';
import { openCanonicalReference } from './fixtures/canonicalReference.js';

const PROMPT = 'A circular progress gauge with a gradient stroke and an animated percentage label';

test('sampled vendor telemetry is fulfilled locally even when sampling fires', async ({ page }) => {
  await open(page, { reducedMotion:'reduce' });
  const response = page.waitForResponse('https://m1.openfpcdn.io/fingerprintjs/v4.6.2/npm-monitoring');
  await page.evaluate(async () => {
    // Exercise the 0.1% path in the exact vendored library, then immediately
    // restore randomness. This does not replace any app code or asset bytes.
    const random = Math.random;
    let load;
    try { Math.random = () => 0; load = window.FingerprintJS.load(); }
    finally { Math.random = random; }
    await load;
  });
  expect((await response).status()).toBe(200);
});

async function open(page, { reducedMotion = 'no-preference' } = {}) {
  await page.emulateMedia({ reducedMotion });
  await page.addInitScript(() => {
    localStorage.setItem('hasSeenWalkthrough', 'true');
    localStorage.setItem('ccc_auth_session', JSON.stringify({ email:'test@example.com', sessionToken:'test-session-token-0001' }));
    window.motionEvidence = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function(frames, options) {
      const animation = animate.call(this, frames, options);
      if (this.classList.contains('composer-morph')) {
        const record = { frames, options, samples:[] };
        window.motionEvidence.push(record);
        for (const t of [0,157,314,560,1400]) setTimeout(() => {
          const panel = document.getElementById('main-stage-container');
          const title = panel.querySelector('#progress-title-text');
          record.samples.push({ t, visibility:getComputedStyle(panel).visibility, titleVisibility:getComputedStyle(title).visibility, ghost:this.isConnected });
        }, t);
      }
      return animation;
    };
  });
  await applyDefaultRoutes(page, { [ENDPOINTS.getSubscription]:professionalSubscription() });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => typeof window.runThinkingPipeline === 'function');
}

async function gates(page) {
  const calls = [];
  const releases = {};
  for (const step of ['architect','generator','review']) {
    let resolve;
    const held = new Promise(r => { resolve = r; });
    releases[step] = { held, resolve };
  }
  await page.route(ENDPOINTS.pipeline, async route => {
    const step = route.request().postDataJSON().step;
    calls.push(step);
    const response = await releases[step].held;
    await route.fulfill(response || (step === 'review' ? reviewPassed() : oneArtifact()));
  });
  return { calls, release:(step, response) => releases[step].resolve(response) };
}

async function submit(page) {
  await page.locator('#pipeline-input').fill(PROMPT);
  await page.locator('#hero-send').click();
}

async function rect(page, selector) {
  return page.locator(selector).evaluate(el => {
    const r = el.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height];
  });
}

async function box(page, selector, expected) {
  const actual = await rect(page, selector);
  actual.forEach((value,i) => expect(Math.abs(value - expected[i]), `${selector} component ${i}: ${actual} vs ${expected}`).toBeLessThanOrEqual(1));
}

async function accountRoundTrip(page) {
  await page.locator('#topbar-avatar').click();
  await expect(page.locator('#account-view')).toBeVisible();
  await page.locator('a.brand').click();
  await expect(page.locator('#home-view')).toBeVisible();
}

// Fixed structural coordinates remain independent of either render. Intrinsic
// text geometry comes from the pinned source in this same browser/viewport,
// not a platform-specific line-wrap measurement. Both use real frozen fonts.
for (const width of [1920,1440,1366,921,920,390,389]) {
  test(`reference stage and panel geometry at ${width}px`, async ({ page, context }, testInfo) => {
    await page.setViewportSize({ width, height:width <= 390 ? 844 : width === 1366 ? 768 : width === 1440 ? 900 : 1080 });
    await open(page);
    const reference = await context.newPage();
    await openCanonicalReference(reference, page.viewportSize());
    const run = await gates(page);
    await page.waitForTimeout(800); // authored first-load reveal
    const scale = Math.min(1,width/1920);
    if (width > 920) {
      await box(page, '.topbar', [0,0,width,88*scale]);
      await box(page, '#composer', [580*scale,575.76*scale,760*scale,148*scale]);
      await box(page, '#pipeline-input', [605*scale,596.76*scale,710*scale,58*scale]);
      await box(page, '#hero-send', [1279*scale,662.76*scale,44*scale,44*scale]);
    } else if (width === 390) {
      await box(page, '#composer', [20,408.859375,350,148]);
      await box(page, '#pipeline-input', [40,426.859375,310,94]);
      await box(page, '#hero-send', [314,500.859375,44,44]);
    }
    await reference.locator('#prompt').fill(PROMPT);
    await Promise.all([submit(page), reference.locator('.send').click()]);
    await expect.poll(() => run.calls).toEqual(['architect']);
    await page.waitForTimeout(2300);
    await expect(reference.locator('#pipeline-title')).toHaveText('Understanding your prompt');
    await expect(page.locator('#progress-title-text')).toHaveText('Understanding your prompt');
    await expect(reference.locator('#submitted-prompt')).toHaveText(PROMPT);
    await expect(page.locator('#pipeline-submitted-prompt')).toHaveText(PROMPT);
    for (const [appSelector, referenceSelector] of [
      ['#main-stage-container', '.walkthrough-layout'],
      ['#progress-title-text', '#pipeline-title'],
      ['#progress-description-text', '#pipeline-description'],
      ['.progress-track', '.pipeline-track'],
    ]) await box(page, appSelector, await rect(reference, referenceSelector));
    for (const [render, selector] of [[page, '#progress-title-text'], [reference, '#pipeline-title']]) {
      await expect(render.locator(selector)).toHaveCSS('letter-spacing', width <= 920 ? '-0.625px' : '-0.85px'); // -.025em
      expect(await render.evaluate(() => document.fonts.check('500 25px Delight'))).toBe(true);
    }
    if (width > 920) {
      await box(page, '#main-stage-container', [250*scale,164*scale,1420*scale,590*scale]);
      await box(page, '.pipeline-prompt-recap', [252*scale,166*scale,310*scale,586*scale]);
      await box(page, '.progress-track', [626*scale,553.1875*scale,978*scale,4*scale]);
    } else {
      const panel = await rect(reference, '.walkthrough-layout');
      const track = await rect(reference, '.pipeline-track');
      await box(page, '#main-stage-container', [20,92,width-40,panel[3]]);
      await box(page, '.progress-track', [46,track[1],width-92,4]);
      await expect(page.locator('#progress-title-text')).toHaveCSS('font-size','25px');
      await expect(page.locator('#progress-title-text')).toHaveCSS('line-height','30px');
    }
    if (width === 1920 || width <= 390) {
      await page.screenshot({ path:testInfo.outputPath('app-pipeline.png'), fullPage:true });
      await reference.screenshot({ path:testInfo.outputPath('reference-pipeline.png'), fullPage:true });
    }
    await reference.close();
    const sidebar = await page.locator('.pipeline-prompt-recap').elementHandle();
    run.release('architect');
    await expect.poll(() => run.calls).toEqual(['architect','generator']);
    await expect(page.locator('#progress-stage-count')).toHaveText('Step 2 of 3');
    run.release('generator');
    await expect.poll(() => run.calls).toEqual(['architect','generator','review']);
    run.release('review');
    await expect(page.locator('#results-view')).toBeVisible();
    await page.waitForTimeout(2200);
    expect(await sidebar.evaluate(el => el === document.querySelector('.pipeline-prompt-recap') && el.isConnected)).toBe(true);
    await expect(page.locator('#pipeline-submitted-prompt')).toHaveText(PROMPT);
    await expect(page.locator('.review-score strong')).toHaveText('96');
    if (width > 920) {
      await box(page, '#main-stage-container', [40*scale,104*scale,1840*scale,936*scale]);
      await box(page, '.results-action-bar', [400*scale,941*scale,1430*scale,57*scale]);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect(page.locator('.composer-morph')).toHaveCount(0);
  });
}

for (const reducedMotion of ['no-preference','reduce']) {
  for (const outcome of ['held Architect','backend failure']) {
    test(`Edit after ${outcome} preserves the composer through two navigation cycles and a successful retry (${reducedMotion})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width:390,height:844 });
      await open(page, { reducedMotion });
      for (const cycle of [1,2]) {
        const run = await gates(page);
        await submit(page);
        await expect.poll(() => run.calls).toEqual(['architect']);
        if (outcome === 'backend failure') {
          run.release('architect', providerError());
          await expect(page.locator('#pipeline-failure')).toBeVisible();
          await page.locator('#pipeline-failure-actions [data-action="edit"]').click();
        } else {
          await page.locator('#pipeline-edit-prompt').click();
          run.release('architect');
        }
        await expect(page.locator('#composer')).toBeVisible();
        await accountRoundTrip(page);
        await page.waitForTimeout(1500); // stale response and cancelled handoff must stay retired
        await page.screenshot({ path:testInfo.outputPath(`edited-home-${cycle}.png`), fullPage:true });
        await expect(page.locator('#composer')).toBeVisible();
        await expect(page.locator('#pipeline-input')).toHaveValue(PROMPT);
        await expect(page.locator('#hero-send')).toBeEnabled();
        await expect(page.locator('#generation-stage')).toBeHidden();
        await expect(page.locator('#pipeline-progress')).toHaveAttribute('data-run-state','settled');
        await expect(page.locator('#pipeline-progress')).toBeHidden();
        await expect(page.locator('#results-view')).toBeHidden();
        await expect(page.locator('.composer-morph')).toHaveCount(0);
        expect(run.calls).toEqual(['architect']);
      }

      const retry = await gates(page);
      await submit(page);
      retry.release('architect'); retry.release('generator'); retry.release('review');
      await expect(page.locator('#results-view')).toBeVisible();
      const expectedCode = JSON.parse(JSON.parse(oneArtifact().body).output).artifacts[0].code;
      for (const cycle of [1,2]) {
        if (cycle === 2) await page.locator('#artifact-tabs [role=tab]').first().click();
        await accountRoundTrip(page);
        await expect(page.locator('#results-view')).toBeVisible();
        await expect(page.locator('#composer')).toBeHidden();
        await expect(page.locator('#pipeline-submitted-prompt')).toHaveText(PROMPT);
        await expect(page.locator('.review-score strong')).toHaveText('96');
        expect((await page.locator('#results-code-output .code-line').allTextContents()).join('\n')).toBe(expectedCode);
        await expect(page.locator(cycle === 1 ? '#results-summary-tab' : '#artifact-tabs [role=tab]')).toHaveAttribute('aria-selected','true');
        await expect(page.locator('.composer-morph')).toHaveCount(0);
      }
      expect(retry.calls).toEqual(['architect','generator','review']);
      await page.screenshot({ path:testInfo.outputPath('retry-results-retained.png'), fullPage:true });
    });
  }

  for (const returnAction of ['Edit prompt','focusPromptInput']) {
    test(`explicit composer return via ${returnAction} is not undone by navigation after Results (${reducedMotion})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width:390,height:844 });
      await open(page, { reducedMotion });
      const run = await gates(page);
      await submit(page);
      run.release('architect'); run.release('generator'); run.release('review');
      await expect(page.locator('#results-view')).toBeVisible();
      await expect(page.locator('.review-score strong')).toHaveText('96');
      if (returnAction === 'Edit prompt') await page.locator('#pipeline-edit-prompt').click();
      else await page.evaluate(() => window.focusPromptInput());
      await expect(page.locator('#composer')).toBeVisible();
      for (const cycle of [1,2]) {
        await accountRoundTrip(page);
        await expect(page.locator('#composer')).toBeVisible();
        await expect(page.locator('#pipeline-input')).toHaveValue(PROMPT);
        await expect(page.locator('#hero-send')).toBeEnabled();
        await expect(page.locator('#generation-stage')).toBeHidden();
        await expect(page.locator('.composer-morph')).toHaveCount(0);
      }
      expect(run.calls).toEqual(['architect','generator','review']);
      await page.screenshot({ path:testInfo.outputPath('completed-result-return-home.png'), fullPage:true });
    });
  }

  test(`abandoned Architect returns to the preserved composer on both navigation cycles (${reducedMotion})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width:1920,height:1080 });
    await open(page, { reducedMotion });
    for (const cycle of [1,2]) {
      const run = await gates(page);
      await submit(page);
      await expect.poll(() => run.calls).toEqual(['architect']);
      await page.locator('#topbar-avatar').click();
      await expect(page.locator('#account-view')).toBeVisible();
      await page.locator('a.brand').click();
      await expect(page.locator('#home-view')).toBeVisible();
      run.release('architect');
      await page.waitForTimeout(1500); // late response and all abandoned handoff timers
      await page.screenshot({ path:testInfo.outputPath(`abandoned-home-${cycle}.png`), fullPage:true });
      expect(run.calls).toEqual(['architect']);
      await expect(page.locator('#pipeline-progress')).toHaveAttribute('data-run-state','settled');
      await expect(page.locator('#pipeline-progress')).toBeHidden();
      await expect(page.locator('#generation-stage')).toBeHidden();
      await expect(page.locator('#composer')).toBeVisible();
      await expect(page.locator('#pipeline-input')).toHaveValue(PROMPT);
      await expect(page.locator('#hero-send')).toBeEnabled();
      await expect(page.locator('.composer-morph')).toHaveCount(0);
      await expect(page.locator('#results-view')).toBeHidden();
    }
  });

  test(`completed Results retain fullscreen layout and raw code on both navigation cycles (${reducedMotion})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width:1920,height:1080 });
    await open(page, { reducedMotion });
    const run = await gates(page);
    await submit(page);
    run.release('architect'); run.release('generator'); run.release('review');
    await expect(page.locator('#results-view')).toBeVisible();
    await page.waitForTimeout(2200);
    await box(page, '#main-stage-container', [40,104,1840,936]);
    const expectedCode = JSON.parse(JSON.parse(oneArtifact().body).output).artifacts[0].code;
    for (const cycle of [1,2]) {
      // First preserve Summary, then preserve the selected file on the second visit.
      if (cycle === 2) await page.locator('#artifact-tabs [role=tab]').first().click();
      await page.locator('#topbar-avatar').click();
      await expect(page.locator('#account-view')).toBeVisible();
      await expect(page.locator('#generation-stage')).toBeHidden();
      await page.locator('a.brand').click();
      await expect(page.locator('#results-view')).toBeVisible();
      await page.waitForTimeout(300); // router visibility transition
      await page.screenshot({ path:testInfo.outputPath(`results-home-${cycle}.png`), fullPage:true });
      await box(page, '#main-stage-container', [40,104,1840,936]);
      await box(page, '.results-action-bar', [400,941,1430,57]);
      await expect(page.locator('body')).toHaveClass(/results-fullscreen/);
      await expect(page.locator('body')).toHaveClass(/results-with-sidebar/);
      await expect(page.locator('#main-stage-container')).toHaveCSS('visibility','visible');
      await expect(page.locator('#pipeline-submitted-prompt')).toHaveText(PROMPT);
      await expect(page.locator('.review-score strong')).toHaveText('96');
      expect((await page.locator('#results-code-output .code-line').allTextContents()).join('\n')).toBe(expectedCode);
      await expect(page.locator(cycle === 1 ? '#results-summary-tab' : '#artifact-tabs [role=tab]')).toHaveAttribute('aria-selected','true');
      await expect(page.locator('#pipeline-progress')).toBeHidden();
      await expect(page.locator('#composer')).toBeHidden();
      await expect(page.locator('.composer-morph')).toHaveCount(0);
      expect(run.calls).toEqual(['architect','generator','review']);
    }
  });
}

test('morph keyframes, opaque ghost, hidden destination and reading-order reveal', async ({ page }) => {
  await page.setViewportSize({ width:1920,height:1080 });
  await open(page);
  const run = await gates(page);
  await submit(page);
  await expect(page.locator('.composer-morph')).toHaveCount(1);
  expect(await page.locator('.composer-morph').evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  await expect(page.locator('#main-stage-container')).toHaveCSS('visibility','hidden');
  await page.waitForTimeout(1250);
  const reveal = await page.locator('#progress-title-text').evaluate(el => ({ name:getComputedStyle(el).animationName, delay:getComputedStyle(el).animationDelay, duration:getComputedStyle(el).animationDuration }));
  expect(reveal).toEqual({ name:'fidelity-rise', delay:'0.32s', duration:'0.5s' });
  await page.waitForTimeout(300);
  const [motion] = await page.evaluate(() => window.motionEvidence);
  expect(motion.options.duration).toBe(1120);
  expect(motion.frames.map(f => f.offset)).toEqual([0,.14,.28,1]);
  expect(motion.frames[2].easing).toBe('cubic-bezier(.32,1.38,.5,1)');
  const initial = motion.frames[0].transform.match(/scale\(([^,]+),([^\)]+)\)/).slice(1).map(Number);
  const shrink = motion.frames[2].transform.match(/scale\(([^,]+),([^\)]+)\)/).slice(1).map(Number);
  shrink.forEach((v,i) => expect(v/initial[i]).toBeCloseTo(.93,6));
  expect(motion.samples.filter(s => s.t <= 560).map(s => s.visibility)).toEqual(['hidden','hidden','hidden','hidden']);
  expect(motion.samples.filter(s => s.t <= 560).map(s => s.titleVisibility)).toEqual(['hidden','hidden','hidden','hidden']);
  expect(motion.samples.find(s => s.t === 1400)).toMatchObject({ visibility:'visible',ghost:false });
  run.release('architect'); run.release('generator'); run.release('review');
  await expect(page.locator('#results-view')).toBeVisible();
  await page.waitForTimeout(1500);
  expect((await page.evaluate(() => window.motionEvidence)).length).toBe(2);
});

test('held backend stage outlives the entire illustrative completion clock', async ({ page }) => {
  test.setTimeout(90000);
  await open(page, { reducedMotion:'reduce' });
  const run = await gates(page);
  await submit(page);
  await expect.poll(() => run.calls).toEqual(['architect']);
  await page.waitForTimeout(48000);
  expect(run.calls).toEqual(['architect']);
  await expect(page.locator('#pdot-1')).toHaveAttribute('data-state','active');
  await expect(page.locator('#results-view')).toBeHidden();
  run.release('architect');
  await expect.poll(() => run.calls).toEqual(['architect','generator']);
  await expect(page.locator('#results-view')).toBeHidden();
  run.release('generator');
  await expect.poll(() => run.calls).toEqual(['architect','generator','review']);
  await expect(page.locator('#results-view')).toBeHidden();
  run.release('review');
  await expect(page.locator('#results-view')).toBeVisible();
});

test('fast success, live reduced motion and navigation retire every transient handoff', async ({ page }) => {
  await open(page);
  await page.route(ENDPOINTS.pipeline, route => route.fulfill(route.request().postDataJSON().step === 'review' ? reviewPassed() : oneArtifact()));
  await submit(page);
  await expect(page.locator('.composer-morph')).toHaveCount(1);
  await page.emulateMedia({ reducedMotion:'reduce' });
  await expect(page.locator('#results-view')).toBeVisible();
  await expect(page.locator('.composer-morph')).toHaveCount(0);
  await expect(page.locator('#main-stage-container')).toHaveCSS('visibility','visible');
  await page.locator('#topbar-avatar').click();
  await expect(page.locator('#account-view')).toBeVisible();
  await expect(page.locator('.composer-morph')).toHaveCount(0);
});

test('failure and abandoned responses cannot leave an invisible or stale panel', async ({ page }) => {
  await open(page);
  const run = await gates(page);
  await submit(page);
  await expect.poll(() => run.calls).toEqual(['architect']);
  run.release('architect', providerError());
  await expect(page.locator('#pipeline-failure')).toBeVisible();
  await expect(page.locator('.composer-morph')).toHaveCount(0);
  await page.locator('#pipeline-edit-prompt').click();
  await expect(page.locator('#pipeline-input')).toHaveValue(PROMPT);
  const next = await gates(page);
  await submit(page);
  await expect.poll(() => next.calls).toEqual(['architect']);
  await page.locator('#topbar-avatar').click();
  next.release('architect');
  await page.waitForTimeout(1500);
  expect(next.calls).toEqual(['architect']);
  await expect(page.locator('#account-view')).toBeVisible();
  await expect(page.locator('.composer-morph')).toHaveCount(0);
});

test('file reveal keeps single-spaced raw lines and retires on reduced motion', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await open(page);
  await page.route(ENDPOINTS.pipeline, route => route.fulfill(route.request().postDataJSON().step === 'review' ? reviewPassed() : oneArtifact()));
  await submit(page);
  await expect(page.locator('#results-view')).toBeVisible();
  await page.locator('#artifact-tabs [role=tab]').first().click();
  const lines = page.locator('#results-code-output .code-line');
  const source = (await lines.allTextContents()).join('\n');
  const layout = await lines.evaluateAll(nodes => nodes.slice(0,2).map(node => {
    const r = node.getBoundingClientRect(), style = getComputedStyle(node);
    return { y:r.y, height:r.height, lineHeight:parseFloat(style.lineHeight), duration:style.animationDuration, delay:style.animationDelay };
  }));
  expect(layout[0].duration).toBe('0.52s');
  expect(layout[1].delay).toBe('0.01s');
  await page.emulateMedia({ reducedMotion:'reduce' });
  await expect(page.locator('.code-line.is-in')).toHaveCount(0);
  const spacing = await lines.evaluateAll(nodes => nodes.slice(0,2).map(node => node.getBoundingClientRect().y));
  const scale = Math.min(1,page.viewportSize().width/1920);
  expect(spacing[1]-spacing[0]).toBeCloseTo(layout[0].lineHeight*scale,1);
  await page.locator('#btn-copy-results').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(source);
});

test('compact settings opens tutorial without leaving a second modal active', async ({ page }) => {
  await open(page, { reducedMotion:'reduce' });
  await page.getByRole('button', { name:'Generation settings',exact:true }).click();
  await page.getByRole('button', { name:'Watch tutorial',exact:true }).click();
  await expect(page.locator('#composer-settings-modal')).toBeHidden();
  await expect(page.locator('#walkthrough-modal')).toBeVisible();
  await page.getByRole('button', { name:'Close tutorial',exact:true }).click();
  await expect(page.locator('#walkthrough-modal')).toBeHidden();
});
