# Vercel deployment

Production: https://reach-lilac-mu.vercel.app

## Two workspaces

- The public landing page and workspace run the complete practice workflow with fictional data and no model calls.
- `/live` requires HTTP Basic authentication: username `owner`, password configured as `REACH_OWNER_KEY`. After authentication, the same UI uses the server-configured Google test account and Anthropic model. Never put this key in a URL or publish it with the demo link.
- Visitors cannot invoke the owner's live provider merely by changing a request parameter. The server determines the provider from authentication. Separate Secure, HttpOnly, SameSite cookies identify practice and live tasks.

The current deployment is an owner-operated test workspace, not a multi-user OAuth service. It reuses the owner's existing Google refresh grant. Hosted OAuth routes are disabled; reconnect or configure credentials through the local setup and update production environment variables if the grant expires. The owner key is stored separately in an ignored local file and in production environment variables.

## Runtime and persistence

Vercel uses Node.js 24 and the API handler at `api/index.mjs`; the local loopback server remains available through `npm start`. Static output comes from `public/`. The Vercel configuration routes API requests and `/live` to the hosted handler.

Private Vercel Blob stores task snapshots and action journals. Reads bypass the CDN cache and request identity encoding so the returned strong ETag can be used for conditional writes. A request claims a task for 330 seconds, longer than the configured 300-second function duration. Every journal write uses the most recent ETag. A stale function cannot overwrite a newer claim. If execution is interrupted, the task can be checked after the claim expires; uncertain writes are never blindly retried.

Sessions expire after 24 hours. This currently limits access, not physical storage retention: expired blobs are not automatically deleted. Add retention maintenance and public abuse/rate controls before sustained public usage. The deployment does not claim production-scale multi-user operation.

## Reproduce deployment

1. Import the GitHub repository into your Vercel account with the repository root as the project root. The checked-in `vercel.json` supplies build/output settings.
2. Create a **private** Blob store and connect it to the production environment. Provide the Blob SDK credentials through the project connection.
3. To enable the owner-only live workspace, set these **production-only** environment variables:
   - `REACH_OWNER_KEY`: a randomly generated secret of at least 32 characters.
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`.
   - `REACH_MESSAGE_ID`, `REACH_DRIVE_FOLDER_ID`, `REACH_CALENDAR_ID`, `REACH_TIMEZONE`, `REACH_SLOT_STARTS`.
   - `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, and `ANTHROPIC_WORKSPACE_ID` if needed.
4. Deploy to production. With no live credentials, the owner cannot enter a live Google workspace. Never expose Google/Anthropic secrets as frontend variables.
5. Verify public practice completion, persistence after reload, rejection of unauthenticated `/live`, and owner-authorized live execution against dedicated test resources.

The current project is linked to GitHub. Commits may trigger deployments; keep credentials restricted to production rather than sharing them with preview deployments. Preview practice execution requires its own Blob connection if enabled.

## Verified on September 13, 2026

- 48 backend tests passed, including hosted persistence, private consistent Blob operations and authentication boundaries.
- Actual private Blob concurrent-update test: one writer succeeded and the stale writer was rejected, including payloads larger than the compression threshold.
- Public landing and full practice flow verified in Codex browser; completed receipts survived reload.
- Protected production API completed real Sonnet planning, PDF selection, slot selection and approved Google execution. Three provider receipts verified; nothing was sent and no guests were invited.
- Production session readback retained the same receipts. An unauthenticated request with the live session cookie could not access the live task.

The production API verification is distinct from the earlier local Space-key browser demonstration. Raw hosted proof and owner credentials are ignored by Git.
