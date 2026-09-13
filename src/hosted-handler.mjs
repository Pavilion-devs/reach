import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { BlobTaskStore } from './blob-task-store.mjs';
import { ReachSession } from './engine.mjs';
import { DemoProvider, GoogleProvider } from './providers.mjs';
import { AnthropicPlanner } from './planner.mjs';
const hash = value => createHash('sha256').update(value).digest();
export function isOwner(req, env) {
  if (!env.REACH_OWNER_KEY || env.REACH_OWNER_KEY.length < 32) return false;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const expected = `owner:${env.REACH_OWNER_KEY}`;
  return timingSafeEqual(hash(Buffer.from(header.slice(6),'base64').toString()), hash(expected));
}
function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').filter(s => s.includes('=')).map(s => s.trim().split('='))); }
function demoState(p) { return { context:p.context, scenario:p.scenario, holds:[...p.holds], drafts:[...p.drafts], writes:p.writes }; }
function restoreDemo(state) { const p = new DemoProvider(state.scenario); Object.assign(p,state,{ holds:new Map(state.holds), drafts:new Map(state.drafts) }); return p; }
async function input(req) {
  if (req.body && typeof req.body === 'object') { if (JSON.stringify(req.body).length > 16000) throw new Error('Request too large'); return req.body; }
  let raw = ''; for await (const part of req) { raw += part; if (raw.length > 16000) throw new Error('Request too large'); }
  return JSON.parse(raw || '{}');
}
export function createHostedHandler(env = process.env, store = new BlobTaskStore()) {
  return async (req,res) => {
    const json = (status,data,headers={}) => { res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',...headers}); res.end(JSON.stringify(data)); };
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
    let record, etag, id, session, provider, claimed = false;
    try {
      const owner = isOwner(req,env);
      const live = owner && !!(env.GOOGLE_REFRESH_TOKEN && env.ANTHROPIC_API_KEY);
      const mode = live ? 'google' : 'demo';
      const binding = hash(JSON.stringify([mode, live ? env.GOOGLE_REFRESH_TOKEN : 'practice', live ? env.REACH_DRIVE_FOLDER_ID : '',live ? env.REACH_MESSAGE_ID : '',live ? env.REACH_CALENDAR_ID : ''])).toString('hex');
      const path = new URL(req.url,'https://reach.invalid').pathname;
      if (path === '/live') {
        if (!owner) return json(401,{error:'Owner access required.'},{'WWW-Authenticate':'Basic realm="Reach live workspace", charset="UTF-8"'});
        res.writeHead(302,{Location:'/#app','Cache-Control':'no-store'}); return res.end();
      }
      if (path === '/auth/google' || path === '/auth/callback') return json(403,{error:'Hosted live mode uses the owner’s server-configured test connection.'});
      if (req.method === 'POST' && (req.headers['x-reach-client'] !== '1' || !req.headers.origin || new URL(req.headers.origin).host !== req.headers.host)) return json(403,{error:'Request must originate in Reach.'});
      if (path === '/api/config' && req.method === 'GET') return json(200,{mode,googleConfigured:false,connected:live,planner:live?'anthropic':'template-practice',aiConfigured:live,model:live?(env.ANTHROPIC_MODEL||'claude-sonnet-5'):null,hosted:true});
      const cookieName = live ? '__Host-reach_live' : '__Host-reach_practice';
      id = cookies(req)[cookieName];
      if (path === '/api/start' && req.method === 'POST') {
        const body = await input(req);
        // Reuse an existing task until it is complete/cancelled; repeated starts cannot hide an uncertain result.
        const previous = await store.load(id);
        if (previous?.data.binding === binding && previous.data.snapshot && !['complete','cancelled'].includes(previous.data.snapshot.stage)) return json(409,{error:'Finish or cancel the current task before opening another.'});
        const scenario = ['normal','calendar-changed','file-changed','gmail-fails','readback-fails'].includes(body.scenario) ? body.scenario : 'normal';
        id = randomBytes(24).toString('hex');
        provider = live ? new GoogleProvider(env) : new DemoProvider(scenario);
        record = { binding, mode, expires:Date.now()+86400000, busyUntil:Date.now()+330000 };
        etag = await store.save(id,record); claimed = true;
        session = new ReachSession(provider, live ? new AnthropicPlanner(env) : null, async snapshot => { record.snapshot=snapshot; if (!live) record.demo=demoState(provider); etag=await store.save(id,record,etag); });
        await session.start();
      } else if (['/api/session','/api/choose'].includes(path)) {
        const saved = await store.load(id);
        if (!saved || saved.data.binding !== binding || saved.data.expires < Date.now()) return json(path === '/api/session'?200:409,path === '/api/session'?null:{error:'Session expired. Open a new task.'});
        ({data:record,etag}=saved);
        if (!record.snapshot) return json(409,{error:'The request is still being prepared. Reload shortly.'});
        provider = live ? new GoogleProvider(env) : restoreDemo(record.demo);
        session = ReachSession.restore(provider,live?new AnthropicPlanner(env):null,record.snapshot,async snapshot => {record.snapshot=snapshot; if (!live) record.demo=demoState(provider); etag=await store.save(id,record,etag);});
        if (path === '/api/session' && req.method === 'GET') {
          const view=session.view(); if (record.busyUntil>Date.now()) {view.choices=[];view.error='An action is still running. Reload shortly to check its result.';} return json(200,view);
        }
        if (req.method !== 'POST') return json(405,{error:'Method not allowed.'});
        if (record.busyUntil>Date.now()) return json(409,{error:'An action is already running. Wait before checking again.'});
        const body=await input(req);
        record.busyUntil=Date.now()+330000; etag=await store.save(id,record,etag); claimed=true;
        await session.choose(body.choice,body.revision);
      } else return json(404,{error:'Not found.'});
      record.busyUntil=0; etag=await store.save(id,record,etag); claimed=false;
      return json(200,session.view(),{'Set-Cookie':`${cookieName}=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`});
    } catch (error) {
      // Journal/claim failures must never cause an automatic action retry.
      if (claimed && error.code !== 'JOURNAL_FAILED') { try {record.busyUntil=0; if(session)record.snapshot=session.snapshot(); await store.save(id,record,etag);} catch {} }
      const known = error.code || (/Precondition|already exists/i.test(error.name+' '+error.message)?'CONCURRENT_ACTION':'HOSTED_ERROR');
      return json(known==='CONCURRENT_ACTION'?409:503,{error:known==='HOSTED_ERROR'?'Reach could not complete this request. Reload to check saved progress.':error.message,code:known});
    }
  };
}
