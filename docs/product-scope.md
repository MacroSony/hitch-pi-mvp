# Product scope

## Outcome

One Linux service lets a small statically configured user set operate Pi
coding-agent sessions through private Telegram and WeChat conversations.

For each enrolled person, Hitch provides:

- identity derived from exact authenticated channel metadata;
- one canonical private workspace;
- named Pi sessions with durable context and per-session model selection;
- every provider/model currently registered and authenticated in the
  operator-managed Pi profile, subject to an optional static allowlist;
- pinned operator extensions, extension commands, and IM-compatible extension
  interactions;
- text, image, and ordinary-file input/output;
- bounded queueing, status, cancellation, recovery, and session selection;
- model-facing shell/file tools routed through an OS sandbox extension; and
- useful failure reporting and restart behavior.

This is an attended private MVP, not a public service.

## Supported user experience

Private messages are accepted from configured identities only. Group chats,
channels, shared sessions, and forwarded identity claims are rejected.

| Command | Behavior |
| --- | --- |
| `!new [name]` | Create and select a Pi session in the user's workspace |
| `!sessions` | List the user's sessions with stable short selectors |
| `!switch <id-or-name>` | Select one owned session for this endpoint |
| `!status` | Show session, model, queue, Turn, and sandbox state |
| `!abort` | Cancel the user's active Turn and complete sandbox process tree |
| `!stop` | Stop the session and atomically cancel its active/queued Turns |
| `!recover` | Replace a quarantined session without replaying unknown work |
| `!models [filter]` | List allowed models reported by the current Pi profile |
| `!model <provider>/<model>` | Select an available model for this session |
| `!thinking <level>` | Select a thinking level supported by the model |
| `!commands` | List enabled extension commands |
| `!send <relative-path>` | Snapshot and send a workspace file |

Enabled `/extension-command` messages are passed to Pi. Extension dialogs are
represented as bounded, expiring reply interactions. Text notifications and
status are delivered or coalesced; unsupported terminal-only UI is rejected
clearly.

All other non-command text submits a Turn. If no session exists, Hitch creates
one. Unknown `!` commands are rejected rather than passed to Pi.

At most one Turn runs per user and three wait in a FIFO. Duplicate platform
messages resolve to the original Turn. `!abort` acts on that user's active Turn
even from another configured endpoint. Reusing an idempotency key with
different normalized content is rejected and audited without content.

## Provider and extension definition

Hitch does not implement provider protocols. Pi runs as a trusted controller
using a host-private operator profile and its native provider/auth machinery.
Changes to authentication, provider extensions, or model catalogs are made by
the operator outside chat and published after restart.

Extension support means:

- one mandatory pinned Hitch sandbox/media extension;
- optional pinned operator extensions, globally or per configured user;
- provider registration, tools, commands, events, system-prompt hooks, and RPC
  extension UI supported through Pi's normal extension API; and
- package/version/integrity or source digest recorded at startup.

Operator extensions run with Pi controller authority and can access provider
credentials. They are trusted installed code, not a user sandbox. Workspace
`.pi/extensions`, chat installation, arbitrary Git/npm sources, and unreviewed
user code are excluded from this MVP.

## Media definition

“Full media” means transport and preservation, not semantic processing:

- JPEG, PNG, GIF, and WebP input is passed to Pi as native images;
- ordinary documents are mounted read-only under `/inbox` and named in the
  prompt;
- images and ordinary files use native channel delivery;
- users can publish with `!send` and Pi with `hitch_publish`; and
- all objects have compiled byte, count, name, MIME, image, and quota bounds.

Audio/video may travel as opaque ordinary files where a channel allows it.
Transcription, OCR, conversion, and semantic audio/video input are not MVP
features.

## Fixed product choices

- Linux, Node.js 24, TypeScript, and SQLite.
- Telegram long polling and the existing WeChat iLink client.
- One pinned Pi compatibility version and operator-managed Pi profile.
- All authenticated/registered Pi providers, optionally statically filtered.
- Model and reasoning choice persisted per session.
- Static users, endpoints, workspaces, and extension profiles; restart to
  publish changes.
- Private conversations and one workspace per user.
- Fresh Pi controller and sandbox backend per Turn, with resumable private Pi
  session storage.
- Pi/controller extensions are trusted; model tools and generated code are
  sandboxed.
- No automatic replay of an uncertain agent Turn.

## Explicit non-goals

- Public API/UI, signup, invitations, OIDC, or remote administration.
- Groups, teams, shared sessions, delegated roles, or cross-user context.
- Hitch-authored provider protocols, provider fallback policy, billing, or
  per-user provider credentials.
- Provider login/logout or extension/package installation through IM.
- Untrusted or workspace-local Pi extensions.
- Dynamic workspaces, arbitrary host mounts, schedules, triggers, or unattended
  automation.
- Exactly-once chat delivery, high availability, horizontal scaling, or old
  database migration.

## MVP completion gate

Two users must independently use Telegram and WeChat while acceptance proves:

1. channel identity cannot select another Hitch user;
2. neither user can access another user's sessions, workspace, inbox,
   artifacts, Pi state, cancellation, or delivery;
3. Pi context and model choice survive fresh controller processes;
4. Pi enumerates and selects allowed registered/authenticated providers and at
   least an API-key and OAuth auth family pass live smoke when available;
5. pinned operator extension commands and IM-compatible UI work;
6. no workspace extension loads and every standard Pi filesystem/shell tool or
   direct shell path enters the sandbox with no fail-open host path; any
   operator-extension host tool is explicitly declared and trusted;
7. provider/channel credentials never appear in the sandbox guest, workspace,
   inbox, tool arguments/results, channel output, Hitch database, or logs;
8. cancellation/timeout removes the sandbox process tree and ambiguous Pi
   close quarantines the session;
9. text, image, and ordinary-file input/output work on both channels;
10. restart preserves queued work, never replays an unknown Turn, and keeps
    delivery ownership; and
11. configuration, dependency, extension, auth-profile, and deployment
    documentation match the tested commit.
