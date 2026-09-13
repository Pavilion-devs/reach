import { checkConstraints } from './constraints.mjs';
import { randomBytes, createHash } from 'node:crypto';
import { hash, copy, draftMime, slotLabel, ReachError } from './providers.mjs';

const choice = (id, title, description, icon = 'arrow') => ({ id, title, description, icon });
export class ReachSession {
  constructor(provider, planner = null, persist = null) { this.persist = persist; this.actions = {}; this.changes = []; this.provider = provider; this.planner = planner; this.analysis = null; this.stage = 'loading'; this.receipts = []; this.trace = []; this.revision = 0; this.busy = false; this.error = null; }
  snapshot() {
    const { provider, planner, persist, busy, ...state } = this;
    return copy(state);
  }
  async checkpoint() {
    try { await this.persist?.(this.snapshot()); }
    catch (error) { throw new ReachError('Task journal could not be saved. No further app writes will be attempted.', 'JOURNAL_FAILED'); }
  }
  static restore(provider, planner, snapshot, persist) {
    const session = new ReachSession(provider, planner, persist);
    Object.assign(session, snapshot);
    session.busy = false;
    if (Object.keys(session.actions).length && session.stage !== 'complete') {
      session.stage = 'recovery';
      session.error = 'Execution was interrupted. Check recorded actions before doing anything else. An uncertain write will not be repeated.';
      session.revision++;
    }
    return session;
  }
  async reconcile() {
    // Read-only recovery: missing responses remain uncertain; absence is not proof of failure.
    for (const [kind, action] of Object.entries(this.actions)) {
      let id = action.id || (kind === 'hold' ? this.plan.id : null);
      if (!id && kind === 'draft' && this.provider.findDraft) {
        try { id = (await this.provider.findDraft(this.plan))?.id; if (id) action.id = id; } catch {}
      }
      if (!id) { action.state = 'uncertain'; continue; }
      try {
        const verified = kind === 'hold'
          ? await this.provider.verifyHold(this.plan, { id })
          : await this.provider.verifyDraft(this.plan, { id }, this.executionRaw);
        action.state = verified ? 'verified' : 'uncertain';
        const app = kind === 'hold' ? 'Calendar' : 'Gmail';
        let receipt = this.receipts.find(r => r.app === app);
        if (verified && !receipt) { receipt = { app, action: kind === 'hold' ? 'Private hold found' : 'Reply draft found', id }; this.receipts.push(receipt); }
        if (receipt) receipt.verified = verified;
      } catch { action.state = 'uncertain'; const receipt = this.receipts.find(r => r.app === (kind === 'hold' ? 'Calendar' : 'Gmail')); if (receipt) receipt.verified = false; }
    }
    this.stage = this.actions.draft?.state === 'verified' && (!this.plan.slot || this.actions.hold?.state === 'verified') ? 'complete' : 'recovery';
    this.error = this.stage === 'complete' ? null : 'Recorded app state checked. This task is incomplete; uncertain writes are never retried automatically.';
    if (!this.actions.draft && this.actions.hold?.state === 'verified') { this.stage = 'resume_review'; this.error = null; }
    this.record('recovery.checked');
  }
  async resume() {
    // Only an absent draft ledger entry proves that no draft POST was attempted.
    if (this.actions.draft || this.actions.hold?.state !== 'verified') throw new ReachError('This write cannot be resumed safely.', 'UNSAFE_RETRY');
    try {
      if (!await this.provider.verifyHold(this.plan, { id: this.actions.hold.id || this.plan.id })) throw new Error('The saved hold has changed.');
      const fresh = await this.provider.readContext({ excludeHoldId: this.plan.id });
      if (hash(fresh.message) !== hash(this.context.message) || fresh.timezone !== this.context.timezone || !fresh.slots.some(s => hash(s) === hash(this.plan.slot)) || (this.plan.file && !fresh.files.some(f => hash(f) === hash(this.plan.file))) || checkConstraints(fresh, this.plan).some(c => !c.passed)) throw new Error('The request, attachment, or calendar availability changed.');
      this.actions.draft = { state: 'started' }; await this.checkpoint();
      const draft = await this.provider.createDraft(this.plan, this.executionRaw);
      this.actions.draft = { state: 'confirmed', id: draft.id }; await this.checkpoint();
      const receipt = { app: 'Gmail', action: 'Reply draft created', id: draft.id, verified: false }; this.receipts.push(receipt);
      receipt.verified = await this.provider.verifyDraft(this.plan, draft, this.executionRaw);
      if (!receipt.verified) throw new Error('Draft readback failed.');
      this.actions.draft.state = 'verified'; this.stage = 'complete'; this.error = null; this.record('recovery.completed');
    } catch (error) { this.stage = 'recovery'; this.error = error.message; if (error.code === 'JOURNAL_FAILED') throw error; }
  }
  async repair() {
    const fresh = await this.provider.readContext();
    if (hash(fresh.message) !== hash(this.context.message) || fresh.timezone !== this.context.timezone) { await this.start(); return; }
    this.context = fresh;
    this.file = this.plan.file && fresh.files.find(f => hash(f) === hash(this.plan.file));
    this.slot = this.plan.slot && fresh.slots.find(s => hash(s) === hash(this.plan.slot));
    this.repairing = true; this.error = null;
    if (this.plan.file && !this.file) this.stage = 'file';
    else if (this.plan.slot && !this.slot) this.stage = 'slot';
    else await this.buildPlan(this.plan.decline);
  }
  record(event, detail = {}) { this.trace.push({ at: new Date().toISOString(), event, ...detail }); }
  async start() {
    this.repairing = false; this.context = await this.provider.readContext(); this.stage = 'intent'; this.plan = null; this.error = null; this.analysis = null;
    this.record('context.read', { mode: this.provider.mode, apps: ['Gmail', 'Drive', 'Calendar'] });
    this.constraints = checkConstraints(this.context);
    if (this.planner) {
      try { this.analysis = await this.planner.analyze(this.context); this.record('ai.analyzed', this.analysis.metadata); if (this.analysis.task_type === 'unsupported') this.stage = 'unsupported'; }
      catch (e) { this.stage = 'planner_error'; this.error = e.message; this.record('ai.failed', { code: e.code || 'AI_UNAVAILABLE' }); }
    }
    if (this.constraints.some(c => !c.passed)) { this.stage = 'unsupported'; this.error = 'An explicit request constraint cannot be satisfied by these resources.'; }
    this.revision++; await this.checkpoint(); return this.view();
  }
  needsFile() { return !this.analysis || ['portfolio', 'portfolio_and_meeting'].includes(this.analysis.task_type); }
  needsSlot() { return !this.analysis || ['meeting', 'portfolio_and_meeting'].includes(this.analysis.task_type); }
  choices() {
    switch (this.stage) {
      case 'intent': return [choice('prepare', 'Prepare a reply', 'Review the resources before creating anything.', 'spark'), choice('read', 'Read the full request', 'Take as much time as you need.', 'mail'), choice('decline', 'Politely decline', 'Review a short reply before creating a draft.', 'minus'), choice('cancel', 'Leave this for later', 'Finish without changing anything.', 'close')];
      case 'source': return [choice('back', 'Back to my choices', 'Return to the request.', 'back')];
      case 'file': return [...this.context.files.map(f => choice(`file:${f.id}`, f.name, this.analysis?.recommended_file_id === f.id ? 'Suggested by Reach · ' + f.description : f.description, 'file')), choice('back', 'Back to the request', 'Choose a different response.', 'back'), choice('cancel', 'Stop here', 'No changes will be made.', 'close')];
      case 'slot': return [...this.context.slots.map(s => choice(`slot:${s.id}`, slotLabel(s, this.context.timezone), `30 minutes · ${this.context.timezone}${this.analysis?.recommended_slot_id === s.id ? ' · Suggested by Reach' : ''}`, 'calendar')), choice('back', 'Change the attachment', 'Return to your files.', 'back'), choice('cancel', 'Stop here', 'No changes will be made.', 'close')];
      case 'review': return [...(this.planner ? [choice('revise', 'Change the wording', 'Make the reply shorter, warmer or more formal.', 'spark')] : []), choice('change', 'Change my choices', 'Go back before creating anything.', 'back'), choice('approve', this.plan.slot ? 'Create draft + private hold' : 'Create this draft', 'Use exactly the details shown above. Nothing is sent.', 'check'), choice('cancel', 'Cancel this task', 'Keep your apps as they are.', 'close')];
      case 'revise': return [choice('tone:concise', 'Make it shorter', 'Keep the same attachment, time and intent.', 'spark'), choice('tone:warm', 'Make it warmer', 'Friendly wording with the same facts.', 'spark'), choice('tone:formal', 'Make it more formal', 'Professional wording with the same facts.', 'spark'), choice('review_back', 'Keep the current wording', 'Return to the review.', 'back'), choice('cancel', 'Stop here', 'No changes will be made.', 'close')];
      case 'planner_error': return [choice('refresh', 'Read and propose again', 'Retry AI planning without creating anything.', 'refresh'), choice('cancel', 'Stop here', 'No changes will be made.', 'close')];
      case 'verification_error': return [choice('retry_verification', 'Recheck and create the reviewed items', 'Check the apps again before using the same reviewed reply.', 'refresh'), choice('change', 'Change my choices', 'Return to the request.', 'back'), choice('cancel', 'Stop here', 'No changes were made.', 'close')];
      case 'unsupported': return [choice('read', 'Read the original request', 'Check the request in full.', 'mail'), choice('cancel', 'Leave this request', 'This task is outside Reach’s supported actions.', 'close')];
      case 'recovery': return [choice('reconcile', 'Check saved app actions', 'Read the apps without creating anything.', 'refresh')];
      case 'blocked': return [choice('repair', 'Update only what changed', 'Keep the wording and unaffected choices.', 'refresh'), choice('refresh', 'Review the latest information', 'Your previous approval will not be reused.', 'refresh'), choice('cancel', 'Stop here', 'Leave this task.', 'close')];
      case 'resume_review': return [choice('resume', 'Finish the remaining draft', 'Recheck the saved hold and request. Create only the draft that was never attempted.', 'check')];
      case 'partial': return [choice('reconcile', 'Check saved app actions', 'Read the apps without repeating writes.', 'refresh')];
      case 'complete': case 'cancelled': return [];
      default: return [];
    }
  }
  async buildPlan(decline = false, tone = 'natural') {
    const previousBody = this.plan?.body;
    const preserved = this.repairing ? this.plan?.fragments : null;
    const preservedAI = this.repairing ? this.plan?.ai : null;
    const m = this.context.message;
    this.plan = { id: randomBytes(16).toString('hex'), recipient: m.email, subject: `Re: ${m.subject.replace(/^Re:\s*/i, '')}`, decline, file: decline || !this.needsFile() ? null : copy(this.file), slot: decline || !this.needsSlot() ? null : copy(this.slot), holdTitle: `Hold · Call with ${m.name}`, timezone: this.context.timezone };
    if (this.planner) {
      const fragments = preserved || await this.planner.draft(this.context, { ...this.plan, previousBody }, tone);
      const facts = [];
      if (this.plan.file) facts.push(`I’ve attached ${this.plan.file.name}.`);
      if (this.plan.slot) facts.push(`Would ${slotLabel(this.plan.slot, this.context.timezone)} (${this.context.timezone}) work for a 30-minute call?`);
      this.plan.body = [`Hi ${m.name},`, fragments.acknowledgement, ...facts, fragments.closing].join('\n\n');
      this.plan.fragments = fragments; this.plan.ai = preservedAI || { ...fragments.metadata, tone }; this.record('ai.drafted', this.plan.ai);
    } else {
      this.plan.body = decline ? `Hi ${m.name},\n\nThank you for getting in touch. I’m unable to take this on at the moment, but I appreciate you considering me.\n\nBest wishes` : `Hi ${m.name},\n\nThanks for getting in touch. I’ve attached ${this.file.name}.\n\nWould ${slotLabel(this.slot, this.context.timezone)} (${this.context.timezone}) work for a 30-minute call?\n\nLooking forward to hearing from you.`;
    }
    this.repairing = false; this.changes = [];
    this.plan.reviewHash = hash(this.context); this.plan.expires = Date.now() + 10 * 60000; this.stage = 'review';
    this.record('review.created', { planId: this.plan.id, contextHash: this.plan.reviewHash });
  }
  async choose(id, revision) {
    if (this.busy) throw new ReachError('An action is already in progress.', 'BUSY');
    if (revision !== this.revision) throw new ReachError('The choices changed. Review the current screen.', 'STALE_SCREEN');
    if (!this.choices().some(c => c.id === id)) throw new ReachError('That choice is not available on this screen.', 'INVALID_CHOICE');
    this.busy = true;
    try {
      this.record('choice.selected', { choice: id, stage: this.stage });
      if (id === 'cancel') this.stage = 'cancelled';
      else if (id === 'reconcile') await this.reconcile();
      else if (id === 'resume') await this.resume();
      else if (id === 'repair') await this.repair();
      else if (id === 'refresh') await this.start();
      else if (id === 'read') this.stage = 'source';
      else if (id === 'prepare') { this.repairing = false; this.file = null; this.slot = null; this.stage = this.needsFile() ? 'file' : 'slot'; }
      else if (id === 'decline') await this.buildPlan(true);
      else if (id.startsWith('file:')) { this.file = this.context.files.find(f => `file:${f.id}` === id); if (this.needsSlot() && !(this.repairing && this.slot)) this.stage = 'slot'; else await this.buildPlan(); }
      else if (id.startsWith('slot:')) { this.slot = this.context.slots.find(s => `slot:${s.id}` === id); await this.buildPlan(); }
      else if (id === 'back') this.stage = this.stage === 'slot' && this.needsFile() ? 'file' : (this.analysis?.task_type === 'unsupported' || this.constraints?.some(c => !c.passed)) ? 'unsupported' : 'intent';
      else if (id === 'change') { this.repairing = false; this.stage = 'intent'; this.plan = null; }
      else if (id === 'revise') this.stage = 'revise';
      else if (id === 'review_back') this.stage = 'review';
      else if (id.startsWith('tone:')) await this.buildPlan(this.plan.decline, id.slice(5));
      else if (id === 'approve' || id === 'retry_verification') await this.execute();
      this.revision++; await this.checkpoint(); return this.view();
    } catch (e) {
      if (e.code === 'JOURNAL_FAILED') throw e;
      if (this.planner && !['complete', 'partial'].includes(this.stage) && !this.receipts.length) {
        this.plan = null; this.stage = 'planner_error'; this.error = e.message; this.revision++;
        this.record('ai.failed', { code: e.code || 'AI_UNAVAILABLE' }); await this.checkpoint(); return this.view();
      }
      throw e;
    } finally { this.busy = false; }
  }
  async execute() {
    const plan = this.plan;
    let fresh;
    try { await this.provider.beforeApproval?.(); fresh = await this.provider.readContext(); }
    catch (e) {
      this.stage = 'verification_error'; this.error = 'Reach could not refresh the app information. Your reviewed reply is preserved, and no write was attempted.';
      this.record('verification.failed', { code: e.code || 'READ_UNAVAILABLE' }); return;
    }
    this.constraints = plan.decline ? [] : checkConstraints(fresh, plan);
    if (this.constraints.some(c => !c.passed)) { this.stage = 'blocked'; this.error = 'A selected resource does not satisfy the request. Review the constraint checks.'; return; }
    this.changes = [];
    if (Date.now() > plan.expires) this.changes.push('review_expired');
    if (hash(fresh.message) !== hash(this.context.message) || fresh.timezone !== this.context.timezone) this.changes.push('request_changed');
    if (plan.file && !fresh.files.some(f => hash(f) === hash(plan.file))) this.changes.push('file_changed');
    if (plan.slot && !fresh.slots.some(s => hash(s) === hash(plan.slot))) this.changes.push('slot_unavailable');
    if (this.changes.length) {
      this.stage = 'blocked'; this.error = 'Something changed after your review. Check the latest details before continuing.'; this.record('approval.invalidated'); return;
    }
    this.record('approval.accepted', { planId: plan.id });
    try {
      const attachment = plan.file ? await this.provider.download(plan.file) : null;
      if (attachment) { this.receipts.push({ app: 'Drive', action: 'Attachment read', id: plan.file.id, verified: true, sha256: createHash('sha256').update(attachment).digest('hex') }); this.record('attachment.read'); }
      this.executionRaw = draftMime(plan, attachment);
      if (plan.slot) {
        this.actions.hold = { state: 'started' }; await this.checkpoint();
        const hold = await this.provider.createHold(plan);
        this.actions.hold = { state: 'confirmed', id: hold.id }; await this.checkpoint();
        const receipt = { app: 'Calendar', action: 'Private hold created', id: hold.id, verified: false }; this.receipts.push(receipt);
        receipt.verified = await this.provider.verifyHold(plan, hold);
        if (!receipt.verified) throw new ReachError('The calendar hold could not be verified.', 'READBACK_FAILED');
        this.actions.hold.state = 'verified'; await this.checkpoint();
        this.record('calendar.verified', { id: hold.id });
      }
      const raw = this.executionRaw;
      this.actions.draft = { state: 'started' }; await this.checkpoint();
      const draft = await this.provider.createDraft(plan, raw);
      this.actions.draft = { state: 'confirmed', id: draft.id }; await this.checkpoint();
      const receipt = { app: 'Gmail', action: 'Reply draft created', id: draft.id, verified: false }; this.receipts.push(receipt);
      receipt.verified = await this.provider.verifyDraft(plan, draft, raw);
      if (!receipt.verified) throw new ReachError('The draft was created, but its contents could not be verified.', 'READBACK_FAILED');
      this.actions.draft.state = 'verified';
      this.record('gmail.verified', { id: draft.id }); this.stage = 'complete';
    } catch (error) {
      this.stage = 'partial'; this.error = error.code === 'WRITE_UNCERTAIN' ? error.message : `The task stopped: ${error.message}`;
      this.record('execution.stopped', { code: error.code || 'UNKNOWN', receipts: this.receipts.length });
      if (error.code === 'JOURNAL_FAILED') throw error;
    }
  }
  view() { return { constraints: this.constraints || [], actions: this.actions, changes: this.changes, analysis: this.analysis, planner: this.planner ? 'anthropic' : 'template-practice', mode: this.provider.mode, stage: this.stage, revision: this.revision, context: this.context, plan: ['review', 'revise', 'verification_error', 'blocked', 'file', 'slot', 'recovery', 'resume_review'].includes(this.stage) || ['complete', 'partial'].includes(this.stage) ? this.plan : null, choices: this.choices(), receipts: this.receipts, trace: this.trace, error: this.error }; }
}
