# Architecture

## Design rule

Build one vertical Pi product. Do not add an abstraction until two implemented
MVP paths require it.

```text
Telegram long poll              WeChat iLink
        |                            |
        +------ channel ingress -----+
                       |
          trusted channel identity
                       |
             command/session router
                       |
             SQLite + private blobs
                       |
                per-user FIFO
                       |
             Turn runner/supervisor
                       |
       +---------------+----------------+
       | Bubblewrap worker              |
       |                                |
       | Pi RPC                         |
       | /workspace (user rw)           |
       | /inbox (Turn ro)               |
       | /session (private rw)          |
       | /tmp (bounded)                 |
       | no external network            |
       | localhost -> mounted UDS ------+---- host provider broker
       +--------------------------------+              |
                                                       +---- fixed upstream

Terminal result -> durable outbox -> originating channel endpoint
Published file  -> immutable blob  -> originating channel endpoint
```

## Module boundaries

The initial source tree should stay small:

```text
src/
  config/       strict startup configuration and environment lookup
  db/           schema, transactions, and narrow state operations
  channels/     Telegram, WeChat, and their shared transport interface
  app/          identity mapping, commands, session routing, Turn admission
  runtime/      Pi RPC, Bubblewrap launch, supervision, and cancellation
  broker/       scoped-token validation and fixed-upstream streaming proxy
  media/        blob store, MIME/size validation, inbox and publish snapshots
  delivery/     durable outbox and channel send attempts
  main.ts       production composition and shutdown
```

There is no generic agent interface, general authorization engine, event bus,
repository framework, plugin system, or transport-neutral remote protocol.

## Trusted identity and routing

Configuration maps exact channel identities to a stable Hitch user:

```yaml
users:
  alice:
    workspace: /srv/hitch/workspaces/alice
    telegram:
      bot_account: primary
      user_id: "123"
      private_chat_id: "123"
    wechat:
      account: primary
      user_id: wxid_alice
```

The channel adapter constructs identity evidence from the authenticated API
update. Message text, captions, callback values, filenames, and forwarded
metadata never select the user. The accepted tuples are concrete:

- Telegram: configured bot account, `chat.type == "private"`, exact `chat.id`,
  exact `from.id`, and a stable update/message id for idempotency.
- WeChat: configured account, exact `from_user_id`, absent or empty `group_id`,
  and a stable message id. Send-context tokens are stored against that exact
  account/peer tuple and never select a different peer.

Anything missing, group-scoped, contradictory, or ambiguous is ignored and
audited as a denial without content. Existing Hitch adapters may be used as
transport references, but their identity and media paths are not copied
without adapting them to these tuples.

Each endpoint stores its selected session. Sessions are always owner-scoped;
lookups by ID or name include `user_id` in the same query.

## Minimal persistence

Use a versioned schema with normal foreign keys and explicit transactions, but
no generic revision or grant graph.

| Table | Purpose |
| --- | --- |
| `users` | Published configured users and enabled state |
| `channel_endpoints` | Exact private channel address and selected session |
| `sessions` | User-owned Hitch/Pi session identity and lifecycle |
| `turns` | Admission, queue ordinal, execution state, result, and idempotency |
| `artifacts` | Content-addressed inbound/outbound private objects |
| `turn_artifacts` | Turn, direction, prompt/delivery role, and display metadata |
| `outbox` | Text/artifact deliveries and bounded attempt state |
| `audit` | Content-free security and lifecycle events |

Persist prompt text and final assistant text because they are required for
operator recovery and product behavior. Never place provider credentials,
broker tokens, raw channel tokens, absolute artifact paths, or raw tool
arguments/results in SQLite or audit rows.

States are intentionally small:

```text
Turn: queued -> starting -> running -> terminal
Terminal outcome: succeeded | failed | cancelled | timed-out | unknown
Outbox: pending -> sending -> sent | retryable | failed | expired
Session: active | stopped | quarantined
```

The transaction admitting a Turn allocates its per-user queue ordinal and
enforces one active plus three pending. Startup may run queued Turns after
normal validation unless their session is quarantined. Any `starting` or
`running` Turn found after process restart becomes terminal `unknown`; it is
never resubmitted. Its session becomes `quarantined` because Pi may have
flushed part of the transcript before dying. Pending Turns for that session
remain visible but cannot dispatch. `!recover` atomically cancels those pending
Turns, stops the quarantined session, and creates a fresh selected session. It
does not reuse or roll back the ambiguous transcript.

## Pi session and Turn execution

Each Hitch session owns:

- a stable random Pi `--session-id`;
- a private host session directory;
- a fixed user workspace;
- no persistent worker process.

Every Turn launches a fresh Pi RPC process with the stable session ID and
private session directory. This retains conversation context without retaining
process authority. Only one Turn may use a user's Pi state at once.

Pi is launched from an empty-base environment and with all resource discovery
disabled as specified by `docs/phase-0-inputs.md`. The workspace cannot supply
configuration, extensions, context files, prompts, themes, packages, provider
credentials, or environment overrides.

The reviewed tool set is:

```text
read, write, edit, ls, grep, find, bash, hitch_publish
```

`bash` is allowed because the sandbox—not a model instruction—is the security
boundary. It receives only the user's workspace, Turn inbox, private session
state, bounded temporary storage, runtime artifacts, and local broker adapter.

Pi RPC supplies normalized progress, tool status, final text, cancellation,
and native image input. Unsupported interactive requests fail the Turn with a
clear message rather than waiting indefinitely.

`!abort` and a deadline first request cancellation over RPC. The session stays
active only if Pi emits the proven terminal event, the controller completes its
close/flush handshake, the session file is durably synchronized, and the whole
process tree then exits. If a deadline forces a signal, the transport closes
ambiguously, the process must be killed, or any boundary cannot be proven, the
Turn may still be reported `cancelled` or `timed-out` but the session is also
quarantined. No later prompt uses that transcript. Tests cover both graceful
and forced abort/timeout paths.

## Broker

### Preferred MVP design

Pi loads one generated custom-provider configuration whose base URL points to
a loopback HTTP adapter inside the isolated network namespace. The adapter
forwards bytes over a mounted Unix socket to the host broker.

Pi receives a random, short-lived Turn token as its provider API key. This is
authorization to ask the broker for one bounded Turn, not a provider secret.

The trusted loopback adapter assigns the next request sequence and forwards it
with the token and request bytes. The host broker independently hashes the body
and enforces the sequence. The host broker:

- keeps only an HMAC-SHA-256 token digest under a process-local random key,
  compares digests in constant time, and never persists the raw token;
- binds a token to one user, session, Turn, provider, model, expiry, and request
  limit;
- permits at most one request in flight and eight monotonically sequenced
  requests total so one Turn can perform a bounded agent/tool loop;
- consumes each sequence number once and records its sanitized body
  fingerprint; a duplicate sequence is rejected whether its body matches or
  differs;
- accepts only the exact HTTP method, origin-form local path, content type, and
  a bounded JSON body; absolute-form targets are rejected;
- rejects model changes and token/output ceilings above configuration, and
  injects the fixed output limit when the field is absent;
- rejects `CONNECT`, redirects, duplicate or conflicting authority,
  authorization, content-length, transfer-encoding, forwarding, cookie, proxy,
  and hop-by-hop headers, including conflicting framing;
- adds the configured upstream credential and exact upstream URL;
- streams the upstream response, including SSE, with compressed,
  decompressed, event, final-output, and wall-clock limits;
- accepts only the configured upstream response media types and copies an
  allowlist of response headers, never cookies, authentication, redirects, or
  hop-by-hop fields;
- uses manual redirect handling and rejects every redirect;
- configures Pi/provider SDK, adapter, broker, and HTTP client retry counts to
  zero and opens at most one upstream connection for each accepted sequence;
- records `not-started`, `completed`, or `outcome-unknown` without raw bodies.

The token is revoked on cancellation, Turn terminalization, expiry, or any
protocol violation. A disconnect before an upstream connection is established
is `not-started`; any disconnect after connection/bytes may have begun is
`outcome-unknown`. Unknown is never retried automatically.

The sandbox has no route to external networks. Its only network listener is the
loopback adapter connected to the broker Unix socket.

### Mandatory Phase 0 proof

Before building the product around this broker, prove with the selected Pi
version and provider API that:

1. a generated custom provider can use the local base URL and opaque key;
2. normal Pi RPC agent loops and tool calls work through the proxy;
3. SSE, cancellation, errors, reasoning configuration, and native image input
   survive the proxy;
4. the worker has no external network route; and
5. the real upstream credential remains host-only.

If the selected provider cannot be proxied without provider-specific semantic
translation, stop and choose one of two explicit outcomes:

- narrow the MVP to a compatible API-key/OpenAI-compatible provider; or
- reuse the existing Hitch v2 Pi-native bridge/sidecar as one concrete broker.

Do not invent a second generalized broker architecture during implementation.

## Media

Inbound channel bytes stream into an exclusively created owner-private temp
file. Hitch rejects advertised oversize before download, counts bytes and
aborts at limit plus one, hashes incrementally, sniffs MIME, and validates
image structure and pixel/frame/decompression ceilings. It fsyncs and
atomically promotes the file to an immutable owner-namespaced blob only after
validation. Partial and orphan temps are removed at startup and after every
failure. Blob addressing includes the owner before the SHA-256; content is
never deduplicated across users.

Images become Pi native image blocks. Other files appear in a read-only
per-Turn `/inbox` mount using generated safe names; the prompt lists those
sandbox paths.

Outbound publication has two entry points:

- `!send <relative-path>` from the authenticated session owner;
- `hitch_publish(relativePath, caption?)` from the active sandbox.

Both call the same host operation. Starting from a verified workspace directory
descriptor, it uses `openat2` beneath/no-symlink/no-magiclink resolution, accepts
regular files only, rejects `st_nlink > 1`, and copies through the open file
descriptor with a byte bound and incremental hash. Pre/post `fstat` values must
prove the source did not change. It then atomically promotes an owner-private
immutable snapshot. Neither delivery nor later validation reopens the live
workspace path.

## Configuration and capacity bounds

Configuration publication is immutable for the life of the data root. Startup
fails on duplicate endpoint tuples, endpoint reassignment to another user,
duplicate or same-inode workspaces, nested/overlapping user workspaces, or any
workspace overlap with service, session, channel-state, runtime, or blob roots.
A workspace path/inode cannot change while it has sessions. Removing a user or
endpoint disables its published row; an old tuple is never repurposed. Outbox
delivery rechecks the original published endpoint tuple and enabled owner.

The repository ships conservative compiled maxima; configuration may lower but
not raise them without a reviewed release:

| Resource | MVP maximum |
| --- | --- |
| Prompt text | 32 KiB UTF-8 |
| Session name / sessions per user | 64 UTF-8 bytes / 32 |
| Active / pending Turns per user | 1 / 3 |
| Input artifacts per Turn | 8 |
| One input / all input per Turn | 20 MiB / 40 MiB |
| Display filename / MIME label | 128 UTF-8 bytes / 127 ASCII bytes |
| Image dimensions / decoded pixels | 16,384 per side / 40 megapixels total |
| Animated image frames | 100 |
| One outbound artifact | 50 MiB, further limited by channel |
| Published artifacts per Turn / caption | 8 / 1,024 UTF-8 bytes |
| Final assistant text retained/delivered | 64 KiB UTF-8 |
| Delivery chunks per logical text item | 16 |
| Provider requests per Turn | 8 sequential, 1 in flight |
| Provider request body | 64 MiB |
| Provider decompressed response / SSE event | 16 MiB / 1 MiB |
| Audit storage | 8 files of 16 MiB |
| Workspace quota per user | 10 GiB |
| Blob plus Pi-session quota per user | 2 GiB |
| Complete service data-root quota | 20 GiB |

Pi transcript/session files count against the per-user data quota. The service
data root and every workspace must be backed by enforceable project quotas;
plain free-space checks are insufficient. Admission reserves database/blob
headroom, and `EDQUOT`/`ENOSPC` terminalize safely without partial promotion.
Successful/failed/cancelled Turn prompt/result rows and delivered artifacts are
retained for 30 days; stopped or replaced Pi session transcripts for 30 days;
expired/failed outbox payloads for 7 days; and temp files for at most one hour.
Active and quarantined sessions are retained until explicitly replaced/stopped
or the operator removes the whole disabled user. Retention never crosses user
namespaces.

Only JPEG, PNG, GIF, and WebP that pass structural validation become native Pi
images. Every other accepted object is treated as an opaque ordinary file,
mounted read-only, never rendered, expanded, sourced, or executed by Hitch, and
uses the sniffed canonical MIME when known or `application/octet-stream`.

## Delivery

Terminal text and published artifacts are committed to the outbox before a
channel send begins. One worker serializes sends per endpoint. It rechecks that
the original endpoint tuple and user remain enabled, applies platform
size/chunking rules, and records each attempt.

Retries are bounded. A platform response that may have succeeded can produce a
duplicate chat message after restart; it must never cause a duplicate agent
Turn. Delivery IDs are included in logs so operators can distinguish this case.
