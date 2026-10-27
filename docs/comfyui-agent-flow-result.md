# Agent-controlled Paint — development acceptance

2026-10-27. Functional candidate **0010de1**, branch `feat/comfyui-agent-flow`, checkout `<worktrees>/comfyui-agent-flow` (base `2ecf27c`). **Not deployed, not pushed.** User authorized development; Luna pilot remains stopped. LunaTest PID <redacted>/media checkout and dad PID <redacted>/progress-cap release remain running and unchanged. Pilot DB remains schema10, 10 jobs; no process uses its config.

## Delivered behavior

- Sixth attested tool `paint_get_details({workflow})` returns the loaded operator graph's real `[NOTE]`, variable limits/defaults, file slots and output kind. No extra writable graph/model/backend controls. Anima's actual configured NOTE was read through the new service: 1,438 characters, not truncated, original default832×1216 available.
- Explicit operator `paint.deliveryMode: "agent"`; absent/`direct` retains legacy behavior. Mode is persisted per job, not inferred later from config. Existing jobs migrate as `direct`.
- Agent job completion stores an immutable original and queues one trusted internal continuation in the originating owner/session/endpoint. No fixed caption or automatic intermediate artifact outbox. Runtime saves the result to a private, stable short-named workspace file before model review; image-capable models receive the current image natively.
- Bot can use its completed job ID to edit with Qwen or condition H3 FL, receive another continuation, and select a final workspace file via existing `hitch_publish`. `paint_result` also supplies bounded image preview plus persistent `workspace_path`/relative `publish_path` in agent mode.
- File publication still uses immutable snapshots and existing rich-message outbox. No Discord credentials or direct arbitrary send API are exposed to the model.
- Pending generation turns suppress generic progress/job-ID chatter when no explicit publication was requested. An explicit `hitch_publish` remains authoritative: this is not a hard ban on intermediate files if the bot chooses to publish them; normal guidance says final-only unless requested otherwise.
- Host-persisted four-job budget per original user turn covers automatic descendants, sibling branches and rejected attempts. New human requests get a new budget. Unknown submissions are not replayed.
- Owner queue/restart recovery, sticky cancellation and route revocation, session selection, disabled owner/endpoint/Paint, and **Pi session epoch** changes are checked. Old tasks do not resume in a new context. Internal completion admission remains durable even when ordinary queue capacity is full; bound/rationale in continuation handoff.
- Workspace copy rejects symlink/hardlink/path collisions, validates actual source FD bytes/hash and directory identity, never overwrites a conflicting file, and only returns sandbox paths. Existing exact files are reused. Subsequent publication re-snapshots mutable workspace files.

## Verification

### Final integrated code
- `npm run check`: **550 total / 522 pass / 28 opt-in skip / 0 fail**.
- `HITCH_RUN_SANDBOX_TESTS=1 node --test dist/test/native-runtime.test.js dist/test/comfyui-video.test.js dist/test/comfyui-video-delivery.test.js dist/test/comfyui-agent-media.test.js`: **23/23 pass**. Includes actual sandbox attestation/publication/readonly inbound files and isolated FFprobe/full decode, plus deterministic image→workspace→own-job video→final rich delivery.
- Deterministic media-chain test: three model turns/two backend submissions, source image uploaded as first-frame handle, zero intermediate outbox, exactly one final text+MP4 rich send via fake Discord, no duplicate on another tick/delivery. Its video bytes/inspector are deliberately transport fixtures, not an aesthetic or real-provider evaluation; real codec inspection is tested separately.
- Final logs copied to private Assistant report directory below.

### Real native Luna, no GPU or Discord sends
Opt-in script: `scripts/probe-comfy-agent-native.mjs`. Actual pinned Pi + `openai-codex/gpt-6-luna`/medium, isolated DB/workspace, backend substitutes an existing image; no DiscordWorker/network channel is constructed. Existing dedicated provider authority is used normally through the existing writer-lock path; no manual credential inspection/copy.

1. **Single-image happy path PASS** at integrated candidate `1895421` (before subsequent epoch/rollback-error hardening): `/tmp/hitch-native-agent-flow-NDtuYw/receipt.json`.
   - Actual calls: `paint_list_workflows` → `paint_get_details(anima)` → `paint`.
   - Actual prompt used the NOTE's quality/score format and832×1216 defaults rather than the earlier640×704.
   - One submission, one internal continuation. Native model described black-haired/green-eyed cat-eared maid, green monitor and keyboard from the image; it then called `hitch_publish` on the generated short workspace filename.
   - Original and selected publication SHA identical; exactly one final text row plus one artifact row, pending in isolated outbox. **Not a Discord receipt**. Model wording said “sent” although only snapshot/queue had occurred; do not treat that wording as evidence of external delivery.
2. **Additional real-model image→video probe INCOMPLETE/FAILED**: `/tmp/hitch-native-agent-flow-hvL3eR/failure.json`.
   - Initial real provider turn returned `provider-error` after one mock image submission (also polled status despite guidance). Source failure blocked automatic continuation; only the failure notice was queued.
   - No retry/provider fallback, no new GPU job, no external send. **Real-model automatic video chaining is not accepted by this run.** Deterministic multi-stage test and existing video validation lanes passed separately.

### Non-destructive migration rehearsal
Copied the stopped pilot DB via read-only SQLite backup to `/tmp/hitch-agent-migration-jal341ia`; opened **only the copy** with final candidate to migrate schema10→11. Compared every pre-existing column/row in10 non-meta tables by count and canonical hashes: unchanged. FK check empty, quick_check OK; all10 existing jobs remain `direct`. Source DB rechecked schema10. This is not deployment or authorization to restore an old DB.

## Independent reviews and corrections
- Read-only workspace/details review found missing test import, a trailing-newline path acceptance edge, and video guidance inaccurately referring to an attached image. Corrected and regression tested; no evidence-backed filesystem escape found (not a formal proof).
- Read-only continuation review found unreferenced blob leakage on completion transaction rollback. Added an owner-enable-independent retained-artifact query: uncommitted imported blobs are discarded on rollback, committed originals are retained even when the owner becomes disabled; unknown query state preserves bytes conservatively. Repeated rollback and post-commit failure tests pass.
- Post-commit scheduling callback failures now retain results and retry the notification on the next tick; restart relies on durable queued rows. Pi epoch rotations are sticky-revoked at trusted state-change boundaries and on dispatch/completion.

## Remaining limitations / next gate

- **No new visual-quality sweep.** This fixes orchestration and missing instructions, not proof that current Anima/Qwen/H3 checkpoints produce desired aesthetics. No GPU generation occurred in this task.
- Image inspection works natively; MP4 is still a file, not native video vision. Automatic video contact sheets/frame inspection are not implemented. Guidance explicitly forbids inventing a video review.
- Existing image references are current/recent upload handles or own completed image jobs. Arbitrary manually edited workspace paths are not a new Paint input API; tool-based Qwen edits chain through their new job IDs.
- Agent ledger history is retained to preserve budget/provenance. Retention policy is a future separate change. Existing conservative `submission_unknown` activity slots need operator resolution if saturated; no unsafe automatic replay/interrupt was added.
- Mutable workspace remains mutable after copy; snapshots protect publication bytes, not aesthetic correctness. Existing Discord transport is not exactly-once across network/receipt crash windows.
- Schema11 cannot be opened with old schema10 binaries. The disposable pre-hardening native-probe schema11 DBs are evidence, not release migration targets.
- Next gate: user approval to back up current stopped pilot data, prepare an `agent` candidate config, switch only the pilot to this checkout, then verify natural group usage. Do not touch LunaTest/dad or restore old OAuth/DB snapshots. Do not promise new files were externally delivered merely because `hitch_publish` succeeded.

Private evidence: `<private-operator-reports>/luna-paint-agent-flow-20261027/` (receipts, summaries and test logs). No credentials included. Detailed component evidence remains in `comfyui-details-result.md`, `comfyui-workspace-result.md`, `comfyui-continuation-handoff.md`.
