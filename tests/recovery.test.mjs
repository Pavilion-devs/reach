import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { ReachSession } from '../src/engine.mjs';
import { DemoProvider } from '../src/providers.mjs';
const pick = (s, id) => s.choose(id, s.revision);
async function ready(persist, planner = null) {
  const p = new DemoProvider(); const s = new ReachSession(p, planner, persist);
  await s.start(); for (const id of ['prepare', 'file:portfolio-current', 'slot:slot-0']) await pick(s, id);
  return { p, s };
}
test('journal is private, survives a fresh store instance and rejects another connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reach-journal-')); const id = 'a'.repeat(48);
  try {
    const store = new TaskStore(directory, 'connection-a'); const { s } = await ready(state => store.save(id, state));
    const snapshot = await new TaskStore(directory, 'connection-a').load(id);
    assert.equal(snapshot.plan.body, s.plan.body); assert(!('provider' in snapshot)); assert(!('planner' in snapshot));
    assert.equal((await stat(store.path(id))).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    await assert.rejects(new TaskStore(directory, 'connection-b').load(id), /different connection/);
    assert.equal(await store.load('../secret'), null);
  } finally { await rm(directory, { recursive: true }); }
});
test('journal failure before the first POST prevents all writes', async () => {
  const { p, s } = await ready(state => { if (state.actions.hold) throw new Error('disk full'); });
  await assert.rejects(pick(s, 'approve'), { code: 'JOURNAL_FAILED' }); assert.deepEqual(p.writes, []);
});
test('lost draft response restores uncertain state and reconciliation never repeats the POST', async () => {
  let snapshot; const { p, s } = await ready(state => { snapshot = structuredClone(state); });
  const create = p.createDraft.bind(p);
  p.createDraft = async (...args) => { await create(...args); throw new Error('response lost'); };
  await pick(s, 'approve');
  assert.equal(snapshot.actions.draft.state, 'started');
  const restored = ReachSession.restore(p, null, snapshot, null);
  assert.equal(restored.stage, 'recovery'); await pick(restored, 'reconcile');
  assert.equal(restored.stage, 'recovery'); assert.deepEqual(p.writes, ['calendar.create', 'gmail.createDraft']);
  assert(!restored.choices().some(c => c.id === 'approve'));
});
test('crash after draft response but before verification can reconcile to complete without writes', async () => {
  let snapshot; const { p, s } = await ready(state => { if (state.actions.draft?.state === 'confirmed') snapshot = structuredClone(state); });
  await pick(s, 'approve'); const restored = ReachSession.restore(p, null, snapshot, null);
  await pick(restored, 'reconcile'); assert.equal(restored.stage, 'complete'); assert.deepEqual(p.writes, ['calendar.create', 'gmail.createDraft']);
});
test('changed slot preserves wording and attachment, then requires a new review', async () => {
  let calls = 0;
  const planner = { analyze: async () => ({ task_type: 'portfolio_and_meeting' }), draft: async () => { calls++; return { acknowledgement: 'My carefully chosen wording.', closing: 'Cheers.', metadata: {} }; } };
  const { p, s } = await ready(null, planner); const oldId = s.plan.id;
  p.context.slots.shift(); await pick(s, 'approve'); assert.deepEqual(s.changes, ['slot_unavailable']);
  await pick(s, 'repair'); assert.equal(s.stage, 'slot'); assert.equal(s.file.id, 'portfolio-current');
  await pick(s, `slot:${p.context.slots[0].id}`); assert.equal(s.stage, 'review'); assert.equal(calls, 1);
  assert.match(s.plan.body, /My carefully chosen wording/); assert.notEqual(s.plan.id, oldId); assert.deepEqual(p.writes, []);
});
test('changed attachment preserves a still available slot and skips selecting it again', async () => {
  const { p, s } = await ready(); p.context.files[0].revision = 'changed';
  await pick(s, 'approve'); await pick(s, 'repair'); assert.equal(s.stage, 'file');
  await pick(s, 'file:portfolio-current'); assert.equal(s.stage, 'review'); assert.equal(s.plan.slot.id, 'slot-0');
});
test('unrelated file changes do not invalidate an otherwise unchanged reviewed action', async () => {
  const { p, s } = await ready(); p.context.files[1].revision = 'irrelevant'; await pick(s, 'approve'); assert.equal(s.stage, 'complete');
});

test('abrupt process exit leaves the pre-write journal recoverable by a new process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reach-crash-')); const id = 'b'.repeat(48);
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { TaskStore } from './src/task-store.mjs';
      import { ReachSession } from './src/engine.mjs';
      import { DemoProvider } from './src/providers.mjs';
      const store = new TaskStore(process.env.TEST_JOURNAL, 'test');
      const p = new DemoProvider();
      p.createHold = async () => { process.exit(77); };
      const s = new ReachSession(p, null, state => store.save('${id}', state));
      await s.start();
      for (const choice of ['prepare', 'file:portfolio-current', 'slot:slot-0', 'approve']) await s.choose(choice, s.revision);
    `], { cwd: new URL('..', import.meta.url), env: { ...process.env, TEST_JOURNAL: directory }, encoding: 'utf8' });
    assert.equal(child.status, 77, child.stderr);
    const snapshot = await new TaskStore(directory, 'test').load(id);
    assert.equal(snapshot.actions.hold.state, 'started'); assert(snapshot.executionRaw.includes('MIME-Version'));
    const restored = ReachSession.restore(new DemoProvider(), null, snapshot, null);
    assert.equal(restored.stage, 'recovery'); assert.deepEqual(restored.choices().map(c => c.id), ['reconcile']);
  } finally { await rm(directory, { recursive: true }); }
});

test('verified hold with never-attempted draft resumes only the draft after fresh checks', async () => {
  let snapshot; const { p, s } = await ready(state => { if (state.actions.hold?.state === 'verified' && !state.actions.draft) snapshot = structuredClone(state); });
  await pick(s, 'approve'); p.drafts.clear(); p.writes = ['calendar.create'];
  const restored = ReachSession.restore(p, null, snapshot, null);
  await pick(restored, 'reconcile'); assert.equal(restored.stage, 'resume_review');
  await pick(restored, 'resume'); assert.equal(restored.stage, 'complete'); assert.deepEqual(p.writes, ['calendar.create', 'gmail.createDraft']);
});
test('resume refuses changed context without attempting the remaining draft', async () => {
  let snapshot; const { p, s } = await ready(state => { if (state.actions.hold?.state === 'verified' && !state.actions.draft) snapshot = structuredClone(state); });
  await pick(s, 'approve'); p.writes = []; p.context.message.body += 'Changed request.';
  const restored = ReachSession.restore(p, null, snapshot, null); await pick(restored, 'reconcile'); await pick(restored, 'resume');
  assert.equal(restored.stage, 'recovery'); assert.deepEqual(p.writes, []);
});
test('unknown draft ID can be discovered but must pass content verification', async () => {
  let snapshot; const { p, s } = await ready(state => { snapshot = structuredClone(state); });
  const create = p.createDraft.bind(p); p.createDraft = async (...args) => { await create(...args); throw new Error('response lost'); };
  await pick(s, 'approve'); p.findDraft = async plan => ({ id: p.drafts.get(plan.id).id });
  const restored = ReachSession.restore(p, null, snapshot, null); await pick(restored, 'reconcile');
  assert.equal(restored.stage, 'complete'); assert.equal(p.writes.length, 2);
});
