# Discord Luna M1 — local acceptance

Date: 2026-10-01 UTC. Base d14d1c6, branch feat/discord-luna.

## Result

M1 text implementation is locally complete and independently reviewed. This is NOT live Discord/provider/production acceptance.

- Strict static Discord DM/server config and account secret references; optional MESSAGE_CONTENT setting.
- Distinct owner scope versus author identity, independent DM workspaces and shared server context/workspace across allowed text channels.
- Schema9 + historical migration chain, FK checks before commit, bidirectionally immutable Discord owner/scope bindings including disabled history.
- @mention/bot-reply triggers, exact route admission, source JSON persisted on Turns and prefixed to model prompts, real-author admin ID checks.
- Shared session create/switch/recovery, channel replacement and restart persistence.
- Pinned discord.js14.19.3 Gateway/REST, authenticated Ready identity, safe reply/mention policy, bounded Unicode chunking, serial/bounded ingress and durable result delivery.
- Typing instead of progress dumps; fatal Gateway close propagates to independent worker retry. Shutdown/uncertain sends never knowingly mark unsent work delivered.
- Legacy channel behavior retained. Discord LOCAL/wake/extension commands and file intake/delivery explicitly excluded from M1.

## Evidence

Executed in the isolated worktree, not the production release/data root:

- `npm run check`: formatter + typecheck + build + full deterministic suite, **338 tests / 314 passed / 24 opt-in skipped / 0 failed**.
- Final independent review: **PASS**, with focused `dist/test/discord-{sdk,worker}.test.js` **9/9** and typecheck rerun.
- Foundation fixtures test actual nonempty schema7/schema8 upgrades, original session/Turn/outbox preservation, FK and failed-migration rollback. Fake application tests close/reopen the foundation and test shared/DM selection boundaries. These do not stand in for a native provider transcript smoke.
- SDK/worker tests are injected offline fakes. No real Discord login, bot invitation, DM, guild send, provider generation or credentials were used.
- Original Pi package and dependency-closure attestations pass unchanged. Initial `npm install --ignore-scripts` left the pinned nested esbuild binary wrapper unoptimized; independently traced to one file, then ran only the reviewed pinned esbuild postinstall locally. No safety hash was changed and no dependency hoist workaround was needed.

## Review fixes

- Persisted private/server scope must not be repurposed; owner-to-scope AND scope-to-owner checks include disabled endpoints.
- Real schema7 migration disables FKs before endpoint rebuild and restores/checks them; no production acceptance of fake old-version/current-column fixtures.
- Bot ID is read from authenticated SDK Ready state, not a guessed configuration value/token decode.
- Preserve multi-line prompts; reject empty/oversize admitted prompts.
- Shared selection fallback includes historical disabled channels, so replacing all allowed channels preserves context.
- Explicit abort handling retains retryable/uncertain delivery rather than marking sent.
- Pinned SDK emits fatal shardDisconnect without automatic reconnect; adapter health state now drives independent close/backoff/retry. The final review reproduced/verified this path.
- Earlier reviewer type/format findings observed while parallel tests were being written were fixed and the complete stable tree rechecked.

## Deferred / accepted limitations

- User-created test server + DM acceptance is next. Real members, intents, channel permissions, real rate limiting/resume and real-model responses have not been validated.
- Non-pinging replies need MESSAGE_CONTENT in both config and portal, or an explicit @mention. Intent enablement does not imply background context ingestion.
- All configured server channels share one audience/context/workspace; not for adversarial members. Admin command restrictions do not prevent trusted members from requesting sandboxed edits through ordinary model prompts.
- Ambiguous outbox retries can duplicate messages. No indefinite missed-event replay or exactly-once claim. Ingress overload drops beyond 64 pending messages with a sanitized warning.
- Very long output truncates after16 Discord chunks; Markdown fences are not rewritten across chunks.
- M2 files, M3 ComfyUI Paint and the new jointly-authored Luna profile remain unimplemented. No voice/public signup/production guild activation.
- Existing live dad/zihan config, auth, database, timers, service and release untouched. No push/deployment performed.

See [configuration and attended setup](discord.md), [example config](../examples/discord.config.json), and [implementation scope](discord-plan.md).
