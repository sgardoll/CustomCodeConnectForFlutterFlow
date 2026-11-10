import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const start = app.indexOf('async function callBuildShip(');
const actualFunction = app.slice(start, app.indexOf('\n// Set when', start));
function harness(status = 200) {
  let release, started;
  const bodyStarted = new Promise(resolve => { started = resolve; });
  const body = new Promise(resolve => { release = resolve; });
  const writes = [];
  const env = {
    pipelineState: { runId: 1, requestId: 'request-a' }, identityEpoch: 1,
    authState: { isVerified: true }, identityState: { userId: 'a', token: 'scoped-a' },
    ensureAccountGenerationIdentity: async () => {},
    isCurrentPipelineRun: id => id === env.pipelineState.runId,
    activeBuildShipControllers: new Set(), AbortController, DOMException, setTimeout, clearTimeout,
    PIPELINE_ENDPOINT: 'https://example.test/pipeline', USAGE_STORAGE_KEY: 'usage',
    fetch: async () => ({ status, ok: status === 200, text: async () => { started(); return body; } }),
    localStorage: { setItem: (...args) => writes.push(args) },
    updateUsageDisplay: () => {}, getCurrentYearMonth: () => '2026-11', incrementUsage: () => writes.push('increment'),
    createModelArmorError: () => null, console: { log() {} },
  };
  // Execute the production function with an abort-insensitive transport, not a duplicate implementation.
  const call = new Function('env', `with (env) { return (${actualFunction}); }`)(env);
  return { env, writes, release, bodyStarted, call };
}
for (const status of [200, 429]) test(`late ${status} response cannot meter a different account`, async () => {
  const h = harness(status);
  const pending = h.call('generator', 'model', 'account A prompt');
  await h.bodyStarted;
  h.env.identityEpoch++; h.env.pipelineState.runId++;
  h.env.identityState = { userId: 'b', token: 'scoped-b' };
  h.env.activeBuildShipControllers.forEach(c => c.abort());
  h.release(JSON.stringify({ output: 'code', usage_status: 'success', usage_count: 31, usage_month: '2026-11', serverCount: 31 }));
  await assert.rejects(pending, error => error.isPipelineCancel === true);
  assert.deepEqual(h.writes, []);
});
test('current account generator response still reconciles usage', async () => {
  const h = harness(); const pending = h.call('generator', 'model', 'prompt');
  await h.bodyStarted;
  h.release(JSON.stringify({ output: 'code', usage_status: 'success', usage_count: 31, usage_month: '2026-11' }));
  assert.equal(await pending, 'code');
  assert.deepEqual(h.writes, [['usage', JSON.stringify({ count: 31, month: '2026-11' })]]);
});
