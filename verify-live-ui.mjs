// Controlled calendar-conflict fixture for the browser verification. Never sends mail.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { GoogleProvider } from './src/providers.mjs';
const config = {};
for (const line of (await readFile(new URL('.env', import.meta.url), 'utf8')).split('\n')) { const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if (m) config[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2'); }
const p = new GoogleProvider(config);
const path = new URL('artifacts/live-ui-verification.json', import.meta.url);
const command = process.argv[2];
if (command === 'conflict') {
  try { await readFile(path); throw new Error('A verification journal already exists; inspect it before creating another conflict.'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const files = await readdir(new URL('.tasks-4317/', import.meta.url));
  const states = await Promise.all(files.filter(f => f.endsWith('.json')).map(async f => ({storageFilename:f, ...(JSON.parse(await readFile(new URL('.tasks-4317/' + f, import.meta.url), 'utf8'))).snapshot})));
  const state = states.filter(s => s.stage === 'review').sort((a,b) => b.plan.expires-a.plan.expires)[0];
  if (!state?.plan?.slot) throw new Error('No reviewed task found');
  const hold = { id: randomBytes(16).toString('hex'), slot:state.plan.slot, holdTitle:'Reach temporary conflict test' };
  const proof = { status:'conflict_pending', taskFile:state.storageFilename, originalPlan:state.plan, conflict:hold, startedAt:new Date().toISOString() };
  await writeFile(path, JSON.stringify(proof,null,2), {mode:0o600});
  await p.createHold(hold); proof.conflictVerified = await p.verifyHold(hold,{id:hold.id}); proof.status='conflict_ready'; await writeFile(path,JSON.stringify(proof,null,2)); console.log('Temporary private conflict created and verified.');
} else if (command === 'finish') {
  const proof = JSON.parse(await readFile(path,'utf8'));
  const {snapshot:s} = JSON.parse(await readFile(new URL('.tasks-4317/'+proof.taskFile,import.meta.url),'utf8'));
  proof.finalStage=s.stage; proof.receipts=s.receipts; proof.trace=s.trace;
  proof.wordingPreserved=JSON.stringify(s.plan.fragments)===JSON.stringify(proof.originalPlan.fragments);
  proof.attachmentPreserved=s.plan.file.id===proof.originalPlan.file.id;
  proof.timeReplaced=s.plan.slot.id!==proof.originalPlan.slot.id;
  proof.markerDiscovery=(await p.findDraft(s.plan))?.id===s.actions.draft?.id;
  // Delete only this script's temporary test event, leaving the actual result intact.
  const response=await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.REACH_CALENDAR_ID||'primary')}/events/${proof.conflict.id}?sendUpdates=none`,{method:'DELETE',headers:{Authorization:`Bearer ${await p.token()}`}});
  proof.conflictCleanedUp=response.ok||response.status===410;
  proof.status=s.stage==='complete'&&proof.wordingPreserved&&proof.attachmentPreserved&&proof.timeReplaced&&proof.markerDiscovery&&proof.conflictCleanedUp?'passed':'needs_attention';
  await writeFile(path,JSON.stringify(proof,null,2)); console.log(JSON.stringify({status:proof.status,finalStage:proof.finalStage,wordingPreserved:proof.wordingPreserved,attachmentPreserved:proof.attachmentPreserved,timeReplaced:proof.timeReplaced,markerDiscovery:proof.markerDiscovery,conflictCleanedUp:proof.conflictCleanedUp}));
}
