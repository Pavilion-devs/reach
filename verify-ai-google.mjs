// Explicit live test: writes one fictional reply draft and private hold after review.
// A journal prevents this command from blindly repeating an uncertain run.
import { readFile, writeFile, access } from 'node:fs/promises';
import { GoogleProvider } from './src/providers.mjs';
import { AnthropicPlanner } from './src/planner.mjs';
import { ReachSession } from './src/engine.mjs';
const root = new URL('.', import.meta.url);
const path = new URL('artifacts/anthropic-google-verification.json', root);
try { await access(path); throw new Error('A live AI test journal already exists. Reconcile its receipts before any new run.'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const config = {};
for (const file of ['.env', '.anthropic.env']) for (const line of (await readFile(new URL(file, root), 'utf8')).split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); const value = m?.[2].trim().replace(/^(['"])(.*)\1$/, '$2'); if (m && value) config[m[1]] = value;
}
const p = new GoogleProvider(config), planner = new AnthropicPlanner(config), session = new ReachSession(p, planner);
const report = { startedAt: new Date().toISOString(), live_model: true, live_google: true, status: 'planning', receipts: [] };
const save = () => writeFile(path, JSON.stringify(report, null, 2) + '\n');
await save();
try {
  const choose = id => session.choose(id, session.revision);
  await session.start(); if (session.stage !== 'intent') throw new Error(session.error || 'Unsupported test task');
  if (!session.context.message.body.includes('FICTIONAL REACH TEST DATA')) throw new Error('Refusing to use a non-fixture request in this test.');
  await choose('prepare');
  const file = session.context.files.find(f => f.name === 'Reach test portfolio 2026.pdf');
  if (!file || !session.context.slots.length) throw new Error('Test resources are unavailable');
  await choose(`file:${file.id}`); await choose(`slot:${session.context.slots[0].id}`);
  if (session.stage !== 'review') throw new Error(session.error || 'No review');
  report.originalPlanId = session.plan.id;
  await choose('revise'); await choose('tone:concise');
  if (session.stage !== 'review') throw new Error(session.error || 'Revision failed');
  report.plan = session.plan; report.analysis = session.analysis;
  report.status = 'reviewed_write_pending'; await save();
  console.log('Reviewed fictional recipient, 2026 portfolio and available 30-minute slot; executing once.');
  await choose('approve');
  if (session.stage === 'verification_error') { report.status = 'read_failed_no_writes'; await save(); throw new Error(session.error); }
  report.status = session.stage; report.receipts = session.receipts; report.trace = session.trace;
  report.completedAt = new Date().toISOString(); await save();
  if (session.stage !== 'complete') throw new Error(session.error || 'Workflow incomplete');
  console.log(JSON.stringify({ status: report.status, model: session.plan.ai.model, revisionChangedPlanId: session.plan.id !== report.originalPlanId, receipts: session.receipts }, null, 2));
} catch (e) { report.error = e.message; report.receipts = session.receipts; report.trace = session.trace; await save(); console.error(e.message); process.exitCode = 1; }
