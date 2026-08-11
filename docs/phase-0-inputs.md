# Phase 0 execution contract

This file pins the inputs that Phase 0 must use. Evidence produced with a
different input is not evidence for the MVP until this file is deliberately
updated and the affected checks are rerun.

## Pinned host and runtime baseline

| Input | Phase 0 value |
| --- | --- |
| Host architecture | Linux x86_64 |
| Observed kernel | `7.0.0-28-generic` |
| Node.js | `24.14.0` |
| npm | `11.9.0` |
| Bubblewrap | `0.9.0` |
| systemd | `255` (`255.4-1ubuntu8.17`) |
| Pi package | `@earendil-works/pi-coding-agent@0.84.1` |
| Pi tarball integrity | `sha512-ncAqFrG+iybuPGOhMiZoEHkEzTpJgz3guYD32pD+M7ucc0WeHmauP6wa7qwP8V/KWvsZDVNa5XGsdZ7fkC7w7A==` |

Production dependencies must be installed from a committed npm lockfile. The
acceptance evidence records the exact kernel, distribution, Bubblewrap,
systemd, Node, npm, Pi package, and lockfile hash actually used. A different
minor or patch version is an explicit compatibility test, not an implicit
upgrade.

The deployment host must support user, PID, mount, and network namespaces;
cgroup-v2 systemd scopes; `openat2`; Unix sockets; and enforceable filesystem
project quotas for every workspace and the service data root. Startup fails
closed when a required facility or configured quota cannot be verified.

## Pi process contract

Hitch launches Pi with an allowlisted environment built from an empty base.
The exact executable path is resolved and attested at service startup. The
worker receives only locale/runtime variables, its private paths, and the
Turn-scoped broker token. In particular, all upper- and lower-case HTTP proxy
variables and all known provider credential variables are absent.

The launch includes the equivalent of:

```text
PI_CODING_AGENT_DIR=/runtime/pi-config
PI_CODING_AGENT_SESSION_DIR=/session/pi-sessions
PI_OFFLINE=1
PI_TELEMETRY=0

pi --mode rpc
   --provider hitch-broker
   --model hitch-broker/<fixed-model-id>
   --thinking <fixed-reasoning>
   --api-key <turn-scoped-token>
   --session-id <stable-random-session-id>
   --session-dir /session/pi-sessions
   --offline
   --no-extensions
   --no-skills
   --no-prompt-templates
   --no-themes
   --no-context-files
   --no-approve
   --tools read,write,edit,ls,grep,find,bash,hitch_publish
   --extension /runtime/hitch-tools.mjs
```

`/runtime/pi-config` is generated into a fresh host-private Turn runtime,
attested, then mounted read-only. It contains only the fixed custom-provider
definition and required Pi settings and is discarded after the Turn. It must
not be copied from a user's home or a global Pi directory. Only
`/session/pi-sessions` is persistent and writable. The explicit extension is
Hitch-owned, versioned with the repository, mounted read-only, and is the only
extension Pi may load. Workspace files cannot affect Pi configuration, tools,
context, prompts, themes, or extensions. Phase 0 tests malicious workspace
copies of all known Pi discovery filenames. If Pi 0.84.1 cannot operate with
read-only generated config, stop and document the exact write before changing
the boundary; never make persistent configuration model-writable.

If Pi needs an additional environment variable or generated file, Phase 0 must
record its exact name, contents classification, permissions, and justification
before it is allowed.

## Provider decision — required before live Phase 0 acceptance

The existing project does not pin a real provider/model; selecting one based on
whatever local Pi credential happens to be available would make the proof
non-reproducible. The operator must set all fields below before the live gate:

| Input | Required value |
| --- | --- |
| Provider/API variant | **UNRESOLVED** |
| Exact upstream origin and path | **UNRESOLVED** |
| Exact model ID | **UNRESOLVED** |
| Reasoning setting | **UNRESOLVED** |
| Maximum output tokens | **UNRESOLVED** |
| Host credential environment-variable name | **UNRESOLVED** |
| Provider SDK retry-disable setting | **UNRESOLVED** |

The first choice should be an API-key provider that Pi can represent as a
custom OpenAI-compatible provider. OAuth or a provider requiring native
library semantics is allowed only by revising Phase 0 to use the concrete
Pi-native sidecar path and revising the estimate.

## Deterministic and live evidence

Phase 0 has two separate gates:

1. `npm test` uses a deterministic local upstream fixture and proves exact
   request parsing, multi-request tool loops, streaming, cancellation, image
   projection, failures, and sandbox denial without credentials or Internet.
2. `npm run acceptance:live-provider` is opt-in and exercises the exact
   provider/model above. It emits a content-free evidence manifest containing
   commit, lockfile, host/runtime versions, configuration digest, test names,
   timestamps, and sanitized outcomes.

Both gates are mandatory before Phase 0 is complete. Live credentials,
prompts, response content, and provider headers are never written to the
manifest. Telegram and WeChat have equivalent separately named live acceptance
commands; they are not part of the normal deterministic test command.
