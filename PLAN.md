# Implementation plan

## Estimate units

Estimates are **active Luna agent-hours**, including repository inspection,
tool execution, test runs, debugging, and one self-review pass. External
waiting for package downloads, provider login, Telegram setup, WeChat QR
confirmation, or user feedback is listed separately.

With Luna allowed to run continuously and operator checkpoints answered
promptly, the user-testable Telegram build should take roughly 24–48 elapsed
hours and the full two-channel actual-usage gate roughly 3–7 elapsed days. The
more reliable planning range is the active-agent range below because paused
agents and live-service availability dominate calendar time.

## Phase 0 — Prove the revised runtime boundary (4–8 agent-hours)

1. Pin the exact Pi and sandbox candidate inputs in
   `docs/phase-0-inputs.md`.
2. Start Pi 0.84.1 against a disposable fixture profile, then run an opt-in
   inventory against the configured operator profile without copying its
   credentials; enumerate registered/available models and switch provider,
   model, and thinking level without Hitch provider translation.
3. Test shared-profile concurrency and OAuth refresh failure; retain a global
   one-controller gate unless atomic behavior is proven.
4. Load only the mandatory Hitch extension, disable built-in tools, and prove
   that every file/shell path—including direct RPC bash—uses the extension.
5. Prototype the Bubblewrap backend using bounded code copied from
   `../hitch-hub`; measure the official Gondolin extension/backend if QEMU is
   made available.
6. Prove workspace rw, inbox ro, host/other-user denial, no sandbox credential,
   cancellation, timeout, process cleanup, and `hitch_publish` bridging.
7. Verify session continuity across fresh Pi processes and quarantine on every
   forced or ambiguous close.
8. Inventory existing Telegram/WeChat transport code and its unsafe identity or
   media assumptions.

Gate: record the selected sandbox backend, Pi profile/auth boundary, loaded
extension manifest, available-model snapshot, commands, measurements, and
adversarial evidence in `docs/phase-0-decisions.md`. Stop if any built-in or
extension tool can execute model-controlled work outside the sandbox.

## Phase 1 — Durable foundation (5–9 agent-hours)

- Add Node 24/TypeScript setup, lockfile, lint/typecheck/build/test commands,
  and CI.
- Implement strict static configuration and secret references.
- Create the small SQLite schema from `docs/architecture.md` with foreign keys,
  WAL, explicit transactions, deterministic clocks/IDs, and restart tests.
- Publish immutable users, endpoints, workspaces, and extension profiles.
- Add owner-namespaced private blobs and quota verification.

Checkpoint: fake channels boot/reopen a private data root and reject unsafe
configuration, path overlap, quota failure, or unknown schema state.

## Phase 2 — Telegram text and sessions (8–14 agent-hours)

- Implement exact private identity mapping, idempotent intake, per-user FIFO,
  durable outbox, and the session/recovery commands.
- Add the Pi RPC lifecycle with a deterministic fake runtime first.
- Port Telegram long polling, text delivery, health, and shutdown.
- Prove two-user isolation, duplicate suppression, restart, stop, abort, and
  forced-close quarantine.

Checkpoint: two Telegram users can independently hold durable text sessions.

## Phase 3 — Native Pi providers and extensions (8–16 agent-hours)

- Connect the Phase 0 Pi controller and selected sandbox extension/backend.
- Add `!models`, `!model`, `!thinking`, and `!commands`.
- Persist selected model/reasoning per session and validate it against Pi's
  current available-model snapshot.
- Load pinned operator extensions from read-only paths.
- Bridge extension commands and bounded RPC UI interactions to IM replies.
- Add live acceptance for at least two differently authenticated Pi providers,
  one API-key and one OAuth provider when available.

Checkpoint: the same session can deliberately switch among allowed Pi-native
models; provider credentials remain absent from the tool sandbox and outputs.

## Phase 4 — Telegram full media (12–22 agent-hours)

- Port image/document download and upload.
- Implement streaming temp intake, size/count limits, hashing, MIME/image
  validation, atomic owner-private blobs, cleanup, and read-only inbox mounts.
- Pass supported images to Pi natively and ordinary files by sandbox path.
- Implement descriptor-based `!send` snapshots and the authenticated
  `hitch_publish` extension bridge.
- Test symlink/hardlink/rename races, mutation, oversize, decompression bombs,
  abort, and delivery restart.

Checkpoint: two Telegram users exchange text, images, and ordinary files
without workspace, credential, or artifact leakage.

## Phase 5 — WeChat and multi-channel operation (8–14 agent-hours)

- Port QR login, sync/context state, receiving, sending, throttling, cooldown,
  and upload behavior.
- Apply the same identity/session/Turn/media/outbox services as Telegram.
- Keep WeChat state outside all workspaces and tool sandboxes.
- Prove exact private-peer routing and group rejection.

Checkpoint: one service safely runs Telegram and WeChat for two users.

## Phase 6 — Actual-usage gate (12–24 agent-hours)

- Complete the adversarial suite in `docs/security-floor.md`.
- Add text chunking, bounded retries, graceful shutdown, diagnostics,
  retention, audit rotation, backup, upgrade, and revocation guidance.
- Exercise process death in every Turn/outbox state and dependency failures.
- Run attended Telegram, WeChat, native-provider, operator-extension, sandbox,
  media, abort, restart, and recovery acceptance with two users.

Checkpoint: every product completion condition is recorded against one commit,
one dependency lock, one Pi profile digest, and one host snapshot.

## Milestone forecast

| Milestone | Cumulative active agent time | Typical external checkpoints |
| --- | ---: | --- |
| Runtime/sandbox decision | 4–8 h | QEMU choice if Gondolin is tested |
| Telegram text dogfood | 17–31 h | Bot token and two test identities |
| Native providers + extensions | 25–47 h | Pi auth and one extension approval |
| Telegram full-media dogfood | 37–69 h | Live upload/download checks |
| Telegram + WeChat feature-complete | 45–83 h | WeChat QR/login availability |
| Actual-usage release gate | 57–107 h | Two-user attended acceptance |

Expect approximately 8–14 implementation/review cycles. A failed sandbox
candidate can add 8–16 agent-hours; unstable WeChat behavior can add 6–12.
Provider breadth itself is no longer a per-provider implementation estimate
because Pi owns it, though each important auth family still needs live smoke
evidence.

## Implementation constraints

- Do not import `../hitch-hub` at runtime. Copy only bounded modules with tests
  or provenance.
- Do not bring over the generalized v2 schema, authorization graph, remote
  protocol, or provider broker.
- Pi and enabled operator extensions are trusted controller code. Workspace or
  chat users cannot add extensions.
- Every model-facing tool and direct shell path must fail closed through the
  selected sandbox backend; no host fallback exists.
- Real provider/channel tests remain opt-in; deterministic equivalents run in
  normal CI and never claim live acceptance.
- Keep commits phase-bounded and the repository green.
