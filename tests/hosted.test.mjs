import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedHandler, isOwner } from '../src/hosted-handler.mjs';
import { BlobTaskStore } from '../src/blob-task-store.mjs';
import { Readable } from 'node:stream';
class Store {
  records = new Map();
  async load(id) {return structuredClone(this.records.get(id) || null);}
  async save(id,data,etag) {const prev=this.records.get(id); if(prev && prev.etag!==etag)throw new Error('Precondition failed'); const next=String(Number(prev?.etag||0)+1);this.records.set(id,{data:structuredClone(data),etag:next});return next;}
}
async function request(handler,path,body,cookie,extra={}) {
  const req=Readable.from([]);Object.assign(req,{url:path,method:body?'POST':'GET',body,headers:{host:'reach.example',origin:'https://reach.example','x-reach-client':'1',...(cookie?{cookie}:{}),...extra}});
  let result;const headers={}; const res={setHeader:(k,v)=>headers[k]=v,writeHead:(status,h)=>{result={status,headers:{...headers,...h}};},end:value=>{result.body=value?JSON.parse(value):null;}};
  await handler(req,res);return result;
}
test('public hosted workflow persists across fresh handler instances without credentials',async()=>{
 const store=new Store();const handler=()=>createHostedHandler({},store);
 let r=await request(handler(),'/api/start',{}); assert.equal(r.status,200); const cookie=r.headers['Set-Cookie'].split(';')[0]; assert.match(r.headers['Set-Cookie'],/Secure/);
 for(const choice of ['prepare','file:portfolio-current','slot:slot-0','approve']) {r=await request(handler(),'/api/choose',{choice,revision:r.body.revision},cookie);assert.equal(r.status,200,JSON.stringify(r.body));}
 assert.equal(r.body.stage,'complete');assert.equal(r.body.receipts.length,3);
 const reloaded=await request(handler(),'/api/session',null,cookie);assert.deepEqual(reloaded.body.receipts,r.body.receipts);
});
test('hosted rejects cross-origin writes and public requests cannot enter live mode',async()=>{
 const env={REACH_OWNER_KEY:'a'.repeat(48),GOOGLE_REFRESH_TOKEN:'test-token',ANTHROPIC_API_KEY:'test-key'};
 const h=createHostedHandler(env,new Store());
 assert.equal((await request(h,'/api/start',{},null,{origin:'https://evil.example'})).status,403);
 assert.equal((await request(h,'/api/config')).body.mode,'demo');
 assert.equal((await request(h,'/live')).status,401);
 assert.equal((await request(h,'/auth/google')).status,403);
 assert(isOwner({headers:{authorization:'Basic '+Buffer.from('owner:'+env.REACH_OWNER_KEY).toString('base64')}},env));
});
test('a second start does not hide an unfinished task',async()=>{
 const h=createHostedHandler({},new Store());const first=await request(h,'/api/start',{});const cookie=first.headers['Set-Cookie'].split(';')[0];assert.equal((await request(h,'/api/start',{},cookie)).status,409);
});
test('Blob store requests consistent private reads and conditional writes',async()=>{
 let options;const store=new BlobTaskStore({get:async(p,o)=>{options=o;return {stream:new Response('{"ok":true}').body,blob:{etag:'one'}};},put:async(p,b,o)=>{options=o;return {etag:'two'};}});
 const id='a'.repeat(48);assert.deepEqual(await store.load(id),{data:{ok:true},etag:'one'});assert.equal(options.useCache,false);assert.equal(options.headers['Accept-Encoding'],'identity');assert.equal(options.access,'private');await store.save(id,{},'one');assert.equal(options.ifMatch,'one');assert.equal(options.addRandomSuffix,false);
});
test('competing hosted approvals cannot execute the same task twice',async()=>{
 const store=new Store();const handler=()=>createHostedHandler({},store);let r=await request(handler(),'/api/start',{});const cookie=r.headers['Set-Cookie'].split(';')[0];
 for(const choice of ['prepare','file:portfolio-current','slot:slot-0'])r=await request(handler(),'/api/choose',{choice,revision:r.body.revision},cookie);
 const body={choice:'approve',revision:r.body.revision};const attempts=await Promise.all([request(handler(),'/api/choose',body,cookie),request(handler(),'/api/choose',body,cookie)]);
 assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
 const saved=await store.load(cookie.split('=')[1]);assert.deepEqual(saved.data.demo.writes,['calendar.create','gmail.createDraft']);
});
