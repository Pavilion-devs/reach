// Deterministic checks supplement model interpretation; this is deliberately not a natural-language parser.
export function checkConstraints(context, plan = null) {
  const text = `${context.message.subject}\n${context.message.body}`;
  const checks = [];
  const durations = [...text.matchAll(/\b(\d+(?:\.\d+)?)\s*[- ]?\s*(minutes?|mins?|hours?|hrs?)\b/gi)].map(m => Number(m[1]) * (/^(hour|hr)/i.test(m[2]) ? 60 : 1));
  if (/\b(?:an?|one|two|three)\s*[- ]?\s*hours?\b/i.test(text)) durations.push(60);
  if (durations.length) checks.push({ rule: 'duration', passed: durations.every(n => n === 30), detail: 'Explicit numeric meeting durations must be 30 minutes.' });
  const dates = [...new Set(text.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [])];
  if (dates.length) {
    const candidates = plan?.slot ? [plan.slot] : context.slots;
    const localDate = s => new Intl.DateTimeFormat('en-CA', { timeZone: context.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(s.start));
    checks.push({ rule: 'explicit_date', passed: dates.length === 1 && candidates.some(s => localDate(s) === dates[0]), detail: 'An explicit ISO date must match the selected local meeting date; multiple dates need clarification.' });
  }
  if (plan?.file && /\b(latest|most recent|newest)\b/i.test(text)) {
    const newest = Math.max(...context.files.map(f => Date.parse(f.modifiedTime)));
    checks.push({ rule: 'latest_file', passed: Date.parse(plan.file.modifiedTime) === newest, detail: 'The request explicitly asks for the latest file.' });
  }
  return checks;
}
