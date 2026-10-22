# Discord M2 — local file transport result

Date: 2026-10-21. Branch: `feat/discord-files`, based on M1 `51ede5e`.

## Scope and design

Inbound Discord attachments now use the existing owner-bound immutable MediaStore and staged/artifacts/turn_artifacts pipeline. Worker route + trigger classification precedes downloads (`src/channels/discord.ts:539`); bots/webhooks/denied/nontrigger messages never download. DM owners remain private; server members and allowed channels share their configured server owner's files/context/workspace.

`text-trigger` stages attachment-only messages; `always-trigger` admits them with the existing inspect-media prompt. Attachment digests use content hashes, not expiring URLs/generated IDs. Terminal admission records deduplicate staging without a schema migration. Discord consumes staging and admits/stages atomically with SQLite savepoints (`src/app/store.ts:911`), preserving files on rejected admission. Duplicate downloads are discarded like the other transports.

Pi receives existing artifacts; native runtime uses images or read-only `/inbox` files (`src/pi/native-runtime.ts:1783,1851`). Workspace copies use existing sandbox tools, not a new Discord file writer.

Outbound images/documents use `MediaStore.verifiedObjectPath` then discord.js attachment upload (`src/channels/discord.ts:382`). Mentions/reply pings stay disabled. Oversized artifact failure and explanatory text enqueue are atomic (`src/app/store.ts:2633`); normal outbox retry/restart/cancellation semantics remain. No raw SDK errors are logged.

## Limits actually reused

- `src/media/media-store.ts:50-52`: 8 inbound artifacts, 20 MiB/file, 40 MiB total. Worker imports these constants; streaming ingest verifies actual byte count and advertised size (`:502`). Store retains matching admission/staging bounds.
- `src/media/media-store.ts:55-58`: 2 GiB owner media/session quota; maximum image side 16,384, decoded pixels 40,000,000, animation frames 100. Free-space threshold and content sniffing/validation are reused (`:454`). JPEG/PNG/GIF/WebP sniffing is unchanged; opaque documents have no new extension allowlist. Image-advertised attachments use existing `expectImage` validation, including existing incomplete-image fallback behavior.
- `src/app/store.ts:24,2297`: staged files expire after 10 minutes; maximum 8 staged/40 MiB owner-wide. Expiry produces the existing resend notice.
- `src/media/media-store.ts:701,725`: outbound digest/path verification and read-only inbox materialization.
- New Discord-specific outbound cap: `DISCORD_UPLOAD_LIMIT_BYTES`, `src/channels/discord.ts:92`, **10 MiB = 10,485,760 bytes** (named constant, not a new config field). No split/compression. SDK and worker both enforce it.
- CDN download transport: HTTPS `cdn.discordapp.com` / `media.discordapp.net`, no redirects, 30-second deadline (`src/channels/discord.ts:349`).

## Verification

Final `npm run check` passed (format:check, typecheck, build and full tests): **353 total / 329 pass / 24 opt-in skip / 0 fail**. M1: **338 / 314 / 24 / 0**; delta **+15 passing tests**, no added skips. Evidence: `test/discord-files.test.ts`; existing Discord/other-channel tests also ran. Local check output: `/tmp/discord-files-check.log` (ephemeral).

Coverage includes DM/server mention staging/dedup; attachment-only always-trigger/inbox; ignored/denied/bot/webhook no-download; inbound over-limit and stream-size mismatch; server cross-channel sharing versus DM isolation; image/document outbound; verified SDK payload and mention policy; oversized durable failure + notice after reopen; upload retry/cancellation; staged-file preservation on busy rejection and duplicate text.

No Discord login/network, live provider, credential file, production data/service, sibling worktree or push was used. No packages added. No functional owner-decision deviations. Implementation interprets the named 10 MB default as 10 MiB and exposes the exact bytes in notices; owner should verify live Discord's effective account limit.

## Owner-only attended LunaTest acceptance (not run)

1. Follow `discord.md` isolated test-root/service instructions. Use LunaTest only; verify no other process consumes it. Supply secrets privately; do not paste tokens. Add Attach Files permission alongside View/Send/Read History; never Administrator.
2. DM: upload a small PNG and text/PDF document with and without text. In text-trigger, confirm saved acknowledgement then ask to inspect; in always-trigger, confirm immediate inspection. Ask the agent to copy a document into its own workspace and read it on a later Turn.
3. Server: upload with @LunaTest; upload via reply to bot (with configured/portal MESSAGE_CONTENT if non-pinging). Attachment-only mention must stage/trigger per mediaMode. Ordinary unmentioned uploads, denied channels, bot/webhook events and threads must stay silent and unconsumed.
4. From a second trusted member and another allowed channel, ask to use the server file. Verify it is shared. Ask from the DM and verify server files are unavailable; verify DM uploads cannot be read by server or another DM owner.
5. Have the sandbox model publish an image and document; verify real downloadable attachments in the originating DM/server channel, no mention notifications, correct filenames/content. Verify another allowed channel is not the outbound destination.
6. Publish a file above 10,485,760 bytes; verify a short name/size/limit notice, failed artifact row, no upload/compression/split and no endless retry. Restart the isolated instance before delivering the notice to verify persistence.
7. Check >20 MiB inbound, >8 files/40 MiB batch, malformed image, staged expiry, revoked Attach Files permission, transient disconnect/retry and restart. Expect bounded errors and no secrets in logs; ambiguous retries may duplicate sends.
8. Verify !send/!wake/LOCAL/extensions/slash/threads/paint remain rejected. Get explicit owner approval before any separate production rollout.

## Remaining risks

Real CDN/intents/permissions, Discord account upload limits/rate buckets and real-model image/document behavior still require attended acceptance. Serial bounded ingress can delay downloads or drop overload; no indefinite offline replay/exactly-once guarantee. The shared server workspace assumes trusted members and one audience. Existing media image fallback/validation policy is reused, not redesigned by M2.
