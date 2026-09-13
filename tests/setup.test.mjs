import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { initializeGoogle, candidateTimes, testPdf } from '../src/setup.mjs';

function fakeProvider() {
  return { config: {}, writes: [], email: 'test@example.com',
    async api(service, path, opts = {}) {
      if (path === '/profile') return { emailAddress: this.email };
      assert.equal(opts.method, 'POST'); this.writes.push(service);
      if (service === 'drive') return { id: 'folder-1' };
      assert(path === '/drafts'); return { id: 'draft-1', message: { id: 'message-1' } };
    },
    async uploadPdf(meta, bytes) { this.writes.push('pdf'); assert(bytes.toString().startsWith('%PDF-1.4')); assert.deepEqual(meta.parents, ['folder-1']); return { id: meta.name }; },
    async readContext() { assert.equal(this.config.REACH_MESSAGE_ID, 'message-1'); return { files: [{ id: 'pdf-1' }] }; }
  };
}
test('setup creates dedicated resources, configures IDs, and repeat invocation creates no duplicates', async () => {
  const dir = await mkdtemp(tmpdir() + '/reach-setup-');
  try {
    const p = fakeProvider(); await initializeGoogle(p, dir); assert.deepEqual(p.writes, ['drive', 'pdf', 'pdf', 'gmail']);
    const env = await readFile(dir + '/.env', 'utf8'); assert.match(env, /REACH_MESSAGE_ID=message-1/); assert.match(env, /REACH_PROVIDER=google/); assert.equal((await stat(dir + '/.env')).mode & 0o777, 0o600);
    await initializeGoogle(p, dir); assert.equal(p.writes.length, 4);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('setup does not silently reuse resources across Google accounts', async () => {
  const dir = await mkdtemp(tmpdir() + '/reach-setup-');
  try { const p = fakeProvider(); await initializeGoogle(p, dir); p.email = 'other@example.com'; await assert.rejects(initializeGoogle(p, dir), /different Google account/); assert.equal(p.writes.length, 4); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
test('uncertain setup write is journaled before the call and cannot be blindly retried', async () => {
  const dir = await mkdtemp(tmpdir() + '/reach-setup-');
  try {
    const p = fakeProvider(); p.uploadPdf = async () => { p.writes.push('uncertain'); throw new Error('Connection lost'); };
    await assert.rejects(initializeGoogle(p, dir), /Connection lost/); await assert.rejects(initializeGoogle(p, dir), /needs reconciliation/); assert.deepEqual(p.writes, ['drive', 'uncertain']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('candidate meeting times are future weekdays and PDF xref points at real objects', () => {
  const now = new Date('2026-09-18T23:00:00Z'); const times = candidateTimes(now); assert.equal(times.length, 9); assert(times.every(t => Date.parse(t) > now.getTime() && ![0, 6].includes(new Date(t).getUTCDay())));
  const pdf = testPdf('Test portfolio').toString(); const pointer = Number(pdf.match(/startxref\n(\d+)/)[1]); assert.equal(pdf.slice(pointer, pointer + 4), 'xref');
});
