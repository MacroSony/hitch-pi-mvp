# Trusted-personal MVP safety baseline

> **2026-09-19 narrow scope amendment:** the operator-approved
> [UX/local-notification increment](ux-notifications-plan.md) adds optional
> host-only notification/scheduling control for trusted static callers. See
> [local-control boundaries and enablement](local-control.md); it does not
> authorize a public API, hostile tenants, or exactly-once unattended delivery.

## Threat model

Hitch is an attended service for a few statically configured people personally
trusted by the operator. It is not designed for public signup, hostile tenants,
shared workspaces, or unattended automation.

Trusted host code consists of Hitch, pinned Pi, the selected sandbox backend,
and any explicitly enabled operator extension. Untrusted inputs consist of
model output, model-created commands, workspace content, inbound files, and
chat content. Trusted people can still trigger unsafe model behavior by
accident, so model-facing file and shell execution must not run directly on the
host.

The baseline below is intentionally smaller than a production multi-tenant
security program. It preserves the boundaries needed to test the product
without pretending the MVP is hardened for adversarial users.

## Required controls

### Identity and ownership

- Accept only exact statically configured private-channel tuples derived from
  authenticated Telegram, WeChat, or Enterprise WeChat metadata. Reject groups
  and missing or contradictory identity fields before content or media work.
- Scope sessions, Turns, selected models, cancellation, artifacts, and outbox
  rows to the authenticated Hitch user.
- Reject duplicate endpoint tuples, duplicate/nested user workspaces, and
  workspace overlap with Hitch data, Pi profiles, or channel state.
- Persist message admission before execution. Duplicate messages resolve to
  the original Turn; a conflicting reuse is rejected.

### Pi and extensions

- Pin Pi and the mandatory Hitch extension. Use a dedicated, host-private Pi
  operator auth authority shared by the configured users; keep per-user
  settings/cache directories separate. Never clone auth at startup or mount
  either auth or profile directories into the tool sandbox. Require shared-auth
  bootstrap attestation before prompting.
- Disable Pi project/global discovery, context files, workspace settings,
  packages, project extensions, skills, prompts, and themes.
- Disable Pi built-in tools. Before each prompt, attest that `read`, `write`,
  `edit`, `bash`, `grep`, `find`, `ls`, and `hitch_publish` come from the
  mandatory extension and that direct RPC bash is intercepted.
- Extension initialization, duplicate registration, digest drift, or sandbox
  startup failure aborts the Turn. There is no direct host fallback.
- Optional operator extensions are absent from the initial MVP. Adding one is
  an explicit operator trust decision and a later scoped change.

### Sandbox and process

- Route every standard Pi filesystem/shell tool and direct user/RPC bash path
  through Bubblewrap.
- Expose only the current workspace read-write, current Turn inbox read-only,
  bounded temporary storage, minimal runtime files, and the scoped publication
  bridge. Do not expose host home, Pi auth, Hitch/channel data, or another user.
- Deny sandbox networking by default.
- Enforce practical wall-time, memory, process-count, temporary-storage, and
  combined-output limits using the proven systemd/Bubblewrap backend.
- Cancellation and timeout terminate the sandbox scope and confirm it is empty
  before releasing the controller slot. Sandbox units are namespaced to the
  owning runtime so cleanup never kills another runtime's active units.
- Wait for Pi `agent_settled`. A forced or ambiguous controller close marks the
  Turn unknown and quarantines the session instead of replaying it.

### Credentials and providers

- Keep channel credentials in channel adapters and provider credentials in
  Pi's trusted profile. Do not store them in SQLite or log/chat payloads.
- Build controller and sandbox environments from explicit allowlists. No
  provider or channel secret may enter the sandbox environment, arguments,
  files, tool results, workspace, or inbox.
- Provider login/logout is an attended host-operator action, never an IM
  command.
- Run at most `maxConcurrentTurns` provider-owning Pi controllers globally
  (default 2, range 1–8), with per-user Turn serialization preserved by the
  pump.
- Validate that Pi profile JSON is readable before startup and provide clear
  backup/re-login recovery if the pinned Pi writer is interrupted.
- Resolve model changes only against Pi's current reported model catalog and
  an optional static allowlist.

### Media and delivery

- Apply advertised and observed byte/count limits while receiving input. Use
  exclusive owner-private temporaries, generated storage names, hashes, and
  atomic promotion. Never use a supplied filename as a storage path.
- Mount inbound files read-only. Treat only validated JPEG, PNG, GIF, and WebP
  objects as native images; other accepted files remain opaque.
- Snapshot outbound workspace files into immutable owner-private artifacts
  through the descriptor-confined Phase 0 publication helper. Delivery never
  reopens a live workspace path.
- Persist terminal text and artifact deliveries to the owner-bound outbox
  before sending. A channel retry may duplicate delivery, but it must not rerun
  the agent Turn.

### Bounds and operations

- Enforce the compiled prompt, queue, object, media, output, session-count, and
  execution bounds documented in `docs/architecture.md`.
- Refuse new media/Turn work when configured free-space thresholds are crossed.
  Surface a clear operator warning that initial workspaces lack kernel-enforced
  per-user disk quotas.
- Use a private data root, SQLite foreign keys and explicit transactions, and
  owner-private file modes.
- Keep real provider/channel credentials and live calls out of deterministic
  tests.

## Accepted MVP risks

- AUTH-1 uses locked atomic persistence around Pi 0.84.1 refresh, but remote
  rotation and local persistence are not one transaction. A crash between them
  can require operator re-login; restoring an older backup may not help.
  External/desktop/plugin writers are not certified by this path and must not
  run concurrently against the same rotating authorization. Operator auth
  changes require a stopped service.
- The initial ext4 deployment has no project quota. Configured object/temp
  limits and free-space checks reduce accidental exhaustion, but a runaway
  workspace can consume shared disk. The operator monitors and can stop the
  service.
- Users are trusted not to attack identity, ownership, or resource controls.
  Deterministic isolation tests still guard accidental cross-user bugs.
- Delivery may duplicate after an ambiguous channel response.
- Audit and retention are operationally useful but not tamper-evident or
  exhaustively crash-tested.
- Only providers and channel accounts actually available to the operator need
  live MVP acceptance. Unavailable integrations are reported, not simulated as
  live success.

## Deferred hardening

- public/hostile users, signup, roles, groups, shared sessions, and remote
  administration;
- kernel-enforced workspace quotas and complete hostile disk-exhaustion proof;
- a patched crash-atomic upstream Pi credential writer;
- Forge, ComfyUI Paint, arbitrary operator extensions, skills, MCP adapters,
  and user-installed code;
- high availability, horizontal scaling, exactly-once channel delivery, and
  unattended scheduling; and
- exhaustive filesystem race, media bomb, provider-family, dependency-failure,
  and channel-failure certification beyond the MVP paths.

## Release-stopping failures

Stop rather than weaken the MVP if an untrusted file/shell path can execute on
the host, a credential reaches the tool sandbox or user output, a channel tuple
can select another owner, cancellation leaves its sandbox scope running, or an
unknown Turn is automatically replayed.

Users receive stable failure categories such as `rejected`, `busy`,
`media-invalid`, `session-quarantined`, `model-unavailable`, `sandbox-failed`,
`agent-failed`, `delivery-failed`, and `internal-error`. Raw provider bodies,
tokens, host paths, and internal tool payloads do not enter chat responses.
