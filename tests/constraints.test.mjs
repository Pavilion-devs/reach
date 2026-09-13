import test from 'node:test';
import assert from 'node:assert/strict';
import { checkConstraints } from '../src/constraints.mjs';
import { DemoProvider, GoogleProvider } from '../src/providers.mjs';
test('explicit durations, dates and latest-file requests are checked against actual selections', async () => {
  const c = await new DemoProvider().readContext();
  c.message.body = 'Please propose a 120-minute call'; assert.equal(checkConstraints(c)[0].passed, false);
  c.message.body = 'A 30-minute call on 2030-01-01'; assert.equal(checkConstraints(c).find(c => c.rule === 'explicit_date').passed, false);
  c.message.body = 'Send the latest portfolio'; assert.equal(checkConstraints(c, { file: c.files[1] })[0].passed, false);
  assert.equal(checkConstraints(c, { file: c.files[0] })[0].passed, true);
});
test('Gmail discovery accepts exactly one persisted marker and refuses ambiguous matches', async () => {
  const p = new GoogleProvider({}); let duplicate = false;
  p.api = async (service, path) => path.startsWith('/drafts?') ? { drafts: [{ id: 'a' }, ...(duplicate ? [{ id: 'b' }] : [])] } : { message: { payload: { headers: [{ name: 'X-Reach-Plan-ID', value: 'plan' }] } } };
  assert.equal((await p.findDraft({ id: 'plan' })).id, 'a'); duplicate = true;
  assert.equal(await p.findDraft({ id: 'plan' }), null);
});
