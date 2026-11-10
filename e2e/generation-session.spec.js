import {test, expect} from '@playwright/test';
import {applyDefaultRoutes, ENDPOINTS, ok} from './fixtures/apiFixtures.js';
const emailJwt = email => `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({email,iat:1,exp:9999999999})).toString('base64url')}.synthetic-signature`;
async function setup(page) {
 const token=emailJwt('a@example.com');
 await page.addInitScript(token=>{localStorage.setItem('hasSeenWalkthrough','true');localStorage.setItem('ccc_auth_session',JSON.stringify({email:'a@example.com',sessionToken:token}));},token);
 await applyDefaultRoutes(page,{[ENDPOINTS.authRefreshSession]:ok({email:'a@example.com',sessionToken:token}),[ENDPOINTS.identity]:ok({user_id:'legacy-device',identity_token:'signed-legacy-proof',status:'recognized'})});
 return token;
}
test('email session bootstraps account identity; history keeps email token and pipeline uses scoped token',async({page})=>{
 const token=await setup(page);let bridgeCalls=0;let historyCalls=0;let pipelineCalls=0;
 await page.route(ENDPOINTS.identity,r=>{
  if (!r.request().postDataJSON().sessionToken) return r.fallback();
  bridgeCalls++;
  expect(r.request().postDataJSON()).toEqual({sessionToken:token,identityToken:'signed-legacy-proof'});
  return r.fulfill({json:{user_id:'account-owner',identity_token:'signed-account-proof'}});
 });
 await page.route('**/service/generation-history',r=>{historyCalls++;expect(r.request().headers().authorization).toBe(`Bearer ${token}`);return r.fulfill({json:{items:[],nextCursor:null}});});
 await page.route(ENDPOINTS.pipeline,r=>{pipelineCalls++;expect(r.request().headers().authorization).toBe('Bearer signed-account-proof');expect(r.request().postDataJSON().user_id).toBe('account-owner');return r.fulfill({status:503,json:{error:'Synthetic stop'}});});
 await page.goto('/#account');await expect(page.locator('#topbar-avatar')).toContainText('A');
 await page.locator('#history-refresh').click();await expect(page.locator('#history-status')).toContainText('No saved');expect(historyCalls).toBe(1);
 await page.evaluate(()=>window.switchView('home'));await page.locator('#pipeline-input').fill('Build a calendar');await page.locator('#hero-send').click();
 await expect.poll(()=>pipelineCalls).toBeGreaterThan(0);expect(bridgeCalls).toBeGreaterThan(0);
});
test('delayed account A bridge cannot replace account B credentials',async({page})=>{
 const a=await setup(page),b=emailJwt('b@example.com');let release;let historyCalls=0;
 await page.route(ENDPOINTS.identity,async r=>{
  if (!r.request().postDataJSON().sessionToken) return r.fallback();
  if(r.request().postDataJSON().sessionToken===a) { await new Promise(resolve=>release=resolve);await r.fulfill({json:{user_id:'owner-a',identity_token:'scope-a'}}).catch(()=>{}); }
  else { expect(r.request().postDataJSON().sessionToken).toBe(b);await r.fulfill({json:{user_id:'owner-b',identity_token:'scope-b'}}); }
 });
 await page.route('**/service/generation-history',r=>{historyCalls++;expect(r.request().headers().authorization).toBe(`Bearer ${b}`);return r.fulfill({json:{items:[],nextCursor:null}});});
 await page.route(ENDPOINTS.pipeline,r=>{expect(r.request().headers().authorization).toBe('Bearer scope-b');expect(r.request().postDataJSON().user_id).toBe('owner-b');return r.fulfill({status:503,json:{error:'Synthetic stop'}});});
 await page.goto('/#account');await expect.poll(()=>!!release).toBe(true);
 await page.evaluate(token=>window.__CCC_HISTORY_TEST__.session('b@example.com',token),b);
 release();await page.locator('#history-refresh').click();await expect(page.locator('#history-status')).toContainText('No saved');expect(historyCalls).toBe(1);
 const request=page.waitForRequest(ENDPOINTS.pipeline);await page.evaluate(()=>window.switchView('home'));await page.locator('#pipeline-input').fill('Account B code');await page.locator('#hero-send').click();await request;
});
test('failed bridge blocks history and generation rather than using legacy identity',async({page})=>{
 await setup(page);let forbidden=0;
 await page.route(ENDPOINTS.identity,r=>r.request().postDataJSON().sessionToken ? r.fulfill({status:503,json:{error:'Unavailable'}}) : r.fallback());
 await page.route('**/service/generation-history',r=>{forbidden++;return r.abort();});
 await page.route(ENDPOINTS.pipeline,r=>{forbidden++;return r.abort();});
 await page.goto('/#account');await expect(page.locator('#topbar-avatar')).toContainText('A');await page.locator('#history-refresh').click();await expect(page.locator('#history-status')).toContainText('Try again');
 await page.evaluate(()=>window.switchView('home'));await page.locator('#pipeline-input').fill('Must not run');await page.locator('#hero-send').click();
 await expect.poll(()=>page.evaluate(()=>window.__CCC_HISTORY_TEST__.state().isRunning)).toBe(false);expect(forbidden).toBe(0);
});
