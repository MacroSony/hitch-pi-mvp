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
- `minimumFreeBytes` stops new work when the data filesystem falls below the
  configured reserve.

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
`service.env`. Hitch validates this profile before native startup. While the
service is stopped, keep an owner-private offline copy of `auth.json`; the
pinned Pi writer is not crash-atomic.

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
6. Restart the service and confirm sessions remain listed. Hitch quarantines
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

## 9. Known MVP limits

- Users are personally trusted and statically configured; there is no signup,
  role system, group chat, or public multi-tenancy.
- Workspaces have no kernel project quotas. Hitch enforces media/session limits
  and a free-space stop threshold; the operator still monitors workspace use.
- Pi `auth.json` may require backup restore or re-login after a host crash.
- Channel delivery can duplicate after an ambiguous response, but an agent
  Turn is never rerun for that reason.
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
