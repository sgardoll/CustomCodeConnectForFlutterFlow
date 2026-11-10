import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverGenerationHistory as recover, createGenerationHistoryClient as client } from './generationHistory.js';
const bundle = () => ({schemaVersion:'artifact-bundle/v1',artifacts:[{id:'one',artifactType:'CodeFile',artifactName:'One',fileName:'one.dart',code:'class One {}'}]});
const detail = stages => ({generation:{id:'synthetic',request_id:'synthetic',stages}});
const output = value => ({output_text:JSON.stringify(value)});
test('complete output and actual review preserve original and fixed source', () => {
 const value = recover(detail({generator:output(bundle()),review:output({schemaVersion:'artifact-bundle/v1',bundleReview:{status:'pass',score:95,summary:'Synthetic review'},artifacts:[{id:'one',review:{status:'pass',fixedSource:'class One { }'}}]})}));
 assert.equal(value.availability,'reviewed'); assert.equal(value.artifactBundle.artifacts[0].code,'class One {}'); assert.equal(value.bundleReview.artifacts[0].fixedCode,'class One { }');
});
test('review input recovery is explicitly pre-review and prompt is recovered', () => {
 const value = recover(detail({architect:{input_text:JSON.stringify({userRequest:'Synthetic prompt'})},review:{input_text:JSON.stringify({generatedBundle:bundle()})}}));
 assert.equal(value.source,'review-input'); assert.equal(value.reviewAvailable,false); assert.equal(value.originalPrompt,'Synthetic prompt'); assert.equal(value.metadata.status,null);
});
test('missing, unsupported, truncated, duplicate and mismatched data cannot replay', () => {
 for (const generator of [{}, {...output(bundle()),output_truncated:true}, {...output(bundle()),finish_reason:'length'}, {...output(bundle()),output_chars:99999}, output({...bundle(),schemaVersion:'future'}), output({...bundle(),artifacts:[...bundle().artifacts,...bundle().artifacts]})]) assert.equal(recover(detail({generator})).availability,'unavailable');
 assert.equal(recover({...detail({generator:output(bundle())}),identityMismatch:true}).availability,'unavailable');
});
test('bounded page allows empty continuation and sends no owner fields', async () => {
 let body;
 const c = client({endpoint:'https://example.test/service/generation-history',getSession:()=>({token:'synthetic',key:'a'}),fetchImpl:async (_,opts)=>{body=JSON.parse(opts.body);return {ok:true,json:async()=>({items:[],nextCursor:'next'})};}});
 assert.equal((await c.list({user_id:'forged'})).nextCursor,'next'); assert.deepEqual(body,{action:'list'});
 await assert.rejects(c.list({cursor:'next'}),/Invalid history page/);
});
test('session changes and invalidation suppress late responses even if fetch ignores abort', async () => {
 for (const mode of ['session','invalidate','signal']) {
 let session={token:'token',key:'a'}, release;
 const signal=new AbortController();
 const c=client({endpoint:'https://example.test/service/generation-history',getSession:()=>session,fetchImpl:()=>new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>({items:[],nextCursor:null})});})});
 const pending=c.list({signal:signal.signal});
 if(mode==='session')session={token:'token2',key:'b'}; else if(mode==='invalidate')c.invalidate(); else signal.abort();
 release(); await assert.rejects(pending,{name:'AbortError'});
 }
});
test('detail/delete and structured HTTP errors',async()=>{
 let response={generation:{id:'a'}};
 const c=client({endpoint:'https://example.test/service/generation-history',getSession:()=>({token:'t',key:'a'}),fetchImpl:async()=>({ok:true,json:async()=>response})});
 assert.equal((await c.detail('a')).generation.id,'a'); response={deleted:true,id:'a'}; assert.equal((await c.delete('a')).deleted,true);
 await assert.rejects(c.detail('../bad'));
});
