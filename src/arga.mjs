import { readFile } from 'node:fs/promises';
import { GoogleProvider, ReachError } from './providers.mjs';

// Reuse Google data-plane operations; never reuse a real Google token for twins.
export class ArgaProvider extends GoogleProvider {
  mode = 'arga';
  async token() { throw new ReachError('Arga uses twin credentials only.', 'ARGA_CREDENTIAL_BOUNDARY'); }
  async uploadPdf() { throw new ReachError('Seed PDF content through Arga provisioning; Google upload is unavailable in twin mode.', 'ARGA_UNSUPPORTED_OPERATION'); }
  async manifest() {
    let data;
    try { data = JSON.parse(await readFile(this.config.REACH_ARGA_MANIFEST || new URL('../.arga-run.json', import.meta.url), 'utf8')); }
    catch { throw new ReachError('Provision Reach’s Arga twins first: npm run arga:provision.', 'ARGA_NOT_READY'); }
    if (data.status !== 'ready' || !data.expires_at || Date.parse(data.expires_at) <= Date.now()) throw new ReachError('The Arga environment is not ready or has expired.', 'ARGA_EXPIRED');
    return data;
  }
  async api(service, path, { method = 'GET', body, binary = false } = {}) {
    const manifest = await this.manifest();
    const names = { gmail: 'gmail', drive: 'google_drive', calendar: 'google_calendar' };
    const prefixes = { gmail: '/gmail/v1/users/me', drive: '/drive/v3', calendar: '/calendar/v3' };
    const twin = manifest.twins?.[names[service]];
    if (!twin?.base_url) throw new ReachError(`The ${names[service]} twin is not provisioned.`, 'ARGA_MISSING_TWIN');
    const env = twin.env_vars || {};
    const token = env.GOOGLE_ACCESS_TOKEN || env.GMAIL_ACCESS_TOKEN || env.GOOGLE_CALENDAR_ACCESS_TOKEN || env.ACCESS_TOKEN;
    const base = new URL(twin.base_url);
    const prefix = base.pathname.replace(/\/$/, '').endsWith(prefixes[service]) ? '' : prefixes[service];
    const url = new URL(base.origin + base.pathname.replace(/\/$/, '') + prefix + path);
    for (const [k, v] of base.searchParams) url.searchParams.set(k, v);
    if (manifest.proxy_token) url.searchParams.set('token', manifest.proxy_token);
    const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.headers.get('x-arga-stub') || response.headers.get('x-twin-stub')) throw new ReachError(`${service} returned a stubbed operation, not proof of execution.`, 'ARGA_STUB');
    if (!response.ok) throw new ReachError(`Arga ${service} returned ${response.status}. Check the twin’s supported operations and credentials.`, method === 'POST' ? 'WRITE_UNCERTAIN' : 'ARGA_PROVIDER_ERROR');
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  }
}
