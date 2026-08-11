# Native Pi runtime and sandbox-extension decision

Status: proposed MVP architecture, pending Phase 0 proof

## Decision

Run Pi as the trusted provider-owning controller and move every standard Pi
filesystem/process operation behind one mandatory Hitch sandbox extension.

This deliberately replaces the earlier design in which the whole Pi process
ran inside Bubblewrap and reached one provider through a Hitch inference
broker. The new design favors Pi compatibility and extension flexibility:

- Pi uses its native `ModelRuntime`, `auth.json`, `models.json`, built-in
  providers, OAuth refresh, and provider extensions.
- Hitch uses Pi RPC `get_available_models`, `set_model`, and thinking-level
  commands instead of maintaining a provider catalog or protocol proxy.
- The mandatory `hitch-sandbox` extension replaces every built-in tool and
  direct user-shell path, then delegates operations into an OS sandbox.
- Provider credentials stay in the trusted Pi controller. They never enter the
  tool sandbox, workspace, inbox, tool output, channel message, or Hitch log.

The consequence is explicit: Pi and every controller extension are inside the
provider-credential trust boundary. Arbitrary extensions cannot be both fully
privileged Pi extensions and untrusted code. This is an accepted private-MVP
tradeoff.

## Runtime shape

```text
Telegram / WeChat
        |
   Hitch core
 identity, sessions, queue, DB, media, outbox
        |
   Pi RPC controller (trusted)
 native providers + operator Pi auth
 mandatory hitch-sandbox extension
 optional allowlisted operator extensions
        |
   sandbox backend
 /workspace rw, /inbox ro, bounded /tmp
 no provider auth, no Hitch/channel state
        |
 model-created commands and file operations
```

Each Hitch session keeps Pi's private transcript and selected provider/model.
Each Turn starts a fresh Pi RPC controller against that session. Only one Turn
per user runs at once. A crash or forced close still quarantines the session
unless a durable Pi terminal/flush boundary is proven.

## Provider and model behavior

Hitch points Pi at one operator-managed, host-private Pi profile. On startup it
asks Pi for the models whose providers are registered and authenticated. The
snapshot is filtered only by an optional static operator allowlist, recorded by
digest, and exposed through:

- `!models [filter]`;
- `!model <provider>/<model-id>`;
- `!thinking <level>`; and
- Pi/extension model-selection UI translated to IM interactions.

Model and reasoning selection persist per Hitch session. Users cannot add,
remove, log in, log out, or mutate provider credentials through chat. The
operator uses normal Pi authentication out of band and restarts Hitch to
publish a changed provider/extension snapshot.

This supports built-in API-key providers, Pi OAuth providers, custom providers,
and providers registered by trusted extensions without Hitch understanding
their wire protocols.

## Extension support and trust tiers

### Mandatory Hitch extension

`hitch-sandbox` is loaded explicitly from a pinned, read-only artifact. Pi
built-in tools are disabled; the extension re-registers `read`, `write`,
`edit`, `bash`, `grep`, `find`, and `ls`, plus `hitch_publish`. It also routes
direct RPC/user bash into the same backend. Failure to initialize or attest the
extension is fatal and never falls back to host tools.

### Operator extensions

Static configuration may enable reviewed extension packages globally or per
user. They are pinned by package/version/integrity or file digest, loaded from
operator-owned read-only paths, and receive the normal Pi extension API:

- tools and commands;
- lifecycle and provider events;
- provider registration;
- system-prompt/event behavior supplied by the extension; and
- RPC extension UI.

Hitch lists extension commands with `!commands`, forwards `/command` prompts,
and maps `select`, `confirm`, `input`, notifications, and status requests to
bounded, expiring IM interactions. Unsupported TUI-only UI fails clearly.

Operator extensions execute in the trusted Pi controller. Their model-callable
tools are not automatically sandboxed: the extension must use the Hitch
sandbox client when it needs untrusted execution, or explicitly declare that
it is a host-authority tool. An operator extension can read provider auth or
make host network calls, so enabling one is equivalent to installing trusted
service code. Hitch reports its tool/command names and manifest digest but
cannot infer the safety of arbitrary TypeScript.

### Rejected for the MVP

Workspace `.pi/extensions`, chat-driven extension installation, unpinned npm
or Git sources, and arbitrary user-supplied extension code are not loaded.
Safely running those requires putting the whole Pi process back inside a
sandbox and restoring an inference broker, or implementing a large extension
API proxy. Neither is a shortcut.

## Sandbox backend choice

Phase 0 compares two concrete backends behind the same mandatory extension:

1. **Custom Bubblewrap backend — default candidate.** Reuse the reviewed
   launcher, `openat2`, process-tree, and workspace-tool code from
   `../hitch-hub`. It is installed on the current host and has the least new
   operational surface.
2. **Gondolin backend — compatibility candidate.** Pi 0.84.1 ships a complete
   example that overrides all seven built-in tools and direct `!` commands,
   while leaving provider auth in host Pi. Gondolin offers a QEMU micro-VM and
   programmable VFS/network policy, but is described upstream as experimental,
   needs QEMU and roughly 200 MiB or more of guest assets, and does not provide
   complete denial-of-service governance. QEMU is not currently installed on
   the target host.

The Pi `sandbox` example based on `@anthropic-ai/sandbox-runtime` is not an MVP
candidate: it overrides only bash and can fall back to local bash when disabled
or initialization fails.

Phase 0 chooses one production backend using startup latency, cancellation,
resource limits, workspace/inbox semantics, media publication, and adversarial
tests. Hitch core depends only on the extension contract; it does not contain
provider-specific or sandbox-backend-specific routing.

## What becomes simpler

- no provider wire-protocol proxy or custom provider translation;
- no per-provider retry, streaming, header, OAuth, or model-catalog logic;
- native access to every Pi-authenticated/registered provider;
- native provider and extension upgrades remain Pi compatibility work; and
- the core owns IM/session/media concerns rather than agent internals.

What does not disappear is the sandbox security work. The extension/backend
must still prove complete tool replacement, path confinement, process-tree
cleanup, resource quotas, media publication, and fail-closed startup.
