# Product scope

Status: trusted-personal MVP baseline

## Outcome

One Linux service lets a small statically configured, personally trusted user
set operate Pi coding-agent sessions through private Telegram and WeChat
conversations. The purpose is to test whether the interaction model is useful,
not to launch a public or adversarial multi-tenant service.

For each enrolled person, Hitch provides:

- identity derived from exact authenticated channel metadata;
- one canonical private workspace;
- named Pi sessions with durable context and per-session model selection;
- every provider/model currently registered and authenticated in the
  operator-managed Pi profile, subject to an optional static allowlist;
- the mandatory Hitch sandbox extension and, later, explicitly selected
  operator extensions whose features are needed for dogfooding;
- text, image, and ordinary-file input/output;
- bounded queueing, status, cancellation, recovery, and session selection;
- model-facing shell/file tools routed through an OS sandbox extension; and
- useful failure reporting and restart behavior.

This is an attended private MVP, not a public service. Human users are trusted;
model-generated commands, workspace content, inbound files, and channel input
are not trusted to execute on the host.

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
| `!send <relative-path>` | Snapshot and send a workspace file |

Optional extension commands and RPC UI projection are post-MVP features when a
specific operator extension is selected.

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

Initial extension support means:

- one mandatory pinned Hitch sandbox/media extension;
- no optional operator extension is required for the first usable build;
- optional pinned operator extensions may be added after the core concept works
  and their concrete host authority is understood;
- package/version/integrity or source digest recorded at startup.

The proposed Forge/ComfyUI subsets are recorded in
`docs/operator-extension-compatibility.md`, but both are deferred because their
released packages do not implement those service modes. Successful Pi loading
alone is not a reason to expose a model-controlled host tool.

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
- Pi/controller extensions are trusted; standard file/shell tools and generated
  code are sandboxed, while declared host-authority tools stay inside their
  certified policy.
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

Deterministic tests use two fake users. Attended live acceptance may use the
small set of personal accounts available to the operator. Completion proves:

1. exact private-channel tuples select only their configured Hitch user;
2. sessions, workspaces, files, cancellation, and delivery stay owner-scoped;
3. Pi context and model choice survive fresh controller processes;
4. at least one operator-authenticated Pi provider completes useful Turns;
5. no workspace extension loads and every standard Pi filesystem/shell tool or
   direct shell path enters Bubblewrap with no host fallback;
6. provider/channel credentials do not enter the tool sandbox, workspace,
   database, logs, or chat output;
7. cancellation removes the sandbox process tree, while ambiguous work is
   quarantined rather than replayed;
8. text works over Telegram and WeChat, and common image/file paths work for
   the channels supported by the configured accounts;
9. restart preserves admitted work and session ownership; and
10. a new operator can install, configure, authenticate, start, and recover the
    attended service using the checked-in guide.

Optional operator extensions, multiple live authentication families, hard
per-workspace quotas, and exhaustive hostile-user testing are not completion
requirements for this MVP.
