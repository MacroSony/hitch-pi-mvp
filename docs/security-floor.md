# Security floor

This project intentionally cuts architectural scope, not the controls that
separate users, host data, and provider credentials.

## Non-negotiable controls

### Identity

- Accept only exact statically configured private-channel identities.
- Derive identity from authenticated Telegram/WeChat update metadata.
- Never accept user, workspace, session owner, or endpoint from message text.
- Scope every session, Turn, artifact, cancellation, and delivery query by the
  authenticated user.
- Reject duplicate identities, tuple reassignment, workspace inode/path drift,
  same-inode or nested workspaces, and overlap with any service-controlled root.

### Filesystem and process

- Linux Bubblewrap is required; there is no direct-execution fallback.
- Canonical workspace roots are opened and revalidated without following
  symlinks before launch.
- Mount only the current user's workspace/session state and current Turn inbox.
- Do not mount the service data directory, host home, channel state, or another
  user's paths.
- Use a private home, bounded tmpfs, fresh PID namespace, minimal `/proc`, and
  empty external network namespace.
- Launch Pi from an empty-base environment with discovery, project approval,
  startup networking, implicit extensions, skills, prompts, themes, and context
  files disabled. Load only the versioned Hitch extension and explicit tools.
- Enforce wall-clock, memory, process, temporary-storage, and combined output
  limits outside the worker.
- Require enforceable workspace and service-data quotas; fail startup rather
  than operating on an unbounded filesystem.
- Cancellation and timeout kill and confirm absence of the complete process
  tree before releasing the user execution slot.
- Keep a session active after cancellation/timeout only after a proven Pi
  terminal, close/flush, durable-sync, and clean-exit boundary. Forced or
  ambiguous termination quarantines the transcript even when the Turn outcome
  is `cancelled` or `timed-out`.

### Credentials and broker

- Channel and provider credentials exist only in the trusted host service.
- Pi receives only an expiring, Turn-scoped broker token.
- The broker selects the upstream URL, provider credential, and model.
- Broker request bodies and responses are bounded and are never logged.
- Permit only one in-flight request and a bounded sequential tool loop per
  Turn; revoke the token at cancellation or terminalization.
- Disable retries at every provider/HTTP layer. No automatic provider retry
  occurs after request forwarding starts or its outcome becomes ambiguous.
- Reject redirects, `CONNECT`, absolute-form targets, conflicting framing or
  authority, forbidden headers, wrong media types, and compressed/SSE limit
  bypasses.

### Media

- Stream to exclusive temp files; enforce advertised and observed count/byte
  limits, hash incrementally, and atomically promote only validated content.
- Sniff supported image types; do not trust platform filenames or MIME alone.
- Bound image dimensions, frame counts, and decoded pixels to reject
  decompression bombs.
- Sanitize display names and generate storage names.
- Inbound files are read-only to the Turn.
- Outbound files are immutable snapshots opened beneath the user's workspace
  without symlink traversal.
- Open outbound sources by verified directory descriptor, accept regular
  single-link files only, compare pre/post metadata, and never reopen the path.
- Never deliver a live path or a snapshot owned by another user/Turn.

### Persistence and recovery

- Use a private data root and SQLite foreign keys/transactions.
- Persist admission before execution.
- Do not replay work found `starting` or `running` after restart.
- Mark its outcome unknown and quarantine its session until explicit recovery
  replaces it; do not continue a possibly advanced Pi transcript.
- Keep provider/channel secrets, broker tokens, and raw tool payloads out of
  SQLite and logs.

## Deliberate shortcuts

These are accepted MVP compromises:

- Configuration and restart replace a dynamic administration service.
- One installation role exists operationally: the host operator.
- One provider/model policy applies to all enabled users.
- There is no protection from root or the service account.
- There is no group-chat authorization model.
- Delivery may duplicate after an ambiguous platform response.
- Interrupted provider work becomes `unknown` rather than being reconciled.
- The audit log is a bounded metadata trail, not a tamper-evident ledger.
- Pi session transcripts are private per user but readable by that user's
  sandbox shell; they contain that user's own conversation.

## Rejected shortcuts

- Sharing one workspace or Pi session directory between users.
- Putting a provider credential, channel token, or host-control token in the
  worker environment or mounted files.
- Relying on Pi tool names or prompts instead of filesystem/process isolation.
- Allowing unrestricted host networking from the sandbox.
- Reading outbound files by unresolved string path.
- Retrying an uncertain agent/provider submission.
- Treating group sender IDs, forwarded messages, captions, filenames, or
  callback payloads as authenticated identity.
- Falling back to unsandboxed execution when Bubblewrap, cgroups, or broker
  setup fails.

## Minimum adversarial suite

The normal test command must exercise:

1. cross-user session/Turn/artifact identifier guessing;
2. workspace `..`, absolute, symlink, hardlink, rename, and mount-overlap cases;
3. shell attempts to access host home, service state, other users, credentials,
   external network, and broker operations for another Turn;
4. broker token expiry, replay, model substitution, oversized requests, extra
   headers, redirect behavior, cancellation, and uncertain forwarding;
5. media MIME spoofing, oversized content, malicious names, symlink swaps, and
   post-authorization mutation;
6. worker forks, memory exhaustion, output flooding, timeout, and complete
   process-tree cleanup;
7. duplicate channel messages and restart during queued, starting, running,
   sending, and possibly-sent states;
8. deterministic Telegram and WeChat identity fixtures for private acceptance,
   group rejection, malformed/missing fields, duplicate ids, and tuple drift;
9. Pi discovery attacks from malicious workspace files and environment/proxy
   variables; and
10. quota exhaustion, `EDQUOT`/`ENOSPC`, orphan-temp cleanup, retention, and
    audit rotation.

Live Telegram, WeChat, and provider acceptance are separate opt-in commands.
They must pass for the private MVP release and produce content-free manifests,
but the normal test command remains deterministic and credential-free.

## Sanitized failure contract

Users receive one stable category plus a correlation id: `rejected`, `busy`,
`media-invalid`, `session-quarantined`, `agent-failed`, `provider-unavailable`,
`provider-outcome-unknown`, `delivery-failed`, or `internal-error`. Provider
bodies, tool payloads, host paths, exception strings, credentials, tokens, and
channel internals never enter chat errors or audit metadata.
