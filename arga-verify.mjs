// Run once against a private, fictional, single-twin environment. No real Google access.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { ArgaProvider } from './src/arga.mjs';
import { hash, draftMime } from './src/providers.mjs';
import { testPdf } from './src/setup.mjs';

const p = new ArgaProvider({});
const manifest = await p.manifest();
const twins = Object.keys(manifest.twins);
assert.equal(twins.length, 1, 'This verifier tests one provider at a time.');
const service = twins[0];
assert(['gmail', 'google_drive', 'google_calendar'].includes(service));
await mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
const path = new URL(`./artifacts/arga-${service}-verification.json`, import.meta.url);
const previous = await readFile(path, 'utf8').then(JSON.parse).catch(e => { if (e.code !== 'ENOENT') throw e; });
assert.notEqual(previous?.run_id, manifest.run_id, 'This run already has a verification journal. Inspect its receipts before doing anything else.');
const proof = { run_id: manifest.run_id, provider: service, expires_at: manifest.expires_at, live_google: false, scope: 'Single-provider contract test; not a complete multi-app workflow.', status: 'started', checks: {} };
const save = () => writeFile(path, JSON.stringify(proof, null, 2) + '\n');
await save();
try {
  if (service === 'gmail') {
    const messages = await p.api('gmail', '/messages?maxResults=10');
    assert(messages.messages?.length);
    const source = await p.api('gmail', `/messages/${messages.messages[0].id}?format=full`);
    const headers = source.payload?.headers || [];
    assert(headers.some(h => h.name.toLowerCase() === 'from' && h.value.includes('aya@northstar.example')));
    proof.checks.seeded_request_read = true;
    const plan = { id: hash(manifest.run_id).slice(0, 32), recipient: 'aya@northstar.example', subject: 'Reach integration test', body: 'Fictional Reach test. This remains an unsent draft.', file: { name: 'Reach test portfolio.pdf' } };
    const raw = draftMime(plan, testPdf('Fictional Reach test portfolio'));
    proof.status = 'draft_write_pending'; await save();
    const draft = await p.createDraft(plan, raw); proof.draft_id = draft.id; await save();
    assert(await p.verifyDraft(plan, draft, raw));
    proof.checks.decoded_content_and_pdf_readback = true;
    assert.equal((await p.findDraft(plan))?.id, draft.id); proof.checks.draft_discovery_by_marker = true;
    const listed = await p.api('gmail', '/drafts?maxResults=100');
    assert.equal((listed.drafts || []).filter(d => d.id === draft.id).length, 1); proof.checks.discovery_did_not_duplicate_draft = true;
    const sent = await p.api('gmail', '/messages?labelIds=SENT');
    assert.equal((sent.messages || []).length, 0); proof.checks.sent_mail_count_zero = true;
  } else if (service === 'google_calendar') {
    const before = await p.api('calendar', '/calendars/primary/events');
    assert.equal((before.items || []).length, 0); proof.checks.seeded_empty_calendar_read = true;
    const start = new Date(Date.now() + 86400000).toISOString();
    const plan = { id: hash(manifest.run_id).slice(0, 32), holdTitle: 'Reach fictional private hold', slot: { start, end: new Date(Date.parse(start) + 1800000).toISOString() } };
    proof.status = 'hold_write_pending'; await save();
    const hold = await p.createHold(plan); proof.hold_id = hold.id; await save();
    assert(await p.verifyHold(plan, hold)); proof.checks.private_hold_readback_without_guests = true;
    const after = await p.api('calendar', '/calendars/primary/events');
    assert.equal(after.items?.filter(e => e.id === plan.id).length, 1); proof.checks.hold_listed_once = true;
  } else {
    const files = await p.api('drive', '/files?' + new URLSearchParams({ q: "trashed = false and mimeType = 'application/pdf'", fields: 'files(id,name,size,md5Checksum,version,parents)', pageSize: '100' }));
    assert(files.files?.length >= 2, 'Expected two seeded PDF fixtures.');
    proof.files = [];
    for (const f of files.files) {
      const bytes = await p.download(f);
      assert(bytes.subarray(0, 5).toString() === '%PDF-', 'Seeded file has no actual PDF content.');
      assert(bytes.includes(Buffer.from('%%EOF')), 'PDF content is incomplete.');
      proof.files.push({ id: f.id, name: f.name, downloaded_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    proof.checks.seeded_pdfs_downloaded = true;
  }
  proof.status = 'passed'; proof.verified_at = new Date().toISOString();
} catch (e) {
  proof.status = 'failed'; proof.failure = { code: e.code || 'CONTRACT_FAILURE', message: e.message };
  process.exitCode = 1;
}
await save();
console.log(JSON.stringify(proof, null, 2));
