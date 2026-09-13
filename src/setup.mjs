import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { hash } from './providers.mjs';

export async function writePrivateJson(path, value) {
  const temp = path + '.tmp';
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await chmod(temp, 0o600); await rename(temp, path);
}
export async function updateEnv(path, values) {
  let text = ''; try { text = await readFile(path, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n]/.test(String(value))) throw new Error('Invalid environment setting');
    const re = new RegExp(`^${key}=.*$`, 'm'); const line = `${key}=${value}`;
    text = re.test(text) ? text.replace(re, () => line) : text.trimEnd() + '\n' + line + '\n';
  }
  const temp = path + '.tmp'; await writeFile(temp, text, { mode: 0o600 }); await chmod(temp, 0o600); await rename(temp, path);
}
export function testPdf(title) {
  const escaped = title.replace(/[()\\]/g, c => '\\' + c);
  const stream = `BT /F1 22 Tf 64 740 Td (${escaped}) Tj 0 -40 Td /F1 12 Tf (Fictional Reach test portfolio. No client data.) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
export function candidateTimes(now = new Date()) {
  const day = new Date(now); const result = []; day.setUTCHours(0, 0, 0, 0);
  while (result.length < 9) {
    day.setUTCDate(day.getUTCDate() + 1); if ([0, 6].includes(day.getUTCDay())) continue;
    for (const hour of [9, 12, 15]) { const at = new Date(day); at.setUTCHours(hour); result.push(at.toISOString()); }
  }
  return result;
}
export async function initializeGoogle(provider, root) {
  const statePath = root + '/.setup-state.json';
  const profile = await provider.api('gmail', '/profile'); const accountHash = hash(profile.emailAddress);
  let state; try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (state && state.accountHash !== accountHash) throw new Error('These test resources belong to a different Google account. Keep that account connected or create a separate setup.');
  state ||= { id: randomBytes(12).toString('hex'), accountHash, resources: {} };
  async function create(key, action) {
    if (state.resources[key]?.status === 'ready') return state.resources[key].value;
    if (state.resources[key]?.status === 'started') throw new Error(`The previous ${key} creation needs reconciliation before retrying. No duplicate will be created automatically.`);
    state.resources[key] = { status: 'started' }; await writePrivateJson(statePath, state);
    const value = await action(); state.resources[key] = { status: 'ready', value }; await writePrivateJson(statePath, state); return value;
  }
  const folder = await create('folder', () => provider.api('drive', '/files?fields=id,name', { method: 'POST', body: { name: 'Reach - isolated test portfolios', mimeType: 'application/vnd.google-apps.folder', appProperties: { reachSetup: state.id } } }));
  for (const year of ['2026', '2025']) {
    await create(`portfolio${year}`, () => provider.uploadPdf({ name: `Reach test portfolio ${year}.pdf`, parents: [folder.id], appProperties: { reachSetup: state.id } }, testPdf(`Reach test portfolio ${year}`)));
  }
  const request = await create('requestDraft', async () => {
    const raw = ['From: Aya - Reach test <aya@northstar.example>', 'To: Reach test <ola@reach.example>', 'Reply-To: Aya - Reach test <aya@northstar.example>', 'Subject: Reach test - portfolio and meeting request', `Message-ID: <setup-${state.id}@reach.invalid>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', 'FICTIONAL REACH TEST DATA. This is an unsent setup draft, not a received client message.', '', 'Hi Ola, please share your portfolio and suggest a 30-minute call in the next few weekdays. Thank you, Aya.'].join('\r\n');
    return provider.api('gmail', '/drafts', { method: 'POST', body: { message: { raw: Buffer.from(raw).toString('base64url') } } });
  });
  const values = { REACH_PROVIDER: 'google', REACH_MESSAGE_ID: request.message.id, REACH_DRIVE_FOLDER_ID: folder.id, REACH_CALENDAR_ID: 'primary', REACH_TIMEZONE: 'Africa/Lagos', REACH_SLOT_STARTS: candidateTimes().join(',') };
  Object.assign(provider.config, values);
  // Read all three providers before saving the setup as complete.
  const context = await provider.readContext();
  if (!context.files.length) throw new Error('The created portfolio PDFs could not be read back.');
  await updateEnv(root + '/.env', values);
  state.completedAt = new Date().toISOString(); await writePrivateJson(statePath, state);
  return { context, resources: { folder: folder.id, requestDraft: request.id, requestMessage: request.message.id, portfolios: Object.keys(state.resources).filter(k => k.startsWith('portfolio')).length } };
}
