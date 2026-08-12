# Phase 0 transport inventory

This is an inventory of the exact legacy sources at `../hitch-hub`, not a
production port. No channel credential, network request, live account, or
message content is used. The deterministic fixture in `run-transports.mjs`
pins the selected source files and the installed `wechat-ilink-client@0.1.0`
tree.

## Decision

The Telegram and WeChat adapters are **reference-only**. Neither may be copied
wholesale. Later phases may adapt the bounded pieces marked “reference” only
after durable admission, endpoint identity, owner-private media, outbox, and
cancellation contracts exist.

| Legacy area | Inventory result | MVP disposition |
| --- | --- | --- |
| Telegram `getUpdates`/health/stop loop | Offset starts at zero, lives only in memory, and the next poll may acknowledge work before durable admission | Reference for HTTP shapes only; rebuild around a persisted endpoint cursor and transactional idempotent intake |
| Telegram identity | The parsed shape omits `chat.type`; adapter checks chat allowlist before constructing an optional sender | Reject; require configured bot account, `chat.type == private`, exact chat and sender, stable update and message IDs before content/media |
| Telegram callbacks | Chat-only prefilter turns unsigned callback text into approval commands | Reject; carry only a private authenticated callback envelope to the owner-bound, expiring, single-use interaction service |
| Telegram inbound media | `file_size` is optional and the complete response is buffered with `arrayBuffer()` before the actual-size check | Reject; stream to an exclusive owner temp, stop at limit+1, sniff/validate, fsync, and atomically promote |
| Telegram outbound send/retry | Reads a live path fully and retries ambiguous POST responses without a durable outbox state | Reject; send only an immutable owner snapshot through `pending/sending/possibly_sent/sent` outbox state |
| WeChat login/API client | Pinned client exposes QR login and raw `ApiClient.getUpdates` | Reference after live inventory; do not use its high-level `start()` monitor for admission |
| WeChat identity | Adapter uses `group_id || from_user_id`, represents groups as threads, and the principal check occurs after context/media work | Reject; bind authenticated account plus exact sender, require empty/absent group ID, and deny before content/media |
| WeChat stable ID | Falls back from `message_id` to `seq` and finally wall-clock time | Reject; missing stable message ID is a content-free denial, never synthesized |
| WeChat sync cursor | Client saves `get_updates_buf` before invoking message callbacks; its EventEmitter callback does not await adapter admission | Reject high-level monitor; own the raw polling loop and commit cursor only with durable batch admission |
| WeChat context tokens | Tokens are keyed by peer/chat only, have a cross-key fallback, and are rewritten in place | Reject; bind encrypted/opaque token state to endpoint account plus exact peer and update it in the same durable intake boundary |
| WeChat credentials/sync/context files | Plain JSON in-place writes followed by best-effort chmod; no exclusive temp, fsync, rename, parent fsync, or corruption quarantine | Reject; use owner-private durable state and explicit quarantine/relogin behavior |
| WeChat inbound media | Pinned library buffers the entire CDN response and decrypts before the adapter checks size | Reject; a bounded streaming/decryption path and media validation are required |
| WeChat send serialization/response validation | Serial queue, minimum interval, and `ret` checking address observed API behavior, but reach private library methods and are not abort-safe end to end | Reference only; re-prove against the pinned live account behind durable outbox/cancellation |
| WeChat full-URL upload workaround | Supports both observed upload response shapes but reads/encrypts the full live file in memory | Reference protocol shape only; operate on immutable bounded snapshots with cancellation and output limits |
| Shared media cache | Global content-hash path deduplicates across principals and retains untrusted filename/type metadata | Reject; blobs are owner-namespaced and never cross-user deduplicated; filenames never select paths or identity |
| Multi-channel queue | In-memory queue is unbounded and channel termination/error has no durable ingress ownership | Reject; each endpoint has bounded intake and durable per-user scheduling |

## Admission contract captured by the fixture

- Telegram accepts only the configured bot-account/private-chat/sender tuple
  with safe stable update and message/callback IDs.
- WeChat accepts only an event from the configured authenticated account and
  exact sender with empty/absent `group_id` and a safe stable message ID.
- Missing fields, groups, tuple drift, ambiguous payloads, and unstable IDs are
  rejected before media eligibility.
- Control characters are rejected in raw string identifiers. Composite keys
  use UTF-8 byte-length prefixes rather than delimiter concatenation, with
  adversarial fixtures proving formerly colliding account/peer partitions do
  not alias.
- Text, captions, filenames, callback data, forwards, and context tokens never
  select identity.
- Idempotency is endpoint-namespaced: identical key+digest is a duplicate;
  identical key with a different digest is a conflict. Neither executes.
- A WeChat send-context token is bound only to the same account/peer tuple.

## Deferred live evidence

Telegram bot-token checks, WeChat QR/login and raw-envelope inventory, media
downloads/uploads, ambiguous delivery behavior, and multi-account behavior
remain separately named opt-in acceptance. Synthetic fixtures are not reported
as live-channel success.
