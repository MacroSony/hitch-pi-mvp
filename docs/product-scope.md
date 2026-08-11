# Product scope

## Outcome

One Linux service lets a small set of statically configured people operate Pi
coding-agent sessions through private Telegram and WeChat conversations.

For each enrolled person, Hitch must provide:

- a stable Hitch identity derived from trusted channel metadata;
- one configured, canonical workspace that no other user can mount;
- named Pi sessions with durable conversation continuity;
- text, image, and ordinary-file input;
- text, image, and ordinary-file output;
- bounded queueing, status, cancellation, and session selection;
- a fresh Bubblewrap process for every Turn;
- shell and file tools constrained by the sandbox rather than by prompt rules;
- provider access through a host broker without exposing provider credentials;
- useful failure reporting and restart behavior.

The target is an attended private MVP, not a public service.

## Supported user experience

Private messages are accepted from configured identities only. Group chats,
channels, shared sessions, and forwarded identity claims are rejected.

Commands:

| Command | Behavior |
| --- | --- |
| `!new [name]` | Create and select a Pi session in the user's fixed workspace |
| `!sessions` | List the user's sessions with stable short selectors |
| `!switch <id-or-name>` | Select one owned session for this private endpoint |
| `!status` | Show selected session, queue position, and active Turn state |
| `!abort` | Cancel the active Turn and kill its complete sandbox process tree |
| `!stop` | Atomically stop the selected session and cancel its active and queued Turns |
| `!recover` | Replace a quarantined session with a fresh selected Pi session; never replay its unknown Turn or reuse its ambiguous transcript |
| `!send <relative-path>` | Snapshot and send a workspace file explicitly |

All other non-command text submits a Turn to the selected session. If no
session exists, Hitch creates one automatically. Unknown `!` commands are
rejected rather than forwarded to Pi.

At most one Turn runs per user. Up to three additional Turns may wait in a
per-user FIFO. A duplicated channel message resolves to the original Turn and
never starts a second agent execution. `!abort` operates on the authenticated
user's active Turn even when it was submitted from another configured endpoint.
Submitting the same platform idempotency key with different normalized content
is rejected as a conflict and audited without the content.

## Media definition

"Full media" for this MVP means transport and preservation, not media
understanding:

- inbound JPEG, PNG, GIF, and WebP images are passed to Pi as native images;
- inbound ordinary documents are mounted read-only under `/inbox` and
  referenced in the prompt;
- outbound images are sent with the channel's native image operation;
- outbound ordinary files are sent with the channel's native document/file
  operation;
- the user can publish a workspace-relative file with `!send`;
- Pi receives a reviewed `hitch_publish` tool for explicit artifact delivery;
- every inbound and outbound object has byte, count, filename, and MIME bounds.

Compiled ceilings and retention are fixed in `docs/architecture.md`; operators
may lower them but cannot silently raise them through configuration.

Audio and video may travel as ordinary files when the channel permits it.
Transcription, OCR, image conversion, video processing, and semantic audio or
video input are not MVP features.

## Fixed product choices

- Linux only.
- Node.js 24 and TypeScript.
- SQLite in one configured private data directory.
- Telegram long polling and the existing WeChat iLink client.
- One Pi version compatibility range selected and tested by the repository.
- Exact runtime and provider inputs pinned by `docs/phase-0-inputs.md`.
- One operator-selected provider, model, and reasoning setting at a time.
- Static YAML user/channel/workspace configuration; changes require restart.
- Private conversations only.
- One workspace per user.
- Fresh sandbox process per Turn with private resumable Pi session storage.
- Agent networking denied except for the local broker adapter.
- No automatic retry after a provider request may have started.

## Explicit non-goals

- Public Internet API, browser UI, mTLS client CLI, OIDC, signup, invitations,
  or remote administration.
- Groups, teams, session sharing, delegated roles, or cross-user context.
- Generic agent drivers, multiple providers, model discovery, model switching,
  provider fallback, or arbitrary user provider configuration.
- Dynamic workspaces, arbitrary host mounts, user extensions, packages, MCP
  servers, schedules, triggers, or unattended work.
- Interactive approvals. The reviewed sandbox policy is the approval boundary.
- Exactly-once chat delivery. Delivery is retryable and may duplicate after an
  ambiguous platform response; agent execution must not duplicate.
- High availability, horizontal scaling, billing, or configurable quota UI.
- Migration of the original Hitch database.

## MVP completion gate

The MVP is complete when two users can independently use Telegram and WeChat
against one service and the acceptance suite proves:

1. channel identity cannot select a different Hitch user;
2. neither user can list, select, prompt, cancel, mount, read, mutate, publish,
   or receive the other user's sessions, workspace, inbox, artifacts, or Pi
   state;
3. Pi retains conversation context across fresh sandbox processes for the same
   session;
4. shell and file tools work inside the workspace while host paths, other user
   paths, Hitch state, and external networking remain inaccessible;
5. no provider credential appears in the worker environment, filesystem,
   arguments, RPC frames, tool results, or logs;
6. one scoped broker token authorizes only its Turn and fixed provider/model,
   and an uncertain request is not replayed automatically;
7. cancellation and timeout remove the complete worker process tree;
8. text, image, and ordinary-file input and output work on both channels;
9. service restart preserves sessions and queued Turns, marks interrupted work
   `unknown`, quarantines its session until explicit replacement, and does not
   rerun it; and
10. configuration, dependency, and operator documentation matches the tested
    deployment.
