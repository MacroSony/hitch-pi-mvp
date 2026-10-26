# Discord M3: ComfyUI — implementation plan

Status: authorized development after user accepted M2 cross-Turn originals and combined replies. Stage A foundations are implemented and code-tested; B/C remain pending. **Not enabled in LunaTest or production; no GPU generation performed.**

## First playable slice

A Discord user asks Luna to draw with one operator-configured Anima text-to-image workflow. Luna submits a bounded request and promptly returns an owner-private short job ID. Generation runs independently of the Pi controller. On completion Hitch validates/imports one immutable image and automatically sends a short completion caption plus attachment to the originating channel, using M2 rich delivery. DM and server owners cannot inspect or cancel one another's jobs.

First backend: one explicit configured origin, initially the existing `gpu-a` endpoint. No implicit fallback to another GPU or model. First workflow: `T2I_Anime_Anima.json`, with a short operator ID such as `anima`, fixed graph/model/LoRA settings, and explicitly typed text/dimension bindings. The observed installed Anima model is `anima_baseV10.safetensors`; operational availability must be checked again before actual generation.

Do not build a generic extension loader or general-purpose GPU platform. `extension-modes.md` supersedes the older per-extension certification manifesto: workflow policy is ordinary operator configuration, not a hand-authored digest ceremony. Trusted workflow graphs and backend custom nodes are operator-selected code; the boundary constrains model-controlled selectors and values.

## Staged implementation

### A. Bounded backend and workflow primitives (this development slice)

- `ComfyWorkflowPolicy`: trusted graph + explicit bindings, immutable private copy; unknown variables/targets/graph mutation rejected. Bounds for prompts, numeric/enum values, graph size and output nodes. No global config discovery, filesystem paths, arbitrary workflow JSON, model/LoRA selectors or backend URLs in model input.
- `EgressClient.requestBytes`: the existing fixed-origin/DNS-pinned/deadline/byte-bounded HTTP path, with a host-internal binary response variant. Text sanitization and existing callers unchanged. Bounds are applied while reading the response, not only after buffering it.
- A small host-only Comfy backend adapter using those controlled clients: submit, inspect one known prompt, download declared image outputs and targeted cancellation. No raw backend error text in outward errors, no automatic submission replay, no backend-wide interrupt. This adapter alone is **not** an authorization or image-validation layer.
- Deterministic loopback/unit tests; no GPU work.

### B. Durable owner-bound jobs and publication

- Dedicated durable job rows in Hitch SQLite (attended test-only schema migration), not desktop Paint's global job directory. Bind owner, origin Turn/session/endpoint and workflow snapshot to each job. A model supplies neither owner nor backend prompt ID.
- Persist before submission. If acceptance is uncertain, preserve `submission_unknown`; never automatically resubmit user work. Accepted jobs survive fresh Pi controllers and process restart. Keep short waits and bounded/fair polling; do not occupy the global Pi slot for minutes.
- Initial per-owner concurrency/queue and job retention limits are finite and operator-defined; result count is one and generated-image byte cap is at most the existing Discord 10 MiB limit. No silent recompression/splitting.
- Status/cancel lookups always include authenticated owner. A foreign job ID is indistinguishable from an unknown ID. Public IDs are short opaque handles; backend identifiers, paths, raw errors and URLs remain host-private.
- Use only declared output nodes; no desktop fallback to every backend output. Download bounded bytes, then use the existing owner-bound MediaStore ingestion/structure/dimension/quota checks before any Pi/IM projection. Transport success or a `.png` suffix is not image validation.
- Completion is an explicit idempotent host event with its own terminal outbox group and copied authenticated source reference. Do not replay the original model Turn, append files to an already-partially-delivered group, change selected sessions, or fabricate user input. Atomically record completion and text/artifact outbox rows once.
- Modern targeted cancel is preferred. If unsupported, report that running work cannot safely be stopped; never call `/interrupt`. Turn cancellation does not prove an accepted external job stopped. Preserve honest recoverable state.

### C. Attested Luna tools and attended acceptance

- Explicit opt-in configuration and enabled owners; default off. Use a narrow attested host bridge analogous to the current web-search bridge, not the desktop Pi extension entry point.
- Initial user surface: workflow description, `paint`, owner-only job status and targeted cancel. Tool schemas never accept paths, graph/node mutation, raw backend prompt IDs, arbitrary origins, headers or caller identity. Backend status projections must not enumerate other owners' jobs.
- Test fake backend through real Store/runtime bridge/outbox before enabling the isolated LunaTest instance. Check owner/session/channel boundaries, cancellation/restart/unknown submission, malformed/oversize outputs, source references, no leaked host metadata, full tool attestation, and existing-channel regressions.
- Only after explicit approval for a real GPU smoke test: recheck backend/workflow/models/queue, submit one plain test image, inspect pixels, verify immutable output and actual same-message text+attachment delivery. Then request user acceptance.

## Stage A acceptance (2026-10-26)

- Integrated controlled binary egress, immutable typed workflow policy, and host-internal Comfy backend adapter. Real Comfy protocol cases are covered: empty pending history, root-level empty subfolder, exact cancellation booleans and no global interrupt, successful selected outputs only. No automatic ambiguous submission replay.
- Independent review caught that TypeScript `readonly` alone did not prevent replacing the policy definition at runtime. The policy instance is now frozen as well as its owned data; replacement/rebinding and nested mutation have regressions.
- Parent's fake-backend integration exercises policy rendering → one submission → pending → completion → selected download → actual MediaStore validated image ingestion, exact byte/SHA checks and rejection of forged owner metadata/fake PNG content. This is **not** a Store/job/Pi/outbox end-to-end test.
- The actual installed Anima graph compiled locally: 16 nodes, output node `46`, 3,773 rendered bytes. This local compile submitted no backend job. Read-only workflow/model/backend discovery was performed separately; no live `/prompt` submission or GPU work.
- Final `npm run check`: **397 total / 372 pass / 25 opt-in skip / 0 fail**. Final `npm run acceptance:host`: **15/15**. Logs retained under this worktree's ignored `tmp/m3-foundation-check.log` and `tmp/m3-foundation-host-check.log`.
- Native Pi's pinned-path validation rejects a `node_modules` symlink to another worktree. Removed only our newly created dependency symlinks and used the existing pinned lock with `npm ci --offline`; all worktrees used for validation have their own dependency install. Installed desktop Paint/global configuration was not changed.
- The live LunaTest remains at accepted M2 `0d90e56` in `discord-files`, not this development branch. No service restart/config/DB migration, push or production action occurred in Stage A.

## Deferred

Image editing via immutable inbound/job-result handles (Qwen workflow observed, not yet integrated), multiple backends/workflow selection, LoRA controls, video/audio, Danbooru lookup and broader desktop Paint compatibility. No raw local `input_files` paths or global job lists are ever exposed to Luna as a shortcut.

## Boundaries

- Base is accepted `feat/discord-files` at `0d90e56`; implementation lives in isolated `comfyui-*` worktrees.
- Do not edit the live LunaTest checkout/config/database or the installed desktop Paint package while building foundations.
- No production/dad bot service, credentials, config, database or schedules; no push/release/deployment in this slice.
- Real image generation is a separate explicit gate, not an automatic unit-test side effect.
