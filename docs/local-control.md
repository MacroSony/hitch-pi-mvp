# Local notifications and scheduling (LOCAL-1)

This is the narrow host-only amendment described in
[UX/notifications plan](ux-notifications-plan.md), not a public administration
API or a multi-agent platform. It is **disabled by default**. Merely upgrading
does not activate a listener, create caller keys, or send a message.

## Architecture and trust

```text
external trusted agent -> stdio MCP -> authenticated Unix socket
                                            |
                              running Hitch service (sole writer)
                              /                         
                  literal notify -> outbox       schedule -> existing wake tick
                                                              /           
                                                literal outbox       queued Pi task
```

Hitch owns user/endpoint resolution, SQLite and schedule files, and the existing
channel send workers. The adapter neither opens the DB nor receives channel
credentials. There is no TCP listener. Workspace sandbox tools do not receive
the socket or its token. Do not mount them into a model sandbox or add the token
to the Pi controller environment allowlist.

This protects supported callers from accidental cross-owner/action mistakes;
it is **not isolation from malicious host programs running under the same uid**.
Such code can read that account's private files and is in the trusted boundary.
The socket has a private 0700 parent, mode 0600 and owner checks. Symlink paths
are refused. Active/unresponsive sockets are not replaced; only a proven-stale
socket is explicitly removed after checking its device/inode identity.

## Enable only with operator approval

After building (`npm ci && npm run build`), add an optional config fragment:

```json
{
  "localControl": {
    "callers": [
      {
        "id": "mika",
        "tokenEnv": "HITCH_CONTROL_MIKA_TOKEN",
        "userIds": ["alice"],
        "actions": [
          "targets.list",
          "notify",
          "delivery.get",
          "schedule.create",
          "schedule.list",
          "schedule.set_enabled",
          "schedule.cancel"
        ]
      }
    ]
  }
}
```

This is a fragment, not a complete service configuration. `alice` must already
be a configured Hitch user with an enabled endpoint. Use fewer actions for a
notify-only caller. Up to eight distinct callers are supported. Permissions
are static startup configuration, not model-editable settings.

Generate a random key (e.g. 32 random bytes encoded as hex), store it outside
workspaces in an owner-private service EnvironmentFile, and provide it via the
configured `tokenEnv`. Do not put the value in JSON, command arguments, chat,
logs, Git, or examples. Startup validates **32–4096 UTF-8 bytes**; it does not
prove statistical entropy. Rotate/revoke via the service environment and
caller configuration, then restart. Disabling a caller does not cancel its
previously accepted schedules: pause/cancel those explicitly before revocation
if they must stop too.

The socket path is fixed at `<dataRoot>/control/hitch.sock`. No custom bind
address is accepted. Check-only mode neither binds nor reads caller secrets.
Normal startup authenticates/binds before starting application pumps; failed
listener startup leaves queued work queued. Signal/error cleanup closes the
listener and stops/drains the app before closing SQLite. `--fake-channels`
retains its historical meaning: **fake model, real channel transports**, not a
network-free test mode.

For a stdio MCP client, use the built entry point directly (avoid npm's banners
on protocol stdout):

```text
command: /absolute/path/to/node
args: [--disable-warning=ExperimentalWarning, /absolute/release/dist/src/local/mcp.js]
```

Inject these into the adapter process from the operator's private credential
loader, without printing their values:

- `HITCH_CONTROL_SOCKET`: the absolute socket path above;
- `HITCH_CONTROL_CALLER`: `mika` in the example;
- `HITCH_CONTROL_TOKEN`: the same key supplied to the service under its
  configured token-env name.

The adapter reads only those three variables. Installing this adapter in a
specific agent's MCP configuration is a separate operator action; a previously
configured but disconnected `hitch` server is not automatically repaired.

## Tools and routing

| MCP tool | Service method | Behavior |
| --- | --- | --- |
| `hitch_targets` | `targets.list` | Allowed users, endpoints and owned sessions |
| `hitch_notify` | `notify` | Literal text to one endpoint; no model |
| `hitch_delivery_status` | `delivery.get` | Existing outbox state, scoped to user |
| `hitch_schedule_create` | `schedule.create` | One-shot, daily or weekly notify/wake |
| `hitch_schedule_list` | `schedule.list` | Caller-owned external schedules, next slot, last outcome |
| `hitch_schedule_set_enabled` | `schedule.set_enabled` | Pause/resume, not edit content/time |
| `hitch_schedule_cancel` | `schedule.cancel` | Permanent cancellation tombstone |

All mutations require a caller-scoped `requestId`. Reuse the **same id and exact
semantic arguments** after a timeout or disconnected response. Reusing the id
with changed arguments/method is `conflict`; a new intended action needs a new
id. Sorted object keys do not matter; array order does. `notify` stores its
outbox row and receipt in one SQLite transaction. Schedule creation uses a
stable caller/request-derived ID plus on-disk origin digest to reconcile a
schedule-file-before-receipt crash without creating a second task. Recovery
precedes mutable endpoint/session validation and does not revive cancellations.
Other file/receipt mutation gaps are idempotent state assignments, not a claim
of a distributed transaction or exactly-once physical delivery.

Specify `channel` (`wechat`, `telegram`, `wecom`) whenever the user has multiple
endpoints. Zero matches are not-found; more than one is rejected. There is no
broadcast, implicit first-endpoint choice, or arbitrary platform-user address.
The selected endpoint is saved on a schedule and ownership/channel/enabled
state is rechecked on dispatch.

Example notify arguments (not automatically executed):

```json
{
  "requestId": "reminder-water-001",
  "userId": "alice",
  "channel": "wechat",
  "text": "Time for a short break."
}
```

A schedule additionally requires `action`, `text`, `timeOfDay` (`HH:MM`), an
explicit IANA `timezone`, and `recurrence`, for example:

```json
{
  "requestId": "morning-briefing-001",
  "userId": "alice",
  "channel": "wechat",
  "action": "wake",
  "sessionId": "<existing-owned-active-session-id>",
  "text": "Read the workspace briefing instructions and produce today's briefing.",
  "timeOfDay": "08:00",
  "timezone": "America/Toronto",
  "recurrence": { "kind": "daily" }
}
```

Other recurrences are `{ "kind": "once", "date": "YYYY-MM-DD" }` (local date,
new past-due one-shots are rejected), or `{ "kind": "weekly", "weekdays":
[1, 3, 5] }` (unique ascending integers, Sunday=0). The existing DST policy is
reused. New creation returns an ISO next-fire time and timezone; later list
results are authoritative about current enable/cancel/outcome state.

For `notify`, text remains literal, including `{{date}}`; omit `sessionId`.
For `wake`, provision a dedicated active task session/profile beforehand and
use its ID. The API does not create sessions, change profiles, clear context,
or enforce that the chosen session differs from a user's interactive one.
The explicit pinned session is strict: a stopped/missing session is rejected
at creation or fails at dispatch, never silently falls back to a chat session.
Legacy chat-created schedules retain their existing fallback behavior.

To change a task's text/time, cancel it and create a new task with a new request
ID. This first version is a reminder list, **not Google/Outlook/phone calendar
synchronization**.

## Bounds and reliability

- 64 KiB request, 1 MiB response, five-second transport deadline and sixteen
  concurrent connections. Timeouts are ambiguous: retry with the same id.
- Text up to 16 KiB UTF-8; request IDs up to 128 bytes; thirty new mutations per
  caller per rolling minute. Literal notifications honor the existing disk
  admission guard. List text previews are 240 Unicode code points, with a
  truncation flag, not unbounded prompt dumps.
- **64 stored schedules per user, including cancelled tombstones and legacy
  schedules.** This prevents unbounded JSON growth. There is no automated
  tombstone retention/compaction or destructive cleanup API in this slice;
  reaching the cap needs an explicit operator retention decision.
- To detect cross-user orphan/conflicting origins after a crash, new creations
  examine stores for all users permitted to that caller. An unreadable store
  makes creation unavailable even if it belongs to another allowed user. This
  is deliberate fail-closed behavior; it is not silently treated as empty.
- Wake ticks use the existing 30-minute lateness grace and **at-most-once slot
  admission**. `recordFire` persists an `uncertain` outcome before dispatch.
  Queue-full/disabled endpoint/etc. records skipped/failed; crash gaps can lose
  a fire. This is not a guaranteed alarm or an automatic retry system.
- Different schedules sharing a user/endpoint/minute have different delivery
  IDs. Repeating the same schedule/slot deduplicates against the original
  ownership and text.
- Creation/notify `queued` means accepted. Outbox `pending`/`sending`/`sent`/
  `failed` describe service/platform progress, never a read receipt. A wake's
  `queued` last outcome means turn admission, not model completion/delivery.
- Personal WeChat may reject proactive messages when its send context expires;
  this endpoint cannot override platform limitations. There is no silent
  fallback to another channel.

## Migration, validation and release gate

UX-1 is a separate commit (`be0cfb5`), introducing schema 7 and advisory
last-completed-turn context snapshots. LOCAL-1 introduces schema 8 with
`local_requests`; upgrades from 6 traverse both. The FIFO index omitted by an
older compact migration is restored. Do not run old schema-6/7 code over the
new DB or restore an old DB/auth snapshot to roll back a code release.

2026-09-19 validation: full format/typecheck/build/deterministic suite passed;
see [acceptance record](ux-local-acceptance-20260919.md) for exact counts and
limits. Official MCP client -> stdio -> real socket/auth -> real store/scheduler
is tested against private fixtures, ending at the outbox with **zero model
calls and no real channel sends**. An owner-private SQLite backup cloned via a
read-only production connection migrated 6 -> 8; old row counts, quick_check,
foreign keys and FIFO index were verified. The live database was not migrated.

Backend and transport received separate independent reviews, followed by
parent integration verification. Production activation, caller enrollment,
attended IM delivery/formatting tests, and full opt-in sandbox acceptance remain
separate gates. No live caller/config/credential/service changes are implied by
this implementation record.
