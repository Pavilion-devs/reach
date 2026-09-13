import test from 'node:test';
import assert from 'node:assert/strict';
import { ArgaProvider } from '../src/arga.mjs';

test('Arga cannot use inherited Google token refresh or upload, even if real credentials are configured', async () => {
  const p = new ArgaProvider({ GOOGLE_REFRESH_TOKEN: 'must-never-be-used' });
  await assert.rejects(p.token(), { code: 'ARGA_CREDENTIAL_BOUNDARY' });
  await assert.rejects(p.uploadPdf({}, Buffer.from('test')), { code: 'ARGA_UNSUPPORTED_OPERATION' });
});
