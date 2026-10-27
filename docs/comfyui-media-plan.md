# ComfyUI results, editing and H3 video

Scope authorized after Anima acceptance: (1) model access to its own completed results and workspace preservation, (2) safe Qwen editing, (3) video generation including H3 text2va/fl2va/ref2va. Development is isolated from the running M3 checkout. No production rollout, arbitrary host paths, global interrupt or automatic exposure of every desktop workflow.

## Verified H3 feasibility, not current LunaTest support

Read-only audit found actual active API workflows under `<operator-workflow-dir>/` and official templates under `<ComfyUI>/blueprints/minimax-h3-turbo/`. The backend exposes the required H3, hybrid loader, video and audio nodes. Exact FL2VA/REF2VA weights, H3 Qwen encoder, both VAEs and FL2V Turbo LoRA exist under **`/data/models`** (not the empty standard `<ComfyUI>/models` directories); backend inventory also lists them.

- Ref2VA workflow has optional 9-image/3-video/3-audio reference wiring and video soundtrack references. It already decodes and muxes generated audio.
- Active FL2VA Turbo8 graph has optional first and last images, but currently **does not connect audio to CreateVideo**. A silent MP4 is not a complete VA acceptance. Reuse the official audio decode/mux route when provisioning a VA policy.
- The H3 FL2VA node accepts no keyframes, so text-only generation uses the same conditioning route. It does not require a hypothetical third set of T2VA weights.
- H3 uses the 17k+5 frame grid at 24fps. Requesting 5 seconds yields 124 frames / ~5.17 seconds; timestamps/prompts must use the actual grid.
- Native SaveVideo returns `images:[file refs]` plus `animated:[true]` in history, even for MP4. Do not look only for a `videos` field.

Actual isolated Qwen and all three bounded H3 routes have now been generated and checked; see `comfyui-media-result.md` for evidence and limitations. This remains separate from live/user acceptance. The Ref sample has an AAC stream but is effectively silent; its audible sound quality is not accepted.

## Implementation stages

### 1. Completed-result access

Add `paint_result(job_id, preview?)`, bound to the actual caller owner. Resolve only a completed job's unique consistent completion/outbound artifact; no general file lookup. Runtime mounts exact original bytes read-only under `/inbox/results`, and the model may copy them using existing sandbox tools into `/workspace`.

Image previews are actual native image tool-result blocks, not base64 text pretending to be vision. Reuse the pinned Pi resize API; at most two preview responses per Turn, <=512KiB each, max1024 pixels per side. Nonvisual models get original metadata/path only. The private bridge raises response allowance only for this operation, not every control call. Two explicit result originals, <=10MiB each, have a separate bounded per-Turn result budget; existing inbound 8-file/40MiB behavior is unchanged.

### 2. Safe editing/reference inputs

Inputs must be owner-bound current-Turn attachment handles or an explicit own completed-job result ID. No local paths or arbitrary artifact/Comfy backend filenames from the model. Inputs are snapshotted/verified before upload; total count/byte/type limits remain finite.

Use a controlled binary Egress request and owner-scoped content-addressed Comfy input names. Persist the job before external work; an ambiguous generation submission is never automatically replayed. Multipart delimiters must be unpredictable and absent from file bytes. Operator origin/headers are immutable constructor snapshots.

Workflow policies explicitly declare file slots and media types. Required inputs cannot fall back to operator default filenames. Unfilled optional ports disconnect only configured literal input keys, then unreachable loader branches are pruned. **H3 dotted input keys are literal JSON keys, not nested JSON paths.** First Qwen editing uses one image reference; its native visual and original-file semantics remain distinct.

### 3. Video output and H3 policies

Backend output parsing now supports declared image/video kind and native SaveVideo metadata, with isolated codec inspection and durable file/caption publication. Automated and actual short-GPU acceptance are documented in `comfyui-media-result.md`; full multimodal reference inputs and live video acceptance remain open.

The implemented output path has bounded format/stream/duration/dimension/codec checks, original-byte preservation, kind-aware job artifacts/captions, and grouped delivery tests. Enable it in LunaTest only after an attended rollout decision. Raw untrusted input video/audio needs a bounded isolated inspection/normalization path before forwarding to a privileged backend decoder; simply trusting an advertised `.mp4` MIME is insufficient.

Start with short bounded MP4 clips and explicit policies for text2va, fl2va (keyframe image input) and ref2va. Image/video/audio reference coverage must be stated separately; do not call a picture-only Ref2VA test full multimodal-reference acceptance. Preserve generated audio when the workflow is advertised as VA. Do not silently reinterpret N/A prompt sections as an instruction to avoid all audio computation.

Keep the currently accepted 10MiB Discord limit and no automatic compression/splitting. Define honest over-limit/finalization errors and retention/retrieval behavior before advertising longer clips; do not label a successful backend generation as a successful Discord delivery.

## Acceptance gates

- Unit/fake-backend tests for owner isolation, file-slot substitution/pruning, upload framing, preview budgets, readonly byte-identical originals, workspace copy, MP4 metadata and malformed/oversize content.
- Real Pi preview + sandbox copy must be verified without a new generation, reusing an already-owned test output.
- Qwen/H3 actual generation tests only against currently checked idle configured backends, short bounded jobs, Mika-authored prompts and authorized test assets. Never interrupt other jobs or treat queued as complete.
- No upgrade/rebuild of the running LunaTest checkout during this development slice. Separate attended test enablement/backup remains required when the new feature bundle is ready; no production change or push.
