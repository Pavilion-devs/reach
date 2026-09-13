import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleProvider } from '../src/providers.mjs';
test('Google retries an interrupted GET once but never retries an uncertain write', async t => {
  const p = new GoogleProvider({}, { access_token: 'test-token', expiresAt: Date.now() + 60000 }); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { if (++calls === 1) throw new Error('Connection reset'); return { ok: true, json: async () => ({ id: 'read-resource' }) }; });
  assert.equal((await p.api('gmail', '/profile')).id, 'read-resource'); assert.equal(calls, 2);
  globalThis.fetch.mock.mockImplementation(async () => { calls++; throw new Error('Lost write response'); }); calls = 0;
  await assert.rejects(p.api('gmail', '/drafts', { method: 'POST', body: { message: {} } }), { code: 'WRITE_UNCERTAIN' }); assert.equal(calls, 1);
});
