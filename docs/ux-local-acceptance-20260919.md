# UX-1 / LOCAL-1 acceptance — 2026-09-19

Initial implementation record, followed by the later attended dogfood
confirmation below. Code acceptance alone does not activate an installation.

## UX-1 (commit be0cfb5)

- One grouped help source; generated help/list/status use real double-newline
  paragraphs. Synthetic tool progress has leading/trailing paragraph boundaries.
  Model final text/code is not globally reformatted.
- Pi `get_session_stats().contextUsage` is sampled through the existing turn
  controller. Schema 7 stores nullable context/window/percentage snapshots tied
  to the Pi session and effective model, with sample time. Status is last-known,
  not live billing totals. Reset/model/profile/fresh/compact paths invalidate
  stale values; advisory RPC failures do not weaken cleanup/durability.
- Phase validation: **231 passed, 18 opt-in skipped**; independent review passed.
  Private read-only backup clone migrated 6 -> 7 successfully.
- Source/transport inspection found real LF was preserved; screenshot motivated
  paragraph formatting but does not prove a particular WeChat renderer defect.
  Actual tablet rendering of the new format remains an attended release check.

## LOCAL-1 (commit accompanying this record)

- Optional, authenticated, bounded Unix socket; static per-caller user/action
  scopes; official SDK stdio adapter with seven tools. Absent config creates no
  listener and reads no control secret.
- Literal notify -> existing outbox; notify/wake schedules -> existing scheduler;
  wake requires explicit owned active pinned session. Legacy fallback preserved.
- Caller/request idempotency, stable schedule IDs plus origin digest, cancellation
  tombstones, explicit queued/skipped/failed/uncertain outcomes and bounded previews.
- Auth/bind completes before app startup. Failed listen does not claim queued
  turns. Historic `--fake-channels` semantics remain unchanged.
- Schema 8 adds local receipts; migrations repair the old missing FIFO index.

### Review and parent corrections

Separate workers implemented backend and transport. A backend-independent review
caught schedule-slot ID collision (two tasks at the same endpoint/minute) and
receipt-crash recovery occurring after mutable endpoint/session checks. Parent
fixed both, added regressions, restored legacy channel test-mode semantics,
added disk guards and past-due one-shot rejection, and verified composition.

A different worker independently reviewed transport/config/MCP/main and returned
PASS. Backend re-review returned PASS. These are bounded code reviews, not a
formal hostile-host security proof. A failed earlier reviewer invocation produced
no evidence and is not counted as a successful review.

### Final deterministic checks

- `npm run check`: formatting, TypeScript, build and tests all pass.
- **282 total: 264 passed, 18 opt-in skipped, 0 failed, 0 cancelled.**
- Separate mandatory sandbox-extension TypeScript check passes; this is not yet
  a new CI gate for every optional extension.
- New tests cover owner/action denial, literal notify idempotency, disk admission,
  cross-user delivery lookup, restart/receipt-crash recovery, changed-user/key
  conflicts, same-minute distinct tasks, explicit pinned session and legacy
  fallback, queue-full outcome, cancellation no-revival, past/invalid dates,
  origin/outcome validation and rate limits.
- Socket tests cover bounded frames/connections/timeouts, auth/errors, private
  modes, direct symlinks, active vs stale socket, and close-during-listen. Main
  subprocess tests cover check-only and listener failure preserving queued turns.
- Official MCP client -> stdio adapter -> authenticated Unix socket -> real
  HitchStore/scheduler test exercises all seven tools, pause/resume/cancel,
  literal template preservation, duplicate retries and cross-user denial.
  Stops at durable outbox; **zero model calls, no real channel sends**.
- Actual-shaped schema-6/7 fixture migration tests pass. A separate private
  SQLite backup taken using a read-only production connection migrated 6 -> 8:

| Existing table | Rows preserved |
| --- | ---: |
| app_meta | 2 |
| users | 1 |
| sessions | 16 |
| channel_endpoints | 3 |
| turns | 167 |
| outbox | 202 |
| artifacts | 36 |
| turn_artifacts | 33 |
| staged_artifacts | 0 |

`quick_check=ok`, no foreign-key violations, FIFO index present, new local receipt
count zero. Only the private clone was migrated and then removed. Live database
remained schema 6.

## Initial acceptance gates and remaining limits

- At the initial code-acceptance checkpoint there was no production
  service/config/caller/credential change, deployment, real notification or
  reminder creation. Existing daemon remained
  on the earlier path-guidance release when last checked.
- Activation requires explicit approval, narrowly scoped caller enrollment and
  attended notification/status/WeChat paragraph tests on each installation.
  The subsequent dogfood result is recorded below; outbox `sent` alone is
  insufficient to establish user-visible reception.
- Full opt-in sandbox acceptance remains outstanding; ordinary suite success is
  not a substitute. Successful main-process signal shutdown with real local
  requests is not yet a dedicated network-free subprocess test.
- 64 schedule cap includes tombstones; any unreadable caller-authorized schedule
  store blocks new creation; see [runbook](local-control.md). Preview truncation,
  total-tombstone cap and multi-store corruption behavior are primarily inspected
  rather than exhaustively property-tested.
- Slot admission remains at-most-once with 30-minute lateness grace, not guaranteed
  punctual or exactly-once delivery. Personal WeChat send-context expiry remains.
- No calendar-provider sync, arbitrary task edits, session/profile creation,
  automatic isolated task-session provisioning, or public API.
- Independent `!send` suffixed-blob bug, compact no-op wording, father onboarding
  generator and broad extension CI are not fixed by this increment.


## Subsequent attended personal-WeChat dogfood (2026-09-19)

After the implementation checkpoint, the operator authorized an immutable
release deployment and a caller restricted to their own Hitch user. A private
stopped backup and rehearsal preceded schema-8 activation; FK/integrity checks
passed. This installation-specific activation is not a default permission grant
for other deployments.

The operator then reloaded their desktop MCP adapter and explicitly reported
that WeChat testing was normal, following the requested help/session/status and
ordinary-chat checks. This confirms the operator's client experience, not a
claim that all IM clients/renderers behave identically.

At the operator's request, the reloaded MCP adapter submitted one literal
notification through the live authenticated local socket to personal WeChat.
The receipt progressed from queued to sent, and the operator explicitly
confirmed receipt ("Received!"). That human confirmation, not the outbox label,
is the evidence of user-visible delivery. The notification did not invoke a
model. No credentials, platform peer IDs or private installation paths are
included in this public record.

This closes personal-WeChat paragraph/command experience and immediate local
notification dogfood for that installation. It does **not** certify scheduled
notify/wake fires, all WeCom/media paths, or the skipped opt-in sandbox suite.
The public-release cleanup only removes a one-off web-search diagnostic file
sink and updates documentation; the running dogfood release was not changed
as part of preparing the public push.
