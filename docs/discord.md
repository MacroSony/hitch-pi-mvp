# Discord Luna — text and file connections

Status: M1/M2, including cross-Turn originals and combined replies, have isolated LunaTest user acceptance. Implementation scope is [discord-plan.md](discord-plan.md). Optional M3 Anima generation code and an isolated real-model/GPU probe are accepted; live test-instance enablement/receipt remain an attended gate. See [M3 results](discord-m3-result.md).

## Connection selection

Discord is configured beside Telegram/WeChat/WeCom, not as a separate agent backend. A static `users[]` entry now denotes a **workspace owner**: a legacy private person, one Discord DM, or one Discord server. A server owner is not its speaking member. Every accepted Discord prompt stores the real author ID, display name, guild/channel IDs, message ID, timestamp and optional reply reference, both as `turns.discord_source` and as a JSON-escaped prompt prefix.

See [the example](../examples/discord.config.json). Its IDs and paths are placeholders. Secrets are environment-variable references only.

- `discordAccounts`: optional list of `{id, botTokenEnv, messageContent?}`.
- `users[].discord.mode: "dm"`: exact account + peer user ID + DM channel ID. Each enrolled peer gets a separate owner/workspace/context. No automatic signup or dynamic workspace creation.
- `users[].discord.mode: "server"`: exact account + guild ID + nonempty `channelIds` and `adminUserIds` lists. All human members in those channels are trusted to prompt. No bot/webhook traffic, group DMs, threads, forum/announcement channels or history import in M1.
- All allowed channels in a server connection share one selected context and workspace. **Use channels with the same intended audience.** A file/context shared at server scope cannot remain private to one channel.
- A Discord owner cannot also carry Telegram/WeChat/WeCom endpoints. Historical private owners cannot become servers, nor can existing Discord owners be reassigned to a different peer/server/account. Create a new owner and distinct private directory instead of reusing old personal state.
- `forgeProfile` can select an existing operator-published profile through the existing Forge catalog. A new Luna persona is intentionally deferred; no old private persona/archive was imported.

### Trigger and content intents

DM messages trigger directly. Server messages (including attachments) trigger only on an explicit mention of the bot or a reply to a bot message. Attachments are downloaded immediately after route and trigger approval, never from denied/nontrigger/bot/webhook messages. Nontrigger messages are not stored or fed to Pi. At most one referenced message is fetched, only after checking the configured route; its text is not imported into context.

By default the SDK requests Guilds, GuildMessages and DirectMessages, with DM channel partials. DM and explicit bot mentions work without the privileged MESSAGE_CONTENT intent. **A reply that does not ping/mention the bot may have empty content without that intent.** For reliable non-pinging replies, explicitly set `messageContent: true` and enable MESSAGE CONTENT INTENT in the Discord developer portal (and obtain approval if the application requires it). Otherwise use an explicit @mention; an unreadable triggered message receives a content-free explanatory reply, never an empty model Turn. Enabling the intent does not enable background listening.

## Commands and shared authority

In a server, only IDs in `adminUserIds` can invoke any `!` command. The list is static; Discord roles/display names do not grant access. An ordinary member may chat but cannot run `!new`, `!abort` or change models. In DM, the exact enrolled peer controls only their own owner scope.

Supported M1 commands: `!new`, `!sessions`, `!switch`, `!status`, `!abort`, `!stop`, `!recover`, `!compact`, `!models`, `!model`, `!thinking`, `!help`. Server commands still require a mention or bot-reply trigger. Use `!new` to start a fresh shared conversation; this is not a workspace deletion/reset.

`!send`, `!wake`, `!profile`, `!preset`, slash/extension commands, LOCAL targets/delivery/scheduling are explicitly unavailable on Discord. Existing channels retain their previous behavior. File intake and artifact delivery use the existing immutable media pipeline; no arbitrary workspace path is opened by the Discord transport.

**Admin commands are not a model privilege boundary.** All server members are trusted co-owners of the shared workspace and can ask the same sandboxed agent to read/write it. Prompt text and display names never acquire operator authority, but this is not a design for adversarial members or private per-member files inside a shared workspace. Standard model tools still use the mandatory sandbox; credentials and private DM/other-owner workspaces stay outside it.

## Files (M2)

- Same existing inbound limits: 8 files, 20 MiB per file, 40 MiB total; image inspection/validation and owner storage/free-space quotas are unchanged. Documents remain opaque; no new document extension allowlist. Files claiming to be images use existing image validation.
- `mediaMode: "text-trigger"` stages attachment-only messages for up to 10 minutes and queues a saved-file acknowledgement; the next ordinary text prompt consumes that owner's staged files. In `always-trigger`, attachment-only messages use the existing “Please inspect the attached media.” prompt. Server messages still need @mention or a bot reply, even with files.
- Server files/staging belong to the server owner's **shared** workspace across all configured channels, not the individual uploader. DM files belong only to that DM owner. No private per-member server attachments.
- Current images provide both native visual input (where supported) and original read-only files under `/inbox`; documents also receive read-only `/inbox` paths. The model can copy originals into its persistent owner workspace.
- Discord later Turns re-materialize a bounded recent window of inbound originals from **the same owner and session**, retaining each original generated `/inbox` filename. Selection considers at most 64 earlier-terminal attachment candidates, excludes future queued Turns, and prioritizes current files within the combined 8-file / 40 MiB budget. Historical images are **not** resent as new visual input. This is not a complete archive or arbitrary artifact lookup API: files outside the window may need reupload or a prior workspace copy. `!new`/recovery starts a separate session window; it does not erase the owner workspace.
- Model-produced images/documents upload to the originating channel using verified immutable objects. Named constant `DISCORD_UPLOAD_LIMIT_BYTES` defaults to **10 MiB (10 × 1024 × 1024 bytes)** per file. Larger artifacts fail durably without compression/splitting; a separately durable text notice gives name, byte size and limit. Upload errors/cancellation retain the existing bounded outbox retry behavior.
- CDN downloads allow only HTTPS Discord attachment hosts, reject redirects, and have a 30-second deadline. Expiring URLs are not persisted as file storage. Busy ingress/offline gaps still have M1's bounded/no-indefinite-replay limitation.

## Transport and persistence

- Pinned `discord.js@14.19.3`; exact dependency graph/integrity in lockfile, compatible with pinned Node 24.14.0. SDK owns Gateway heartbeat/resume/reconnect and REST buckets. Bot identity comes from authenticated Ready state, not token decoding or manual user-ID configuration.
- Discord emits typing plus durable final/error responses and file attachments, not token streaming or tool-progress dumps. Results reply to the original message/channel when available; missing originals do not block delivery.
- An eligible complete, unsent same-Turn reply combines its nonempty text (at most 2000 UTF-16 units) and 1–8 files in **one Discord message**. Each file and the combined file bytes must fit 10 MiB. Constituent outbox rows are claimed and completed/retried atomically; already partially delivered replies are not recombined. Long text, larger batches and oversize failures keep the existing separate delivery/notice paths rather than losing content. An ambiguous request can still duplicate the whole message on retry; this is not exactly-once delivery.
- Discord REST explicitly uses platform fetch captured before the WeChat-specific global override, avoiding the mixed-Undici dispatcher multipart failure. This does not change WeChat's transport.
- Every outbound message disables all mention parsing and reply pings.
- Text uses <=2000 UTF-16 units per chunk, without broken surrogate pairs, capped at 16 chunks with a truncation notice. Markdown fences are not rewritten; very long fenced blocks may render across separate messages.
- Shared owner FIFO remains one active + three queued Turns. Async ingress is serialized and bounded (64 pending); overload is dropped with a sanitized operator warning rather than unbounded memory growth.
- DB admission/source and outbox are durable. Duplicate events cannot rerun admitted work. Ambiguous sends/retries can duplicate messages; cancellation never knowingly marks unsent/uncertain work sent. No exactly-once or indefinite offline replay claim.
- Discord connection failures retry independently and must not take down existing channel workers. Raw SDK errors and token-bearing objects are never logged. Existing global service startup validation may still reject invalid configuration or missing credentials before any channel starts.
- Schema8→9 is an attended offline migration: adds workspace scope, endpoint mode and source metadata, preserving legacy IDs/rows/FKs. Other supported historical migrations also chain to9. Do not run an old binary against schema9 or restore an old SQLite backup over new data.

## Attended test setup (not executed automatically)

1. Use a dedicated test data root, separate DM/server workspaces and test configuration, not the production dad/zihan data root. Create owner-only directories (0700) and follow the existing operator guide for the Pi profile and sandbox. Provider auth sharing needs explicit operator planning; do not clone rotating auth to create independent writers.
2. Reuse the old application identity only after verifying ownership, token availability and that no old Luna process is consuming the same bot. If that bot already belongs to production servers, preferably use a separate test application; otherwise enable only the test guild/channels in Hitch and keep production routes absent.
3. Operator creates a test server, invites the bot with View Channel, Send Messages, Attach Files, Read Message History and required application bot scope; no Administrator permission is required. Obtain snowflakes with Discord developer mode / Copy ID, including the DM channel ID.
4. Store the bot token privately via the existing service environment mechanism; never paste it in chat or source/config JSON. For `messageContent: true`, enable the matching portal intent before startup.
5. Run deterministic tests first. Configuration check (`node dist/src/main.js --config …`) creates/migrates the supplied data root but does not connect channels. `--fake-channels` means **fake Pi with REAL channel transports**, not a network-free test: use only the attended test configuration. `--channels` enables native Pi and live transports.
6. Test DM and test guild: two members/two allowed channels share context, DM remains private, ordinary nontrigger text is ignored, reply and @mention work, source labels are correct, nonadmin control fails, long text/Unicode behaves, restart preserves context, channel replacement preserves shared selection, and denied channels stay silent. A second member/account is needed for real multi-author acceptance; fake fixtures alone are not that proof.
7. Upload an image without asking for preservation; on a later Turn ask to copy and return that original. Verify the original path still works within the recent window, returned bytes match, and short explanatory text plus files arrive in one message. Repeat across restart, and verify another owner/new session cannot retrieve the old inbox originals. Workspace copies intentionally remain owner-persistent. Test long/oversize/partial/retry fallbacks separately.
8. Only after user-visible acceptance and explicit approval, prepare a separate production rollout/backup plan. This implementation does not authorize connecting the real server or changing the existing service.

M3's first opt-in Anima text-to-image path now has fixed workflow policy, owner-bound durable jobs, targeted cancellation and background publication; see [M3 plan](discord-m3-plan.md) and [results](discord-m3-result.md). Image editing, broader model/workflow selection and video remain deferred. Real-time voice, unsolicited speech and public multi-server enrollment remain out of scope.
