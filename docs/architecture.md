# Architecture

## Design rule

Hitch owns IM identity, sessions, scheduling, media, and delivery. Pi owns agent
behavior, providers, models, and extensions. The mandatory Hitch extension
routes untrusted tool execution to the sandbox backend.

```text
Telegram long poll              WeChat iLink
        |                            |
        +------ channel ingress -----+
                       |
          trusted channel identity
                       |
        commands / sessions / SQLite / blobs
                       |
                per-user FIFO
                       |
              Turn supervisor
                       |
        trusted Pi RPC controller
        native ModelRuntime + auth
        allowlisted operator extensions
        mandatory hitch-sandbox extension
                       |
             sandbox backend
        /workspace rw  /inbox ro
        bounded /tmp   no credentials
                       |
             model-facing tools

Terminal result -> durable outbox -> originating endpoint
Published file  -> immutable blob  -> originating endpoint
```

The trust decision and alternatives are recorded in
`docs/runtime-extension-architecture.md`.

## Module boundaries

```text
src/
  config/       strict startup configuration and secret references
  db/           schema, transactions, and narrow state operations
  channels/     Telegram, WeChat, and shared transport interface
  app/          identity, commands, session routing, Turn admission
  pi/           RPC lifecycle, native model/command/UI projection
  extensions/   manifests, trust profiles, and explicit loading
  sandbox/      extension protocol and selected backend adapter
  media/        private blobs, inbox, publication snapshots
  delivery/     durable outbox and channel attempts
  main.ts       composition, health, and shutdown
packages/
  hitch-sandbox-extension/  mandatory pinned Pi extension
```

There is no generic agent interface, provider proxy, authorization graph,
event bus, plugin marketplace, or transport-neutral remote protocol.

## Trusted identity and routing

Configuration maps exact channel tuples to one Hitch user:

```yaml
users:
  alice:
    workspace: /srv/hitch/workspaces/alice
    extensions: [review-loop]
    telegram:
      bot_account: primary
      user_id: "123"
      private_chat_id: "123"
    wechat:
      account: primary
      user_id: wxid_alice
```

Accepted evidence is:

- Telegram: configured bot account, `chat.type == "private"`, exact `chat.id`,
  exact `from.id`, and stable update/message id.
- WeChat: configured account, exact `from_user_id`, absent/empty `group_id`,
  and stable message id. Send-context tokens bind to the same account/peer.

Text, captions, callbacks, filenames, forwards, and extension payloads never
select identity. Missing, group-scoped, contradictory, or ambiguous updates
are denied and audited without content. Old Hitch adapters are transport
references only; their identity/media assumptions must be adapted.

Each endpoint stores its selected session. Every lookup and mutation includes
the authenticated `user_id` in the same database operation.

## Minimal persistence

| Table | Purpose |
| --- | --- |
| `users` | Published users, workspace identity, enabled state |
| `channel_endpoints` | Exact private tuple and selected session |
| `extension_profiles` | Immutable allowed extension manifest digest |
| `sessions` | Owner, Pi identity, selected model/thinking, lifecycle |
| `turns` | Admission, FIFO ordinal, state, result, idempotency |
| `artifacts` | Owner-namespaced immutable inbound/outbound objects |
| `turn_artifacts` | Turn, direction, role, display metadata |
| `interactions` | Expiring extension UI request/reply state |
| `outbox` | Text/artifact deliveries and bounded attempts |
| `audit` | Content-free security/lifecycle metadata |

Prompt and final assistant text are retained for product recovery. Provider or
channel credentials, raw extension UI secrets, absolute paths, and raw tool
arguments/results are never stored in SQLite/audit.

```text
Turn: queued -> starting -> running -> terminal
Outcome: succeeded | failed | cancelled | timed-out | unknown
Session: active | stopped | quarantined
Interaction: pending -> answered | cancelled | expired
Outbox: pending -> sending -> sent | retryable | failed | expired
```

Admission atomically assigns a per-user FIFO ordinal and enforces one active
plus three pending. Startup may dispatch queued Turns only for active sessions.
A `starting`/`running` Turn found after restart becomes `unknown`; its session
is quarantined because Pi may have advanced its transcript. `!recover`
atomically cancels pending Turns, stops the quarantined session, and creates a
fresh selected session without transcript reuse or prompt replay.

## Pi controller, providers, and sessions

Each Hitch session owns a stable random Pi session id, a private session
directory, selected provider/model/thinking, fixed workspace, and extension
profile digest. Each Turn launches a fresh Pi 0.84.1 RPC controller against
that state. Only one Turn per user may touch Pi state.

The controller uses an operator-managed, host-private Pi profile and native
`ModelRuntime`. At service startup Hitch obtains `get_available_models`, checks
static allowlists, and publishes a content-free catalog digest. Session changes
use RPC `set_model` and `set_thinking_level`. Hitch does not parse provider
requests or credentials.

The MVP admits only one provider-owning Pi controller globally at a time until
Phase 0 proves that independent Pi processes can safely share and atomically
refresh the same `auth.json` across API-key and rotating OAuth providers. This
is a throughput shortcut, not a multiuser identity shortcut: every user's
queue/session remains independent. A later tested per-provider lock or
credential service may raise concurrency without changing the IM model.

Pi discovery is disabled and extensions are loaded explicitly from immutable
manifests. The workspace cannot load `.pi/extensions`, settings, packages,
skills, prompts, themes, or context files. Operator extensions may contribute
their own reviewed resources through Pi APIs.

Pi RPC supplies progress, tools, final text, model/catalog operations,
commands, cancellation, native image input, and extension UI. Select/confirm/
input requests become owner-bound expiring IM interactions. Notifications and
status are bounded/coalesced; editor/custom/TUI-only requests fail unless a
defined text projection exists.

`!abort` and deadlines first request RPC cancellation. A session stays active
only after Pi emits a proven terminal event, completes close/flush, durably
synchronizes its transcript, and exits cleanly. Forced signals, ambiguous
transport close, or unproven flush quarantine the session even if the Turn is
reported `cancelled` or `timed-out`.

## Extension boundary

The mandatory `hitch-sandbox` extension is an attested read-only artifact. Pi
starts with built-in tools disabled; the extension registers:

```text
read, write, edit, ls, grep, find, bash, hitch_publish
```

It also overrides direct user/RPC bash. Initialization failure, missing tool,
duplicate tool override, unexpected discovered extension, digest drift, or
sandbox backend failure aborts the Turn before prompting Pi.

Optional operator extensions are pinned and loaded explicitly. They may use
the full Pi API, including providers, commands, tools, events, and UI, and
therefore execute in the provider-credential trust boundary. Their tools are
host-capable unless the extension deliberately delegates to the Hitch sandbox
client. Enabling an operator extension is equivalent to installing trusted
service code; chat/workspace users cannot do it.

## Sandbox extension and backend

The first candidate is a custom Bubblewrap backend reusing reviewed Hitch
launcher and path-helper code. The official Pi Gondolin extension is the
fallback/compatibility candidate. Both implement the same Turn-scoped contract:

- one owner/session/Turn binding and unforgeable controller handle;
- canonical verified `/workspace` rw and current `/inbox` ro;
- private bounded `/tmp`, minimal runtime, PID isolation, and no provider,
  channel, Hitch-state, other-user, or host-home data;
- no external network unless a future static sandbox policy explicitly adds an
  allowlisted route;
- wall, CPU, memory, process, temporary-storage, and combined-output limits;
- complete cancellation and process-tree cleanup before slot release; and
- a host publication bridge scoped to the active Turn.

No backend can fall back to direct host execution. The supervisor must be able
to terminate the complete backend even when the Pi controller or extension is
stuck. A production Gondolin choice additionally pins QEMU, guest assets, VFS
policy, and systemd limits because Gondolin itself does not claim complete DoS
governance.

## Media

Inbound bytes stream to an exclusively created owner-private temp. Hitch
rejects advertised oversize, counts and aborts at limit+1, hashes
incrementally, sniffs MIME, validates image structure/pixel/frame ceilings,
fsyncs, and atomically promotes to an immutable owner-namespaced blob. Partial
and orphan temps are cleaned after failure and startup. Blobs never deduplicate
across users.

Validated images become native Pi image blocks. Other objects appear through a
read-only per-Turn `/inbox` with generated names. Only JPEG, PNG, GIF, and WebP
become native images; everything else is opaque and never rendered, expanded,
sourced, or executed by Hitch.

`!send` and `hitch_publish` share one host snapshot operation. From a verified
workspace directory descriptor it uses `openat2` beneath/no-symlink/
no-magiclink resolution, accepts regular files with `st_nlink == 1`, copies
through the descriptor with bounds/hash, compares pre/post `fstat`, and
atomically promotes an owner-private immutable snapshot. Delivery never reopens
the live path.

## Configuration and capacity bounds

Configuration publication is immutable for a data root. Startup fails on
duplicate/reassigned endpoint tuples; duplicate, same-inode, nested, or
overlapping workspaces; workspace path/inode drift with sessions; extension
manifest drift; or overlap with service/session/channel/runtime/blob roots.
Removal disables a published row; identities are never repurposed. Outbox and
interaction replies recheck the original tuple and owner.

| Resource | Compiled MVP maximum |
| --- | --- |
| Prompt text | 32 KiB UTF-8 |
| Session name / sessions per user | 64 UTF-8 bytes / 32 |
| Active / pending Turns per user | 1 / 3 |
| Active provider-owning Pi controllers | 1 globally until auth concurrency is proven |
| Input artifacts / one / total | 8 / 20 MiB / 40 MiB |
| Display filename / MIME label | 128 UTF-8 / 127 ASCII bytes |
| Image side / decoded pixels / frames | 16,384 / 40 MP / 100 |
| Outbound artifact / count / caption | 50 MiB / 8 / 1,024 bytes |
| Final text / delivery chunks | 64 KiB / 16 |
| Pending extension interactions per user | 1, expires after 10 minutes |
| Tool output per call / Turn | 1 MiB / 8 MiB |
| Audit storage | 8 files of 16 MiB |
| Workspace quota per user | 10 GiB |
| Blob plus Pi-session quota per user | 2 GiB |
| Complete service data-root quota | 20 GiB |

Workspace and data roots require enforceable quotas. `EDQUOT`/`ENOSPC` fail
without partial promotion. Turn/result and delivered artifacts retain 30 days;
stopped/replaced transcripts 30 days; failed/expired outbox payloads 7 days;
temps at most one hour. Active/quarantined sessions remain until explicit
replacement/stop or whole disabled-user removal.

## Delivery

Terminal text and artifacts enter the outbox before a channel send. One worker
serializes each endpoint and rechecks its original tuple and owner. Attempts,
chunking, expiry, and retry are bounded. An ambiguous channel response may
duplicate delivery after restart, but can never duplicate an agent Turn.
