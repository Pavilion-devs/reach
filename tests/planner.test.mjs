import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicPlanner, validateAnalysis } from '../src/planner.mjs';
import { DemoProvider, ReachError } from '../src/providers.mjs';
import { ReachSession } from '../src/engine.mjs';

const analysisFor = (context, type = 'portfolio_and_meeting') => ({
  summary: 'The client wants a portfolio and a call.', task_type: type, evidence: ['Could you send over your portfolio'],
  recommended_file_id: ['meeting', 'unsupported'].includes(type) ? null : context.files[0].id,
  recommended_slot_id: ['portfolio', 'unsupported'].includes(type) ? null : context.slots[0].id,
  rationale: 'These are observed resources. The final choices belong to the user.'
});
function fakePlanner(type = 'portfolio_and_meeting') {
  return { analyze: async c => analysisFor(c, type), draft: async (c, p, tone) => ({ acknowledgement: tone === 'concise' ? 'Thanks for your request.' : 'Thank you for your interest in my work.', closing: 'I look forward to hearing from you.', metadata: { model: 'test-model' } }) };
}
const choose = (s, id) => s.choose(id, s.revision);
async function ready(type) {
  const p = new DemoProvider(); const s = new ReachSession(p, fakePlanner(type));
  await s.start(); await choose(s, 'prepare');
  if (s.stage === 'file') await choose(s, 'file:portfolio-current');
  if (s.stage === 'slot') await choose(s, 'slot:slot-0');
  return { s, p };
}
test('planner validates evidence, resource IDs and rejects extra action fields', async () => {
  const c = await new DemoProvider().readContext();
  assert.equal(validateAnalysis(analysisFor(c), c).task_type, 'portfolio_and_meeting');
  for (const change of [{ evidence: ['Invented quote'] }, { recommended_file_id: 'secret-file' }, { recommended_slot_id: 'imaginary-slot' }, { action: 'send_mail' }]) {
    assert.throws(() => validateAnalysis({ ...analysisFor(c), ...change }, c), { code: 'INVALID_PROPOSAL' });
  }
});
test('Anthropic request sends only bounded context, requires finished structured output, and records usage', async () => {
  const c = await new DemoProvider().readContext(); let sent;
  const planner = new AnthropicPlanner({ ANTHROPIC_API_KEY: 'test-only-key', ANTHROPIC_MODEL: 'test-model', ANTHROPIC_WORKSPACE_ID: 'wrkspc_test', GOOGLE_REFRESH_TOKEN: 'never-send-this' }, async (url, options) => {
    assert.equal(options.headers['anthropic-workspace-id'], 'wrkspc_test');
    assert.equal(url, 'https://api.anthropic.com/v1/messages'); sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ id: 'test-request', model: 'test-model', stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'text', text: JSON.stringify(analysisFor(c)) }] }) };
  });
  const result = await planner.analyze(c);
  assert.equal(result.metadata.inputTokens, 100); assert.equal(sent.output_config.format.type, 'json_schema');
  assert(!JSON.stringify(sent).includes('never-send-this')); assert(!sent.tools);
  planner.fetcher = async () => ({ ok: true, json: async () => ({ stop_reason: 'max_tokens' }) });
  await assert.rejects(planner.analyze(c), { code: 'INVALID_PROPOSAL' });
});
test('AI credentials or API failure do not fall back to a fabricated successful proposal', async () => {
  const s = new ReachSession(new DemoProvider(), new AnthropicPlanner({}));
  await s.start(); assert.equal(s.stage, 'planner_error'); assert(!s.choices().some(c => c.id === 'approve')); assert.equal(s.plan, null);
  const p = new AnthropicPlanner({ ANTHROPIC_API_KEY: 'test-only' }, async () => ({ ok: false, status: 429 }));
  await assert.rejects(p.analyze(await new DemoProvider().readContext()), { code: 'AI_RATE_LIMIT' });
  p.fetcher = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'anthropic-workspace-id is required' } }) });
  await assert.rejects(p.analyze(await new DemoProvider().readContext()), { code: 'AI_WORKSPACE_REQUIRED' });
});
test('AI revision changes plan identity and requires fresh approval while preserving chosen resources', async () => {
  const { s, p } = await ready('portfolio_and_meeting'); const old = structuredClone(s.plan); const oldRevision = s.revision;
  assert.deepEqual(p.writes, []); await choose(s, 'revise'); await choose(s, 'tone:concise');
  assert.equal(s.stage, 'review'); assert.notEqual(s.plan.id, old.id); assert.notEqual(s.plan.body, old.body);
  assert.equal(s.plan.file.id, old.file.id); assert.equal(s.plan.slot.start, old.slot.start); assert.equal(s.plan.recipient, old.recipient);
  assert(s.plan.body.includes('\n\n')); assert(!s.plan.body.includes('\\n'));
  await assert.rejects(s.choose('approve', oldRevision), { code: 'STALE_SCREEN' });
  await choose(s, 'approve'); assert.equal(s.stage, 'complete'); assert.equal(p.writes.length, 2);
});
for (const type of ['portfolio', 'meeting']) test(`${type}-only request skips unrelated choices and creates only the selected resources`, async () => {
  const { s, p } = await ready(type); assert.equal(s.stage, 'review');
  assert.equal(!!s.plan.file, type === 'portfolio'); assert.equal(!!s.plan.slot, type === 'meeting');
  await choose(s, 'approve'); assert.equal(s.stage, 'complete');
  assert.deepEqual(p.writes, type === 'portfolio' ? ['gmail.createDraft'] : ['calendar.create', 'gmail.createDraft']);
});
test('unsupported task cannot enter execution through source/back navigation', async () => {
  const p = new DemoProvider(); const s = new ReachSession(p, fakePlanner('unsupported'));
  await s.start(); assert.equal(s.stage, 'unsupported'); await choose(s, 'read'); await choose(s, 'back');
  assert.equal(s.stage, 'unsupported'); await assert.rejects(choose(s, 'prepare'), { code: 'INVALID_CHOICE' }); assert.deepEqual(p.writes, []);
});
test('failed revision removes the old approval and cannot write', async () => {
  const { s, p } = await ready('portfolio_and_meeting');
  s.planner.draft = async () => { throw new ReachError('AI unavailable', 'AI_UNAVAILABLE'); };
  await choose(s, 'revise'); await choose(s, 'tone:concise');
  assert.equal(s.stage, 'planner_error'); assert.equal(s.plan, null); assert.deepEqual(p.writes, []);
  await assert.rejects(choose(s, 'approve'), { code: 'INVALID_CHOICE' });
});

test('pre-write read failure preserves the reviewed plan and retries verification without another model call', async () => {
  const { s, p } = await ready('portfolio_and_meeting'); const planId = s.plan.id;
  const originalRead = p.readContext.bind(p); p.readContext = async () => { throw new Error('Network disconnected'); };
  await choose(s, 'approve'); assert.equal(s.stage, 'verification_error'); assert.equal(s.plan.id, planId); assert.deepEqual(p.writes, []);
  p.readContext = originalRead; await choose(s, 'retry_verification'); assert.equal(s.stage, 'complete'); assert.equal(p.writes.length, 2);
});
