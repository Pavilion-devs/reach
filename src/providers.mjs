import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const copy = value => structuredClone(value);
export const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/calendar.events'];
export class ReachError extends Error { constructor(message, code = 'PROVIDER_ERROR') { super(message); this.code = code; } }
export function slotLabel(slot, timezone) {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(new Date(slot.start));
}
const safeHeader = text => String(text).replace(/[\r\n]/g, ' ');
export function draftMime(plan, attachment) {
  const boundary = `reach_${plan.id}`;
  const lines = [
    `To: ${safeHeader(plan.recipient)}`,
    `Subject: =?UTF-8?B?${Buffer.from(plan.subject).toString('base64')}?=`,
    `Message-ID: <${plan.id}@reach.invalid>\r\nX-Reach-Plan-ID: ${plan.id}`, 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(plan.body).toString('base64')
  ];
  if (attachment) lines.push(`--${boundary}`, 'Content-Type: application/pdf', 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${safeHeader(plan.file.name).replace(/["\\]/g, '_')}"`, '', attachment.toString('base64'));
  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}

export class DemoProvider {
  mode = 'demo'; writes = []; drafts = new Map(); holds = new Map();
  constructor(scenario = 'normal') {
    this.scenario = scenario;
    const tomorrow = new Date(); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1); tomorrow.setUTCHours(10, 0, 0, 0);
    const starts = [tomorrow.getTime(), tomorrow.getTime() + 3 * 3600000];
    this.context = {
      timezone: 'Africa/Lagos',
      message: { id: 'mail_aya', revision: '1', name: 'Aya Okafor', email: 'aya@northstar.example', subject: 'A little more about your work', body: 'Hi Ola,\n\nWe loved the direction you shared for Northstar. Could you send over your portfolio and suggest a time for a 30-minute call? I’m flexible tomorrow.\n\nLooking forward to it,\nAya', received: 'Today', app: 'Gmail' },
      files: [
        { id: 'portfolio-current', name: 'Selected work · 2026.pdf', size: 1080, modifiedTime: '2026-09-12T10:00:00Z', revision: '3', description: 'A concise selection of your recent projects.', app: 'Drive' },
        { id: 'portfolio-archive', name: 'Selected work · 2025.pdf', size: 940, modifiedTime: '2025-11-20T10:00:00Z', revision: '1', description: 'Your previous portfolio. Included so the choice stays yours.', app: 'Drive' }
      ],
      slots: starts.map((start, i) => ({ id: `slot-${i}`, start: new Date(start).toISOString(), end: new Date(start + 1800000).toISOString(), app: 'Calendar' }))
    };
  }
  async readContext() { return copy(this.context); }
  async beforeApproval() {
    if (this.scenario === 'calendar-changed') this.context.slots = [];
    if (this.scenario === 'file-changed') this.context.files[0].revision = '4';
  }
  async download(file) { return Buffer.from(`%PDF-1.4\nReach practice attachment: ${file.name}\n%%EOF`); }
  async createHold(plan) {
    if (!this.holds.has(plan.id)) { this.holds.set(plan.id, { id: `hold-${plan.id}`, ...copy(plan.slot), summary: plan.holdTitle, visibility: 'private', attendees: [] }); this.writes.push('calendar.create'); }
    return { id: this.holds.get(plan.id).id };
  }
  async verifyHold(plan, receipt) { const h = this.holds.get(plan.id); return !!h && h.id === receipt.id && h.start === plan.slot.start && h.end === plan.slot.end && h.attendees.length === 0; }
  async createDraft(plan, raw) {
    if (this.scenario === 'gmail-fails') throw new ReachError('Gmail did not confirm the draft. Check the mailbox before trying again.', 'WRITE_UNCERTAIN');
    if (!this.drafts.has(plan.id)) { this.drafts.set(plan.id, { id: `draft-${plan.id}`, raw }); this.writes.push('gmail.createDraft'); }
    return { id: this.drafts.get(plan.id).id };
  }
  async verifyDraft(plan, receipt, raw) { return this.scenario !== 'readback-fails' && this.drafts.get(plan.id)?.id === receipt.id && this.drafts.get(plan.id)?.raw === raw; }
}

export class GoogleProvider {
  mode = 'google';
  constructor(config, tokens = {}) { this.config = config; this.tokens = tokens; }
  async uploadPdf(metadata, bytes) {
    const boundary = 'reach_upload_' + hash(bytes.toString('base64')).slice(0, 24);
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,md5Checksum', { method: 'POST', signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
    if (!response.ok) throw new ReachError(`Drive upload returned ${response.status}. Check the new test folder before retrying.`, 'WRITE_UNCERTAIN');
    return response.json();
  }
  async token() {
    if (this.tokens.access_token && Date.now() < this.tokens.expiresAt - 30000) return this.tokens.access_token;
    const refresh = this.tokens.refresh_token || this.config.GOOGLE_REFRESH_TOKEN;
    if (!refresh) throw new ReachError('Connect your Google test account first.', 'AUTH_REQUIRED');
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(20000), body: new URLSearchParams({ client_id: this.config.GOOGLE_CLIENT_ID, client_secret: this.config.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: 'refresh_token' }) });
    if (!response.ok) throw new ReachError('Google connection expired. Connect again.', 'AUTH_REQUIRED');
    const data = await response.json(); Object.assign(this.tokens, data, { expiresAt: Date.now() + data.expires_in * 1000 }); return data.access_token;
  }
  async api(service, path, { method = 'GET', body, binary = false } = {}) {
    const roots = { gmail: 'https://gmail.googleapis.com/gmail/v1/users/me', drive: 'https://www.googleapis.com/drive/v3', calendar: 'https://www.googleapis.com/calendar/v3' };
    const token = await this.token();
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(roots[service] + path, { method, signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        break;
      } catch {
        if (method === 'GET' && attempt === 0) continue;
        throw new ReachError(method === 'GET' ? `Could not read ${service}. Check the connection and try again.` : `The ${service} write could not be confirmed. Check the app before trying again.`, method === 'GET' ? 'READ_UNAVAILABLE' : 'WRITE_UNCERTAIN');
      }
    }
    if (!response.ok) throw new ReachError(`${service} returned ${response.status}. ${method === 'POST' ? 'The action may need checking in the app.' : 'Check the account and resource permissions.'}`, method === 'POST' ? 'WRITE_UNCERTAIN' : 'PROVIDER_ERROR');
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  }
  async readContext({ excludeHoldId } = {}) {
    const c = this.config;
    if (!c.REACH_MESSAGE_ID || !/^[\w-]+$/.test(c.REACH_DRIVE_FOLDER_ID || '')) throw new ReachError('Set the test email ID and Drive folder ID in .env.', 'CONFIG_REQUIRED');
    const starts = (c.REACH_SLOT_STARTS || '').split(',').filter(Boolean);
    if (!starts.length || starts.some(s => !Number.isFinite(Date.parse(s)))) throw new ReachError('Configure future meeting times in REACH_SLOT_STARTS.', 'CONFIG_REQUIRED');
    const slots = starts.map((s, i) => ({ id: `slot-${i}`, start: new Date(s).toISOString(), end: new Date(Date.parse(s) + 1800000).toISOString(), app: 'Calendar' })).filter(s => Date.parse(s.start) > Date.now());
    if (!slots.length) throw new ReachError('No configured future meeting times remain.', 'CONFIG_REQUIRED');
    const timezone = c.REACH_TIMEZONE || 'Africa/Lagos';
    const calendar = encodeURIComponent(c.REACH_CALENDAR_ID || 'primary');
    const timeMin = slots.map(s => s.start).sort()[0], timeMax = slots.map(s => s.end).sort().at(-1);
    const [message, files, events] = await Promise.all([
      this.api('gmail', `/messages/${encodeURIComponent(c.REACH_MESSAGE_ID)}?format=full`),
      this.api('drive', '/files?' + new URLSearchParams({ q: `'${c.REACH_DRIVE_FOLDER_ID}' in parents and trashed = false and mimeType = 'application/pdf'`, fields: 'files(id,name,size,modifiedTime,md5Checksum,version),nextPageToken', pageSize: '20', orderBy: 'modifiedTime desc' })),
      this.api('calendar', `/calendars/${calendar}/events?` + new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', maxResults: '2500' }))
    ]);
    if (files.nextPageToken) throw new ReachError('Portfolio folder has too many files for a complete comparison.', 'INCOMPLETE_CONTEXT');
    if (events.nextPageToken) throw new ReachError('Calendar window has too many events to verify availability.', 'INCOMPLETE_CONTEXT');
    const headers = Object.fromEntries((message.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
    const from = headers['reply-to'] || headers.from || '';
    const email = (from.match(/<([^<>]+)>/)?.[1] || from).trim();
    if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email)) throw new ReachError('This message needs a manually verified reply address.', 'AMBIGUOUS_RECIPIENT');
    const plain = part => part.mimeType === 'text/plain' && part.body?.data ? Buffer.from(part.body.data, 'base64url').toString() : (part.parts || []).map(plain).filter(Boolean).join('\n');
    const busy = (events.items || []).filter(e => !(e.id === excludeHoldId && e.extendedProperties?.private?.reachPlanId === excludeHoldId) && e.status !== 'cancelled' && e.transparency !== 'transparent' && !(e.attendees || []).some(a => a.self && a.responseStatus === 'declined'));
    // Date-only events conservatively block the entire local date, including timezone boundaries.
    const overlaps = (slot, event) => {
      if (event.start?.date) {
        const date = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(slot.start));
        return date >= event.start.date && date < event.end.date;
      }
      return Date.parse(event.start?.dateTime) < Date.parse(slot.end) && Date.parse(event.end?.dateTime) > Date.parse(slot.start);
    };
    return { timezone, message: { id: message.id, revision: message.historyId, name: from.replace(/<[^>]+>/, '').replaceAll('"', '').trim() || email, email, subject: headers.subject || '(No subject)', body: plain(message.payload || {}) || message.snippet, snippetOnly: !plain(message.payload || {}), received: 'Google test account', app: 'Gmail' },
      files: (files.files || []).filter(f => Number(f.size) <= 5000000).map(f => ({ ...f, size: Number(f.size), revision: f.version, description: 'PDF from your configured portfolio folder.', app: 'Drive' })),
      slots: slots.filter(s => !busy.some(e => overlaps(s, e))) };
  }
  async download(file) {
    const bytes = await this.api('drive', `/files/${encodeURIComponent(file.id)}?alt=media`, { binary: true });
    if (bytes.length > 5000000 || (file.md5Checksum && createHash('md5').update(bytes).digest('hex') !== file.md5Checksum)) throw new ReachError('The attachment changed. Review the latest version first.', 'STALE_CONTEXT');
    return bytes;
  }
  async createHold(plan) {
    return this.api('calendar', `/calendars/${encodeURIComponent(this.config.REACH_CALENDAR_ID || 'primary')}/events?sendUpdates=none`, { method: 'POST', body: { id: plan.id, summary: plan.holdTitle, start: { dateTime: plan.slot.start }, end: { dateTime: plan.slot.end }, visibility: 'private', description: 'Private hold prepared in Reach. No guest has been invited.', extendedProperties: { private: { reachPlanId: plan.id } } } });
  }
  async verifyHold(plan, receipt) {
    const e = await this.api('calendar', `/calendars/${encodeURIComponent(this.config.REACH_CALENDAR_ID || 'primary')}/events/${encodeURIComponent(receipt.id)}`);
    return e.id === plan.id && e.summary === plan.holdTitle && e.extendedProperties?.private?.reachPlanId === plan.id && e.status !== 'cancelled' && Date.parse(e.start?.dateTime) === Date.parse(plan.slot.start) && Date.parse(e.end?.dateTime) === Date.parse(plan.slot.end) && e.visibility === 'private' && !(e.attendees || []).length;
  }
  async createDraft(plan, raw) { return this.api('gmail', '/drafts', { method: 'POST', body: { message: { raw: Buffer.from(raw).toString('base64url') } } }); }
  async findDraft(plan) {
    const matches = []; let pageToken; const deadline = Date.now() + 30000;
    // Bounded read-only discovery. No match never authorizes another POST.
    for (let page = 0; page < 5; page++) {
      const list = await this.api('gmail', '/drafts?' + new URLSearchParams({ maxResults: '100', ...(pageToken ? { pageToken } : {}) }));
      for (const item of list.drafts || []) {
        if (Date.now() > deadline) return null;
        const draft = await this.api('gmail', `/drafts/${encodeURIComponent(item.id)}?format=metadata`);
        if ((draft.message?.payload?.headers || []).some(h => h.name.toLowerCase() === 'x-reach-plan-id' && h.value === plan.id)) matches.push(item);
      }
      pageToken = list.nextPageToken; if (!pageToken) break;
    }
    if (pageToken || matches.length !== 1) return null;
    return matches[0];
  }
  async verifyDraft(plan, receipt, raw) {
    // Verify decoded provider content: raw MIME encoding and header folding are not stable.
    const draft = await this.api('gmail', `/drafts/${encodeURIComponent(receipt.id)}?format=full`);
    const message = draft.message;
    if (draft.id !== receipt.id || !message?.id || !message.labelIds?.includes('DRAFT') || message.labelIds.includes('SENT')) return false;
    const headers = Object.fromEntries((message.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
    const to = (headers.to || '').trim();
    if (to !== plan.recipient || headers.cc || headers.bcc) return false;
    const subject = (headers.subject || '').replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, s) => Buffer.from(s, 'base64').toString());
    if (subject !== plan.subject) return false;
    const leaves = part => part.parts?.length ? part.parts.flatMap(leaves) : [part];
    const parts = leaves(message.payload || {});
    const textParts = parts.filter(part => part.mimeType === 'text/plain' && !part.filename);
    const attachments = parts.filter(part => !!part.filename);
    if (textParts.length !== 1 || parts.length !== textParts.length + attachments.length || attachments.length !== (plan.file ? 1 : 0)) return false;
    const bytes = async part => {
      const body = part.body?.attachmentId
        ? await this.api('gmail', `/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`)
        : part.body;
      return Buffer.from(body?.data || '', 'base64url');
    };
    const normalize = text => text.replace(/\r\n/g, '\n').replace(/\n$/, '');
    if (normalize((await bytes(textParts[0])).toString()) !== normalize(plan.body)) return false;
    if (plan.file) {
      const part = attachments[0];
      const encoded = raw.split('Content-Disposition: attachment;')[1]?.split('\r\n\r\n')[1]?.split('\r\n')[0];
      if (!encoded || part.filename !== plan.file.name || part.mimeType !== 'application/pdf' || !(await bytes(part)).equals(Buffer.from(encoded, 'base64'))) return false;
    }
    return true;
  }
}
