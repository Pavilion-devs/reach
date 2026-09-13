import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleProvider, draftMime } from '../src/providers.mjs';

const plan = { id: 'plan1', recipient: 'aya@northstar.example', subject: 'Re: Portfolio', body: 'Hello Aya,\n\nHere is my portfolio.', file: { name: 'Portfolio.pdf' } };
const pdf = Buffer.from('%PDF-1.4\nFictional attachment\n%%EOF');
const raw = draftMime(plan, pdf);
function fixture() {
  return { id: 'draft1', message: { id: 'message1', labelIds: ['DRAFT'], payload: { mimeType: 'multipart/mixed', headers: [
    { name: 'To', value: plan.recipient }, { name: 'Subject', value: plan.subject },
    { name: 'Message-ID', value: '<provider-canonicalized@google.example>' }
  ], parts: [
    { mimeType: 'text/plain', body: { data: Buffer.from(plan.body.replaceAll('\n', '\r\n') + '\r\n').toString('base64url') } },
    { mimeType: 'application/pdf', filename: plan.file.name, body: { attachmentId: 'attachment1' } }
  ] } } };
}
function provider(draft, attachment = pdf) {
  const p = new GoogleProvider({});
  p.api = async (service, path) => {
    assert.equal(service, 'gmail');
    if (path === '/drafts/draft1?format=full') return draft;
    assert.equal(path, '/messages/message1/attachments/attachment1');
    return { data: attachment.toString('base64url') };
  };
  return p;
}
test('Gmail verification compares decoded content, including separate attachment retrieval', async () => {
  assert(await provider(fixture()).verifyDraft(plan, { id: 'draft1' }, raw));
});
test('Gmail verification rejects changed attachment bytes, body, subject, recipients and sent mail', async () => {
  assert.equal(await provider(fixture(), Buffer.from('wrong PDF')).verifyDraft(plan, { id: 'draft1' }, raw), false);
  for (const mutate of [
    d => { d.message.payload.parts[0].body.data = Buffer.from('Changed body').toString('base64url'); },
    d => { d.message.payload.headers[1].value = 'Changed subject'; },
    d => { d.message.payload.headers.push({ name: 'Bcc', value: 'unapproved@example.com' }); },
    d => { d.message.labelIds = ['SENT']; }
  ]) {
    const d = fixture(); mutate(d);
    assert.equal(await provider(d).verifyDraft(plan, { id: 'draft1' }, raw), false);
  }
});
