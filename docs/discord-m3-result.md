# ComfyUI M3 first slice — 2026-10-26

## Current outcome

The first **Anima text-to-image** path is implemented in isolated `feat/comfyui-m3`, based on accepted M2 `0d90e56`. It has real native-model/GPU verification, but is **not enabled in the running LunaTest** and has not sent a live Discord M3 reply. No production/dad rollout, push, installed desktop Paint modification, or unrelated backend interruption.

Final code verification:

- `npm run check`: **420 total / 394 pass / 26 opt-in skip / 0 fail**.
- `npm run acceptance:host`: **15/15 pass**.
- Additional real-Pi paint bridge acceptance: **1/1 pass**, exercising enabled/default-disabled and per-tool reduced-active cases with a fake provider and no GPU/network backend.
- Independent read-only integrated review found no concrete cross-owner/routing/publication/replay/attestation blocker. Parent additionally verified actual protocol edge cases, bounded cleanup, restart, and completion delivery.

## Implemented behavior

- Optional strict `paint` config, absent/default off. Enabled owners must be configured Discord owners. One operator-selected fixed backend origin, explicit private-origin opt-in, and an operator-owned canonical workflow policy file outside model-writable roots. No global desktop config discovery.
- Typed immutable workflow graph policy, controlled exact-origin HTTP and bounded binary responses. Only configured literal variable targets can change; no arbitrary graphs, host paths, URLs, headers, model/LoRA selectors or caller identities in Pi tool input.
- Four attested optional tools: `paint_list_workflows`, `paint`, `paint_job_status`, `paint_job_cancel`. Private Unix HTTP bridge binds the actual owner and Turn; capability token and backend details do not enter model results. Mandatory source/tool/active-subset attestation includes the paint extension. A short owner-private socket root avoids Unix socket pathname limits.
- SQLite schema10 `comfy_jobs`: source owner/Turn/session/endpoint and workflow snapshot are durable before submission. At most 3 active/uncertain jobs per owner; retain 100 terminal job metadata rows, without deleting original Turns/outbox/artifacts. Foreign IDs are indistinguishable from unknown IDs. Status returns only short job/workflow/state projections.
- No automatic replay of ambiguous submissions. Startup immediately resolves leftover prepared/submitting state conservatively, preserves acknowledged submitted work, and resumes bounded background polling. Chat/model controllers do not wait for GPU completion.
- Targeted cancellation only, with exact backend cancellation booleans. Unsupported/uncertain cancellation is reported honestly; no `/interrupt` or global queue-clearing fallback.
- First slice accepts exactly one output image from declared nodes. Download byte limits are enforced during transport; existing MediaStore validation, owner quotas, immutable import and verified metadata apply before publication. PNG/JPEG/WebP only. Failed/losing finalization cleans up only the artifact just imported, not user materials; uncertain DB completion never triggers destructive cleanup of a potentially committed object.
- Completion creates one idempotent audited terminal host event, copying the authenticated original source when present (or preserving null for an explicit host operator Turn). It does not replay a model Turn, alter session selection, or append to the already-sent submission group. Caption and image outbox rows plus job completion commit together. Async failure generates its own durable text notice.
- User experience is a prompt submission acknowledgement, then **one completion message containing caption + image**. Ambiguous Discord sends may still duplicate on retry; no exactly-once delivery claim.

## Deterministic integrated proof

`test/comfyui-delivery.test.ts` runs policy/service against a fake backend with the actual Store and MediaStore:

1. An actual claimed owner Turn submits a job; no output is published before that source Turn is terminal.
2. Submission acknowledgement is delivered separately.
3. Close/reopen SQLite and create a fresh service; submitted job survives, foreign-owner lookup fails.
4. Completion imports the correct bytes, creates a fresh terminal group, and the actual DiscordWorker delivers exactly one rich reply through a fake client, retaining the original channel/reference.
5. Repeating ticks/delivery does not resubmit or duplicate completion. Original model result/history/session remains unchanged.

The additional opt-in Pi test loads the real pinned Pi and extension, checks the startup witness/source paths, executes through the Unix bridge with captured caller identity, permits a reduced active set containing only `paint`, and confirms no paint tools in the disabled case. The first draft test had incorrect witness field names and leaked its fixture HTTP server on assertion failure; it was cancelled, fixed with unconditional cleanup, and rerun successfully. An unbounded/hanging run was not counted as acceptance.

## Actual 6 Luna → GPU probe

User authorized using the running ComfyUI/model backends for this M3 work. Rechecked backend queue/workflow/models: gpu-a was idle and the configured Anima/CLIP/VAE were installed. Used a **new isolated test data root and workspace**, with the existing dedicated Pi credential authority (not a copied rotating credential) and **no Discord connection**.

Real `openai-codex/gpt-6-luna`, medium, invoked the new `paint` tool exactly once using Mika's own test prompt. Native result was succeeded; job completed via the real Anima backend at `127.0.0.1:8188`.

- One 832×1216 PNG, **1,140,371 bytes**.
- Source Turn duration observed: **7,236 ms**; job duration observed: **19,297 ms**. The chat controller finished before GPU completion. These are one-sample observations, not a performance guarantee.
- Backend output re-download SHA matched the immutable MediaStore object exactly.
- Actual DiscordWorker processed the resulting durable outbox using a **dry transport**: one submission text and one completion rich payload. No live Discord message was sent; dry outbox sent state is not evidence of live receipt.
- Pixel inspection: recognizable dark twin tails, cat ears, green eyes/brooch, maid outfit and green-lit computer; no obvious corrupt image/text artifacts. This is a functional test image, not a final character-design acceptance.

Evidence (private test artifacts, no credentials or signed URLs):

- `<test-data-root>/comfy-m3-native-probe.mjs` — quota-consuming real-model/GPU probe; do not blindly rerun.
- `<test-data-root>/comfy-m3-native-result.json`
- `<test-data-root>/logs/comfy-m3-native-probe.log`
- `<test-data-root>/comfy-m3-probe-TlJ7UP/mika-anima-m3.png`
- Worktree `tmp/m3-final-check.log`, `tmp/m3-final-host-check.log`, `tmp/m3-paint-rpc-check.log`.

## Migration rehearsal, not live migration

Copied a consistent read-only snapshot of the actual M2 test database into a new private rehearsal directory. Ran the real schema9→10 migration **on that copy only**. All original counts of Turns, outbox, artifacts, sessions, turn/staged artifacts, users and endpoints were preserved; foreign-key check returned zero violations. Live schema remains9.

Rehearsal receipt: `<test-data-root>/m3-schema-rehearsal-result.json`.

## Operator configuration contract

The optional app configuration block is:

```json
{
  "paint": {
    "origin": "http://127.0.0.1:8188",
    "allowPrivate": true,
    "workflowFile": "/srv/hitch-operator/comfyui/workflows.json",
    "enabledUsers": ["configured-discord-owner"]
  }
}
```

The policy file is a JSON array of 1–4 `ComfyWorkflowDefinition` objects (`src/comfyui/workflow.ts`), each containing a short `id`, trusted Comfy API `graph`, explicit typed `variables` and declared `outputNodes`. The immediate directory must be private (0700); the file must be canonical, owned by the service user, regular, single-link, at most 1 MiB and not group/world writable. It must not live in the data/profile/workspace/stated forbidden roots. No model path selects this file.

The first service supports binding names `prompt`, `negative`, `width`, `height` and optional host-randomized `seed`. Model tool input uses `prompt`, `negative_prompt`, optional `width`/`height` and configured short `workflow`. Unsupported supplied fields/bindings are rejected, not ignored. For the observed Anima graph, primitive targets are `73.value`, `74.value`, `69.value`, `71.value`, optional `66.seed`, with output node `46`. Reinspect the installed graph before provisioning; do not assume those node IDs for another workflow.

## Next attended action / limits

1. Confirm a short LunaTest maintenance window and schema10 migration; recheck real PID/cwd/source/idle state.
2. Stop only LunaTest, back up its dedicated DB, retain old runner/config, create a separate operator policy and opt-in M3 config/runner, and start the accepted new code. Do not copy/revert provider credentials.
3. Verify PID/cwd, schema10, selected model and both enabled owners. Ask user for a natural Discord draw request; verify actual completion message/CDN bytes and user receipt. This is the remaining user-facing M3 acceptance.
4. A migrated schema10 DB must not be opened by the old schema9 binary. If paint needs disabling, keep the new binary with paint disabled or pause the test instance; no automatic DB restore that would erase newly admitted history.

Qwen image editing/input handles, arbitrary model/LoRA selection, multiple backend selection, video/audio, Danbooru and broad desktop Paint compatibility remain deferred. Production rollout remains unauthorized.
