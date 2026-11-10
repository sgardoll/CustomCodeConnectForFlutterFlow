import { test, expect } from '@playwright/test';
import { applyDefaultRoutes, ENDPOINTS } from './fixtures/apiFixtures.js';
test('history bounded pagination, safe detail and selected deletion', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('hasSeenWalkthrough', 'true');
    localStorage.setItem('ccc_auth_session', JSON.stringify({email:'test@example.com',sessionToken:'synthetic'}));
  });
  await applyDefaultRoutes(page, { [ENDPOINTS.authRefreshSession]: {status:200,contentType:'application/json',body:JSON.stringify({email:'test@example.com',sessionToken:'synthetic'})} });
  const calls=[]; let deleteFailed = false;
  await page.route('**/service/generation-history', route => {
    const body=route.request().postDataJSON(); calls.push(body);
    expect(route.request().headers().authorization).toBe('Bearer synthetic');
    expect(body.user_id).toBeUndefined();
    if (body.action === 'delete' && !deleteFailed) { deleteFailed = true; return route.fulfill({status:500,json:{error:{code:'INTERNAL_ERROR'}}}); }
    const data=body.action==='list' ? body.cursor ? {items:[{id:'entry',status:'<img src=x onerror=alert(1)>'}],nextCursor:null} : {items:[],nextCursor:'continue'} : body.action==='detail' ? {generation:{id:'entry',request_id:'entry',stages:{generator:{output_text:'<script>alert(1)</script>'}}}} : {deleted:true,id:'entry'};
    return route.fulfill({json:data});
  });
  await page.goto('/'); await page.evaluate(()=>window.switchView('account'));
  await page.locator('#history-refresh').click();
  await expect(page.locator('#history-status')).toContainText('Continue');
  await page.locator('#history-next').click();
  await page.getByRole('button',{name:'entry',exact:true}).click();
  await expect(page.locator('#history-detail')).toContainText('Replay unavailable');
  await expect(page.locator('#history-detail script')).toHaveCount(0);
  await page.getByRole('button',{name:'Delete this generation',exact:true}).click();
  await page.getByRole('button',{name:'Confirm delete',exact:true}).click();
  await expect(page.locator('#history-status')).toContainText('Try again');
  await page.getByRole('button',{name:'Confirm delete',exact:true}).click();
  await expect(page.locator('#history-status')).toContainText('Generation deleted');
  expect(calls.map(c=>c.action)).toEqual(['list','list','detail','delete','delete']);
});

const stage = (data, field='output') => ({status:'success',finish_reason:'stop',[`${field}_text`]:JSON.stringify(data),[`${field}_chars`]:JSON.stringify(data).length,[`${field}_truncated`]:false});
for (const reviewed of [true,false]) test(`recover multi-artifact results review=${reviewed} without generation`, async ({page}) => {
 await page.addInitScript(()=>localStorage.setItem('hasSeenWalkthrough','true'));
 await applyDefaultRoutes(page, { [ENDPOINTS.authRefreshSession]: {status:200,contentType:'application/json',body:JSON.stringify({email:'a@example.com',sessionToken:'synthetic'})} });
 await page.addInitScript(()=>localStorage.setItem('ccc_auth_session',JSON.stringify({email:'a@example.com',sessionToken:'synthetic'})));
 const bundle={schemaVersion:'artifact-bundle/v1',artifacts:['one','two'].map(id=>({id,artifactType:'CodeFile',artifactName:id,fileName:`${id}.dart`,code:`class ${id} {}`}))};
 const review={bundleReview:{status:'pass',score:95,summary:'Synthetic'},artifacts:['one','two'].map(id=>({id,review:{status:'pass',fixedSource:`class ${id} { int x = 1; }`}}))};
 let forbidden=0;
 await page.route('**/service/runpipeline**',r=>{forbidden++;return r.abort();});
 await page.route('**/service/generation-history',r=>r.fulfill({json:r.request().postDataJSON().action==='list'?{items:[{id:'saved'}],nextCursor:null}:{generation:{id:'saved',request_id:'saved',stages:{architect:stage({userRequest:'Synthetic prompt'},'input'),generator:stage(bundle),...(reviewed?{review:stage(review)}:{})}}}}));
 await page.goto('/'); await page.waitForFunction(()=>window.__CCC_HISTORY_TEST__);
 await expect(page.locator('#topbar-avatar')).toContainText('A');
 await page.evaluate(()=>window.switchView('account')); await page.locator('#history-refresh').click();
 await page.getByRole('button',{name:'saved',exact:true}).click();
 await page.evaluate(()=>window.__CCC_HISTORY_TEST__.pending(true));
 await page.getByRole('button',{name:'Open in Results',exact:true}).click();
 await expect(page.locator('#history-status')).toContainText('Wait for generation');
 await page.evaluate(()=>window.__CCC_HISTORY_TEST__.pending(false));
 await page.getByRole('button',{name:'Open in Results',exact:true}).click();
 const state=await page.evaluate(()=>window.__CCC_HISTORY_TEST__.state());
 expect(state.artifactBundle.artifacts).toHaveLength(2); expect(state.submittedPrompt).toBe('Synthetic prompt');
 if(reviewed) expect(state.bundleReview.artifacts[0].fixedCode).toContain('int x'); else expect(state.step3Result).toBeNull();
 await page.route('**/*checkout*',r=>{forbidden++;return r.abort();});
 await page.evaluate(()=>window.initiateCommitToFlutterFlow());
 expect(forbidden).toBe(0);
});

test('late list is invalidated by account switch and sign out',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('hasSeenWalkthrough','true')); await applyDefaultRoutes(page, { [ENDPOINTS.authRefreshSession]: {status:200,contentType:'application/json',body:JSON.stringify({email:'a@example.com',sessionToken:'synthetic'})} });
 await page.addInitScript(()=>localStorage.setItem('ccc_auth_session',JSON.stringify({email:'a@example.com',sessionToken:'synthetic'})));
 let release; await page.route('**/service/generation-history',async r=>{await new Promise(resolve=>release=resolve); await r.fulfill({json:{items:[{id:'private-entry'}],nextCursor:null}}).catch(()=>{});});
 await page.goto('/'); await page.waitForFunction(()=>window.__CCC_HISTORY_TEST__);
 await expect(page.locator('#topbar-avatar')).toContainText('A');
 await page.evaluate(()=>window.switchView('account')); await page.locator('#history-refresh').click();
 await expect.poll(()=>!!release).toBe(true);
 await page.evaluate(()=>window.__CCC_HISTORY_TEST__.session('b@example.com','other'));
 release(); await expect(page.locator('#history-list')).toBeEmpty();
 await page.evaluate(()=>window.handleSignOut()); await expect(page.locator('#history-detail')).toBeEmpty();
});

test('malformed list reports error and refresh retries one page', async ({page}) => {
 await page.addInitScript(()=>{localStorage.setItem('hasSeenWalkthrough','true');localStorage.setItem('ccc_auth_session',JSON.stringify({email:'a@example.com',sessionToken:'synthetic'}));});
 await applyDefaultRoutes(page,{[ENDPOINTS.authRefreshSession]:{status:200,contentType:'application/json',body:JSON.stringify({email:'a@example.com',sessionToken:'synthetic'})}});
 let count=0;
 await page.route('**/service/generation-history',r=>r.fulfill({json:++count===1?{items:{bad:true},nextCursor:null}:{items:[],nextCursor:null}}));
 await page.goto('/'); await expect(page.locator('#topbar-avatar')).toContainText('A');
 await page.evaluate(()=>window.switchView('account')); await page.locator('#history-refresh').click();
 await expect(page.locator('#history-status')).toContainText('Try again');
 await page.locator('#history-refresh').click(); await expect(page.locator('#history-status')).toContainText('No saved generations');
 expect(count).toBe(2); await expect(page.locator('#history-next')).toBeDisabled();
});
