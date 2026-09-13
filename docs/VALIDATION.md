# Validation summary

Recorded September 13, 2026. This is a sanitized summary of development evidence, not a claim of independent certification. Raw task content, provider resource IDs, run credentials and screenshots remain local.

## Reproducible checks

`npm test` passed all 43 backend tests. They include process exit after a pre-write journal checkpoint, disk write failure, uncertain provider responses, duplicate approval, verified recovery, changed resources and deterministic constraint checks. These use test doubles and do not call Google, Anthropic or Arga.

`npm run check` checks JavaScript syntax. The optional Playwright suite is configured to run only against its isolated practice server; it is distinct from the live browser demonstration below.

## Live model evaluation

Six live Sonnet cases passed: combined portfolio/meeting request, portfolio only, meeting only, unsupported payment, unsupported duration and injected instructions. App actions in these evaluations were simulated. Passing one injection example is not proof of general prompt-injection resistance.

## Finished UI and real Google

Task selections used the Space key in Codex’s browser. The run read the fictional configured request, selected a PDF/time, revised the reply to a concise tone and reached review. A dedicated verification script created a temporary calendar conflict. Reach blocked the stale approval, preserved the reply fragments and attachment, asked for a replacement time, and required fresh approval.

Final execution read the PDF bytes, created an unsent draft and a private hold without guests, and verified all three receipts. The check script confirmed unchanged reply fragments, unchanged attachment ID, changed slot and successful marker-based draft discovery. It removed only its temporary conflict event. The final draft and hold remained for review.

The server was restarted and the same completed task and receipts were visible after reloading the browser. No browser errors were captured for that tab. Recovery and resume-review screens were additionally inspected with clearly labelled synthetic fixtures; that inspection is not a live crash-recovery run.

## Arga

Separate Gmail, Drive and Calendar twin checks passed. The latest Gmail check verified decoded message/attachment content, unique-marker discovery, one matching draft and zero sent messages. Drive returned two PDFs with actual downloadable contents. Calendar returned a private hold without attendees, listed once. Each environment was torn down after verification.

A simultaneous three-twin provisioning attempt was rejected. Full multi-app Arga execution remains unverified. The single-twin results must not be described as one simultaneous workflow.

## Remaining work

Hosted deployment and the two-minute submission video are pending. End-user accessibility testing, broad natural-language constraint coverage, production-scale persistence and comprehensive fault coverage remain outside the evidence above.
