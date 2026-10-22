# Discord M2 progress

## Design (2026-10-21)

- Preserve M1 routing, author/admin and trigger gates; download only after route + classifier acceptance. Normalize Discord attachment descriptors, inject download/upload transport for offline tests.
- Reuse MediaStore.ingest (20 MiB/file, 8 files, 40 MiB total; existing image sniffing/validation, no document allowlist) and owner-bound RuntimeArtifacts. Reuse text-trigger staging/10-minute TTL and always-trigger fallback prompt. DM owns private files; all allowed server channels share owner staging/workspace.
- Keep staging event dedup durable using a terminal admission record in existing turns; no schema change. Digest includes inbound content hashes, not CDN URLs or generated object IDs.
- Upload images/documents through MediaStore.verifiedObjectPath, 10 MiB named default cap; no compression/splitting. Atomically fail oversized artifact and enqueue durable text notice (not an ephemeral best-effort send). Retain retry/cancellation semantics and sanitized errors.
- Leave !send/!wake/LOCAL/extensions/threads/paint excluded.

## Read / evidence

Read docs/discord.md, discord-plan.md, discord-m1-result.md; Discord ingress/worker; Telegram intake/upload; WeCom media; application staging; store admission/staging; foundation artifact tables. Native runtime materializes files via MediaStore.materializeInbox.

## Status

Design recorded; implementing inbound first, then outbound, deterministic tests and docs. No network/credentials/services accessed. Baseline: 338 total / 314 pass / 24 opt-in skip / 0 fail.

## Next

Implement transport and admission; targeted tests; npm run check; result document and live LunaTest checklist. File:line pointers will be finalized after formatting.

## Implementation checkpoint

Inbound adapter + MediaStore ingestion, owner checks, attachment-only staging/fallback, content-hash digest and durable staging dedup implemented. Outbound verified-path upload and atomic failed-artifact + queued text notice implemented; main passes shared MediaStore. Existing worker fakes updated for new transport contract. Next: end-to-end fake transport/media tests, review staging rejection behavior, full check and docs.

## Tests checkpoint

Added test/discord-files.test.ts: injected file transport with real MediaStore + SQLite + fake Pi, DM/server staging and dedup, no-download gates, limits, attachment-only fallback/inbox, shared server vs DM isolation, image/document upload, durable oversize notice after reopen, upload retry/cancellation. Targeted Discord suite passed 37/37 before the final extra rejection tests. Hardened staged consumption: nested SQLite savepoints make Discord stage/take/admit atomic; rejected admission must preserve prior staging. Next full check and docs.

## Verification checkpoint

Full npm run check passed: 352 total / 328 pass / 24 skip / 0 fail (+14 passing vs M1). Initial new busy-queue test yielded while constructing a media object, allowing fake Pi to drain; fixed the fixture to prepare media before filling the queue. This was a test timing error, not a transport failure. Added one final SDK payload/verified-hash/no-network URL test; rerunning final check below.
