# Architecture

Status: implementation architecture for the trusted-personal MVP

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
        no optional extensions initially
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

```json
{
  "users": [
    {
      "id": "alice",
      "workspace": "/srv/hitch/workspaces/alice",
      "telegram": {
        "account": "primary",
        "userId": "123",
        "privateChatId": "123"
      },
      "wechat": { "account": "primary", "userId": "wxid_alice" }
    }
  ]
}
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

## MVP persistence

| Table | Phase | Purpose |
| --- | --- | --- |
| `users` | 1 | Published users, workspace identity, enabled state |
| `channel_endpoints` | 1 | Exact private tuple and selected session |
| `sessions` | 1 | Owner, Pi identity, selected model/thinking, lifecycle |
| `turns` | 1 | Admission, FIFO ordinal, state, result, idempotency |
| `outbox` | 1 | Text/artifact deliveries and bounded attempts |
| `artifacts` | 4 | Owner-namespaced immutable inbound/outbound objects |
| `turn_artifacts` | 4 | Turn, direction, role, display metadata |

Prompt and final assistant text are retained for product recovery. Provider or
channel credentials, raw extension UI secrets, absolute paths, and raw tool
arguments/results are never stored in SQLite/audit.

```text
Turn: queued -> starting -> running -> terminal
Outcome: succeeded | failed | cancelled | timed-out | unknown
Session: active | stopped | quarantined
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
profile digest. Each Turn launches a fresh Pi 0.85.1 RPC controller against
that state. Only one Turn per user may touch Pi state.

On first use, the transcript path is provisional: Pi does not create its JSONL
file until the first assistant message. Hitch's SQLite session row remains the
source of ownership and requested model/thinking before that boundary. After
creation, every fresh controller opens the exact private transcript path; it
does not use `--session-id` lookup. Two processes may otherwise append valid
JSONL sibling branches to one session while only one Turn remains on the
selected leaf, so the per-user pump plus per-user profile/session isolation
still prohibits concurrent opens of the same transcript.

The controller retains a private per-user Pi directory at startup
(`dataRoot/pi-profiles/<user>`). Only settings/models are synchronized from the
operator profile; auth is never copied. The first prepared user is the
canonical catalog profile. Startup performs one bounded (7-second) public Pi
`ModelRuntime` refresh against that profile, explicitly supplying `modelsPath`
and `modelsStorePath` plus the shared `SharedCredentialStore`. Pi refreshes
only configured/authenticated providers and never generates a model Turn.
Network failures retain Pi's cache or built-ins and emit a content-free
warning; malformed local state still fails closed. Hitch then safely copies the
native `models-store.json` to every prepared user profile (without
auth/settings), and a fresh offline RPC controller reads that same cache for
the model snapshot. Turn controllers remain offline for the service lifetime,
so this catalog is not hot updated. All configured users intentionally share
one operator authority, `piProfileDir/auth.json`; old auth clones are ignored.
A fixed controller-only Node preload wraps public `ModelRuntime.create` before
the original pinned CLI starts and pins each controller's catalog paths.
No private Pi imports or generic loader are introduced. Mandatory startup
attestation proves that the auth bootstrap ran. Session model/thinking changes
retain the original RPC path. Pi still owns provider protocol/refresh; Hitch's
small store owns locked and atomic persistence, without putting credentials in
model or sandbox contexts.

The MVP admits at most `maxConcurrentTurns` provider-owning Pi controllers
globally (config, default 2, validated 1–8). The per-user pump still serializes
Turns for one user; the semaphore only bounds cross-user parallelism. Shared
`proper-lockfile` coordination covers re-read→Pi refresh callback→atomic save,
not whole provider requests. Private temporary-file fsync, rename and directory
fsync avoid truncated authority files. Remote refresh and local persistence are
not one transaction: a crash between them can still require operator re-login.
Login and external auth edits happen only while stopped; additional plugin
writers are not covered. See `docs/shared-auth-plan.md` for acceptance and
migration details. Sandbox
scopes are namespaced to the owning runtime, so one runtime's cleanup cannot
kill another runtime's active units; a global sweep only runs at startup when
no Turn is active.

Pi discovery is disabled and extensions are loaded explicitly from immutable
manifests. The workspace cannot load `.pi/extensions`, settings, packages,
skills, prompts, themes, or context files. Operator extensions may contribute
their own reviewed resources through Pi APIs.

Pi RPC supplies progress, tools, final text, model/catalog operations,
cancellation, and native image input. Optional extension commands and UI are
post-MVP work.

RPC `prompt` success is only a preflight acceptance signal. The Turn remains
active until Pi emits `agent_settled`; `turn_end` and `agent_end` can occur
before tool/retry continuation has fully settled. Hitch never treats the
prompt response itself as a flush or completion boundary.

`!abort` and deadlines first request RPC cancellation. A session stays active
only after Pi emits `agent_settled`, exits cleanly, and Hitch successfully
`fsync`s the transcript file and its parent directory. Forced signals,
ambiguous transport close, or failed/unproven sync quarantine the session even
if the Turn is reported `cancelled` or `timed-out`.

## Extension boundary

The mandatory `hitch-sandbox` extension is an attested read-only artifact. Pi
starts with built-in tools disabled; the extension registers:

```text
read, write, edit, ls, grep, find, bash, hitch_publish
```

It also overrides direct user/RPC bash. The mandatory extension is loaded
first, and startup attests the exact winning source path for every expected
tool. The pinned Pi ResourceLoader's pre-RPC duplicate-registration rejection
is a required security behavior and is tested with the conflicting extension
in both load orders; `getAllTools()` is not treated as collision detection.
Initialization failure, missing or wrong-source tool, duplicate registration,
unexpected discovered extension, digest drift, later surface mutation, or
sandbox backend failure aborts the Turn before prompting Pi.

Optional operator extensions are excluded from the initial build. A later
phase may pin and load a specific extension explicitly, but doing so places it
inside the provider-credential boundary. Chat/workspace users can never
install or enable one.

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
Removal disables a published row; identities are never repurposed. Outbox
delivery rechecks the original tuple and owner.

| Resource | Compiled MVP maximum |
| --- | --- |
| Prompt text | 32 KiB UTF-8 |
| Session name / sessions per user | 64 UTF-8 bytes / 32 |
| Active / pending Turns per user | 1 / 3 |
| Active provider-owning Pi controllers | `maxConcurrentTurns` (default 2, range 1–8); per-user pump keeps one Turn per user |
| Input artifacts / one / total | 8 / 20 MiB / 40 MiB |
| Display filename / MIME label | 128 UTF-8 / 127 ASCII bytes |
| Image side / decoded pixels / frames | 16,384 / 40 MP / 100 |
| Outbound artifact / count / caption | 50 MiB / 8 / 1,024 bytes |
| Final text / delivery chunks | 64,000 bytes / 16 |
| Tool output per call / Turn | 1 MiB / 8 MiB |
| Workspace monitored soft limit per user | 10 GiB |
| Blob plus Pi-session enforced application limit per user | 2 GiB |
| Complete service data-root free-space stop threshold | operator configured |

Object, inbox, publication, temp, and output limits are enforced by Hitch.
The initial filesystem does not provide per-workspace project quotas, so Hitch
also checks free space before accepting work and reports the workspace limit as
attended monitoring rather than hard isolation. `ENOSPC` fails without partial
artifact promotion. Automated retention is post-MVP; the operator can remove
stopped data with the documented maintenance command. Active/quarantined
sessions remain until explicit replacement/stop or disabled-user removal.

## Delivery

Terminal text and artifacts enter the outbox before a channel send. One worker
serializes each endpoint and rechecks its original tuple and owner. Attempts,
chunking, expiry, and retry are bounded. An ambiguous channel response may
duplicate delivery after restart, but can never duplicate an agent Turn.
