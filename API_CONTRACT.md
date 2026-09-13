# Reach frontend/backend contract — v1

Updated 13 September 2026. This describes the implemented API, not a proposed redesign.

## Local runtime

The frontend lives in `public/`; the engine and provider integrations live in `src/` and `server.mjs`. The default local port is 4317. Browser tests use an isolated practice server on port 4318. Register the matching callback when changing OAuth origins.

The server serves `/`, `/app.js`, `/style.css` and `/favicon.svg`. Additional assets/routes need backend routing support. CSP permits local scripts, styles and images and blocks inline JavaScript and third-party resources by default.

## Requests

Use same-origin fetch. The server uses an HttpOnly `reach_session` cookie; never access or recreate it in frontend code. All POST requests need `Content-Type: application/json` and `X-Reach-Client: 1`.

| Endpoint | Request | Result |
| --- | --- | --- |
| `GET /api/config` | None | Configuration below; never credentials |
| `GET /api/session` | Session cookie | Current view, or `null` when none exists |
| `POST /api/start` | `{ "scenario": "normal" }` | New view; sets session cookie; may take up to 45 seconds for AI, plus provider reads |
| `POST /api/choose` | `{ "choice": "<returned choice.id>", "revision": <view.revision> }` | Updated view |
| `GET /auth/google` | Browser navigation | Google OAuth redirect |

`scenario` affects practice mode only: `normal`, `calendar-changed`, `file-changed`, `gmail-fails`, `readback-fails`. Google and Arga mode use their configured actual resources. Starting another live task is explicit, never an automatic retry of a previous task.

HTTP failures return `{ "error": "human-readable explanation", "code": "machine code" }`; missing sessions use HTTP 409. A valid HTTP 200 view may itself represent an error/recovery stage. Do not equate HTTP 200 with task completion. After an uncertain browser POST response, fetch `/api/session`; do not resend the write selection automatically.

While a request is pending, stop the scanner timer, disable task choices and block repeated activation. Restore navigation when the response arrives. Reading the screen must not require rapid input. On tab visibility loss, pause scanning.

## Configuration

```json
{
  "mode": "google",
  "googleConfigured": true,
  "connected": true,
  "planner": "anthropic",
  "aiConfigured": true,
  "model": "claude-sonnet-5"
}
```

`mode`: `demo | google | arga`. `planner`: `template-practice | anthropic`. Demo makes no model calls. `connected` indicates locally available Google credentials, not proof that a provider request will succeed. `aiConfigured` means a key exists; account access is verified when the model is called. Model/auth secrets never reach the frontend.

## Session view

```ts
interface View {
  mode: 'demo' | 'google' | 'arga';
  planner: 'template-practice' | 'anthropic';
  stage: Stage;
  revision: number; // send back exactly; never increment it yourself
  context: {
    timezone: string;
    message: { id: string; revision?: string; name: string; email: string;
      subject: string; body: string; received: string; snippetOnly?: boolean; app: string };
    files: Array<{ id: string; name: string; size: number; modifiedTime?: string;
      revision?: string; md5Checksum?: string; description: string; app: string }>;
    slots: Array<{ id: string; start: string; end: string; app: string }>;
  };
  analysis: null | {
    summary: string;
    task_type: 'portfolio_and_meeting' | 'portfolio' | 'meeting' | 'unsupported';
    evidence: string[]; // exact quotes checked against the request
    recommended_file_id: string | null;
    recommended_slot_id: string | null;
    rationale: string;
    metadata?: ModelMetadata;
  };
  plan: Plan | null;
  choices: Array<{ id: string; title: string; description: string; icon: string }>;
  receipts: Receipt[];
  trace: Array<{ at: string; event: string; [key: string]: unknown }>;
  error: string | null;
}
```

Resources are already filtered by the backend. A suggestion does not select or approve anything. Render `choices` in supplied order, using their actual labels/IDs. Do not create frontend-only task actions, infer execution from a button label, fabricate empty slots, or automatically select the model recommendation. Local controls (scanner pause/speed/voice) remain frontend-owned and must be reachable using the switch.

## Stages

| Stage | UI meaning and required behaviour |
| --- | --- |
| `loading` | Local loading state; no task actions |
| `intent` | Original request, AI understanding, evidence/rationale and returned intent choices |
| `source` | Full original request and returned back choice |
| `file` | Eligible PDF choices; may be empty |
| `slot` | Available 30-minute choices; may be empty |
| `review` | Show exact recipient, subject, full body, optional file and optional private hold before approval |
| `revise` | Show existing wording and returned concise/warm/formal revision choices; revision does not write to apps |
| `unsupported` | Show analysis and limitation; allow reading the source or stopping, never execution |
| `planner_error` | Show error; only returned retry/stop choices; no template fallback labelled as AI |
| `verification_error` | Pre-write provider refresh failed; plan preserved; returned recheck/change/cancel choices; no write attempted |
| `blocked` | Context changed or review expired; show reason; returned refresh/cancel choices; previous approval is invalid |
| `complete` | Verified outcome; show actual receipts; draft is unsent, hold has no guests |
| `partial` | A write may have succeeded or could not be verified; show receipts and error prominently; no blind retry |
| `cancelled` | Task stopped before app writes |

Portfolio-only tasks skip `slot`. Meeting-only tasks skip `file`. Do not assume every task has four steps or that a file implies a slot. Back and cancellation come from the returned choices. Source/back from an unsupported task stays unsupported.

## Plan and receipts

```ts
interface ModelMetadata {
  provider?: 'anthropic'; model: string; requestId?: string;
  elapsedMs?: number; inputTokens?: number; outputTokens?: number; tone?: string;
}
interface Plan {
  id: string;
  recipient: string;
  subject: string;
  decline: boolean;
  body: string;
  file: View['context']['files'][number] | null;
  slot: View['context']['slots'][number] | null;
  holdTitle: string;
  timezone: string;
  reviewHash: string;
  expires: number; // epoch milliseconds; backend enforces it
  ai?: ModelMetadata;
}
interface Receipt {
  app: 'Drive' | 'Calendar' | 'Gmail';
  action: string;
  id: string;
  verified: boolean;
  sha256?: string;
}
```

`plan` is exposed in `review`, `revise`, `verification_error`, `blocked`, `recovery`, `complete`, and `partial`, and can remain present during `file`/`slot` repair choices. Display all user-relevant fields without abbreviating away recipient/body/attachment/time. Treat each receipt independently: an ID alone is not verification. Practice receipts must be labelled simulated. Never claim that a draft was sent or that a guest accepted a meeting.

The model writes acknowledgement/closing text; the engine inserts attachment and meeting facts from selected resources. Tone changes create a new plan ID/review revision. The model cannot approve or execute. Source and model text must be escaped, not inserted as trusted HTML.

## Runtime and limitations

- Google tasks now persist in a private, per-port `.tasks-PORT/` directory. With the same browser session cookie, port and configured connection, `/api/session` restores the latest task after restart. Interrupted executions enter `recovery`; this permits reconciliation, followed by explicit approval to finish a never-attempted draft when the existing hold and fresh context verify. Demo app state is still in memory; Arga tasks cannot resume across runs. Saved evaluation reports document test runs only.
- No SSE or WebSocket endpoint exists. Use the pending request state and the returned view; do not invent streamed progress.
- There is no generic chat/custom-text endpoint yet. Tone presets are supported; unrestricted text input needs a separately agreed API change.
- All local providers/model IDs remain server-side choices. Do not add secret inputs to the product UI.

## Current evidence

- 30 local backend tests passed.
- Six live Sonnet evaluation cases passed (`artifacts/anthropic-evaluation.json`). These use fictional contexts and simulated provider actions.
- Live Sonnet → Google execution with a wording revision completed and all three provider receipts verified (`artifacts/anthropic-google-verification.json`).
- Space-only browser navigation reached and revised a real AI review. Its first execution was stopped before writes by a temporary provider-read error. The corrected backend then completed a separately journaled live run. Do not describe that as an uninterrupted successful Space-only live run until it is repeated with the final integrated UI.

## Ready-to-render sample states

`fixtures/ui-states.json` contains 18 clearly labelled synthetic views generated from the actual engine, including revision, partial failure, unsupported tasks, verification recovery and single-purpose reviews. These are for UI development, not proof of real execution. Regenerate with `node generate-ui-fixtures.mjs`.

The latest isolated API on port 4387 returned a real Sonnet interpretation of the configured Google request through `POST /api/start` (HTTP 200, no writes). Evidence: `artifacts/anthropic-api-smoke.json`.


## Backend recovery additions

The UI now renders recovery and resume review. Render returned choices as usual, including these new choices/states:

- `blocked` offers `repair` to preserve wording and unaffected selections, or `refresh` to start planning again. `changes` lists `review_expired`, `request_changed`, `file_changed`, or `slot_unavailable`. A changed request is re-read and analyzed. A replaced file or slot leads to a new review and requires explicit approval.
- `recovery` offers `reconcile`, which only reads apps. It verifies the deterministic calendar event ID and any recorded Gmail draft ID against the saved plan and MIME contents. Show receipts and the error prominently. If all required actions verify, the stage becomes `complete`.
- `actions` maps `hold`/`draft` to `{state, id?}`. States are `started`, `confirmed`, `verified`, or `uncertain`. `started` is persisted before a write; it does not mean the provider received the request. Only verified readback supports a success claim.

A lost Gmail response can be reconciled by a unique X-Reach-Plan-ID marker using bounded draft discovery, followed by full content verification. Missing, ambiguous or incomplete discovery never authorizes another draft POST. A verified hold with no draft attempt recorded enters `resume_review`; `resume` rechecks the hold, source, selected file and availability (excluding only Reach’s own identified hold), then creates only the never-attempted draft. The original saved MIME is used. Any changed context stops continuation.

Journals include private task content and MIME attachment bytes, but exclude provider objects and credentials. Files use mode 0600 and directories 0700; writes are synced and atomically renamed. They are local plaintext, retained until manually removed, and ignored by Git. Keep the same port to recover a Google session. The session cookie currently lasts for the browser session; no task-list UI or cookie-loss recovery is implemented.

Validation: `tests/recovery.test.mjs` covers disk failure, an actual abrupt child-process exit, lost responses, read-only reconciliation, connection binding, and targeted repair. No new live Google writes were needed for these tests.


## Integrated verification — September 13

The finished UI completed a live Sonnet + Google flow using Space-key selections: open request, select PDF, select time, revise tone, detect a deliberately introduced calendar conflict, preserve wording/PDF, choose a replacement time, approve, and display three verified receipts. See `artifacts/live-ui-verification.json`. The temporary conflict event is removed by the verification script; the final draft and private hold remain available for review.

`constraints` exposes deterministic checks for numeric meeting durations, explicit ISO dates, and latest-file selection. These supplement the model; they are not a complete parser of natural-language conditions. Multiple ISO dates fail closed. Unsupported constraint screens cannot return to executable intent through source/back navigation.

Arga Gmail has additionally verified marker discovery, decoded contents/PDF readback, exactly one matching draft and zero sent mail. A simultaneous three-twin provisioning attempt was rejected; the single-twin run was torn down after testing. Do not present separate service runs as a simultaneous multi-app Arga execution.

Raw `artifacts/` reports referenced above remain local and are excluded from Git. See [docs/VALIDATION.md](docs/VALIDATION.md) for the public validation summary.
