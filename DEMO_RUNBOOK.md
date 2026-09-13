# Reach demonstration and evidence

## Verified demonstration

On September 13, the finished UI at port 4317 completed the following using Space-key task selections and real Sonnet/Google services:

1. Read the configured fictional request in the Google test account.
2. Select the portfolio PDF and an available time.
3. Ask for a concise reply and review it.
4. Introduce a temporary private calendar conflict using the dedicated verification script.
5. Attempt approval: Reach detects the conflict before any task write.
6. Select “Update only what changed”; choose a replacement time.
7. Review the preserved wording and attachment; approve the updated plan.
8. Verify Drive bytes, private Calendar hold and Gmail draft through readback.
9. Restart the server and reload: the same completed task and receipts remain.

Evidence: `artifacts/live-ui-verification.json`. The temporary conflict was removed. The actual final draft and private hold remain in the test account. No email was sent and no guests were invited.

## What to show judges

Lead with the user benefit: completing a multi-app task through one switch, with control over choices and words. Show the changed-time recovery as the central reliability moment. Explain that the model proposes; the backend validates choices and controls writes; provider readback supplies evidence of completion.

Use the existing live result for review. For repeatable practice without writing to Google, start a separate server:

```
PORT=4318 REACH_PROVIDER=demo node server.mjs
```

Open `http://127.0.0.1:4318/?scenario=calendar-changed#app`. This mode uses fictional providers and template wording; label it practice. The normal scenario is `?scenario=normal#app`.

## Arga evidence and limits

Arga Gmail, Drive and Calendar have each passed separate single-provider tests. The latest Gmail run additionally verified unique-marker draft discovery, attachment/body readback, one matching draft and zero sent messages. The environment was torn down.

The three-twin provisioning attempt was rejected. A simultaneous multi-app Arga execution is unverified and must not be claimed. Existing one-twin evidence is in `artifacts/arga-*-verification.json`; Gmail has the newer recovery-discovery checks.

## Recovery and constraints

The journal records a write attempt before the POST. Known or discovered draft IDs require full content verification. Ambiguous or absent discovery never permits repeating an uncertain draft POST. A verified hold can proceed to explicit resume approval only if the journal contains no draft attempt; fresh context is checked again before using the saved MIME.

Numeric meeting duration, explicit ISO date and latest-file checks supplement model interpretation. Broader natural-language constraints are not comprehensively parsed. User research with people who use switches and a new accessibility audit remain outside this verification.

Backend regression result: 43 tests passed. Recovery screens were inspected using explicitly labelled synthetic UI fixtures. Actual browser completion and restart were tested with the real Google result.
