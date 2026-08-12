# Trusted-personal MVP implementation plan

## Delivery rule

Build the smallest vertical product that lets a few statically configured,
trusted people use private Pi sessions from Telegram and WeChat. The model and
workspace contents are still untrusted, so filesystem and shell tools remain
inside the mandatory Bubblewrap-backed Hitch extension.

Implement one phase at a time. Before each phase commit, request an independent
subagent review, resolve blocking findings, run the deterministic checks, and
record the result in the commit message or phase handoff.

Real credentials and live channel/provider checks are always opt-in. They never
run in normal CI.

## Phase 0 — MVP reset and retained evidence (completed)

- Retain the deterministic runtime, extension, sandbox, and transport evidence
  under `spikes/` as design input.
- Accept Pi `auth.json` crash recovery as an attended-operator limitation for
  the MVP. Use one controller globally, validate the profile before launch, and
  document backup/re-login recovery.
- Accept that the initial host has no project quota. Enforce configured object,
  inbox, output, temp, and execution bounds; check free space; document that the
  workspace itself has no hard per-user disk isolation.
- Exclude Pi Forge and ComfyUI Paint from the initial manifest. Their missing
  Hitch service modes do not block the core MVP.
- Move real provider inventory and API-key/OAuth smoke to opt-in dogfood
  acceptance. One working provider is enough for the first usable build.
- Select the proven Bubblewrap spike as the production starting point. Do not
  evaluate Gondolin unless Bubblewrap fails on the deployment host.

Checkpoint: the required documents consistently authorize Phase 1 under the
trusted-personal threat model, while preserving sandbox and credential
separation.

## Phase 1 — Minimal durable foundation (completed)

- Add Node.js 24, TypeScript, a committed lockfile, format/typecheck/test/build
  commands, and CI.
- Use a strict JSON configuration with environment-variable secret references.
- Create a small SQLite schema for users, exact channel endpoints, sessions,
  turns, and outbox rows. Enable foreign keys and explicit transactions.
- Publish static users/workspaces on startup and reject duplicate endpoint
  tuples; missing, non-directory, or non-private workspace paths; nested user
  workspaces; and overlap with the data root.
- Provide deterministic clocks/IDs and credential-free restart tests.

Checkpoint: the service boots and reopens a private data root with two fake
users, and unsafe configuration fails before channel or Pi startup.

## Phase 2 — Telegram text vertical slice (completed)

- Implement direct Bot API long polling with exact bot/private-chat/sender
  admission before content handling.
- Persist idempotent intake before execution, with one active and three queued
  Turns per user.
- Add a small Pi runtime interface and deterministic fake runtime.
- Implement `!new`, `!sessions`, `!switch`, `!status`, `!abort`, `!stop`, and
  `!recover`.
- Persist terminal text to a bounded outbox before delivery; tolerate possible
  duplicate chat delivery but never duplicate an agent Turn.
- Prove two-user isolation, restart behavior, and uncertain-Turn quarantine.

Checkpoint: two allowlisted Telegram fixtures can independently use durable
text sessions through the fake runtime.

## Phase 3 — Native Pi and Bubblewrap dogfood (completed)

- Promote the bounded Phase 0 mandatory extension and Bubblewrap backend into
  production modules.
- Start one fresh pinned Pi controller per Turn, with one global controller
  slot and the dedicated operator profile.
- Disable discovery and built-in tools; attest the mandatory replacement tools
  and direct RPC bash before prompting.
- Add `!models`, `!model`, and `!thinking`, persisting selection per session.
- Wait for `agent_settled`; quarantine on ambiguous close. On clean exit, sync
  the transcript and its parent directory.
- Add startup validation for the Pi profile and clear operator recovery
  instructions for a corrupt profile.
- Run an opt-in live Telegram plus one-provider smoke.

Checkpoint: one trusted user can perform useful Pi coding turns over Telegram,
with shell/file operations confined to the configured workspace sandbox.

## Phase 4 — Basic images and files (completed)

- Stream inbound objects to owner-private temporary files with configured byte
  and count limits, hashing, generated storage names, and atomic promotion.
- Pass JPEG, PNG, GIF, and WebP as native Pi images; mount other files read-only
  in the current Turn inbox.
- Implement bounded immutable snapshots for `!send` and `hitch_publish` using
  the existing descriptor-confined Phase 0 helper.
- Deliver bounded artifacts through the outbox and clean abandoned temporaries.

Checkpoint: Telegram text, common images, and ordinary files work in both
directions without cross-user paths or credentials entering the sandbox.

## Phase 5 — WeChat private-peer support (completed)

- Use the pinned WeChat client only at its raw API boundary; Hitch owns cursor
  persistence and admission order.
- Accept only exact configured account/private-peer tuples with stable message
  IDs, and reject groups before media work.
- Reuse the same sessions, queue, media, sandbox, and outbox services.
- Keep WeChat credentials, cursors, and context tokens outside workspaces and
  bind context tokens to the exact account/peer tuple.
- Run opt-in QR/login and send/receive acceptance.

Checkpoint: the same service supports private Telegram and WeChat use for the
small configured user set.

## Phase 6 — MVP acceptance and operator guide (current)

- Run deterministic isolation, duplicate, restart, abort, timeout, media-bound,
  and sandbox fail-closed tests.
- Run attended live checks for the configured channels and providers that are
  actually available; record unavailable integrations honestly.
- Document installation, Pi login, config, systemd service, backup/recovery,
  logs, known limitations, and complete uninstall/reset steps.
- Fix only release-blocking defects. Move hard quotas, crash-atomic upstream Pi
  auth persistence, optional operator extensions, stronger audit/retention, and
  broader provider matrices to post-MVP work.

Checkpoint: a new operator can follow the guide and use the concept without
editing source code.

## MVP safety baseline

The following remain release requirements even for trusted users:

- exact private-channel allowlisting and owner-scoped state access;
- no provider/channel credentials in workspaces, SQLite, logs, chat, or the
  tool sandbox;
- no workspace/project Pi extension or configuration discovery;
- every standard file/shell tool and direct bash path enters Bubblewrap, with
  no host fallback;
- bounded input, output, queue depth, and execution time;
- cancellation cleans up the sandbox process tree before capacity reuse; and
- uncertain work is quarantined rather than automatically replayed.

## Explicitly deferred hardening

- hostile or public users, groups, signup, roles, remote administration, or
  shared workspaces;
- high availability, horizontal scale, exactly-once delivery, and unattended
  automation;
- per-workspace kernel-enforced project quotas on the initial host;
- crash-atomic changes inside the pinned upstream Pi credential writer;
- Pi Forge, ComfyUI Paint, arbitrary operator extensions, skills, MCP, or
  user-installed extensions; and
- exhaustive filesystem race, media bomb, provider-family, and channel-failure
  certification beyond the bounded paths used by the MVP.
