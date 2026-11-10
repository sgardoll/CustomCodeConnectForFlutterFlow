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

async function historySetup(page, code = 'class Saved {}') {
 await page.addInitScript(() => {
  localStorage.setItem('hasSeenWalkthrough','true');
  localStorage.setItem('ccc_auth_session',JSON.stringify({email:'a@example.com',sessionToken:'synthetic'}));
 });
 await applyDefaultRoutes(page,{[ENDPOINTS.authRefreshSession]:{status:200,json:{email:'a@example.com',sessionToken:'synthetic'}}});
 const detail={generation:{id:'saved',request_id:'saved',stages:{generator:stage({schemaVersion:'artifact-bundle/v1',artifacts:[{id:'saved',artifactType:'CodeFile',artifactName:'Saved',fileName:'saved.dart',code}]})}}};
 await page.route('**/service/generation-history',r=>r.fulfill({json:r.request().postDataJSON().action==='list'?{items:[{id:'saved',status:'success'}],nextCursor:null}:detail}));
 await page.goto('/#account');
 await expect(page.locator('#topbar-avatar')).toContainText('A');
 await page.locator('#history-refresh').click();
 await expect(page.getByRole('button',{name:'saved',exact:true})).toBeVisible();
 return detail;
}

for (const action of ['detail','delete']) for (const transition of ['refresh','logout','account']) {
 test(`late ${action} cannot overwrite ${transition}`,async({page})=>{
  const detail=await historySetup(page);
  if(action==='delete') {
   await page.getByRole('button',{name:'saved',exact:true}).click();
   await page.getByRole('button',{name:'Delete this generation',exact:true}).click();
  }
  let release;
  let completed;
  const settled=new Promise(resolve=>completed=resolve);
  await page.route('**/service/generation-history',async r=>{
   if(r.request().postDataJSON().action!==action) return r.fallback();
   await new Promise(resolve=>release=resolve);
   try { await r.fulfill({json:action==='detail'?detail:{deleted:true,id:'saved'}}); } catch {} finally { completed(); }
  });
  await page.getByRole('button',{name:action==='detail'?'saved':'Confirm delete',exact:true}).click();
  await expect.poll(()=>!!release).toBe(true);
  if(transition==='refresh') await page.locator('#history-refresh').click();
  else if(transition==='logout') await page.evaluate(()=>window.handleSignOut());
  else await page.evaluate(()=>window.__CCC_HISTORY_TEST__.session('b@example.com','other'));
  await expect(page.locator('#history-panel')).toHaveAttribute('aria-busy','false');
  const status=await page.locator('#history-status').textContent();
  release(); await settled;
  // Drain browser tasks after the held transport completes, including abort rejection handlers.
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await expect(page.locator('#history-detail')).toBeEmpty();
  await expect(page.locator('#history-status')).toHaveText(status);
  await expect(page.locator('#history-list li')).toHaveCount(transition==='refresh'?1:0);
  expect((await page.evaluate(()=>window.__CCC_HISTORY_TEST__.state())).artifactBundle).toBeNull();
 });
}

for(const width of [360,1440]) test(`populated history keyboard and layout at ${width}`,async({page})=>{
 await page.setViewportSize({width,height:900}); await historySetup(page);
 const row=page.getByRole('button',{name:'saved',exact:true});
 await page.locator('#history-refresh').focus();
 await page.keyboard.press('Tab');
 await expect(row).toBeFocused(); await page.keyboard.press('Enter');
 await expect(page.locator('#history-detail')).toContainText('Review unavailable');
 const summary=page.locator('#history-detail summary').first();
 await summary.focus(); await page.keyboard.press('Enter');
 await expect(page.locator('#history-detail details').first()).toHaveAttribute('open','');
 await expect(page.locator('#history-status')).toHaveAttribute('role','status');
 for(const selector of ['#history-panel','#history-list','#history-detail']) {
  const bounds=await page.locator(selector).boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x+bounds.width).toBeLessThanOrEqual(width+1);
 }
 await page.getByRole('button',{name:'Delete this generation',exact:true}).focus();
 await page.keyboard.press('Enter');
 await expect(page.getByRole('group',{name:'Confirm deletion'})).toBeVisible();
 await page.getByRole('button',{name:'Cancel',exact:true}).focus(); await page.keyboard.press('Enter');
 await expect(page.getByRole('group',{name:'Confirm deletion'})).toHaveCount(0);
});

for(const valid of [true,false]) test(`restored code passes through configured deployment gate valid=${valid}`,async({page})=>{
 await historySetup(page,valid?'class Saved {}':'class Saved {');
 await page.locator('.acct-connection button',{hasText:'Configure'}).first().click();
 await page.locator('#flutterflow-api-key-input').fill('synthetic-history-key');
 await page.locator('#flutterflow-api-key-input').blur();
 await expect(page.locator('#flutterflow-projects-select option[value="proj-abc-123"]')).toHaveCount(1);
 await page.locator('#flutterflow-projects-select').selectOption('proj-abc-123');
 await page.locator('#api-keys-modal .bg-blue-500').click();
 await expect(page.locator('#api-keys-modal')).toBeHidden();
 const forbidden=[];
 page.on('request',request=>{
  if(/runpipeline|stripe|checkout|billing|deployCustom|syncCustomCode|exportCode|ffai-runner/.test(request.url())) forbidden.push(request.url());
 });
 await page.getByRole('button',{name:'saved',exact:true}).click();
 await page.getByRole('button',{name:'Open in Results',exact:true}).click();
 await expect(page.locator('#results-view')).toBeVisible();
 expect(forbidden).toEqual([]);
 await page.evaluate(()=>window.initiateCommitToFlutterFlow());
 if(valid) {
  await expect(page.locator('#commit-confirm-modal')).toBeVisible();
  await expect(page.locator('#confirm-project-select option[value="proj-abc-123"]')).toHaveCount(1);
 } else {
  await expect(page.getByText(/Pre-commit checks failed:.*FlutterFlow cannot format/)).toBeVisible();
  await expect(page.locator('#commit-confirm-modal')).toBeHidden();
 }
 await expect(page.locator('#api-keys-modal')).toBeHidden();
 expect(forbidden).toEqual([]);
});
