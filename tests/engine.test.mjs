import test from 'node:test';
import assert from 'node:assert/strict';
import { ReachSession } from '../src/engine.mjs';
import { DemoProvider, draftMime } from '../src/providers.mjs';

async function ready(scenario = 'normal') { const provider = new DemoProvider(scenario); const session = new ReachSession(provider); await session.start(); for (const id of ['prepare', 'file:portfolio-current', 'slot:slot-0']) await session.choose(id, session.revision); return { session, provider }; }
test('review is bound to the selected recipient, file and slot; no writes before approval', async () => {
  const { session, provider } = await ready(); assert.deepEqual(provider.writes, []); assert.equal(session.plan.recipient, 'aya@northstar.example'); assert.equal(session.plan.file.id, 'portfolio-current');
  await session.choose('approve', session.revision); assert.equal(session.stage, 'complete'); assert.deepEqual(provider.writes, ['calendar.create', 'gmail.createDraft']); assert.equal(session.receipts.filter(r => r.verified).length, 3);
  const raw = provider.drafts.get(session.plan.id).raw; assert.match(raw, /To: aya@northstar.example/); assert.match(raw, /Content-Disposition: attachment/); assert.equal(provider.holds.get(session.plan.id).attendees.length, 0);
});
for (const scenario of ['calendar-changed', 'file-changed']) test(`${scenario}: a stale review cannot execute writes`, async () => {
  const { session, provider } = await ready(scenario); await session.choose('approve', session.revision); assert.equal(session.stage, 'blocked'); assert.deepEqual(provider.writes, []); assert(!session.choices().some(c => c.id === 'approve'));
});
test('expiry invalidates a review without applying a time limit to the user’s reading', async () => {
  const { session, provider } = await ready(); session.plan.expires = Date.now() - 1; await session.choose('approve', session.revision); assert.equal(session.stage, 'blocked'); assert.deepEqual(provider.writes, []);
});
test('duplicate approval cannot repeat writes', async () => {
  const { session, provider } = await ready(); const rev = session.revision; await session.choose('approve', rev); await assert.rejects(session.choose('approve', rev), /choices changed/); assert.equal(provider.writes.length, 2);
});
test('concurrent approval is rejected while the first executes', async () => {
  const { session, provider } = await ready(); const original = provider.download.bind(provider); let release; const waiting = new Promise(resolve => release = resolve); provider.download = async f => { await waiting; return original(f); };
  const first = session.choose('approve', session.revision); await assert.rejects(session.choose('approve', session.revision), /already in progress/); release(); await first; assert.equal(provider.writes.length, 2);
});
test('partial failure preserves truthful receipts and offers no blind retry', async () => {
  const { session, provider } = await ready('gmail-fails'); await session.choose('approve', session.revision); assert.equal(session.stage, 'partial'); assert.deepEqual(provider.writes, ['calendar.create']); assert.equal(session.receipts.length, 2); assert.deepEqual(session.choices().map(c => c.id), ['reconcile']);
});
test('unverified draft is never reported as completed', async () => {
  const { session } = await ready('readback-fails'); await session.choose('approve', session.revision); assert.equal(session.stage, 'partial'); assert.equal(session.receipts.at(-1).verified, false);
});
test('cancel and change are available before approval and cannot mutate providers', async () => {
  const { session, provider } = await ready(); await session.choose('change', session.revision); assert.equal(session.stage, 'intent'); assert.equal(session.plan, null); await session.choose('cancel', session.revision); assert.deepEqual(provider.writes, []);
});
test('a fabricated action or file ID cannot enter the execution plan', async () => {
  const session = new ReachSession(new DemoProvider()); await session.start(); await assert.rejects(session.choose('approve', session.revision), /not available/); await session.choose('prepare', session.revision); await assert.rejects(session.choose('file:secret-document', session.revision), /not available/);
});
test('empty availability creates no fabricated slot', async () => {
  const provider = new DemoProvider(); provider.context.slots = []; const session = new ReachSession(provider); await session.start(); await session.choose('prepare', session.revision); await session.choose('file:portfolio-current', session.revision); assert(!session.choices().some(c => c.id.startsWith('slot:')));
});
test('declining creates only the reviewed draft, with no attachment or hold', async () => {
  const provider = new DemoProvider(); const session = new ReachSession(provider); await session.start(); await session.choose('decline', session.revision); await session.choose('approve', session.revision); assert.equal(session.stage, 'complete'); assert.deepEqual(provider.writes, ['gmail.createDraft']); assert(!provider.drafts.get(session.plan.id).raw.includes('Content-Disposition: attachment'));
});
test('untrusted display text cannot inject mail headers', () => {
  const raw = draftMime({ id: 'test', recipient: 'x@example.com\r\nBcc: other@example.com', subject: 'Hi\nBcc: bad', body: 'hello' }); assert(!raw.includes('\r\nBcc:'));
});
