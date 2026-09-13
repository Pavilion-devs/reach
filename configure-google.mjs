import { readFile, writeFile, chmod } from 'node:fs/promises';
import { updateEnv } from './src/setup.mjs';
const path = process.argv[2];
if (!path) { console.error('Usage: node configure-google.mjs /path/to/downloaded-client.json'); process.exit(1); }
const data = JSON.parse(await readFile(path, 'utf8'));
const client = data.web;
if (!client?.client_id || !client?.client_secret) throw new Error('Download a Web application OAuth client from Google Auth Platform.');
const envPath = new URL('.env', import.meta.url);
let env; try { env = await readFile(envPath, 'utf8'); } catch { env = await readFile(new URL('.env.example', import.meta.url), 'utf8'); }
for (const [key, value] of Object.entries({ GOOGLE_CLIENT_ID: client.client_id, GOOGLE_CLIENT_SECRET: client.client_secret })) {
  if (/[\r\n]/.test(value)) throw new Error('Invalid client configuration');
  const expression = new RegExp(`^${key}=.*$`, 'm'); env = expression.test(env) ? env.replace(expression, `${key}=${value}`) : env + `\n${key}=${value}\n`;
}
await writeFile(envPath, env, { mode: 0o600 }); await chmod(envPath, 0o600);
await updateEnv(new URL('.env', import.meta.url).pathname, { REACH_AUTO_SETUP: 'true' });
console.log('OAuth client saved locally. After restart, open /auth/google. Consent will trigger creation and verification of dedicated test resources.');
