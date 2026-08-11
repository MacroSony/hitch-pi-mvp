# Phase 0 execution contract

Evidence produced with different inputs is not MVP evidence until this file is
updated and affected checks rerun.

## Pinned baseline

| Input | Phase 0 value |
| --- | --- |
| Host | Linux x86_64, kernel `7.0.0-28-generic` |
| Node.js / npm | `24.14.0` / `11.9.0` |
| Bubblewrap | `0.9.0` |
| systemd | `255` (`255.4-1ubuntu8.17`) |
| Pi | `@earendil-works/pi-coding-agent@0.84.1` |
| Pi integrity | `sha512-ncAqFrG+iybuPGOhMiZoEHkEzTpJgz3guYD32pD+M7ucc0WeHmauP6wa7qwP8V/KWvsZDVNa5XGsdZ7fkC7w7A==` |
| Gondolin candidate | `@earendil-works/gondolin@0.12.0` |
| Gondolin integrity | `sha512-BXbvzQKb5QmxY5NtthRDONJTu7+IDKbzqWGrJyyNXMP7N681Tx0Q9TK8pK1ba8nUvYQTipNJyGZOsJfYiZll1A==` |
| QEMU | not currently installed; required only for Gondolin evaluation |

Production installs from a committed lockfile. Evidence records exact kernel,
distribution, runtime, package, extension, sandbox asset, QEMU (if used), and
lockfile hashes. A version change is a compatibility test, not an implicit
upgrade.

The Bubblewrap path requires namespaces, cgroup-v2 systemd scopes, `openat2`,
Unix sockets, and project quotas. A Gondolin path additionally pins QEMU,
kernel/initramfs/rootfs assets, image checksums, VFS/network policy, and external
resource governance.

## Pi controller contract

The controller is trusted and uses a dedicated operator-managed Pi profile,
not a user's home profile. Provider login happens out of band with normal Pi
auth and the profile is never visible to the sandbox.

The initial CLI proof is equivalent to:

```text
PI_CODING_AGENT_DIR=/srv/hitch/pi-profile
PI_CODING_AGENT_SESSION_DIR=/srv/hitch/users/<user>/pi-sessions
PI_OFFLINE=1
PI_TELEMETRY=0

pi --mode rpc
   --session-id <stable-random-session-id>
   --session-dir /srv/hitch/users/<user>/pi-sessions
   --offline
   --no-extensions
   --extension /opt/hitch/extensions/hitch-sandbox.mjs
   --extension /opt/hitch/extensions/<approved-operator-extension>.mjs
   --no-builtin-tools
   --tools read,write,edit,ls,grep,find,bash,hitch_publish
   --no-skills
   --no-prompt-templates
   --no-themes
   --no-context-files
   --no-approve
```

Explicit extensions still load with `--no-extensions`; all paths are
operator-owned, read-only, and digest-attested. The mandatory extension must
successfully register every listed tool and direct user/RPC bash routing before
Hitch submits a prompt. Phase 0 must prove the exact 0.84.1 behavior rather
than assume registration order or tool replacement semantics.

The environment is allowlisted from an empty base. Provider credentials and
provider-scoped environment values should be stored in the dedicated Pi
profile rather than inherited from Hitch. If a provider cannot operate that
way, its exact required environment names are added to the trusted controller
only and documented; they never enter sandbox operations.

The CLI proof may be replaced with Pi's SDK only if it materially improves
explicit ResourceLoader control and retains the tested RPC/event contract.

## Provider/model proof

There is no single provider selection gate. Phase 0 queries native Pi for:

- registered providers and models;
- authenticated/available status without exposing credential material;
- model input/reasoning capabilities; and
- extension-registered providers.

The result is a content-free startup snapshot and digest. Deterministic tests
use a test provider extension. Live acceptance selects available native models
through Pi RPC and exercises at least one API-key provider and one OAuth
provider when the operator profile has them. Providers not called live remain
available but are reported as inventory-only evidence until first use.

Phase 0 also races two isolated Pi processes against a disposable auth-profile
fixture and records file-lock/atomic-refresh behavior. Production remains at
one global active provider-owning controller unless real OAuth refresh and
failure injection prove a safe higher concurrency strategy.

Users cannot authenticate providers through IM. Hitch can statically filter
the Pi catalog but never add a provider/model that Pi did not report.

## Sandbox candidates

The Bubblewrap candidate must reuse only bounded reviewed launcher/path-helper
code from `../hitch-hub` and live entirely behind `hitch-sandbox`.

The Gondolin candidate uses the Pi 0.84.1 example as reference, not as an
unreviewed production dependency. Evaluation includes image supply chain, QEMU
arguments, RealFSProvider path behavior, network defaults, systemd resource
limits, cancellation, startup cost, and asset cleanup. Its own documentation
states that DoS governance is incomplete, so Hitch must supply it if selected.

The `@anthropic-ai/sandbox-runtime` Pi example is excluded because it only
replaces bash and permits a local-bash path when sandboxing is disabled or not
initialized.

## Deterministic and live evidence

`npm test` is credential-free and proves RPC framing, model snapshot/selection,
extension loading/UI, complete tool replacement, sandbox denial, cancellation,
session recovery, and fake channel identities.

Separately named opt-in commands cover live Pi providers, Telegram, WeChat,
media, and the selected sandbox backend. Each emits a content-free manifest
with commit, lockfile, Pi profile/catalog digest, extension manifest, sandbox
artifacts, host versions, test names, timestamps, and sanitized outcomes.
