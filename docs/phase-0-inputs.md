# Phase 0 execution contract

Status: completed historical evidence contract. The 2026-08-13
trusted-personal MVP reset in `PLAN.md` accepts selected operational findings
and supersedes the former no-go release policy. The pinned observations and
artifact digests remain valid design evidence.

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
| Pi installed-tree SHA-256 | `7298ead16e553a8ffc372ca6a5a17ccfd711ae0887830134255dcea08be55bba` (package tree excluding dependency `node_modules`) |
| Pi installed dependency-closure SHA-256 | `6d2055eaeef6823fd4b6edc062314e383fc6e233a4634a13e868a86eaebbcec4` (complete installed tree including `node_modules`) |
| Gondolin candidate | `@earendil-works/gondolin@0.12.0` |
| Gondolin integrity | `sha512-BXbvzQKb5QmxY5NtthRDONJTu7+IDKbzqWGrJyyNXMP7N681Tx0Q9TK8pK1ba8nUvYQTipNJyGZOsJfYiZll1A==` |
| QEMU | not currently installed; required only for Gondolin evaluation |
| Pi Forge candidate | installed `@zihanw/pi-forge@0.4.0`, integrity `sha512-/B8DBXtqFLIl+Llrr1HJRYUDd2cd4jDt6CsJdBC8kCxn9Kh6Wes9AUpT+b6Cl5NB9oSMtaL0YhYitvfyUk00lQ==`, installed-tree SHA-256 `4e3eb7894ea12b357f2be7b15929ad9b71f0d64f7e84d9b4e1a8ba075b32ef8d`; released artifact lacks the required Hitch service mode |
| ComfyUI Paint candidate | installed `pi-comfyui-paint@0.3.0`, integrity `sha512-6LWaOObIXWvVu49Ycz/UUb8Dd/LgPoh6gYSiwRUPNhhRUvEDuePlnC4RjBElLIkdbLfcEvCTMKGQANds8dA/Iw==`, installed-tree SHA-256 `023684bd2cdaf9d18d2ca405ff8767d2d8fa473dd8981fd2bec7d9c4074ffec6`; released artifact lacks the required Hitch service mode |
| Volcengine provider candidate | installed `pi-volcengine-provider@0.1.2`, integrity `sha512-Cv5ZArW9Yr5su6dEvuyK3YCoLVL7nCg5FK8abCquKRpU57PnZs2+9u9hWeOZtxBMMtNZU4wGFdh59iyaelOxQA==`, installed-tree SHA-256 `9dfa09264530ff487eee87b1a920706cd8fce9b4639c93b36304bdf83eb288e1`; inventory-only pending live smoke |
| Legacy transport reference | `../hitch-hub` commit `f3b90e57f19d345616b94119174113e96129bf78`; exact selected-file hashes recorded by the transport inventory |
| Telegram transport candidate | direct Bot API long polling; legacy adapter is reference-only and no client package is selected |
| WeChat transport client candidate | installed `wechat-ilink-client@0.1.0`, integrity `sha512-/gsWGEGEsWA7C5cgfKtguCL7QPdT95I1HfHHiRcHtwQppwVfgD8aDL4m4soANp1qQDl5RgiJ7q9gh9X5cXUfqA==`, installed-tree SHA-256 `6205dfffd66cef090dab6981fb01b11d7db17c89c7b80c17f7206340fe726302`; raw API live-inventory candidate only |

Production installs from a committed lockfile. Evidence records exact kernel,
distribution, runtime, package, extension, sandbox asset, QEMU (if used), and
lockfile hashes. A version change is a compatibility test, not an implicit
upgrade.

The Bubblewrap path requires namespaces, cgroup-v2 systemd scopes, `openat2`,
and Unix sockets. Project quotas are recommended post-MVP; the initial attended
deployment uses application limits and free-space admission. A Gondolin path
additionally pins QEMU, kernel/initramfs/rootfs assets, image checksums,
VFS/network policy, and external resource governance.

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

Hitch deliberately does not pass the overlapping built-in names through the
CLI `--tools` allowlist. P0a proved that `--no-builtin-tools --tools read,...`
reactivates a built-in tool when the mandatory extension omits its replacement.
After every explicit extension has loaded, `hitch-sandbox` sets the exact
expected active tool names through the extension API and attests every tool's
source path, schema, and manifest membership. Pi's pinned ResourceLoader must
also reject duplicate registrations before RPC initialization; Phase 0 tests
both extension load orders because `getAllTools()` alone is not collision
detection. Any built-in or wrong source, missing or unexpected tool, duplicate
registration, or later surface mutation aborts the Turn before provider
transport.

The environment is allowlisted from an empty base. Provider credentials and
provider-scoped environment values should be stored in the dedicated Pi
profile rather than inherited from Hitch. If a provider cannot operate that
way, its exact required environment names are added to the trusted controller
only and documented; they never enter sandbox operations.

The CLI proof may be replaced with Pi's SDK only if it materially improves
explicit ResourceLoader control and retains the tested RPC/event contract.

## Certified operator-extension proof

Phase 0 uses the exact installed artifacts and compatibility contracts in
`docs/operator-extension-compatibility.md`. It does not load sibling source
trees. For each candidate it records:

- package/tarball integrity and complete installed-tree digest;
- declared and effective tools, commands, providers, events, UI operations,
  configuration/resource roots, environment names, host paths, and network
  destinations;
- behavior with project trust and all project/global discovery disabled;
- model/thinking/tool-surface mutations and Hitch reconciliation;
- fresh-controller, abort, timeout, shutdown, and background-work behavior;
- output/media bounds and sanitized RPC/IM projection; and
- accepted, rejected, and operator-only features.

Forge and ComfyUI Paint did not pass this proof and are not loaded by the
initial MVP. They no longer block the core product path.

## Provider/model proof

There is no single provider selection gate. Phase 0 queries native Pi for:

- registered providers and models;
- authenticated/available status without exposing credential material;
- model input/reasoning capabilities; and
- extension-registered providers.

The result is a content-free startup snapshot and digest. Deterministic tests
use a test provider extension. Initial live acceptance selects available native
models through Pi RPC and exercises at least one provider available in the
operator profile. A broader API-key/OAuth matrix is post-MVP. Providers not
called live remain inventory-only evidence until first use.

Phase 0 also races two isolated Pi processes against a disposable auth-profile
fixture and records locking, refresh, and crash-injected persistence behavior.
Pi 0.84.1 serializes refresh under a file lock but writes `auth.json` in place;
a mid-write `SIGKILL` leaves invalid JSON. The attended MVP accepts operator
backup/re-login recovery, validates the profile before startup, and retains one
global active provider-owning controller. A durable temp-write/rename fix is
post-MVP hardening; serialization does not make an individual write
crash-atomic.

The global lock is also a session-transcript control. Pi permits two processes
to append to the same JSONL session as sibling branches; the file remains
parseable but only one concurrent Turn is on the selected leaf path. Hitch
therefore passes the exact `--session <private-jsonl-path>` when reopening a
session and never relies on `--session-id` lookup or opens the same transcript
concurrently.

An RPC `prompt` success means preflight/acceptance, not Turn completion. Hitch
does not submit dependent RPC operations or close the controller until Pi's
`agent_settled` event, which follows tool cycles, automatic retries, and other
continuations. Pi also defers creation of a new session file until an assistant
message exists, so Hitch persists its own session row and requested
model/thinking immediately and treats the Pi transcript path as provisional
until the first completed assistant message. After `agent_settled` and clean
controller exit, Hitch opens the transcript read-only, calls `fsync` on it and
its parent directory, and quarantines the session if either sync or close
fails. Pi's own JSONL appends do not provide that durability boundary.

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
