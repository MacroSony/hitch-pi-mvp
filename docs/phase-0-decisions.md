# Phase 0 decisions and evidence

Status: complete historical no-go evidence; superseded for MVP scheduling

On 2026-08-13 the operator explicitly narrowed the target to an attended,
trusted-personal concept MVP. The technical findings below remain accepted and
reproducible, but their original release policy is superseded by `PLAN.md`:

- Pi auth corruption is an accepted backup/re-login operational risk;
- missing project quotas are an accepted monitored-host risk;
- Forge and ComfyUI Paint are excluded rather than required; and
- live provider smoke moves to the opt-in Pi dogfood phase.

The independent PASS below certifies that the original no-go decision followed
its then-current contract. It does not contradict the later product decision to
accept or defer those risks. Phase 1 is now authorized after the MVP planning
baseline is reviewed and committed.

This document is the cumulative Phase 0 gate record. Evidence is accepted only
for the pinned inputs in `docs/phase-0-inputs.md`. Secrets, prompt content,
provider bodies, raw tool payloads, and channel content are never recorded.

## Checkpoint reviews

| Checkpoint | Scope | Independent review | Status |
| --- | --- | --- | --- |
| 1 | Extension compatibility contract and P0a formalization | Cycle 1: REVISE; cycle 2: PASS | Complete |
| 2 | Pi provider/profile/session runtime probes | Cycle 1: REVISE; cycle 2: PASS | Complete |
| 3 | Mandatory extension and sandbox backend | Cycle 1: REVISE; cycle 2: PASS | Complete |
| 4 | Telegram/WeChat transport inventory | Cycle 1: REVISE; cycle 2: PASS | Complete |
| 5 | Consolidated Phase 0 release gate | Cycle 1: REVISE; cycle 2: PASS | Complete — BLOCKED no-go |

## P0a: extension loading and tool replacement

Date: 2026-08-12

Artifacts:

- `spikes/p0a/p0a-probe.ts` — SHA-256
  `1351180048d4ffced956b89075bb2bfd31ba150ae171d77212af7c3fdbe51ec1`
- `spikes/p0a/p0a-collision.ts` — SHA-256
  `9493195d7119b2f8c341544a35b1637601f8b3055e8cb92c393a9ac4fc006d5f`
- `spikes/p0a/p0a-attestor.ts` — SHA-256
  `e1704ec8da45ae05822d07bbc0c9fcae07b2f8eaee2d58b76c3a18b444d187bf`
- `spikes/p0a/workspace/.pi/extensions/auto-discovered.ts` — SHA-256
  `8e344108cfa738fd1b5d1df60d2d79089ca4b1f2c59b4ae1b5820f7eaf55dc5d`
- empty `auth.json` and `models-store.json` profile fixtures — SHA-256 each
  `44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a`
- `spikes/p0a/run-p0a.mjs` — SHA-256
  `ce4e94ea52d7bf0153a520c59b0d35d61ba5ddf99e84c08e70623257f290c112`
- `spikes/p0a/P0A-EVIDENCE.json` — content-free deterministic run manifest
- installed Pi package tree excluding dependency `node_modules` — SHA-256
  `7298ead16e553a8ffc372ca6a5a17ccfd711ae0887830134255dcea08be55bba`

The detailed matrix and original observations are in
`spikes/p0a/P0A-FINDINGS.md`.

Accepted observations:

1. Explicit `--extension` paths load under `--no-extensions`.
2. With project approval held equal, `--no-extensions` prevents workspace Pi
   extension discovery; the positive control discovers the fixture.
3. With built-ins disabled, the explicit extension owns the exact seven-tool
   all/active sets, and every winning source path is the pinned probe.
4. RPC/direct user bash reaches the `user_bash` extension event and can be
   completely replaced.
5. `--no-builtin-tools --tools read,...` fails open for an omitted replacement:
   Pi reactivates the same-name built-in tool.
6. `--no-extensions` does not remove Pi's inline `llama` command extension;
   the negative discovery control has exactly that command, the exact seven
   inactive built-ins in `getAllTools()`, zero active tools, and no extension-
   sourced tool.
7. Pi's ResourceLoader rejects an explicit-extension `write` collision before
   RPC in both load orders and attributes both source paths.

Decision:

- Production uses `--no-builtin-tools` without a CLI allowlist containing
  built-in names.
- After all explicit extensions load, the mandatory extension sets the exact
  expected active set and attests tool source path, schema, and manifest
  membership.
- The pinned ResourceLoader must reject duplicate registrations before RPC;
  dual-order adversarial tests enforce that prerequisite because
  `getAllTools()` is not collision detection.
- Any built-in or wrong source, missing or unexpected tool, duplicate
  registration, or later tool-surface mutation fails before provider transport.
- `user_bash` replacement is mandatory and is exercised independently from
  model tool calls.
- The inline `llama` command is included in startup attestation but is not an
  enabled Hitch extension command and is never forwarded from IM. P0a observed
  no tool registered by the inline extension.

P0a closure:

- `node spikes/p0a/run-p0a.mjs` recreated and asserted all eight cases with a
  temporary empty `HOME`, minimal environment, offline mode, no credentials,
  and no provider calls on 2026-08-12;
- Pi `0.84.1`, Node `v24.14.0`, npm `11.9.0`, and kernel
  `7.0.0-28-generic` matched the pinned baseline;
- the complete Pi package tree (excluding dependency `node_modules`) and every
  probe fixture matched its pinned SHA-256; and
- all sanitized outcomes passed in `spikes/p0a/P0A-EVIDENCE.json`.

### Checkpoint 1 independent review, cycle 1

Reviewer: independent subagent `/root/checkpoint1_review`

Verdict: **REVISE**

| Finding | Disposition in re-review candidate |
| --- | --- |
| Phase gate contradicted ComfyUI's declared host authority | Gate now permits only declared, certified host authority inside its reviewed validation, ownership, egress, output, cancellation, and credential policy |
| P0a controls and assertions were not exact enough | A2 controls now differ on discovery only; exact command/all-tool/active-tool/source-path sets and `llama` zero-tool disposition are asserted |
| Duplicate-tool detection claim was unsupported | Added a real conflicting extension and proved Pi ResourceLoader rejection in both load orders; docs no longer claim `getAllTools()` detects collisions |
| ComfyUI workflow and streaming boundaries were underspecified | Added per-workflow typed manifests, immutable input handles, exact-origin egress, streaming-time limits, validation, cleanup, and sanitized errors |
| Forge path, command, payload, regex, and size controls were underspecified | Added path redaction, excluded payload/intercept handlers, profile validation, concrete resource/output/state limits, and disabled regex transforms |
| Evidence inherited ambient state and did not pin the Pi artifact | Runner now uses a temporary empty `HOME`, minimal environment, pinned Pi installed-tree and fixture digests, and no legacy driver dependency |
| Checkpoint wording and Phase 0 estimate were inconsistent | Plan now names five evidence checkpoints and estimates Phase 0 at 8–16 active agent-hours |

### Checkpoint 1 independent review, cycle 2

The same independent reviewer reran all eight cases from a temporary copy and
manually reproduced the collision with nonzero exit, zero RPC stdout, and an
attributed `write` conflict. No blocking findings remained. Verdict: **PASS**.

Two low-severity cleanup notes were resolved before advancing: the collision
fixture comment now describes ResourceLoader rejection rather than first-wins
semantics, and the ComfyUI contract now names its exact eight-tool initial
surface plus the dispositions of model inventory, global interrupt, and
Danbooru tag search.

## Operator-extension compatibility decision

Hitch loads installed immutable packages, never sibling source imports. Pi
Forge and ComfyUI Paint are co-developed certification targets governed by
`docs/operator-extension-compatibility.md`; they are not treated as arbitrary
drop-in host tools. Provider-only extensions retain the simpler native Pi path.

Checkpoint 1 is accepted. Subsequent extension implementation must still prove
the full service-mode contract against the installed artifacts before the
consolidated Phase 0 gate.

## Pi provider/profile/session runtime probe

Date: 2026-08-12

Artifacts:

- `spikes/p0-runtime/provider-fixture.ts` — SHA-256
  `12e461ccc66c6cce800fabe01362f755876b83de6fecfb9a5ec514867b12b0e7`
- `spikes/p0-runtime/oauth-worker.mjs` — SHA-256
  `5df72d71ab514b10ecdadd41332955e37a9cfda5d150bb321ec1ff757b198eff`
- `spikes/p0-runtime/auth-crash-worker.mjs` — SHA-256
  `1b0c77879867ac3d122c8ccc3800c08302cffc1d49887318572c74d5f19498b6`
- `spikes/p0-runtime/run-runtime.mjs` — SHA-256
  `7d587e1fba077d828672a14f7298b7b208afd03c18eed85f86cbc4b697dfd23a`
- `spikes/p0-runtime/P0-RUNTIME-EVIDENCE.json` — content-free sanitized run
  manifest with reproducible assertions
- installed Pi package tree excluding dependency `node_modules` — SHA-256
  `7298ead16e553a8ffc372ca6a5a17ccfd711ae0887830134255dcea08be55bba`
- complete installed Pi dependency closure including `node_modules` — SHA-256
  `6d2055eaeef6823fd4b6edc062314e383fc6e233a4634a13e868a86eaebbcec4`

The deterministic extension registers one synthetic API-key provider and one
synthetic OAuth provider with three models. Its stream is local and makes no
network request. Credentials, prompts, response text, file paths, and raw RPC
events are asserted during the run but omitted from the evidence manifest.
The operator-profile inventory and real API-key/OAuth smoke were not run: they
remain opt-in credentialed acceptance and must be recorded before Checkpoint 5
can pass. Synthetic success is not reported as live-provider success.

Revised observations pending independent re-review:

1. RPC returned and asserted the exact three-model capability tuples. Their
   sanitized catalog SHA-256 is
   `21ce1e0a841a551745088c97b7c0f42c06e651c4e99b60730a2398e64fa48fa2`.
   Unknown model selection failed.
2. A reasoning model exposed `off|minimal|low|medium|high`; selection of `high`
   persisted. Switching to a non-reasoning model clamped it to `off`.
3. After deleting Pi's mutable default settings, a fresh controller opening the
   exact JSONL path restored model `hitch-fixture-key/reasoning-image` and
   thinking `high` from the transcript.
4. An RPC `prompt` response arrived at preflight. A two-cycle model/tool/model
   Turn and a two-attempt automatic-retry Turn proved that only
   `agent_settled` is the usable idle boundary; dependent RPC ran afterward.
   `turn_end` occurred twice in both fixtures and `agent_end` occurred twice
   during retry.
5. A controller that changed model/thinking and exited without prompting kept
   the state in process but created no JSONL. Pi created the transcript only
   after the first assistant response.
6. The OAuth model was selected, prompted, and restored with thinking `medium`
   through two fresh RPC controllers. The exact provider stream log contained
   one OAuth-model call and no credential material.
7. Two pre-initialized Pi `ModelRuntime` processes were released through one
   barrier against an expired synthetic OAuth credential. Pi's file lock plus
   double-check serialized one successful refresh and both processes resolved
   auth. The normal-path JSON stayed valid, mode `0600`, and the lock was
   released. This proves serialization, not atomic persistence.
8. With deterministic refresh failure, the two serialized processes attempted
   refresh once each, neither resolved auth, and `auth.json` remained byte-
   identical and valid.
9. Fault injection terminated Pi during its in-place `writeFileSync` after
   truncation and a partial write. The original bytes were lost and
   `auth.json` became invalid JSON. Pi 0.84.1 auth persistence is not
   crash-atomic and fails the security floor.
10. Pi does not fsync transcript appends. After each clean controller exit the
    runner successfully opened the exact transcript read-only and fsynced both
    it and its parent directory. Hitch must perform this step and quarantine
    on any close/sync failure.
11. Two processes opening the same transcript produced parseable JSONL sibling
   branches, but only one of the two concurrent Turns was on the selected leaf
   path. Concurrent transcript opens are therefore unsafe despite syntactically
   valid output.

Provisional decision:

- retain one global active provider-owning controller for the MVP;
- treat the auth lock as serialization only. Checkpoint 2's deterministic
  subgate may pass, but consolidated Phase 0 remains blocked until the pinned
  Pi auth writer durably fsyncs a temporary file, atomically renames it, fsyncs
  the parent directory, and passes this crash test;
- a higher concurrency setting also remains prohibited until opt-in real OAuth
  success/failure testing passes for the actual operator auth families;
- the gate also prevents concurrent opens of a Pi transcript;
- reopen only the exact private `--session` path recorded after first flush,
  never partial/global `--session-id` lookup;
- persist Hitch ownership plus requested model/thinking before Pi creates the
  first transcript, then reconcile the exact path and restored state; and
- treat RPC prompt success as acceptance only; wait for `agent_settled`, clean
  exit, and successful Hitch fsync of the transcript and parent directory
  before completing a Turn. Any ambiguity or sync failure quarantines.

### Checkpoint 2 independent review, cycle 1

Reviewer: independent subagent `/root/checkpoint2_review`

Verdict: **REVISE**

The reviewer reran the probe twice in place and once from a temporary copy.
All executions passed, but the review found that several claims exceeded the
actual security evidence.

| Finding | Disposition in re-review candidate |
| --- | --- |
| Runner advanced on `turn_end`/`agent_end`, not authoritative idle | Runner now waits only for `agent_settled`; tool-loop and automatic-retry fixtures prove dependent RPC occurs afterward |
| Serialized OAuth write was incorrectly described as atomic | Added mid-write `SIGKILL` injection, which proves corruption; docs and manifest now block final Phase 0 on a durable atomic auth writer |
| Pi transcript writes did not satisfy durable sync | Runner performs and records post-exit transcript-file and parent-directory fsync; production contract quarantines on failure |
| Pi dependencies implementing runtime/auth/session behavior were not pinned | Runner now verifies the full installed dependency closure as well as the Pi package tree |
| OAuth provider was not selected or prompted through RPC | Added OAuth RPC catalog, selection, thinking, prompt, settlement, exact call, and fresh-controller restoration checks |
| Capability, preflush, call-count, credential-scan, and failed-worker assertions were incomplete | Added exact capability tuples/catalog digest, a no-prompt controller, computed stream-call count, rotated-token scanning with credential-free logs, and unconditional exact worker-model assertions |

### Checkpoint 2 independent review, cycle 2

Reviewer: independent subagent `/root/checkpoint2_rereview`

Verdict: **PASS** for the credential-free deterministic subgate.

The reviewer inspected every runtime artifact and the pinned Pi source, then
ran the probe twice from isolated temporary copies. After normalizing the
timestamp and generated transcript filename, both runs matched the recorded
evidence with SHA-256
`5346299866f69a09460d3003deca769b14d61ddeeed6981830f154399938e17f`.
It independently confirmed the exact model/capability catalog, model and
thinking restoration, pre-flush behavior, OAuth RPC path, `agent_settled`
boundary, refresh serialization/failure behavior, corrupting crash injection,
post-exit transcript fsync, same-transcript sibling branches, minimal
environment, offline operation, and content-free manifest.

No blocking findings remain for Checkpoint 2. The review retained these final-
gate blockers rather than treating synthetic evidence as live acceptance:

- replace Pi's in-place auth write with durable temp-write, file fsync, atomic
  rename, and parent-directory fsync, then pass crash injection; and
- run the opt-in operator-profile inventory plus real API-key and OAuth smoke
  before Checkpoint 5 can pass.

The one-global-controller gate remains mandatory and is not a substitute for
crash-atomic credential persistence. Optional runner-hardening notes—asserting
more event-order relationships directly and scanning raw temporary fixture
logs—were recorded as non-blocking because the current bounded writers and
emitted evidence were independently inspected and clean.

## Mandatory extension and Bubblewrap backend probe

Date: 2026-08-12

Status: deterministic evidence pending independent review. The production
candidate remains blocked on an enforceable workspace quota on the deployment
filesystem.

Artifacts:

- `spikes/p0-sandbox/hitch-sandbox.ts` — SHA-256
  `9cc0929c921c47632c2ba53701c95dd5fd195712e1671779931bdaf7c59bf1d8`
- `spikes/p0-sandbox/sandbox-backend.mjs` — SHA-256
  `72d9d2e11012a77dda0491253cc346c5417cfd7a67a0e7042dd79ea7cb91a2c1`
- `spikes/p0-sandbox/sandbox-worker.mjs` — SHA-256
  `7c591aeaa72ca63ddb09db42ee0562505ea3f416264f64870e69e9d8970f2cd9`
- `spikes/p0-sandbox/secure-bwrap-helper.c` — SHA-256
  `766c4e48ab4862f5f9afc394b15c48a69ed6988fc32267e94f0512f225b07c6f`
- compiled helper on the pinned host/toolchain — SHA-256
  `9428f425beb6a544616920f66b74c6d7d4b2b92e9ccf3923a55f9796cf513027`
- `spikes/p0-sandbox/provider-fixture.ts` — SHA-256
  `40f1cde139aaf0d47e3f6b640dbb7436abc999031112552fef2683c32d1bc323`
- `spikes/p0-sandbox/run-sandbox.mjs` — its current digest is recorded in
  `spikes/p0-sandbox/P0-SANDBOX-EVIDENCE.json`
- `spikes/p0-sandbox/P0-SANDBOX-EVIDENCE.json` — content-free deterministic
  run manifest
- installed Pi package tree excluding dependency `node_modules` — SHA-256
  `7298ead16e553a8ffc372ca6a5a17ccfd711ae0887830134255dcea08be55bba`
- complete installed Pi dependency closure including `node_modules` — SHA-256
  `6d2055eaeef6823fd4b6edc062314e383fc6e233a4634a13e868a86eaebbcec4`

The helper is a bounded adaptation of the old Hitch secure launcher, not a
runtime import. Reviewed source inputs inspected before the adaptation were:

- old `secure-bwrap-launcher.c` — SHA-256
  `eff56a9444f91e2699a5aa3b022a8b4cd8a2bb8f7588ef4675b66b0ced8e5d59`;
- old `supervisor-openat2.c` — SHA-256
  `8472d799fac1c78120eb71b4866ef21c7efec278d1583999eb5edc394caf08ff`;
- old Bubblewrap plan — SHA-256
  `ad20279d2fab5fad97a26b681626f3fe0fdaae773c43e7047814cc4724e26af8`;
  and
- old ephemeral-worker supervisor — SHA-256
  `fc93994889a60a345f3a92cd65a93daa50ebcb6da6b53615ba700e9235d03117`.

Observations pending independent review:

1. Pi loaded the mandatory extension first with discovery and built-ins
   disabled. At `session_start` the extension set and attested exactly
   `bash`, `edit`, `find`, `grep`, `hitch_publish`, `ls`, `read`, and `write`.
   Every winning source path was the mandatory extension and the combined
   parameter-schema SHA-256 was
   `198eb6c8949ac454b550602553fcbf4f19691ea7c5c0d3c4e796a97b1d7976bd`.
   Each controller received a unique nonce, the startup record included that
   nonce, and the harness refused to submit direct bash or a prompt until the
   one matching fresh attestation existed. A deliberate `session_start`
   failure after a successful controller proved that Pi reports and swallows
   the extension error; the harness rejected the earlier controller's stale
   readiness and submitted no work.
2. A local image-capable synthetic provider drove all eight tools through
   nine provider cycles. A native one-pixel PNG remained present in every
   provider context. Direct RPC bash independently reached the same backend.
3. Each operation entered a unique systemd transient scope with exact
   `MemoryMax`, zero swap, `TasksMax`, `RuntimeMaxSec`, `CPUQuota=50%`, and
   `KillMode=control-group`. The supervisor checked the live cgroup's
   `memory.max`, `memory.swap.max`, `pids.max`, and `cpu.max`, bounded combined
   output from spawn, and accepted capacity release only after the unit was
   inactive and its complete cgroup tree was empty.
4. The reviewed helper reopened workspace, inbox, worker, runtime, and the
   operation-only publication root using `openat2` with beneath/no-symlink/
   no-magiclink resolution, compared the exact device/inode/mode/link/owner/
   size evidence, sealed the worker in a memfd, verified the executable copier
   digest on its already-open single-link descriptor, and passed only
   descriptors to Bubblewrap. A symlink workspace was rejected before launch.
5. Bubblewrap exposed `/workspace` read-write and `/inbox` read-only, used a
   size-bounded private `/tmp`, cleared the environment, omitted host home,
   provider profile, other-user workspace, and publication root from ordinary
   operations, and unshared the network namespace. Synthetic controller and
   channel secrets did not enter the guest, RPC output, audit, or manifest.
6. `hitch_publish` was the only operation that received the Turn-private
   publication descriptor. The native copier opened the full relative source
   beneath the workspace descriptor with `openat2` no-symlink/no-magiclink
   resolution, required a regular single-link file, bounded and hashed the
   descriptor copy, compared pre/post metadata, fsynced the immutable snapshot
   and parent, and returned only artifact id, bytes, and digest. Symlink and
   hardlink sources, intermediate symlinks, and a concurrently mutating source
   were rejected without a partial artifact. Native write errors unlink their
   temporary file; after an abrupt scope abort, the trusted backend removes
   and durably fsyncs the exact operation-owned temporary name. The injected
   interrupted-copy fixture left the publication root empty.
7. Wall, memory, process, temporary-storage, and combined-output exhaustion
   cases were enforced. Standalone abort and Pi `abort` both killed a spawned
   shell tree; every backend audit recorded `cleanupConfirmed: true`, Pi
   reached `agent_settled`, and zero transient units remained.
8. A deliberately wrong extension digest caused Pi extension loading to fail
   before RPC. The supplied direct-bash command did not execute on the host.
   Operation failures return a fixed `sandbox-failed` result for direct bash,
   so Pi cannot fall through to its local operations.

Provisional decision:

- continue with the custom Bubblewrap candidate; QEMU is absent, so Gondolin
  remains unevaluated rather than implicitly rejected;
- retain the helper/backend as Phase 0 evidence, not yet a production package;
- require the production filesystem to expose an enforceable per-workspace
  project quota and verify it at startup. The current root ext4 mount has no
  `prjquota`/`project` option, so Checkpoint 3 cannot select this host as
  production-ready; and
- do not use the older repository's current real-sandbox test result as
  evidence. Its static/openat2 tests passed, but 11 real-launch tests failed at
  the old secure-helper acknowledgement on this host. The new bounded probe
  uses a different fixed-helper transient-scope handoff and proves it directly.

### Checkpoint 3 independent review, cycle 1

Reviewer: independent subagent `/root/checkpoint3_review`

Verdict: **REVISE**

The review found four blockers: intermediate publication symlinks were not
descriptor-confined; readiness could be inherited from an earlier controller
after Pi swallowed a later `session_start` failure; the Pi dependency closure
was not pinned; and native write or scope-abort failures could orphan a
publication temporary. The revision and adversarial cases described above
close each finding.

### Checkpoint 3 independent review, cycle 2

Reviewer: independent subagent `/root/checkpoint3_review`

Verdict: **PASS** for the credential-free deterministic Bubblewrap subgate.

The reviewer read every artifact and relevant pinned Pi source, then ran the
gate in place and from an isolated repository copy. Both exited zero. After
removing `createdAt`, the in-place, isolated, and checked-in manifests matched
with SHA-256
`586c0facb24f5bc0c4a89075bd8c4a23b2e426d07fd9d630f8e0e566a7722498`.
The pinned source hashes and reproduced compiled-helper hash matched, and no
transient units or processes remained.

No blocking finding remains for Checkpoint 3's deterministic subgate. The
review retains these consolidated/deployment blockers without misreporting
them as sandbox success:

- the current ext4 workspace filesystem lacks `prjquota`/`project`, so real
  per-workspace `EDQUOT` behavior is unproven and this host is not production-
  ready;
- QEMU is absent, so Gondolin remains unevaluated rather than rejected;
- Checkpoint 2's crash-atomic Pi auth-writer repair remains mandatory; and
- operator-profile, real provider, transport, media, and live acceptance
  remain opt-in or pending their later checkpoints.

## Telegram and WeChat transport inventory

Date: 2026-08-12

Artifacts:

- `spikes/p0-transports/transport-contract.mjs` — SHA-256
  `2409b50d24c6cea51bd92efc1e67b66673b2a5b62e74c4250b4d848936a4576a`
- `spikes/p0-transports/P0-TRANSPORT-INVENTORY.md` — SHA-256
  `ebb8224d5d3e7d6115351d14ba25ccc50f901a315328fb441674ec61c5dfcc2c`
- `spikes/p0-transports/run-transports.mjs` — SHA-256
  `097559862d79c2c6b8fc688dee36d8d79ffc828c415d7ba15490a46673636349`
- `spikes/p0-transports/P0-TRANSPORT-EVIDENCE.json` — content-free
  deterministic inventory manifest
- legacy transport reference commit
  `f3b90e57f19d345616b94119174113e96129bf78`; the ten selected-file hashes
  are recorded in the manifest and match that commit despite unrelated dirty
  v2 files in the sibling worktree
- installed `wechat-ilink-client@0.1.0` — integrity
  `sha512-/gsWGEGEsWA7C5cgfKtguCL7QPdT95I1HfHHiRcHtwQppwVfgD8aDL4m4soANp1qQDl5RgiJ7q9gh9X5cXUfqA==`;
  installed-tree SHA-256
  `6205dfffd66cef090dab6981fb01b11d7db17c89c7b80c17f7206340fe726302`

The credential-free inventory made no network or channel call. It passed in
place and from an isolated current-repository copy with the legacy reference
provided explicitly. After deleting only `createdAt`, both manifests matched
with SHA-256
`9971236d8ed74b60e6fc2c51a6b6ddc09c231ef0909be6f33927dd420a1e315d`.

Observations pending independent review:

1. The old Telegram shape does not parse or enforce `chat.type`. It admits on
   chat allowlist before sender authorization, so a configured group or a
   group member can reach attachment work before the later principal denial.
2. Telegram's update offset starts at zero and exists only in memory. The old
   hub runs prompts in the background, allowing polling/remote acknowledgement
   to progress without a transactional durable intake boundary. Message IDs
   are not endpoint-namespaced in the adapter.
3. Telegram buffers complete downloads before its actual-size check and reads
   a live outbound path completely before sending. Ambiguous POST retries have
   no durable `possibly_sent` state. These paths do not satisfy the media or
   outbox floor.
4. The old WeChat adapter selects `group_id || from_user_id`, represents groups
   as threads, and permits context-token/media work before the later principal
   check. It synthesizes a missing stable message ID from `seq` or wall-clock
   time.
5. The pinned WeChat client's high-level monitor persists `get_updates_buf`
   before iterating messages. Its EventEmitter callback does not await the
   adapter's asynchronous admission. A crash can therefore lose an update
   whose remote cursor has advanced but whose Turn was never durably admitted.
6. WeChat credentials, cursor, and context-token maps use in-place JSON writes
   with best-effort chmod and no fsync/rename/quarantine. Tokens are keyed by
   peer/chat with fallback rather than the configured account/peer tuple.
7. The WeChat client buffers a complete CDN object before decryption and the
   adapter checks size only afterward. The shared media cache globally
   content-deduplicates across principals. The multi-channel intake queue is
   unbounded.
8. The deterministic contract accepted only exact Telegram bot/private-chat/
   sender and WeChat authenticated-account/private-peer tuples with stable
   IDs. It rejected groups, missing fields, tuple drift, ambiguous payloads,
   unstable IDs, and conflicting recipients before media eligibility. It also
   proved endpoint-namespaced new/duplicate/conflict idempotency and account/
   peer-bound WeChat context-token keys. Control characters are rejected in
   identifiers, and length-prefixed composite keys prevent delimiter
   collisions. Content and filenames never selected identity.

Provisional decision:

- treat both legacy adapters as reference-only, not production source;
- rebuild Telegram direct Bot API polling around transactional durable intake,
  private tuple validation, bounded owner-private media, and durable outbox;
- retain the pinned WeChat package only as a raw `ApiClient` live-inventory
  candidate. Do not use its high-level `start()` monitor; Hitch must own cursor
  advancement and atomically admit the complete batch before committing it;
- adapt the observed WeChat response/rate/upload shapes only after opt-in live
  evidence and behind the same owner, cancellation, media, and outbox rules;
  and
- do not report this deterministic inventory as live Telegram or WeChat
  success. Bot token, QR/login, raw envelope, media, delivery ambiguity, and
  multi-account behavior remain separately named opt-in acceptance.

### Checkpoint 4 independent review, cycle 1

Reviewer: independent subagent `/root/checkpoint3_review`

Verdict: **REVISE**

The first review found that raw string identifiers could contain NUL while
identity, idempotency, and context-token keys used NUL delimiters. Distinct
WeChat account/peer partitions could therefore collide. The revision rejects
control characters, uses UTF-8 byte-length-prefixed composite fields, and adds
the formerly colliding endpoints plus a structured-partition noncollision
fixture.

### Checkpoint 4 independent review, cycle 2

Reviewer: independent subagent `/root/checkpoint3_review`

Verdict: **PASS** for the deterministic transport inventory subgate.

The reviewer read every artifact, all ten pinned legacy files, and the complete
installed WeChat client runtime/types/package/READMEs. It ran the inventory in
place and from an isolated current-repository copy. After deleting only
`createdAt`, both manifests matched with SHA-256
`9971236d8ed74b60e6fc2c51a6b6ddc09c231ef0909be6f33927dd420a1e315d`.
The exact legacy findings, sanitization claims, collision fix, and reference-
only decisions were confirmed.

Checkpoint 4 does not select a production transport and does not claim live
channel success. Telegram bot/update/media/delivery behavior and WeChat QR,
login, raw envelopes, media, delivery ambiguity, and multi-account behavior
remain named opt-in acceptance.

## Consolidated Phase 0 release gate

Date: 2026-08-12

Artifacts:

- `spikes/p0-gate/run-gate.mjs` — SHA-256
  `5dc5270c720d45d81719ffa9553e9140df8ca927f52ff7289a6a18612f4ab202`
- `spikes/p0-gate/P0-GATE-EVIDENCE.json` — SHA-256
  `321c4e84e1f11d4bab1682c793b48e0da501eb335dc2c0dfb24969e1427d6ded`;
  after deleting only `createdAt`, SHA-256
  `38a1b16ded57b3a12c6447bb301f8ded2649e06684fee33425bce176e4752b38`
- dedicated operator Pi package lock — SHA-256
  `75e860aac1cc09cad3087acc39e2f0fe34a05cf91e416761a4f2c3be1f9f3c20`

The gate pins and verifies each accepted checkpoint runner, exact case set, and
normalized manifest before accepting its result. An outcome-only substitute is
deliberately rejected. It reruns all four accepted deterministic probes,
verifies the installed operator package versions, npm integrities, full
package trees, and entry digests, then records an explicit blocked rather than
weakening a control or claiming that an unrun live test passed.

Installed operator-extension inventory:

| Candidate | Exact installed artifact | Gate result |
| --- | --- | --- |
| Pi Forge | `@zihanw/pi-forge@0.4.0`; tree `4e3eb7894ea12b357f2be7b15929ad9b71f0d64f7e84d9b4e1a8ba075b32ef8d` | Required Hitch service mode is absent. The entry still registers provider-payload interception, subagent tools/commands, project/global discovery, and web editor behavior. Excluded from the MVP manifest. |
| ComfyUI Paint | `pi-comfyui-paint@0.3.0`; tree `023684bd2cdaf9d18d2ca405ff8767d2d8fa473dd8981fd2bec7d9c4074ffec6` | Required Hitch service mode is absent. The entry registers backend-wide interrupt and Danbooru tools, reads project/global config/workflows, and does not enforce Hitch owner-bound job/snapshot policy. Excluded from the MVP manifest. |
| Volcengine provider | `pi-volcengine-provider@0.1.2`; tree `9dfa09264530ff487eee87b1a920706cd8fce9b4639c93b36304bdf83eb288e1` | Provider-only registration is present; remains inventory-only until the opt-in operator-profile and live provider smoke. |

Final independently reviewed gate result: **BLOCKED**.

Phase 1 is not authorized because four Phase 0 requirements remain open:

1. Pi's pinned auth writer is not crash-atomic; the accepted fault injection
   corrupts `auth.json`.
2. The deployment filesystem has no enforceable per-workspace project quota;
   real `EDQUOT` behavior is unproven.
3. Neither Pi Forge nor ComfyUI Paint ships the certified Hitch service mode,
   so the requested initial operator-extension set cannot be loaded safely.
4. Operator-profile inventory plus real API-key/OAuth smoke remains opt-in and
   unrun.

Live Telegram/WeChat/media acceptance remains deferred to its planned phases;
it is a final-product acceptance requirement, not misreported as a completed
Phase 0 transport test. QEMU remains absent, so Gondolin is unevaluated.

### Checkpoint 5 independent review, cycle 1

Reviewer: independent subagent `/root/checkpoint3_review`

Verdict: **REVISE**

The first review found that the consolidated runner accepted each nested
checkpoint using only its caller-controlled `outcome` string. The revision
pins every accepted nested runner and normalized manifest digest, validates
the exact case set and pass flags, records those attestations, and proves that
an outcome-only substitute runner is rejected.

### Checkpoint 5 independent review, cycle 2

Reviewer: independent subagent `/root/checkpoint3_review`

Verdict: **PASS** for the complete Checkpoint 5 no-go gate.

The reviewer read the frozen gate artifacts and package sources, ran the gate
in place and from an isolated repository copy, and deliberately replaced the
P0a runner with an outcome-only fake. Both genuine runs exited zero and
matched after deleting only `createdAt`, with recursively stable SHA-256
`38a1b16ded57b3a12c6447bb301f8ded2649e06684fee33425bce176e4752b38`;
the fake failed immediately on runner drift. Package inputs and incompatible
extension dispositions reproduced, evidence remained mode `0600`, and no
transient sandbox units remained.

Checkpoint 5 is complete. Its PASS certifies the no-go decision and evidence;
it does not clear the four open Phase 0 requirements. Phase 0 therefore remains
blocked and Phase 1 is not authorized.
