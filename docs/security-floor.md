# Security floor

The simplified architecture cuts provider-broker scope. It does not cut the
boundaries separating users, model-executed code, host data, channel secrets,
or delivery ownership.

## Trust boundary

Trusted host code consists of Hitch, Pi 0.84.1, the selected sandbox library,
and explicitly pinned operator extensions. Pi's native controller and those
extensions may access the operator Pi profile and provider credentials.

Untrusted code consists of model output, standard filesystem/shell tool
commands, workspace contents, inbound files, project configuration, and chat
input. It must not execute outside the sandbox backend or install/load a Pi
extension. Arguments sent to a declared host-authority operator tool are
validated under that trusted extension's reviewed policy.

This means extension trust is binary for the MVP: an enabled operator extension
has host/controller authority. “Installed but untrusted” is not a supported
state.

## Non-negotiable controls

### Identity and state

- Accept exact static private-channel tuples derived from authenticated update
  metadata; never identity claims in content.
- Scope session, Turn, model change, interaction, artifact, cancellation, and
  delivery mutations by authenticated user in the same query/transaction.
- Reject duplicate identities, tuple reassignment, workspace path/inode drift,
  same-inode/nested workspaces, and service-root overlap.
- Persist admission before execution and never replay `starting`, `running`, or
  otherwise uncertain work.

### Pi controller and extensions

- Pin Pi and every extension by package/version/integrity or file digest.
- Use a host-private operator Pi auth/profile path; never mount it into the
  sandbox or expose it through media/tools.
- Disable discovery, project trust, context files, workspace settings,
  packages, project extensions, and implicit global extensions.
- Disable Pi built-in tools and load the mandatory Hitch extension explicitly.
- Attest the exact enabled tool/command/provider/extension snapshot before
  accepting a prompt.
- Operator extensions are trusted code. Users cannot install, enable, edit,
  reload, or supply them from chat/workspace.
- Bound and owner-bind extension UI requests; never treat their text/payload as
  identity or authority.

### Sandbox and process

- Every standard Pi file/shell tool and direct user/RPC bash path routes to the
  selected OS sandbox backend.
- There is no direct-execution fallback after extension, backend, resource, or
  namespace failure.
- Open and revalidate canonical workspace roots without symlink following.
- Expose only current workspace, current Turn inbox, bounded temp/runtime, and
  the scoped publication bridge; never other users, Hitch/channel state,
  provider auth, host home, or Pi profile.
- Deny sandbox external networking by default.
- Enforce wall, CPU, memory, process, temp, disk-quota, and output limits
  outside untrusted code.
- Cancellation/timeout kills and proves absence of the complete sandbox process
  tree before releasing capacity.
- A Pi session remains active after abort/timeout only after a proven terminal,
  close/flush, durable sync, and clean controller exit; ambiguity quarantines.

### Credentials and providers

- Channel credentials remain only in Hitch channel adapters.
- Provider credentials remain only in Pi's trusted controller/profile and may
  be visible to trusted operator extensions.
- No credential may enter the sandbox environment, files, arguments, VFS,
  workspace, inbox, tool input/result, RPC output, SQLite, audit, or chat.
- Provider login/logout and auth mutation are host-operator actions, never IM
  commands.
- Serialize provider-owning controllers globally until shared Pi profile/OAuth
  refresh behavior is proven safe across processes; never trade credential
  corruption for throughput.
- Model selection must resolve to Pi's attested available-model snapshot and
  optional static allowlist.
- Do not automatically replay a Turn after uncertain provider/controller
  interruption. Pi-native transient retries must be visible and abortable;
  Phase 0 records their exact behavior rather than making a false exactly-once
  provider claim.

### Media

- Stream intake to exclusive temps with advertised/observed byte limits,
  incremental hash, structural MIME/image checks, and atomic promotion.
- Bound image dimensions, decoded pixels, frames, names, captions, and counts.
- Mount inbound files read-only with generated names.
- Snapshot outbound files by verified descriptor with `openat2`, regular/
  single-link checks, pre/post metadata, and no path reopen.
- Never deliver a live path or object owned by another user/Turn.

### Persistence and operations

- Use private data roots, foreign keys, explicit transactions, quotas,
  retention, and bounded audit rotation.
- Removing a user/endpoint/extension disables immutable publication; it does
  not repurpose identity or silently mutate active sessions.
- Outbox delivery and extension replies recheck the original endpoint tuple and
  enabled owner.

## Accepted MVP compromises

- The operator Pi profile and provider accounts are shared service resources.
- Pi and approved operator extensions are in the provider-secret boundary.
- There is no protection from root, the Hitch service account, or a malicious
  approved extension.
- Configuration/restart replace dynamic administration and extension reload.
- Delivery may duplicate after an ambiguous channel response.
- Interrupted Pi/provider work becomes unknown and its session may quarantine.
- Audit is bounded metadata, not tamper-evident.

## Rejected shortcuts

- Loading workspace/project/chat-supplied Pi extensions.
- Assuming arbitrary extension tools are sandboxed automatically.
- Leaving any built-in/direct host tool path enabled beside the Hitch
  replacements.
- Falling back to host execution when the sandbox fails.
- Sharing workspaces, Pi session directories, or writable runtime/config paths.
- Passing provider/channel credentials into the tool sandbox.
- Treating prompts, forwards, filenames, callbacks, extension UI, or group
  sender ids as authenticated identity.
- Reading outbound files from unresolved strings or retrying unknown Turns.

## Minimum deterministic adversarial suite

1. Cross-user session/model/interaction/Turn/artifact id guessing.
2. Telegram/WeChat private tuples, group rejection, missing fields, duplicates,
   tuple drift, and idempotency conflicts.
3. Workspace absolute/`..`/symlink/hardlink/rename/mount overlap attacks.
4. Malicious `.pi` settings, context, extension, package, skill, prompt, and
   environment/proxy discovery attempts.
5. Tool enumeration proving only replacement tools, direct RPC bash routing,
   extension startup failure, duplicate override, and zero host fallback.
6. Sandbox reads of host home, Pi auth, Hitch state, other users, credentials,
   external network, and another Turn's publication bridge.
7. Sandbox forks, CPU/memory/disk/output exhaustion, timeout, cancellation, and
   complete process-tree cleanup.
8. Provider/model allowlist, unavailable auth, model switching, thinking
   levels, sanitized failures, and interrupted Pi controller behavior.
9. Extension command/UI ownership, expiry, replay, cross-user reply, excessive
   output, and unsupported TUI operations.
10. Media MIME spoofing, oversize, bombs, malicious names, symlink swaps,
    mutation, partial/orphan cleanup, and quota exhaustion.
11. Restart during every Turn, interaction, outbox, and possibly-sent state.

Live Telegram, WeChat, multiple Pi auth families, sandbox, media, and extension
acceptance use separately named opt-in commands and content-free manifests.

## Sanitized failures

Users receive a stable category and correlation id: `rejected`, `busy`,
`media-invalid`, `session-quarantined`, `model-unavailable`,
`extension-failed`, `sandbox-failed`, `agent-failed`, `delivery-failed`, or
`internal-error`. Provider bodies, credentials, tokens, host paths, raw tool
payloads, extension exceptions, and channel internals never enter chat/audit.
