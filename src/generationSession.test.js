import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationSessionClient } from './generationSession.js';
const session = { key: 'a@example.com', token: 'email-session-jwt' };
const response = (user_id = 'account-a') => ({ ok: true, json: async () => ({ user_id, identity_token: `signed-${user_id}` }) });
test('bridge authenticates email session; legacy token is proof only, no caller owner fields', async () => {
  const client = createGenerationSessionClient({ endpoint: '/authUserCheck', getSession: () => session, getLegacyToken: async () => 'legacy-signed', fetchImpl: async (url, init) => {
    assert.equal(url, '/authUserCheck');
    assert.equal(init.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(init.body), { sessionToken: 'email-session-jwt', identityToken: 'legacy-signed' });
    return response();
  } });
  assert.deepEqual(await client.ensure(), { userId: 'account-a', token: 'signed-account-a' });
});
test('missing legacy identity sends only session token; server identity is authoritative', async () => {
  const client = createGenerationSessionClient({ endpoint: '/bridge', getSession: () => session, getLegacyToken: async () => null, fetchImpl: async (_, init) => { assert.deepEqual(JSON.parse(init.body), { sessionToken: 'email-session-jwt' }); return response('new-owner'); } });
  assert.equal((await client.ensure()).userId, 'new-owner');
});
test('account switch rejects old delayed response, even if transport ignores abort', async () => {
  let current = session, release, entered;
  const started = new Promise(r => entered = r);
  const client = createGenerationSessionClient({ endpoint: '/bridge', getSession: () => current, getLegacyToken: async () => null, fetchImpl: async (_, init) => {
    if (JSON.parse(init.body).sessionToken === 'email-session-jwt') { entered(); await new Promise(r => release = r); return response(); }
    return response('account-b');
  } });
  const old = client.ensure(); await started;
  current = { key: 'b@example.com', token: 'email-b' }; client.invalidate();
  assert.equal((await client.ensure()).userId, 'account-b');
  release(); await assert.rejects(old, { name: 'AbortError' });
});
test('logout while obtaining proof prevents bridge request', async () => {
  let current = session, release;
  const proof = new Promise(r => release = r);
  const client = createGenerationSessionClient({ endpoint: '/bridge', getSession: () => current, getLegacyToken: () => proof, fetchImpl: () => { throw new Error('Must not request'); } });
  const pending = client.ensure(); current = null; client.invalidate(); release('legacy');
  await assert.rejects(pending, { name: 'AbortError' });
});
test('bridge errors and malformed credentials fail closed and allow retry', async () => {
  let count = 0;
  const client = createGenerationSessionClient({ endpoint: '/bridge', getSession: () => session, getLegacyToken: async () => null, fetchImpl: async () => ++count === 1 ? { ok: false } : count === 2 ? { ok: true, json: async () => ({ user_id: 'a' }) } : response() });
  await assert.rejects(client.ensure(), /could not be prepared/);
  await assert.rejects(client.ensure(), /Invalid/);
  assert.equal((await client.ensure()).userId, 'account-a');
});
test('returns validated account usage without accepting malformed counters', async () => {
  let data = { user_id: 'account-a', identity_token: 'signed', usage_count: 31, usage_month: '2026-11' };
  const client = createGenerationSessionClient({ endpoint: '/authUserCheck', getSession: () => session, getLegacyToken: async () => null, fetchImpl: async () => ({ ok: true, json: async () => data }) });
  assert.deepEqual(await client.ensure(), { userId: 'account-a', token: 'signed', usageCount: 31, usageMonth: '2026-11' });
  data = { ...data, usage_count: -1, usage_month: {} };
  assert.deepEqual(await client.ensure(), { userId: 'account-a', token: 'signed' });
});
