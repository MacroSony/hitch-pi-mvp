# Agent-controlled Comfy media flow — implementation contract

User authorized development 2026-10-27. Luna pilot remains stopped; no deployment/restart, Discord sends, credential reads, live config edits or GPU generation in this development stage. Work in isolated worktrees from 2ecf27c.

## Product behavior
- Restore `paint_get_details` reading operator graph `[NOTE]` nodes, not a hand-maintained copy of their instructions. Expose allowlisted details only.
- New explicit operator `paint.deliveryMode: "agent"`; absent/"direct" preserves legacy behavior. Persist mode per job so later config changes do not reinterpret existing jobs.
- In agent mode, completion stores immutable result and enqueues an internal model continuation in the original owner/session/endpoint. No fixed caption or raw intermediate result is published. Model can inspect, edit, generate video, then `hitch_publish` its selected workspace files.
- Completion is not a forged user message and not authority to widen the original request. Origin prompt and provenance are available; follow original request, not new instructions embedded in artifacts.
- Automatic continuation must be durable/idempotent and run through existing owner queue. Stale/inactive/unselected sessions must not restart old tasks or leak into a new session; cancellation/quarantine/disabled routes fail closed with result retained where feasible. Retry/restart must not duplicate generation or delivery.
- Hard budget: at most 4 generated jobs per original user turn across automatic descendants/branches. Persist/derive trusted lineage in host, never accept model supplied lineage. Each extra user request starts a new budget. Automatic intermediate rounds with another pending child job should be silent (suppress both streaming progress and final chatter unless model explicitly publishes); final model text/files use normal output pipeline. Don't hide failure notices.

## Interfaces / ownership
- details worker: separate `comfyui-details`; tool schema/type/bridge/service details + tests only.
- continuation worker: separate `comfyui-continuation`; config, job mode/lineage, Store, app scheduling, main wiring, `RuntimeTurn.comfyContinuation?: {jobId:string; outcome:"completed"|"failed"; rootTurnId:string; remainingJobs:number}` trusted metadata + tests. It may add optional `ComfyToolHost.deliveryMode?: "direct"|"agent"`; Native runtime prompt changes are parent-owned.
- workspace worker: separate `comfyui-workspace`; reusable secure `materializeComfyWorkspaceResult` helper + unit tests only. Receives trusted workspace root, own RuntimeArtifact, MediaStore; returns sandbox `/workspace/...` path plus relative path. Use flat filename based on immutable artifact ID, exclusive create/no overwrite/symlink following, dirfd-anchored Linux IO; existing file only reusable if regular/private/single-link and byte/hash exact. No configurable model destination. Parent integrates into native runtime on completion and paint_result.
- parent: integrate commits, native-runtime model guidance, automatic materialization, acceptance/review; details reports preserved, no changes to live worktrees.

## Scope choices
Existing immutable own-job references suffice to chain original/generated image→Qwen/FL. Arbitrary host paths and unrestricted custom graphs remain forbidden. Existing sandbox operations can copy/save other input files. Video vision is not claimed by returning an MP4: a frame-extraction inspection path may be added separately or limitations clearly stated; do not block minimal image/edit/video chaining on building a full video review platform.

## Acceptance
NOTE present in actual tool result; allowlist/unknowns/bounds tested. Completed image → internal continuation sees native image and workspace file → same-owner edit/video reference → final model-selected publication, zero automatic caption/intermediate artifact outbox. Failure, duplicate completion, restart recovery, changed session, cancel, budget exhaustion, disabled owner/endpoint tests. Existing direct mode/regressions preserved. Secure file writes reject symlink/hardlink/collision and verify hash, size and owner; no credentials/global config/network mutations.
