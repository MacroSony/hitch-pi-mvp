# Manual compaction RPC fix — 2026-09-19

## Observed failure

The attended `!compact` turn ended `unknown`, quarantining its session. The old runtime retained only `Pi rejected an RPC command`; the exact Pi rejection reason cannot be recovered from that log. The saved transcript still exists and contained no compaction entry at inspection. It was not modified or unquarantined by this repair.

Two concrete defects were established independently of the lost rejection detail:

- Pi 0.85.1 returns successful compaction metadata in `response.data`; Hitch read the response envelope.
- A clean compact rejection, including Pi's expected empty/already-compacted cases, followed the generic unknown-turn quarantine path.

## Fix

Unwrap and validate successful compact metadata. Require clean controller exit and transcript fsync before reusing a session after success or a recognized compact RPC rejection. Preserve an unknown rejection as a bounded generic error, never echo the raw provider body. Classification of known no-ops uses exact upstream strings; provider summary failures use anchored `Summarization failed` / `Turn prefix summarization failed` prefixes.

Timeout/cancellation requires an acknowledged abort, clean exit, and transcript fsync. Forced close, missing previously durable transcript, malformed metadata, and unsuccessful abort remain fail-closed. A new session with no saved conversation reports that there is nothing to compact without starting a controller.

The fake CLI injection option is accepted only under `NODE_ENV=test` and is not wired through service configuration.

## Verification

- Parent ran `npm run typecheck` and `npm test`: **218 passed, 18 opt-in skipped** (236 total).
- `test/compact-runtime.test.ts`: actual NativePiRuntime/PiRpcProcess path with disposable fake JSONL CLI; success envelope, clean no-op, bounded rejection, malformed/crashed/failed-close, missing vs new history, abort/timeout, and unknown embedded-error classification.
- `test/pi-compact-protocol.test.ts`: installed pinned Pi 0.85.1 CLI with disposable profile and operator fixture hook; actual response.data, append of compaction JSONL entry, get_state after success/no-op, empty history, and cancellation. No real provider credentials or external model request; **not** a sandbox or live-provider acceptance claim.
- Independent subagent review: initial provider-failure-prefix finding corrected and retested; follow-up **PASS**. Parent added mandatory abort acknowledgment and checked upstream abort/idle behavior.
- Build assets and security controls were not weakened. Existing opt-in sandbox-suite issues and the previously known `!send` extension-path regression are separate outstanding work.

## Deployment/acceptance boundary

This change does not migrate the database (schema remains v6), restore credentials, replay an unknown turn, reset user history, or automatically clear quarantine. Production release health and attended provider/channel acceptance must be recorded separately. Normal `!recover` replaces rather than resumes an isolated session; preserve the old transcript and tell the user that context is not carried forward automatically.
