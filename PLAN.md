# Implementation plan

## Delivery principle

Each phase ends in a runnable vertical checkpoint. No phase introduces a
generic framework for deferred work. The repository test command remains green
at every commit.

Estimates assume one experienced full-time engineer and reuse of reviewed code
from `../hitch-hub`. They are planning ranges, not deadlines.

## Phase 0 — Prove the risky seams (3–5 days)

Build disposable spikes, then either promote the smallest proven code or delete
the spike:

1. Reproduce the exact inputs and Pi launch contract in
   `docs/phase-0-inputs.md`.
2. Pi 0.84.1 RPC session continuity using a fixed `--session-id` and private
   `--session-dir` across two fresh processes, including kill-at-each-frame
   transcript tests.
3. A generated custom provider using a local HTTP endpoint and opaque API key.
4. Host proxy forwarding first to the deterministic fixture and then the
   selected real upstream with SSE, cancellation, a multi-request tool loop,
   one native image, retries disabled, and ambiguity injection before headers,
   after headers, and mid-stream.
5. Bubblewrap with no external network, a loopback-to-mounted-UDS adapter, an
   empty-base environment, disabled Pi discovery, and malicious workspace
   fixtures.
6. The existing Telegram and WeChat adapters running independently of the old
   Hub core.

Gate: the deterministic and opt-in live-provider suites both pass. Record the
input manifest, supported Pi version, provider API/model/reasoning, exact proxy
behavior, retry settings, crash behavior, and chosen broker design in
`docs/phase-0-decisions.md`. Stop and revise the plan if credential-free
brokered execution or safe session recovery cannot be shown.

## Phase 1 — Repository and durable foundation (2–3 days)

- Add Node 24/TypeScript project setup, lint/typecheck/build/test scripts, and
  CI.
- Implement strict YAML configuration with environment-only secret references.
- Create the minimal schema from `docs/architecture.md` with schema version 1,
  foreign keys, WAL, busy timeout, and explicit transactions.
- Publish configured users and endpoints idempotently at startup.
- Add deterministic clocks/IDs and disposable data-root test support.
- Add private content-addressed blob storage.
- Verify immutable configuration publication and quota-backed workspace/data
  roots before accepting messages.

Checkpoint: service boots with fake channels, initializes/reopens its private
root, and rejects unsafe configuration or unknown schema state.

## Phase 2 — Text session vertical slice (3–5 days)

- Define the narrow channel transport interface and fake adapter.
- Implement exact identity mapping and private-DM rejection rules.
- Implement `!new`, `!sessions`, `!switch`, `!status`, `!abort`, `!stop`, and
  `!recover`.
- Admit plain text with endpoint-scoped idempotency and per-user FIFO capacity.
- Persist selected session per endpoint.
- Add a fake Turn runner that produces a terminal result and durable outbox
  delivery.
- Port Telegram text polling/sending and health behavior.

Checkpoint: two configured Telegram users cannot cross sessions or results;
duplicate updates create one Turn; restart preserves queued text and outbox.

## Phase 3 — Pi and sandbox vertical slice (4–6 days)

- Port the narrow Pi RPC state machine needed for readiness, prompt, progress,
  tools, final, cancellation, and close.
- Port verified Bubblewrap source opening, launch, systemd/cgroup limits, output
  bounds, cancellation, and cleanup.
- Build the reviewed workspace tools plus `grep`, `find`, `bash`, and a stubbed
  `hitch_publish` capability.
- Mount only `/workspace`, `/session`, `/inbox`, runtime artifacts, private
  home, bounded `/tmp`, and the future broker adapter.
- Resume the stable Pi session from a fresh process each Turn.
- Quarantine the session after any unexpected worker death; no subsequent Turn
  may use its possibly advanced Pi transcript until explicit recovery.
- Prove graceful cancellation/timeout flush boundaries and quarantine after
  every forced or ambiguous close.
- Terminalize and release capacity on every exit path.

Checkpoint: deterministic Pi exercises two conversational Turns, workspace
editing, shell/test execution, timeout, abort, and restart isolation for two
users without a provider credential.

## Phase 4 — Minimal provider broker (4–7 days)

- Implement expiring Turn-scoped tokens with one in-flight request and a fixed
  maximum of eight sequential provider requests for one agent tool loop.
- Generate the fixed Pi provider/model configuration.
- Implement the in-namespace loopback adapter and host UDS broker.
- Validate request sequence/fingerprint, method, absolute target, path, body
  size, framing, media type, model, output ceiling, and forbidden headers;
  inject the exact host credential and upstream URL.
- Stream SSE with cancellation and byte/time limits.
- Persist only forwarding state and sanitized outcomes.
- Disable retries in Pi, the provider SDK, adapter, broker, and HTTP client;
  inject disconnects before/after headers and mid-SSE to prove one upstream
  connection and explicit unknown outcomes.

Checkpoint: one real opt-in provider Turn completes through the sandbox and
broker; token replay, cross-Turn use, model change, direct network, and secret
search all fail.

## Phase 5 — Complete media flow (4–6 days)

- Port Telegram image/document download and upload transports.
- Implement streaming exclusive-temp intake, advertised and measured byte
  limits, incremental hashing, MIME/image-structure validation, atomic blob
  promotion, partial cleanup, and `/inbox` mounts.
- Pass supported images to Pi natively and other files by sandbox path.
- Implement descriptor-based workspace snapshotting for `!send`, rejecting
  links and mutation races before immutable promotion.
- Complete the reviewed `hitch_publish` tool and authenticated active-Turn
  bridge.
- Deliver immutable images/files through the outbox with platform limits.

Checkpoint: two users exchange text, images, and files without path/media
leakage; symlink races, MIME spoofing, and oversized objects fail.

## Phase 6 — WeChat and multi-channel operation (3–5 days)

- Port QR login, credential/sync/context-token state, receive lifecycle, send
  throttling, cooldown, and current upload workaround.
- Store WeChat operational state outside all workspaces and sandboxes.
- Apply the same identity, session, Turn, media, and delivery services used by
  Telegram.
- Run both channels in one service with independent health and shutdown.

Checkpoint: the same user may have independently selected private sessions per
endpoint; Telegram and WeChat cannot misroute another user's result/artifact.

## Phase 7 — Private MVP gate (4–6 days)

- Complete the adversarial suite in `docs/security-floor.md`.
- Add delivery expiry/retry policy, text chunking, graceful shutdown, health
  diagnostics, retention, and bounded audit rotation.
- Run process-death tests for queued/running Turns and pending/sending outbox.
- Add systemd deployment, configuration, backup, upgrade, revocation, and
  troubleshooting guidance.
- Resolve dependency audit findings.
- Perform attended real Telegram, WeChat, provider, sandbox, media, abort, and
  restart acceptance with two users.

Checkpoint: all conditions in `docs/product-scope.md` are demonstrated and
recorded against one commit and environment snapshot.

## Milestone forecast

| Milestone | Expected cumulative effort |
| --- | --- |
| Broker feasibility known | 3–5 days |
| Telegram text dogfood with deterministic Pi | 2–3 weeks |
| Real sandboxed/brokered Pi text dogfood | 3–5 weeks |
| Telegram full-media dogfood | 5–7 weeks |
| Telegram + WeChat private MVP | 8–12 weeks |

The fast target is an attended Telegram text dogfood in 3–5 weeks. The full
two-channel, full-media, brokered MVP is an 8–12 week one-engineer plan. OAuth
or a Pi-native provider sidecar adds roughly 2–3 weeks. Reducing the full
forecast requires dropping a product surface such as WeChat or general files,
not weakening identity, isolation, credential custody, or replay controls.

## Implementation constraints

- Do not import `../hitch-hub` at runtime. Copy or extract only bounded modules
  and preserve their tests or provenance.
- Do not bring over the existing generalized v2 schema, codecs, authorization
  graph, remote protocol, or implementation plan.
- Do not silently widen the product scope. Record proposed changes in the plan
  before implementing them.
- Every phase needs positive flow, denial, cancellation, restart, and cleanup
  tests appropriate to its boundary.
- Real provider/channel tests remain opt-in; deterministic equivalents run in
  normal CI.
- The normal test command never claims live Telegram, WeChat, or provider
  acceptance. Live commands produce content-free evidence manifests tied to a
  commit and exact input digest.
- Keep commits phase-bounded and leave the repository green.
