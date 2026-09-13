// Synthetic UI examples generated from the real engine. No external APIs or model calls.
import { writeFile } from 'node:fs/promises';
import { DemoProvider } from './src/providers.mjs';
import { ReachSession } from './src/engine.mjs';
const states = {};
function planner(type = 'portfolio_and_meeting') {
  return { analyze: async c => ({ summary: 'Synthetic example: the client requests a portfolio and a call.', task_type: type,
    evidence: ['Could you send over your portfolio'], recommended_file_id: type.includes('portfolio') ? c.files[0].id : null,
    recommended_slot_id: type.includes('meeting') ? c.slots[0].id : null, rationale: 'Fictional UI fixture. No AI was called.', metadata: { model: 'synthetic-ui-fixture' } }),
    draft: async () => ({ acknowledgement: 'Thank you for your interest in my work.', closing: 'I look forward to hearing from you.', metadata: { model: 'synthetic-ui-fixture' } }) };
}
function snapshot(name, s) { states[name] = structuredClone(s.view()); }
const choose = (s, id) => s.choose(id, s.revision);
async function ready(type = 'portfolio_and_meeting', scenario = 'normal') {
  const p = new DemoProvider(scenario); const s = new ReachSession(p, planner(type));
  await s.start(); await choose(s, 'prepare'); if (s.stage === 'file') await choose(s, 'file:portfolio-current'); if (s.stage === 'slot') await choose(s, 'slot:slot-0'); return { s, p };
}
const s = new ReachSession(new DemoProvider(), planner());
await s.start(); snapshot('intent', s); await choose(s, 'read'); snapshot('source', s); await choose(s, 'back');
await choose(s, 'prepare'); snapshot('file', s); await choose(s, 'file:portfolio-current'); snapshot('slot', s); await choose(s, 'slot:slot-0'); snapshot('review', s);
await choose(s, 'revise'); snapshot('revise', s); await choose(s, 'review_back'); await choose(s, 'approve'); snapshot('complete', s);
for (const [name, scenario] of [['blocked', 'calendar-changed'], ['partial', 'gmail-fails']]) { const {s} = await ready('portfolio_and_meeting', scenario); await choose(s, 'approve'); snapshot(name, s); }
for (const type of ['portfolio', 'meeting']) { const { s } = await ready(type); snapshot(type + '_only_review', s); }
const cancelled = (await ready()).s; await choose(cancelled, 'cancel'); snapshot('cancelled', cancelled);
const unsupported = new ReachSession(new DemoProvider(), planner('unsupported')); await unsupported.start(); snapshot('unsupported', unsupported);
const failed = new ReachSession(new DemoProvider(), { analyze: async () => { throw new Error('Synthetic AI outage example.'); } }); await failed.start(); snapshot('planner_error', failed);
const {s: verification, p} = await ready(); p.readContext = async () => { throw new Error('Synthetic connection failure'); }; await choose(verification, 'approve'); snapshot('verification_error', verification);
const { s: interrupted, p: recoveryProvider } = await ready('portfolio_and_meeting', 'gmail-fails');
await choose(interrupted, 'approve');
const recovered = ReachSession.restore(recoveryProvider, planner(), interrupted.snapshot(), null);
snapshot('recovery', recovered);
const resumable = structuredClone(recovered.snapshot()); delete resumable.actions.draft;
const resume = ReachSession.restore(recoveryProvider, planner(), resumable, null); await choose(resume, 'reconcile'); snapshot('resume_review', resume);
const { s: repair, p: repairProvider } = await ready();
repairProvider.context.slots.shift(); await choose(repair, 'approve'); await choose(repair, 'repair');
snapshot('repair_slot', repair);
await writeFile(new URL('fixtures/ui-states.json', import.meta.url), JSON.stringify({ synthetic: true, description: 'Fictional UI examples. No real model or provider actions. Not evaluation evidence.', states }, null, 2) + '\n');
console.log(`Generated ${Object.keys(states).length} synthetic UI examples.`);
