import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { TaskStore } from './src/task-store.mjs';
import { ReachSession } from './src/engine.mjs';
import { DemoProvider, GoogleProvider, SCOPES } from './src/providers.mjs';
import { initializeGoogle, updateEnv } from './src/setup.mjs';
import { AnthropicPlanner } from './src/planner.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
for (const file of ['.env', '.anthropic.env']) {
 try {
  for (const line of (await readFile(root + file, 'utf8')).split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    const value = m?.[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (m && value && !(m[1] in process.env)) process.env[m[1]] = value;
  }
 } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
const port = Number(process.env.PORT || 4317), origin = `http://127.0.0.1:${port}`;
let mode = process.env.REACH_PROVIDER || 'demo';
if (!['demo', 'google', 'arga'].includes(mode)) throw new Error('REACH_PROVIDER must be demo, google or arga');
const sessions = new Map(), oauthStates = new Map(), tokens = {};
const google = new GoogleProvider(process.env, tokens);
const planner = new AnthropicPlanner(process.env);
let arga = null;
if (mode === 'arga') { const { ArgaProvider } = await import('./src/arga.mjs'); arga = new ArgaProvider(process.env); }
const binding = createHash('sha256').update(JSON.stringify([mode, process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_REFRESH_TOKEN, process.env.REACH_MESSAGE_ID, process.env.REACH_DRIVE_FOLDER_ID, process.env.REACH_ARGA_MANIFEST, process.env.REACH_CALENDAR_ID])).digest('hex');
const store = new TaskStore(root + `.tasks-${port}`, binding);
const loadingSessions = new Map();
async function getSession(id) {
  if (!loadingSessions.has(id)) loadingSessions.set(id, loadSession(id).finally(() => loadingSessions.delete(id)));
  return loadingSessions.get(id);
}
async function loadSession(id) {
  if (sessions.has(id)) return sessions.get(id);
  const snapshot = await store.load(id);
  if (!snapshot) return null;
  // Demo providers keep fictional app state in memory; only live tasks can be recovered across restarts.
  if (snapshot.mode === 'demo') return null;
  if (mode === 'arga') throw new Error('Saved Arga tasks cannot resume across twin runs. Review the saved receipts locally.');
  const session = ReachSession.restore(mode === 'arga' ? arga : google, planner, snapshot, state => store.save(id, { ...state, mode }));
  const entry = { session, created: Date.now() }; sessions.set(id, entry); return entry;
}
const json = (res, status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(data)); };
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').filter(s => s.includes('=')).map(s => s.trim().split('=')));
const cookieValue = id => `reach_session=${id}; HttpOnly; SameSite=Strict; Path=/`;
async function body(req) {
  let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 16000) throw new Error('Request too large'); }
  return JSON.parse(raw || '{}');
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  try {
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return json(res, 403, { error: 'Local access only.' });
    const url = new URL(req.url, origin);
    if (req.method === 'POST' && ((req.headers.origin && ![origin, `http://localhost:${port}`].includes(req.headers.origin)) || req.headers['x-reach-client'] !== '1')) return json(res, 403, { error: 'Request must originate in Reach.' });
    if (url.pathname === '/api/config') return json(res, 200, { mode, googleConfigured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET), connected: !!(tokens.refresh_token || process.env.GOOGLE_REFRESH_TOKEN), planner: mode === 'demo' ? 'template-practice' : 'anthropic', aiConfigured: planner.enabled, model: mode === 'demo' ? null : planner.model });
    if (url.pathname === '/api/session') return json(res, 200, (await getSession(cookie(req).reach_session))?.session.view() || null);
    if (url.pathname === '/api/start' && req.method === 'POST') {
      const input = await body(req);
      const scenario = ['normal', 'calendar-changed', 'file-changed', 'gmail-fails', 'readback-fails'].includes(input.scenario) ? input.scenario : 'normal';
      const id = randomBytes(24).toString('hex');
      const session = new ReachSession(mode === 'demo' ? new DemoProvider(scenario) : mode === 'arga' ? arga : google, mode === 'demo' ? null : planner, state => store.save(id, { ...state, mode }));
      const view = await session.start();
      // Local single-user prototype. Bound storage rather than retaining task content indefinitely.
      if (sessions.size > 100) {
        const idle = [...sessions].find(([, entry]) => !entry.session.busy);
        if (idle) sessions.delete(idle[0]);
      }
      sessions.set(id, { session, created: Date.now() });
      return json(res, 200, view, { 'Set-Cookie': cookieValue(id) });
    }
    if (url.pathname === '/api/choose' && req.method === 'POST') {
      const entry = await getSession(cookie(req).reach_session);
      if (!entry) return json(res, 409, { error: 'This session has ended. Open a new task.' });
      const input = await body(req);
      return json(res, 200, await entry.session.choose(input.choice, input.revision));
    }
    if (url.pathname === '/auth/google') {
      if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return json(res, 409, { error: 'Configure the OAuth client ID and secret locally in .env first.' });
      const state = randomBytes(24).toString('hex'); oauthStates.set(state, Date.now());
      const target = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: origin + '/auth/callback', response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state });
      res.writeHead(302, { Location: target, 'Set-Cookie': `reach_oauth=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600` }); return res.end();
    }
    if (url.pathname === '/auth/callback') {
      const state = url.searchParams.get('state'), created = oauthStates.get(state); oauthStates.delete(state);
      if (!created || Date.now() - created > 600000 || cookie(req).reach_oauth !== state) return json(res, 403, { error: 'Sign-in session expired. Start again from Reach.' });
      if (!url.searchParams.get('code')) return json(res, 400, { error: 'Google sign-in was not completed.' });
      const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(20000), body: new URLSearchParams({ code: url.searchParams.get('code'), client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: origin + '/auth/callback', grant_type: 'authorization_code' }) });
      if (!response.ok) return json(res, 502, { error: 'Google sign-in could not be completed.' });
      const data = await response.json(); Object.assign(tokens, data, { expiresAt: Date.now() + data.expires_in * 1000 });
      if (process.env.REACH_AUTO_SETUP === 'true') {
        await initializeGoogle(google, root);
        mode = 'google'; sessions.clear();
      }
      // Keep the granted connection across local restarts; never return tokens to the browser.
      if (data.refresh_token) await updateEnv(root + '.env', { GOOGLE_REFRESH_TOKEN: data.refresh_token });
      res.writeHead(302, { Location: '/', 'Set-Cookie': 'reach_oauth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' }); return res.end();
    }
    const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
    if (req.method === 'GET' && files[url.pathname]) { const [file, type] = files[url.pathname]; res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); return res.end(await readFile(root + 'public/' + file)); }
    json(res, 404, { error: 'Not found' });
  } catch (error) { json(res, 400, { error: error.message || 'Reach could not finish this action.', code: error.code || 'ERROR' }); }
});
server.listen(port, '127.0.0.1', () => console.log(`Reach · ${mode} mode · ${origin}`));
