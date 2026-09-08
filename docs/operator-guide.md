# Operator guide

This guide installs the trusted-personal MVP for one dedicated Linux service
user. It assumes the fixed example paths below; changing paths is supported by
updating the static config and user service, never source code.

The service is intentionally small: trusted, statically enrolled people use
private Telegram and/or WeChat chats; Pi owns provider authentication; Hitch
owns durable sessions and delivery; model file/shell work remains in the
mandatory Bubblewrap sandbox.

## 1. Host prerequisites

Use the pinned baseline in `docs/phase-0-inputs.md`: Linux x86-64, Node.js 24,
npm, Bubblewrap, systemd with a user manager, a C compiler, and OpenSSL
development headers. On Ubuntu, the non-Node packages are:

```text
sudo apt-get install bubblewrap build-essential curl libssl-dev
```

Install Node.js 24 through the operator's normal pinned package method and make
the production executable available outside any home directory as
`/usr/local/bin/node`. The supplied unit uses that exact path; if the host uses
a different system-wide path, edit `ExecStart` in the copied unit. An NVM path
inside `/home/hitch` is not a production service installation. Confirm the host
before continuing:

```text
/usr/local/bin/node --version
npm --version
bwrap --version
systemd-run --version
cc --version
```

Create a dedicated account and enable its persistent user manager. Substitute
an existing dedicated account if desired:

```text
sudo useradd --create-home --shell /bin/bash hitch
sudo loginctl enable-linger hitch
sudo install -d -o hitch -g hitch -m 0700 /srv/hitch
sudo -u hitch install -d -m 0700 \
  /srv/hitch/data \
  /srv/hitch/pi-profile \
  /srv/hitch/wechat-primary \
  /srv/hitch/workspaces/alice
```

Every configured data, profile, WeChat-state, and workspace path must be an
existing canonical `0700` directory owned by this service user. They must not
overlap or contain one another.

## 2. Install and verify the build

Place a clean checkout at `/opt/hitch-pi-mvp`, make it service-user owned, and
install only the committed lockfile:

```text
sudo chown -R hitch:hitch /opt/hitch-pi-mvp
sudo -iu hitch bash -lc \
  'cd /opt/hitch-pi-mvp && npm ci && npm run acceptance:deterministic'
```

The deterministic acceptance command formats, typechecks, builds the pinned
sandbox helper, and runs credential-free tests. On the deployment host, also
exercise the real systemd/Bubblewrap boundary without provider credentials:

```text
cd /opt/hitch-pi-mvp
sudo -iu hitch bash -lc 'cd /opt/hitch-pi-mvp && npm run acceptance:host'
sudo -iu hitch bash -lc 'cd /opt/hitch-pi-mvp && npm run acceptance:service'
```

The second host command runs the same native checks inside the service's actual
compatible resource/process restrictions. Do not proceed if any command fails.
Dependency upgrades are compatibility work; do not run `npm update` for this
MVP.

## 3. Static configuration

Copy `config.example.json` to `/srv/hitch/config.json`, then set the exact
account IDs, private-peer IDs, workspace paths, and a free-space threshold
appropriate for the host:

```text
sudo -u hitch cp /opt/hitch-pi-mvp/config.example.json /srv/hitch/config.json
sudo chmod 0600 /srv/hitch/config.json
```

Important fields:

- `telegramAccounts[].id` and `wechatAccounts[].id` are local labels.
- Telegram `userId` and `privateChatId` must match the intended private chat.
  Use the authenticated discovery procedure in Section 4 before Hitch starts;
  do not retain the example `123` values.
- WeChat `userId` is the exact private peer returned by the configured bot.
  If it is not known yet, complete the Section 4 WeChat QR login first, copy
  the printed scanner peer ID, then return here before validating config.
- Each user receives one non-overlapping workspace.
- Remove an unused channel account and its user endpoint rather than leaving a
  placeholder.
- `mediaMode` is `"always-trigger"` (default: a media-only message starts a
  Turn immediately) or `"text-trigger"` (media-only messages stage attachments
  for up to 10 minutes and the next text message merges them into one Turn).
  Staged attachments survive service restarts.
- `minimumFreeBytes` stops new work when the data filesystem falls below the
  configured reserve.
- `maxConcurrentTurns` (optional, default 2, valid 1–8) bounds how many native
  Pi controllers run at once across users. One user's Turns stay serialized;
  this setting only controls cross-user parallelism.
- `webSearch` (optional) configures host-controlled web search integration
  (Tavily). It requires `provider: "tavily"`, `apiKeyEnv` (the uppercase
  environment variable name in `service.env`, e.g. `"TAVILY_API_KEY"`), and
  `enabledUsers` (array of user IDs allowed to search, e.g. `["alice"]`). Set
  `enabledUsers: []` or omit `webSearch` to disable web search.

Validate and publish the topology without starting a channel or Pi:

```text
cd /opt/hitch-pi-mvp
sudo -u hitch npm start -- --config /srv/hitch/config.json
```

This should print one `initialized` JSON line and exit. It creates the private
SQLite database under the data root but does not contact a channel.

## 4. Authenticate outside chat

### Pi providers

Run the pinned Pi CLI as the service user with the dedicated profile. In Pi,
use `/login` for one provider, verify a model is available, then exit:

```text
cd /opt/hitch-pi-mvp
sudo -iu hitch bash -lc \
  'cd /opt/hitch-pi-mvp && PI_CODING_AGENT_DIR=/srv/hitch/pi-profile ./node_modules/.bin/pi'
```

Never use a personal ambient Pi profile and never put provider keys in
`service.env`. Stop Hitch before logging in, editing or restoring provider auth;
use an owner-private profile directory and `auth.json` (0700/0600).
`piProfileDir/auth.json` is the persistent shared authority for all configured
users, **not a startup seed**. Runtime OAuth refresh writes back there using a
shared lock and atomic replacement. Keep an owner-private stopped backup.
Per-user directories under `dataRoot/pi-profiles` still hold separate settings
and model caches; settings/models are synchronized at startup, model cache is
seeded only when absent. Auth is never copied again; legacy per-user auth is
retained but ignored. See Section 11 before upgrading an existing deployment.

### Telegram

Create the named secret environment file using the environment name referenced
by `botTokenEnv` in the JSON config:

```text
sudo -iu hitch bash -lc \
  'umask 077; read -rsp "Telegram bot token: " token; echo; \
   printf "HITCH_TELEGRAM_PRIMARY_TOKEN=%s\n" "$token" > /srv/hitch/service.env'
```

The token is read only by the channel worker. It is not stored in SQLite or
passed to Pi's tool sandbox.

Before starting Hitch, send the bot a private message such as `!status`. Then
read that pending update with the Bot API and print only its identity fields.
This command loads the token from the private file and streams it to curl's
configuration input, so it is absent from shell history and process arguments.
If `botTokenEnv` has a different name, change the variable name below:

```text
sudo -iu hitch bash -lc '
  set -eu
  . /srv/hitch/service.env
  printf '\''url = "https://api.telegram.org/bot%s/getUpdates"\nfail\nsilent\nshow-error\n'\'' \
    "$HITCH_TELEGRAM_PRIMARY_TOKEN" |
  curl --config - |
  /usr/local/bin/node -e '\''
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      const envelope = JSON.parse(body);
      if (envelope.ok !== true || !Array.isArray(envelope.result)) process.exit(1);
      for (const update of envelope.result) {
        const message = update.message;
        if (message?.chat?.type === "private" && message.from?.id != null && message.chat?.id != null) {
          console.log(`userId=${message.from.id} privateChatId=${message.chat.id}`);
        }
      }
    });
  '\''
'
```

Copy the exact `userId` and `privateChatId` for the intended sender into
`config.json`. If nothing prints, verify the user messaged this bot privately
and rerun the command. Do this while Hitch is stopped because its normal poller
intentionally rejects and advances updates from endpoints not yet enrolled.

To replace a compromised or rotated Telegram bot token, stop the service,
rewrite `/srv/hitch/service.env` with the new value using the same `umask 077`
procedure above, then start the service again. Only the token changes; Hitch
keeps its durable Telegram update cursor and configured peer IDs, so chat
enrollment does not need to be redone. Confirm delivery with `!status` in the
private chat before resuming normal use.

### WeChat

Build first, then run the attended QR flow for each configured state directory:

```text
cd /opt/hitch-pi-mvp
sudo -iu hitch bash -lc \
  'cd /opt/hitch-pi-mvp && npm run wechat:login -- --state-dir /srv/hitch/wechat-primary'
```

Open the printed URL, scan and confirm it. Copy the printed scanner private-peer
ID into `config.users[].wechat.userId`. Credentials and the reset cursor are
written atomically to the private state directory. Repeat login after an
expired session; never copy one authenticated bot state into two configured
accounts.

### Web search (Tavily)

When `webSearch` is configured, add the referenced API key variable to
`/srv/hitch/service.env` with owner-only permissions:

```text
sudo -iu hitch bash -lc \
  'umask 077; read -rsp "Tavily API key: " key; echo; \
   printf "TAVILY_API_KEY=%s\n" "$key" >> /srv/hitch/service.env'
```

The key is loaded on host startup only for configured egress requests. It is
never persisted to SQLite or shared with model tool sandboxes. If web search
is not configured or `enabledUsers` is empty, no key is required.

## 5. First foreground run

Start the complete service in the foreground before enabling systemd:

```text
cd /opt/hitch-pi-mvp
sudo -iu hitch bash -lc \
  'if [ -f /srv/hitch/service.env ]; then set -a; . /srv/hitch/service.env; set +a; fi; \
   cd /opt/hitch-pi-mvp; npm start -- --config /srv/hitch/config.json --channels'
```

The single startup line reports `native-pi`, a catalog digest, user count, and
channel-account counts. Stop with `Ctrl-C`. Startup fails closed if the Pi
package, sandbox assets, profile, topology, WeChat state, or user systemd scope
cannot be validated.

`--fake-channels` is available for a clearly labeled fake-Pi exercise, but it
still contacts real configured channels and advances their cursors. Use it only
with disposable test channel accounts.

### Telegram proxy

If this host can only reach `api.telegram.org` through an HTTP proxy, set the
single-purpose variable in `service.env`:

```text
HITCH_TELEGRAM_PROXY=http://proxy-host:port
```

Hitch applies that proxy to Telegram Bot API requests only. Do not set generic
`HTTP_PROXY`/`HTTPS_PROXY` for the Hitch process: WeChat API and CDN traffic
must stay on a direct path (a generic proxy has produced truncated WeChat media
downloads during dogfood), and a generic proxy environment would also flow into
Pi's provider and tool network behavior. A WeChat-only proxy path is not
supported in this release.

## 6. User systemd service

The production runtime uses transient user scopes for every sandbox operation,
so install the supplied unit in the dedicated user's systemd manager:

```text
sudo -u hitch install -d -m 0700 /home/hitch/.config/systemd/user
sudo -u hitch install -m 0600 \
  /opt/hitch-pi-mvp/systemd/hitch-pi-mvp.service \
  /home/hitch/.config/systemd/user/hitch-pi-mvp.service
```

Before enabling it, edit only the copied unit if install/config paths or the
absolute system-wide Node 24 path differ. Then:

```text
HITCH_SERVICE_UID="$(id -u hitch)"
sudo -u hitch env XDG_RUNTIME_DIR="/run/user/$HITCH_SERVICE_UID" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$HITCH_SERVICE_UID/bus" \
  systemctl --user daemon-reload
sudo -u hitch env XDG_RUNTIME_DIR="/run/user/$HITCH_SERVICE_UID" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$HITCH_SERVICE_UID/bus" \
  systemctl --user enable --now hitch-pi-mvp.service
sudo -u hitch env XDG_RUNTIME_DIR="/run/user/$HITCH_SERVICE_UID" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$HITCH_SERVICE_UID/bus" \
  systemctl --user status hitch-pi-mvp.service
```

The unit deliberately omits systemd mount-namespace and empty capability-set
directives because they prevent nested Bubblewrap on the pinned host. The
dedicated controller and enrolled users are trusted; the mandatory inner
Bubblewrap boundary still confines model tools. The unit retains compatible
privilege, address-family, task, descriptor, and memory bounds.

## 7. Attended concept acceptance

Run these only with the intended personal accounts. Record unavailable
channels rather than substituting a synthetic live result.

1. In each available channel, send `!new acceptance`, `!models`, and a normal
   prompt. Confirm only the matching user's workspace changes.
2. Select a model with `!model provider/id`; use `!thinking level` when the
   selected model supports it.
3. Send a common JPEG/PNG and an ordinary small file. Confirm the image is
   understood and the ordinary file is visible in the Turn inbox.
4. Ask Pi to produce a small result and publish it, or send
   `!send relative/path`. Confirm a native image/file arrives in the originating
   channel.
5. Start a longer Turn, send `!abort`, and confirm it is cancelled. Check that
   no `hitch-p0-*.scope` remains with
   `systemctl --user list-units 'hitch-p0-*.scope' --all`.
6. When `mediaMode` is `"text-trigger"`, send a media-only message and confirm
   the "Saved N attachment(s)" reply, then send text and confirm the staged
   attachments merge into one Turn. `!status` reports the staged count.
7. Restart the service and confirm sessions remain listed. Hitch quarantines
   any Turn that was ambiguous at restart and never replays it automatically.

## 8. Operations and recovery

View lifecycle logs without following chat content into shell commands:

```text
HITCH_SERVICE_UID="$(id -u hitch)"
sudo -u hitch env XDG_RUNTIME_DIR="/run/user/$HITCH_SERVICE_UID" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$HITCH_SERVICE_UID/bus" \
  journalctl --user -u hitch-pi-mvp.service -n 200 --no-pager
sudo -u hitch env XDG_RUNTIME_DIR="/run/user/$HITCH_SERVICE_UID" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$HITCH_SERVICE_UID/bus" \
  journalctl --user -u hitch-pi-mvp.service -f
```

Restart after changing static config, provider authentication, or channel
credentials. Configuration publication disables removed users/endpoints; it
does not silently transfer their sessions.

For a consistent backup, stop the service and archive `/srv/hitch` to an
owner-private offline destination. This captures config, SQLite/WAL state, Pi
auth, WeChat state, workspaces, transcripts, and immutable media together:

```text
HITCH_SERVICE_UID="$(id -u hitch)"
sudo -u hitch env XDG_RUNTIME_DIR="/run/user/$HITCH_SERVICE_UID" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$HITCH_SERVICE_UID/bus" \
  systemctl --user stop hitch-pi-mvp.service
sudo sh -c 'umask 077; tar --xattrs --acls -C /srv -czf /root/hitch-backup.tgz hitch'
sudo -u hitch env XDG_RUNTIME_DIR="/run/user/$HITCH_SERVICE_UID" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$HITCH_SERVICE_UID/bus" \
  systemctl --user start hitch-pi-mvp.service
```

Recovery rules:

- Corrupt Pi profile: restore the stopped profile backup or repeat Pi `/login`.
- Expired/corrupt WeChat state: stop, rerun `wechat:login`, then restart. Login
  deliberately resets that account's remote cursor/context state.
- Uncertain prior Turn: use `!recover` to cancel its queued successors, then
  `!new` for a clean session. Do not manually mark it successful or replay it.
- Low disk: stop the service and free space outside live Hitch roots. Do not
  manually delete SQLite-referenced blobs or transcripts.
- Database or data-root loss: restore the whole stopped backup, not individual
  database files.
- Repeated channel delivery failure: correct the account/peer/credential and
  restart promptly. Delivery may duplicate after an ambiguous response and
  permanently failed rows have no MVP chat retry command.
- Telegram bot token rotation: stop, rewrite only the token variable in
  `service.env` (Section 4), and restart. Cursors and peer enrollment survive;
  never edit the token file while the service is running.

## 9. Known MVP limits

- Users are personally trusted and statically configured; there is no signup,
  role system, group chat, or public multi-tenancy.
- Workspaces have no kernel project quotas. Hitch enforces media/session limits
  and a free-space stop threshold; the operator still monitors workspace use.
- Pi `auth.json` may require backup restore or re-login after a host crash.
- Channel delivery can duplicate after an ambiguous response, but an agent
  Turn is never rerun for that reason.
- WeChat large-image CDN downloads can be truncated by the WeChat service
  (about 240 KiB observed during dogfood). Hitch validates JPEG completeness
  and preserves a truncated image as an opaque inbox file so the message is
  never silently dropped.
- Intermediate agent progress is best-effort: at most one merged message every
  30 seconds, at most 4000 characters per message and 64 KiB of progress per
  Turn. A failed progress message never reruns or quarantines the Turn.
- Automated retention, a failed-delivery retry UI, optional operator
  extensions, skills/MCP, a broad provider matrix, and hardened hostile-server
  handling are post-MVP.

## 10. Disable or completely reset

Disable while keeping recoverable data:

```text
HITCH_SERVICE_UID="$(id -u hitch)"
sudo -u hitch env XDG_RUNTIME_DIR="/run/user/$HITCH_SERVICE_UID" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$HITCH_SERVICE_UID/bus" \
  systemctl --user disable --now hitch-pi-mvp.service
sudo -u hitch mv /srv/hitch /srv/hitch.disabled
```

That move is recoverable by moving it back before re-enabling the service.
For a complete reset, first make any desired offline backup, confirm the
service is stopped, then remove the explicit installation and disabled data
paths using the host's normal administrative deletion policy. Also remove the
copied user unit and reload the user manager:

```text
HITCH_SERVICE_UID="$(id -u hitch)"
sudo -u hitch env XDG_RUNTIME_DIR="/run/user/$HITCH_SERVICE_UID" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$HITCH_SERVICE_UID/bus" \
  systemctl --user disable --now hitch-pi-mvp.service
sudo -u hitch rm /home/hitch/.config/systemd/user/hitch-pi-mvp.service
sudo -u hitch env XDG_RUNTIME_DIR="/run/user/$HITCH_SERVICE_UID" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$HITCH_SERVICE_UID/bus" \
  systemctl --user daemon-reload
sudo rm -rf /opt/hitch-pi-mvp /srv/hitch /srv/hitch.disabled
sudo loginctl disable-linger hitch
```

The final recursive removal is intentionally explicit and irreversible. Verify
both paths and the offline backup before running it. Delete the `hitch` account
only if it is dedicated to this service and its home contains nothing else.


## Forge Mode A (prompt-only subset)

Mode A reads an operator-prepared root, **not** the interactive global Forge
home. It imports the pinned `@zihanw/pi-forge/service` entry, never Forge's root
Pi extension. No subagents, editor, provider login, plugins, or project discovery
are enabled. The current bundled service is a local prerelease; see
`../vendor/README.md` for reproducible source provenance.

Optional configuration (absent or an empty user list disables the catalog):

```json
"forge": {
  "root": "/srv/hitch/forge-resources",
  "enabledUsers": ["alice"]
}
```

Copy the examples under `examples/forge/` to that operator-owned root, preserving
`prompt-stacks/*.json` and `agent-profiles/*.json`. Directories/files must be
owned by the service operator and not writable by group/others; do not symlink
or hardlink resources. The canonical root must be separate from all workspaces,
Hitch data, Pi auth profiles, and channel-state directories. Resources are read
once at startup: restart to publish edits. Never put credentials in prompts.

- `!preset list`, `!preset use research`, `!preset preview research`
- `!profile list`, `!profile use research`, `!profile preview research`
- `!preset status`, `!profile status` (also the no-argument defaults)
- `!preset clear` / `!profile clear` clears the selection only if its kind matches;
  clearing the other kind is a no-op. There is one shared Forge selection.

A preset and a profile are alternative selections, not two independently
layered states. Selection belongs to the Hitch owner/session and survives
controller and service restarts. Changes are refused while that session has
queued or active work. Applying a profile validates and sets its model/thinking
once; later `!model` / `!thinking` remains authoritative. Clearing Forge does
not reset model selection. An omitted model in the supplied sample profile
retains the current model (or Hitch's existing first-catalog fallback).

Supported: system blocks, static parameters, bounded supplied-data slots,
replace/append/prepend prompts, and Forge allow/deny tool globs. `allow: []`
keeps Forge's original unrestricted-within-baseline semantics; use `deny: ["*"]`
for no tools. Policies only shrink the enabled Hitch 8/9-tool baseline. The
sample research preset cannot activate web search if operator configuration
has not enabled it. An unmodified chat-history slot is accepted as a marker;
Pi retains natural history. Valid empty rendering (including a model-only
profile) explicitly preserves Pi's base system prompt, matching the Forge
compiler; it does not restore disabled tools. Malformed configuration still
fails initialization. Regex/history filters, synthetic user/assistant
messages, skills/imports, custom macros/slots, and project-scoped references
fail explicitly. This is not full desktop Forge compatibility.

Limits: 64 KiB/resource, 128 resources combined, 1 MiB/catalog, 32 KiB compiled
system content and 64 KiB serialized controller prompt configuration. Preview
uses current time but does not represent a running model/tool snapshot; actual
Turns supply their effective model/tools/time.

**Database upgrade:** this version migrates schema 3 to 4 to retain Forge
selection. Back up the database while stopped before deploying. A code-only
rollback to B2 cannot read schema 4; a rollback needs the pre-upgrade database,
which loses any newer messages unless separately reconciled. No live Mode A
deployment or migration is implied by code acceptance. Dogfood remains on B2
until an attended switch is explicitly arranged.


## 11. Shared operator authentication (AUTH-1)

This section describes the new code, not proof that an existing deployment has
been migrated. Deterministic real-CLI fixtures passed; an attended real-provider
and channel check is still required. No new config key or auth database exists.

### Upgrade an existing deployment

1. Arrange a maintenance window. Confirm turn queue, active sandbox scopes and
   pending deliveries are idle, then stop the service using Section 8. Stop any
   desktop Pi or other process using the same rotating OAuth authorization.
2. Take an owner-private stopped backup of the deployment, including the
   operator profile **and** old per-user profiles. Do not print their contents,
   send them in chat, put them in a workspace or commit them to Git.
3. Choose the single current authority at `piProfileDir/auth.json` in the
   operator terminal. Older versions refreshed separate clones, so the original
   source may be stale. Do not select a clone by timestamp alone, merge refresh
   tokens, or automatically overwrite from the old seed. If currency cannot be
   established, use the pinned Pi `/login` command in Section 4 against this
   dedicated profile while stopped. It must produce a valid, private auth file;
   a missing/corrupt/linked file causes fail-closed startup.
4. Deploy an immutable build and retain the previous release/config. AUTH-1
   itself has no schema migration, but the combined Mode A code uses schema 4:
   upgrading a live schema-3 B2 deployment requires its stopped DB backup and an
   explicit data-loss decision for rollback. Do not assume code-only rollback.
5. Start the new service. Check available models and send an attended test turn
   from the intended private channel. Then, while idle, restart and repeat.
   Only metadata and success/failure belong in logs or an acceptance report.
   Dummy refresh tests do not establish real-provider refresh acceptance; test
   actual refresh when feasible without editing or revealing tokens.

### Daily operation and recovery

- All approved users share the operator account's permissions, quota, rate
  limits and failure/revocation domain. Check provider terms. Their session,
  workspace and model-cache isolation remains unchanged.
- Service-stopped operator `/login` is the recovery path; there is no remote
  chat login and no UI fallback. Restart afterward to refresh the model catalog.
  Do not edit auth during active work, share the entire Pi profile directory,
  or keep separate rotating-token copies in a concurrent desktop instance.
- The controller accepts literal API keys and Pi `$VAR` / `${VAR}` templates
  with `$$` / `$!` escapes. Provider-scoped auth environment is supported;
  ambient host environment is not generally inherited. Missing references and
  leading `!command` key commands fail closed. Do not move provider secrets to
  a model-visible file or enable host command execution to work around this.
- Shared updates use the canonical `auth.json.lock` convention (30s stale,
  bounded 30s wait). Ordinary model requests are not all serialized; the
  read→refresh→save transaction is. Never remove a live lock to unblock a turn.
- Atomic local replacement prevents a partially written authority. It cannot
  prevent remote token rotation followed by a crash before local persistence;
  an old backup may already be invalid, requiring re-login. A failed save can
  also mean a new complete file exists but directory fsync failed. Do not
  automatically retry by restoring an old token. While stopped, remove only
  confirmed orphan `auth.json.tmp-*` files; these are private secret-bearing
  files, not diagnostics to upload.
- Additional plugin writers (notably pi-agy) are not integrated or certified.
  Do not enable them merely because they recognize the same auth format.

### Rollback

Stop and retain the current state first. For an AUTH-1-only rollback on the same
DB schema, preserve the latest authoritative operator auth, restore compatible
code/config, and re-login if needed. **Do not blindly restore old auth clones.**
The old runtime clones auth again, so its original persistence defect returns.
For combined Mode A→B2 rollback, schema 4 is not readable by B2: restoring the
pre-upgrade schema-3 backup discards newer messages/state. Obtain agreement on
that loss or repair forward; restoring old credentials does not repair schema.


## 12. Fixed Antigravity provider (AGY-1)

Set optional `antigravity: true` to explicitly load the shipped provider-only
adapter in both catalog and turn controllers. Default is false. It exposes no
account-management commands, runtime login UI, additional tools or linked-account
pool. Do not load the full desktop extension alongside it.

Use operator-terminal login in an isolated staging profile, then perform the
stopped, provider-specific import described in `docs/antigravity-plan.md`. Never
send tokens/callback URLs in chat or overwrite shared auth with the whole staging
file. Ordinary API-key models keep working while this authentication is pending.

The local artifact adds `antigravity/gemini-3.8-flash`; npm 0.6.1 alone does not.
Profiles for it need thinking low/medium/high (use low), not off. It will not
quietly substitute Gemini 3.7 on a 404. Verify real availability before changing
working profile defaults. A successful new-session model-less profile now uses
the same default-model fallback as ordinary turns; manual overrides remain.
