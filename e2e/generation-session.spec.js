import {test, expect} from '@playwright/test';
import {applyDefaultRoutes, ENDPOINTS, ok, professionalSubscription} from './fixtures/apiFixtures.js';
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
 await page.route('**/service/generation-history',r=>{historyCalls++;expect(r.request().headers().authorization).toBeUndefined();expect(r.request().postDataJSON().sessionToken).toBe(token);return r.fulfill({json:{items:[],nextCursor:null}});});
 await page.route(ENDPOINTS.pipeline,r=>{pipelineCalls++;expect(r.request().headers().authorization).toBeUndefined();expect(r.request().postDataJSON().sessionToken).toBe('signed-account-proof');expect(r.request().postDataJSON().user_id).toBe('account-owner');return r.fulfill({status:503,json:{error:'Synthetic stop'}});});
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
 await page.route('**/service/generation-history',r=>{historyCalls++;expect(r.request().headers().authorization).toBeUndefined();expect(r.request().postDataJSON().sessionToken).toBe(b);return r.fulfill({json:{items:[],nextCursor:null}});});
 await page.route(ENDPOINTS.pipeline,r=>{expect(r.request().headers().authorization).toBeUndefined();expect(r.request().postDataJSON().sessionToken).toBe('scope-b');expect(r.request().postDataJSON().user_id).toBe('owner-b');return r.fulfill({status:503,json:{error:'Synthetic stop'}});});
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
test('switch during generator bootstrap cancels without fallback under the new account',async({page})=>{
 const a=await setup(page),b=emailJwt('b@example.com');let release;let architectDone=false;const calls=[];
 await page.route(ENDPOINTS.getSubscription,r=>r.fulfill(professionalSubscription()));
 await page.route(ENDPOINTS.identity,async r=>{
  const body=r.request().postDataJSON();
  if(!body.sessionToken) return r.fallback();
  if(body.sessionToken===a && architectDone) {
   await new Promise(resolve=>release=resolve);
   await r.fulfill({json:{user_id:'owner-a',identity_token:'scope-a'}}).catch(()=>{});
  } else await r.fulfill({json:{user_id:body.sessionToken===a?'owner-a':'owner-b',identity_token:body.sessionToken===a?'scope-a':'scope-b'}});
 });
 await page.route(ENDPOINTS.pipeline,r=>{
  const body=r.request().postDataJSON();calls.push({step:body.step,token:body.sessionToken});
  architectDone=true;return r.fulfill({json:{output:JSON.stringify({schemaVersion:'artifact-bundle/v1',artifacts:[{id:'widget',artifactType:'CodeFile',artifactName:'Widget',fileName:'widget.dart',code:'class Widget {}'}]})}});
 });
 await page.goto('/');await expect(page.locator('#topbar-avatar')).toContainText('A');
 await page.getByRole('button',{name:'Generation settings',exact:true}).click();
 await page.locator('#composer-settings-model').selectOption('anthropic/claude-opus-5');
 await page.locator('#composer-settings-modal').getByRole('button',{name:'Done',exact:true}).click();
 await page.locator('#pipeline-input').fill('Account A private prompt');
 await page.evaluate(()=>{window.__accountSwitchRun = window.runThinkingPipeline();});
 await expect.poll(()=>!!release).toBe(true);
 await page.evaluate(token=>window.__CCC_HISTORY_TEST__.session('b@example.com',token),b);
 release();
 await expect.poll(()=>page.evaluate(()=>window.__CCC_HISTORY_TEST__.state().isRunning)).toBe(false);
 // Await the actual abandoned run, not the flag cleared immediately by sign-out.
 await page.evaluate(()=>window.__accountSwitchRun);
 expect(calls).toEqual([{step:'architect',token:'scope-a'}]);
});
