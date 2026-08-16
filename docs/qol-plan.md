# Post-MVP QoL plan

Status: planned after trusted-personal dogfood acceptance

## Scope

Small, concrete quality-of-life changes for the attended concept test. This
plan does not expand the product boundary: no generic platform features, no
dynamic user signup, no operator extension marketplace.

Security-floor controls remain unchanged. Progress text, typing indicators,
pending attachments, and error replies stay owner-scoped and bounded.

## Design decisions

- Media trigger mode uses semantics A (attachment staging):
  - `mediaMode: "always-trigger"` (default) keeps the current behavior: any
    media message starts a Turn.
  - `mediaMode: "text-trigger"` makes a media-only message stage its
    attachments instead of starting a Turn. The next text message combines the
    staged attachments with that text into one Turn and clears the stage.
  - Telegram text+media in one message still starts one Turn directly.
- Staged attachments are owner-scoped and bounded: at most 8 objects, at most
  40 MiB combined, and a 10-minute TTL. Expiry discards artifacts through the
  normal media discard path.
- `!help` lists the supported commands without reading or changing state.
- Typing indicators are best-effort presence only. A failed indicator never
  affects admission, dispatch, or delivery.
- Intermediate progress is collected at most every 30 seconds per active Turn,
  is capped per message and per Turn, and is delivered only to the originating
  endpoint. Delivery failure marks the outbox row retryable and never reruns
  the agent Turn.

## Batches

### QoL-1: friendlier command errors and `!help`

- Add `!help` to the command table.
- Replace the generic `agent-failed` reply for:
  - `!send` with a missing, directory, or workspace-relative path violation;
  - a native-image request when the selected model does not accept image
    input.
- Keep rejection text bounded and free of host paths where possible.

Acceptance: deterministic suite plus one dogfood check per changed reply.

### QoL-2: typing presence and Turn timing

- Telegram: send `typing` chat action on Turn start, refresh every 5 seconds,
  and stop when the Turn finishes.
- WeChat: obtain the `typing_ticket` from the configured account for the exact
  peer and use the ilink `sendtyping` API with the same refresh policy.
- `!status` reports the elapsed time of the active Turn when one is running.

Acceptance: dogfood check on both channels; deterministic tests use fake
presence adapters and never require network access.

### QoL-3: media trigger mode (semantics A)

- Add optional `mediaMode` to the strict JSON configuration with values
  `always-trigger` (default) and `text-trigger`.
- Implement owner-scoped staging for media-only messages in `text-trigger`
  mode with the bounds above.
- Reply once with a bounded confirmation when attachments are staged.
- Combine staged attachments with the next text Turn; include the staged
  count in `!status`.
- Publish the mode in the static topology; changing it requires a restart.

Acceptance: two-user deterministic tests for staging, expiry, bounds, and
combination; dogfood check on WeChat where text and media cannot be sent
together.

### QoL-4: intermediate agent progress

- Extend `AgentRuntime.run` with an optional progress callback. The fake
  runtime supports scripted progress for deterministic tests.
- Collect non-thinking assistant text deltas at most every 30 seconds.
- Send merged progress through the originating endpoint's outbox with these
  bounds: at most 4000 UTF-8 characters per message and 64 KiB per Turn.
- Progress rows use the same retryable outbox path; a failed progress message
  never reruns or quarantines the Turn.

Acceptance: deterministic fake-runtime progress tests plus dogfood check
during a longer native Turn.

### QoL-5: operator documentation update

- Document Telegram API proxy requirements, the new configuration fields,
  token replacement, and the post-MVP command surface in the operator guide
  and README.

## Review and commit rule

Each batch is implemented as one phase-bounded commit. Before committing:

1. run the complete deterministic check;
2. review the diff against the security floor and owner-scope rules;
3. resolve every blocking finding;
4. record the result in the commit message.
