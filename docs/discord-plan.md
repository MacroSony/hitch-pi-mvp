# Discord Luna M1 — operator-approved implementation plan

Status: local implementation authorized 2026-10-01; live credentials, service changes and production guild activation are NOT authorized. Base d14d1c6. Work only in this worktree.

## Scope and decisions

Users are personally trusted. Add Discord alongside existing channels, with static DM/server connection selection. M1 is text: DM replies to each message; server responds only to explicit bot mention or reply to the bot, no background listening/history import. Reject bots/webhooks/unsupported group DMs/threads. Source is generated from authenticated Discord events, never inferred from message text or display name. M2 file transport, M3 ComfyUI paint, new Luna profile and attended test guild/DM acceptance follow separately.

Each DM owns independent workspace/context. Each configured server owns shared workspace/context across its explicitly allowed text channels. A server is a workspace owner, NOT a human author: author ID is carried separately on every admitted message. All allowed channels must have the same intended audience; sharing a workspace/context is explicit cross-channel disclosure. No private zihan/dad owner or mixed-channel connection is allowed on a Discord owner in M1. No public/hostile tenant claims or arbitrary roles framework.

Admin IDs are a nonempty static list on server connection. DM owner controls their own DM. Server members can prompt; only configured admin IDs execute supported control commands. M1 Discord excludes !send, !wake, LOCAL delivery/scheduling, extension commands (!profile/!preset/!commands and slash), and attachment intake. These are explicit rejections, not silently fed to the model. Existing channels retain behavior. No token-by-token stream/edit; typing plus durable text results. Optional existing per-owner forgeProfile can supply a persona; no new persona material this phase.

## Concrete config contract

Optional `discordAccounts: [{id, botTokenEnv, messageContent?}]` defaults to []. MESSAGE_CONTENT is opt-in for non-pinging replies, not background listening. A `users[]` row is a sandbox/workspace OWNER, now either a private legacy user, one Discord DM or one Discord server. Optional `discord` union:

- `{mode:"dm", account, userId, channelId}` exact DM tuple.
- `{mode:"server", account, guildId, channelIds:[...], adminUserIds:[...]}` one shared owner per (account,guildId), 1..32 text channels, 1..32 admin IDs.

Snowflakes are nonzero canonical decimal strings (17..20 digits, <= uint64 max). Reject duplicates, unknown accounts, Discord mixed with telegram/wechat/wecom, multiple owners for same DM peer or same server. Explicit channel IDs prevent broadcast/auto-enrollment; no raw credentials.

Topology `PublishedUser.scopeKind?: "private"|"discord-dm"|"discord-server"` defaults private for legacy fixtures. `PublishedEndpoint.discordMode?: "dm"|"server"`, kind gains discord. For discord: platformUserId is scope ID (DM peer or guild), privateChatId is destination channel ID (legacy column name; not an author claim). Tuple `["discord", account, mode, scopeId, channelId]`. Every server channel gets a distinct endpoint for correct outbox destination, but selected session is synchronized owner-wide.

Schema9: users.scope_kind NOT NULL DEFAULT private, immutable on republication including historically disabled owners. channel_endpoints.discord_mode nullable, CHECK enforcing Discord mode/non-null channel and null mode on legacy channels. turns.discord_source nullable valid JSON to persist source/reference alongside prompt. Existing endpoint/turn/session/outbox IDs preserved. Old migrations chain to9. Foreign key check before migration commit. No production database touched.

## Application / transport contracts

New `src/channels/discord-ingress.ts` exports `DiscordMessage` (normalized by trusted SDK adapter), `DiscordSource`, `classifyDiscordMessage(botUserId:string, value:unknown): DiscordIngress|null`, `discordPrompt(source,text)` and `discordDigest(source,text)`.

Normalized message shape:
```
{id, channelId, guildId: string|null, channelType: "dm"|"guild-text"|"unsupported",
 author:{id,name,bot:boolean}, webhookId?: string|null, content:string,
 mentionsBot:boolean, referencedAuthorId?:string, replyToMessageId?:string,
 timestamp:string, hasAttachments:boolean}
```
`DiscordSource` includes messageId/channelId/guildId/authorId/authorName/timestamp/replyToMessageId (optional). `DiscordIngress` includes mode, scopeId, channelId, authorId, source, text, idempotencyKey, hasAttachments. Classifier validates structure/bounds, ignores bot/webhook/self/unsupported/nontrigger guild messages; strips exact bot mention tokens, not human names; no media download. Reply detection requires referencedAuthorId===botUserId and valid reference ID. Source label is JSON-escaped and separate from user content, cannot grant command permissions.

`HitchApplication.receiveDiscord(accountId:string, botUserId:string, value:unknown): IngressResult` validates exact store tuple and static admin policy supplied to application. Admission uses raw text to parse commands, then wraps only ordinary prompts with source. Store gets discordSource optional on MessageIdentity, persists it for prompt/control turns; outbox can recover reply reference by join.

Store exports `resolveDiscordEndpoint(accountId,mode,scopeId,channelId)`, `pendingDiscordOutbox(accountId,limit=20)`. `OutboxDelivery` optional `discordSource?: DiscordSource`; privateChatId is original destination channel. Worker receives `new DiscordWorker(accountConfig, application, store, options?)`; app exposes `discordRouteAllowed(accountId,mode,scopeId,channelId): boolean` to gate REST reference fetch before content/attachment work. Credentials supplied only in options/client construction by main, not application/store. Worker `run(signal)` plus `deliverPending(signal?)` / testable injected transport. Can choose a slightly different constructor with clear final handoff.

SDK owns Gateway heartbeat/reconnect/resume/rate limit. Worker filters allowed scope before reference fetch. REST sends disable all mentions and reply pings; include source message reference with fail_if_not_exists:false. Split at <=2000 UTF-16 units without breaking surrogate pairs, bounded chunks with clear truncation if needed. Retry may duplicate chat delivery, never rerun agent work. M1 artifact outbox must fail clearly (not retry forever) and never open paths. Error logs sanitized (no SDK objects/errors with credentials). Discord worker failure must not terminate other channels; reconnect with bounded backoff. Real network disabled in deterministic tests.

## Review gates

1. Foundation/config/schema migration and negative cases.
2. Gateway adapter/ingress test fixtures without live credentials.
3. Shared session routing, explicit author, admin gate, DM/server/workspace isolation, source persistence/restart, correct origin outbox.
4. Existing full deterministic suite + independent review; fix blockers.
5. Report local result, remaining risks and attended test prerequisites. Do not claim live DM/guild acceptance.


## Integration adjustments

Final transport contract is in `src/channels/discord.ts`: injected `DiscordClient`
exposes authenticated `botUserId`, `connect(onMessage, signal)`, bounded sends
and reference lookup. Worker uses required typed application/store methods
rather than optional duck-typed fallbacks. Config exposes `messageContent` for
non-pinging replies; the portal setting must agree. Shared session fallback
includes disabled historical endpoints so replacing all allowed channels does
not lose the selected context. Owner↔Discord scope binding is immutable in both
directions, including disabled history. See `docs/discord.md` for final setup
and accepted limitations.
