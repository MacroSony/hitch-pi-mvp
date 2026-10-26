# Discord cross-Turn originals and rich replies — 2026-10-26

## Scope and current result

User authorized filling the cross-Turn original-file gap and asked for Discord text + attachments in one reply. Implemented in `feat/discord-files`, isolated LunaTest only. No schema migration, dependency change, production/dad deployment, push, or ComfyUI M3 implementation.

## Cross-Turn original access

- `HitchStore.claimNextTurn` supplies historical references only for Discord, the same owner and selected session, earlier terminal Turns, inbound direction. Future queued/terminal higher-ordinal uploads are excluded.
- At most 64 historical attachment candidates are considered. Current files take priority within the combined 8-file / 40 MiB budget; each file retains the existing 20 MiB bound. Repeated IDs and colliding generated path components are not selected twice.
- SQLite byte/ordinal values are explicitly converted from BigInt. Historical originals retain their original generated `/inbox` paths rather than being renamed with their new list position.
- Native runtime validates the combined inputs and materializes read-only originals. Historical images are NOT resent as new visual image payload. Current images still provide native visual input plus file originals.
- The manifest is a bounded recent window, not a complete archive or arbitrary artifact lookup API. `!new`/recovery has a separate session window. Owner workspace copies remain persistent and are not erased by new sessions.

## Discord combined reply

- One complete same-Turn unsent group may send nonempty text <= 2000 UTF-16 units plus 1–8 files, each and aggregate file bytes <= 10 MiB, in one pinned discord.js request with mentions/reply pings disabled.
- Existing individual outbox rows are retained. Group claim, sent marking, and retry/failure marking are SQLite transactions over the entire verified group.
- Store revalidates owner, endpoint/account/channel, Discord kind, user/endpoint enablement, terminal owned Turn, complete row set, equal pending/retryable state and attempt counts. BigInt counters are normalized before comparisons.
- Whole-group selection is independent of the ordinary 20-row page. Candidate seeds are bounded to 1–20 Turns and each selected group is loaded whole.
- The full group API must be available together. Failed group claims consume the current snapshot's member IDs without accidentally falling through to partial sends.
- Long text, oversized batches/files, already-partially-delivered groups, unsupported client/store interfaces and independent replies keep the existing single-row paths. Nothing is silently truncated or dropped to force combination.
- Ambiguous sends may duplicate the whole message on retry; this remains at-most-once admission / at-least-once-capable delivery, not exactly-once messaging. The earlier captured-platform-fetch multipart fix remains in use.

## Verification

Final combined `npm run check`: **383 total / 358 pass / 25 opt-in skip / 0 fail**.
`npm run acceptance:host`: **15/15 pass**.

Coverage includes same ordinal across multiple old/new files, actual store selection, owner/session/new-session boundaries, SQLite reopen persistence, future-upload exclusion, count/byte priority, native visual payload exclusion for historical images, group claim/mark rollback, retry/restart, pagination/completeness, partial old delivery, long/oversize fallback, owner/endpoint separation, stale disabled/nonterminal rejection, full optional-API gating, failed-claim no-partial-send behavior, and real pinned-SDK loopback multipart with text and correct file bytes.

Parent added the lifecycle/quota regression file rather than treating older passing tests as new coverage. Independent final read-only review found no concrete blockers before live deployment.

## Actual LunaTest probe

After verifying the test instance PID/cwd and idle state, backed up the dedicated SQLite database and stopped only LunaTest. An explicitly audited operator verification Turn was admitted through the real Store to the current test-server session; no fabricated Discord author/message metadata was used, and no old model Turn was replayed.

The probe had **zero new attachments**, selected three earlier references, and included the user's previously inaccessible original server image. Real `openai-codex/gpt-6-luna`, medium, copied the old original into a new unique workspace file and published it. Source, workspace copy and publication all matched SHA-256; size **2,146,867 bytes**. No old file was overwritten or deleted.

Restarted LunaTest with the new code. Both actual text and artifact outbox rows became **sent / attempt 1**, with the same completion timestamp. Discord REST receipt inspection found **one message containing both the exact text and one image**, no separate duplicate text message. Downloaded the actual attachment from the approved Discord CDN and matched all bytes and SHA-256 against the original.

The probe's final text was: `跨轮附件验证完成，文件已提交回传。`

Evidence (private test instance, no credentials or signed CDN URLs printed):

- `<test-data-root>/cross-turn-rich-probe.mjs`
- `<test-data-root>/cross-turn-rich-probe.json`
- `<test-data-root>/logs/cross-turn-rich-probe.log`
- `<test-data-root>/verify-cross-turn-rich.mjs`
- `<test-data-root>/logs/cross-turn-rich-receipt.log`
- `<test-data-root>/logs/cross-turn-rich-final-check.log`
- `<test-data-root>/logs/cross-turn-rich-host-check.log`

Scripts that run the native probe incur model usage and send a test reply; do not rerun automatically. The resulting unique workspace test image is intentionally retained.

## Remaining boundaries

- Ask user to confirm the combined reply in the test server and optionally retry their earlier natural-language save request without reuploading.
- Do not advertise unbounded historical original retrieval: recent-window limits apply; long-term desired files should be copied into workspace.
- WeChat/TG presentation was not changed. The existing WeChat path sends separate items; its protocol's full mixed-message capability was not assessed by this task.
- Multi-member/full exception-matrix acceptance remains distinct from these happy paths. Production rollout and ComfyUI M3 require their own work/approval.
