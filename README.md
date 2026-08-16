# Hitch Pi MVP

Hitch Pi MVP is a deliberately narrow, self-hosted bridge between private
Telegram/WeChat conversations and sandboxed Pi coding-agent sessions.

The first release is an attended concept test for a small, personally trusted,
statically enrolled user set on one Linux host. Each user receives private
sessions, one configured workspace, native access to providers authenticated in
Pi, sandbox-routed tools, and native image/file delivery in both directions.

This repository starts fresh from the product boundary. It may copy small,
reviewed modules from `../hitch-hub`, but it does not import that repository at
runtime and does not inherit its generalized v2 domain model.

## Planning documents

- [Product scope](docs/product-scope.md)
- [Architecture](docs/architecture.md)
- [Native Pi and sandbox-extension decision](docs/runtime-extension-architecture.md)
- [Security floor](docs/security-floor.md)
- [Phase 0 execution contract](docs/phase-0-inputs.md)
- [Sol plan-review record](docs/plan-review.md)
- [Implementation plan](PLAN.md)
- [Luna implementation handoff](LUNA_HANDOFF.md)
- [Operator install, recovery, and reset guide](docs/operator-guide.md)
- [MVP acceptance record](docs/mvp-acceptance.md)

The durable foundation, Telegram and WeChat private-peer paths, native
Pi/Bubblewrap runtime, bounded media, and artifact outbox are implemented.
Earlier Phase 0 evidence under `spikes/` found four real
hardening gaps. The trusted-personal MVP reset accepts two as attended
operational risks, excludes the two unsupported operator extensions, and moves
live provider smoke to dogfooding. The smaller sequence is in
[PLAN.md](PLAN.md); the original findings remain in
[docs/phase-0-decisions.md](docs/phase-0-decisions.md).

## Development

The MVP requires Node.js 24. Building the mandatory sandbox helper also needs
`cc` and OpenSSL development headers; native operation needs Bubblewrap and a
working systemd user manager:

```text
npm ci
npm run check
npm run build
npm start -- --config /absolute/path/config.json
```

Copy `config.example.json`, create each configured workspace, Pi profile, and
WeChat state directory with mode `0700`, and keep bot tokens only in the named
environment variables. The command without a mode validates and publishes the
static configuration, initializes SQLite, reports content-free counts, and
exits. The complete operator path, including attended authentication and the
systemd user service, is in [the operator guide](docs/operator-guide.md).

The real channel workers can be exercised with the deterministic fake runtime:

```text
HITCH_TELEGRAM_PRIMARY_TOKEN=... \
  npm start -- --config /absolute/path/config.json --fake-channels
```

This mode uses the real configured Telegram/WeChat accounts and advances their
cursors, but returns clearly labeled fake Pi responses. Use disposable channel
accounts for it.

## Native Pi dogfood

Authenticate Pi out of band into the dedicated private profile before starting
Hitch. For example, run the pinned local Pi with
`PI_CODING_AGENT_DIR=/srv/hitch/pi-profile`, use its interactive `/login`, exit,
and confirm the profile and JSON files remain readable only by the service
user. Do not use a personal ambient Pi profile and do not put provider keys in
the Hitch service environment.

Keep an offline, owner-private backup of `auth.json` while the service is
stopped. If startup reports corrupt Pi profile JSON after a crash, restore that
backup or repeat the attended Pi login; the MVP deliberately does not patch
Pi's in-place credential writer.

After `npm run build`, start the real vertical slice explicitly:

```text
HITCH_TELEGRAM_PRIMARY_TOKEN=... \
  npm start -- --config /absolute/path/config.json --channels
```

Startup pins and checks Pi `0.84.1` plus its dependency closure, validates the
profile, compiles and pins the reviewed sandbox assets, obtains the native Pi
model catalog, and requires a fresh mandatory-extension/Bubblewrap attestation.
It exits if no authenticated model is available. Normal text and supported
images/files run a native Pi Turn. JPEG, PNG, GIF, and WebP become native Pi
image blocks, while other files are exposed read-only under `/inbox`.
`!send <relative-path>` and Pi's `hitch_publish` create immutable bounded
snapshots and deliver them through the originating channel's native file
methods.

The post-MVP chat command surface is `!new [name]`, `!sessions`,
`!switch <id-or-name>`, `!status`, `!abort`, `!stop`, `!recover`,
`!models [filter]`, `!model <provider>/<id>`, `!thinking <level>`,
`!send <relative-path>`, and `!help`. During longer native Turns, Hitch also
sends merged intermediate agent progress to the originating chat: at most one
message every 30 seconds, 4000 characters per message, and 64 KiB of progress
per Turn.

`config.example.json` documents `mediaMode`: `"always-trigger"` runs media-only
messages immediately, while `"text-trigger"` stages attachments for up to 10
minutes and merges them into the next text Turn. On hosts that need an HTTP
proxy for `api.telegram.org`, set `HITCH_TELEGRAM_PROXY` in the service
environment; Hitch proxies Telegram only, and WeChat API/CDN traffic stays
direct. Do not set generic `HTTP_PROXY`/`HTTPS_PROXY` for the Hitch process.

Authenticate a configured WeChat account with:

```text
npm run wechat:login -- --state-dir /absolute/private/wechat-state
```

Real provider and Telegram traffic is always opt-in and never runs in normal
CI. The host-only sandbox check can be repeated with:

```text
npm run acceptance:host
npm run acceptance:service
```
