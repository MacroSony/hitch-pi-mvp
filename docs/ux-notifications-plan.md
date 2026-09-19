# UX and local notifications — operator-approved increment

2026-09-19: operator approved the UX/context/local-notification proposal. This
supersedes the historical no-scheduling/no-local-control scope only for the
small feature set below. No public API, generic agent platform, or replacement
provider/channel implementation is authorized by this plan.

## Phase UX-1

- Render generated help/list/status replies as paragraphs so clients that fold
  single newlines retain boundaries. Keep model final text/code untouched.
- Put synthetic tool progress on separate paragraphs, not glued to text deltas.
- One help source, grouped commands and brief examples.
- Read Pi contextUsage from the existing per-turn controller, persist a small
  last-known snapshot, show tokens/window/percentage with freshness in !status.
  Cumulative billed usage is not context occupancy. Unknown post-compaction
  values stay unknown; reset/model-switch paths must not show stale snapshots.
- Usage capture is best-effort and does not weaken controller close/transcript
  durability or sandbox cleanup requirements. No controller launch for !status.
- Validate schema migration, fake RPC paths, generated formatting and unchanged
  final text. Review independently and commit this phase before the next.

## Phase LOCAL-1

- Owner-private local service endpoint, thin stdio MCP adapter. No TCP/public
  listener, channel credentials, arbitrary SQL, or raw schedules-file access.
- Static per-caller user/action allowlist. Resolve endpoints against ownership;
  never broadcast by default. Tools list allowed targets, enqueue notification,
  and manage one-time/daily/weekly schedules with IANA timezone.
- Two actions: notify (literal text, no model) and wake (normal queued Hitch
  model task, explicit owned session). No clearing interactive session context.
- Reuse outbox and scheduler; one service writer. Bound requests and repeated
  execution. Durable idempotency for retries, identifiers/status in responses.
- Return queued/platform delivery state, never claim read receipts. Explicit
  failure/skipped outcomes; document existing at-most-once wake limitations and
  WeChat send-context expiration. Calendar sync is out of scope.
- Deterministic ownership, duplicate, restart, queue-full and schedule tests;
  authenticated live messages remain attended checks. Independent review before
  commit. No production config/user/credential changes without operator approval.

## Deployment

Keep phases separate. Before any deployment recheck git/release and active
turns; preserve backups without restoring old auth/data; verify actual PID cwd,
new running log and DB integrity. An additive schema migration is not a safe
reason to roll old application code back over the new database. Production
activation of the local endpoint/caller list is a distinct explicit operation.
