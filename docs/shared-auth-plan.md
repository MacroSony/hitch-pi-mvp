# Shared operator OAuth persistence — AUTH-1

Status: code-accepted after deterministic and real pinned-CLI fixture checks. No live migration or real OAuth-provider acceptance yet.

## Scope and decisions

- All configured Hitch users intentionally use the same operator provider account(s).
- Existing `piProfileDir/auth.json` becomes the single persistent authority. It is not a startup seed after this change; runtime refresh writes back there. No new config, database table, credential broker, remote login, or user account registry.
- Each user's `PI_CODING_AGENT_DIR`, settings/models cache and sessions remain separate. Only selected non-secret provider/settings documents are staged from the operator profile; auth is never cloned into those directories again. Existing old user auth files are retained but ignored for rollback/attended migration; do not automatically choose or merge rotating credentials from old clones.
- Before a real switch, stop service and have the operator select/re-authorize the current authoritative credentials. This phase must not read/copy production credentials.
- Keep pinned Pi 0.84.1, original CLI/RPC, resource loader, tool/source attestation, sandbox, concurrency, transcript and delivery semantics.
- Public Pi `ModelRuntime.create({credentials})` accepts a `CredentialStore`; the CLI does not expose that parameter. A controller-only Node `--import` bootstrap narrowly wraps the public factory to supply this store before original CLI startup. This is an explicit pinned-version compatibility shim, not a general extension/preload loader. The pinned CLI explicitly supplies its per-user default authPath: accept and override only that expected path (or an omitted path), reject other explicit paths/stores, and never fall back to per-user auth. Successful factory initialization marks the bootstrap installed; mandatory startup attestation and the host gate require that marker.
- The store implements Pi's public credential contract with an on-disk Pi-compatible auth.json. Pi owns OAuth protocol and refresh logic. A common `proper-lockfile` lock (same canonical file/path and 30s stale convention as pinned Pi) covers read/refresh/update. Atomic private temporary + file fsync + rename + directory fsync replaces truncating writes. Store operations throw content-free errors, with no secret/path/cause payload.
- Lock state compromise, abort, invalid JSON, unsafe path/file modes, oversized data or failed persistence must fail rather than restore old seeds or silently continue with unsaved refreshed credentials.
- API-key reads must not silently transmit unresolved key references. Supported forms are literal keys and Pi environment templates (`$VAR`, `${VAR}`, `$$`, `$!`) using provider-scoped environment before the sanitized controller environment. Unresolved references and leading `!command` are rejected; command execution is intentionally unsupported. Never add arbitrary model-controlled host execution.
- Bootstrap and store are trusted controller code; no credentials in sandbox env/argv/mounts/tool output, SQLite, workspace, logs or IM. No real tokens in tests.
- No pi-agy installation, arbitrary provider loader, scheduler, source adapter, model-default changes or unattended login in AUTH-1. Additional plugin auth writers need separate review before enabling that plugin.

## Acceptance

1. Repeated profile preparation preserves shared refreshed auth, keeps users' settings/state separate, does not copy auth, and leaves old clones untouched.
2. Two processes using real pinned Pi ModelRuntime + a deterministic local OAuth fixture read the same auth, refresh a rotated token only once, and observe the persisted replacement in fresh processes.
3. Different provider modifications cannot lose each other's updates. Lock wait abort/failure releases or becomes stale, no partial JSON after failure before rename, file and directory durability path covered; accepted remote-refresh/local-crash gap documented.
4. Real Pi CLI fixture confirms original provider registration/catalog/Turn path consumes the shared store rather than a contradictory per-user auth file. Real sandbox fixture checks dummy token/path/env/process isolation. Bad/missing bootstrap initialization fails before prompting, no fallback.
5. `npm run check`, dedicated namespace-scoped RPC suite and independent review before commit. Do NOT call NativePiRuntime.create or legacy global startup cleanup suite beside live dogfood.
6. Pinned Pi package/dependency tree unchanged; no main/release/dist/online config edits. Document operator migration, re-login, rollback and limitations. No claim of live OAuth/provider acceptance without attended test.


## Acceptance evidence

- `npm run check`: **126 total / 112 passed / 14 opt-in skipped / 0 failed**.
- Namespace-scoped real pinned Pi CLI RPC suite: **14/14 passed**, including the existing Mode A/B2 regressions. Network/provider credentials are deterministic test fixtures, not an attended real OAuth login.
- Two separate profile/session controllers concurrently consume one expired OAuth authority; exactly one fixture refresh occurs. Both receive the new access token; rotated access **and refresh** tokens persist. A third fresh controller reuses them without refreshing. Contradictory per-user auth files remain unchanged and unused.
- Real sandbox RPC bash cannot read the dummy authority, see its host environment path or dummy tokens, or access the host controller PID. Missing bootstrap and missing authority fail the host attestation gate before a prompt is sent.
- Store subprocess tests cover concurrent different-provider updates, abort while waiting, malformed/oversized/linked files, oversized persistence, and SIGKILL after temporary-file fsync but before rename. The authority remains complete; a deliberately aged dead-fixture lock is recovered. This is a process-crash test, not simulated power-loss certification.
- Gemini reviewed the store lane; Luna reviewed the runtime/bootstrap/profile lane (neither reviewed its own lane as independent evidence). Both reported PASS; Mika reviewed integration and ran the final suites. The preferred reviewer profile could not start its extension-owned provider in its fresh-process backend; cross-review used working profiles instead.
- Clean temporary `npm ci --offline --ignore-scripts` passed. A lockfile comparison confirms every previously locked package entry is unchanged. Direct dependency `proper-lockfile` is pinned to 4.1.2; existing Pi remains 0.84.1. No upstream/private Pi imports, package patches, production credential reads, live-service changes or global startup-cleanup tests.

## Migration, recovery and limits

See the operator guide's **Shared operator authentication (AUTH-1)** section. This phase changes auth ownership, not database schema; deploying it together with already-accepted Mode A still requires the separate schema 3→4 backup/rollback decision.

The authority must exist, be canonical, service-owned, owner-private, singly linked, valid Pi JSON and at most 1 MiB. Missing files do not silently create an empty store. Preparation overwrites/removes only managed settings/models; models-store is seeded once, and legacy user auth is retained but ignored. It does not discover/copy arbitrary files or provider extensions.

All active auth writers must use the same lock protocol. Operator login/edit/restore is **service-stopped only**; do not run a desktop Pi or plugin writer against the same account's rotating token while Hitch is active. Sharing auth does not share workspaces or sessions, but does share account permissions, quotas, rate limits and revocation/failure scope; confirm provider terms permit the intended use.

The write is atomic locally, not a distributed transaction with the provider. A crash after remote refresh/rotation but before the new token is durably saved can still require re-login. A post-rename fsync/release failure is reported as failure even if the new complete file is already present; do not automatically restore an older token. Abort is cooperative, with a final check before rename submission; cancellation after commit begins cannot undo a completed write. A killed writer can leave a private `auth.json.tmp-*` orphan and a lock until it becomes stale. Only inspect/remove orphans while stopped; never force-delete a live lock. Additional provider/plugin writers, including pi-agy, are not covered by this phase.
