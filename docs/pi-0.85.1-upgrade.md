# Pi 0.85.1 and native catalog refresh

Status: development checks and isolated RPC accepted, not deployed.

## Intent

Keep Pi as Hitch's only provider/model knowledge source. Pin `pi-ai` and
`pi-coding-agent` to exact `0.85.1`, refresh native metadata once at startup,
and keep the resulting model menu and offline Turn controllers consistent.
There is no new schema, configuration platform, provider protocol, hand-made
model catalog, hot refresh, or automatic replay of quarantined work.

## Risk and trust boundary

This is a medium-risk controller/dependency compatibility change. The sandbox
and shared operator credential boundary remain mandatory and unchanged.

- Continue launching modular `dist/cli.js`, not the new bundled package-bin
  entry. The shared-auth preload must wrap the same public `ModelRuntime`
  class used by the CLI.
- Pi 0.85.1 retains a new inactive `powershell` builtin in its registry even
  with `--no-builtin-tools`. Add native `--exclude-tools powershell`; do not
  hide that tool from attestation or relax the exact eight-tool inventory
  (nine with web search). The two mandatory tool extensions are unchanged.
- Repack `pi-agy` as `0.6.1-hitch.2`: only package version and two exact Pi peer
  pins change from `.hitch.1`. No dependency-force bypass or provider fallback.
- Native startup refresh uses explicit prepared `modelsPath`/`modelsStorePath`
  and `SharedCredentialStore`. The shared authority is never copied. Metadata
  refresh can use Pi's native OAuth refresh, but never generates a model Turn.
- A 7-second refresh budget and content-free warning cover network failure,
  timeout, and provider refresh failure. Existing native cache/builtins remain
  usable. Bad local paths, configuration, credentials, or storage still fail
  closed. OAuth callback failure has a dedicated sanitized error type, distinct
  from read/write/lock/release failure; no original provider body escapes.
- Synchronize only `models-store.json` to prepared user profiles before the
  existing RPC catalog query. Controllers retain offline mode; restart is
  still the publication boundary. Pi's own metadata freshness policy applies.
- Missing model or unsupported thinking before controller creation returns
  `failed`, `model-unavailable`, reusable session. Ownership and transcript
  checks precede this shortcut; ambiguous execution, attestation, transcript,
  and cleanup failures still quarantine. File-only `!send` remains model-free.

## Review hunks

- `src/pi/native-runtime.ts`: package pins, startup refresh, model preflight,
  controller arguments, phase diagnostics.
- `src/pi/profile-preparation.ts`: native cache-only synchronization.
- `src/pi/auth-preload.ts`: explicit controller catalog paths.
- `src/pi/shared-credentials.ts`: sanitized provider-callback error distinction.
- `src/pi/runtime-diagnostics.ts`: allowlisted phase/code/status/Turn ID only;
  no prompts, provider response bodies, paths, tokens, or stacks in new logs.
- `package.json`, lockfile, and `vendor/pi-agy-README.md`: dependency provenance.

Run `node scripts/pi-package-hashes.mjs` after a clean install to calculate the
separate Pi package-tree and dependency-closure digests, then review and set
the runtime pins explicitly. The script only reports hashes; it never updates
or bypasses runtime validation. Historical Phase 0 evidence is not rewritten.

## Verification, 2026-09-16

- `npm run check`: format/typecheck/build passed; **171 passed, 18 opt-in
  skipped**.
- `HITCH_RUN_SANDBOX_TESTS=1 node --disable-warning=ExperimentalWarning --test
  dist/test/web-search-runtime.test.js`: **18/18 passed**. This fixture suite
  only cleans its own random systemd scope prefixes; it does not call the
  runtime's global startup cleanup.
- RPC coverage includes actual Pi 0.85.1 processes, mandatory tool attestation,
  shared OAuth with fake credentials, real sandbox tool loops, search egress
  fixtures, Forge reductions, exact old-session-file continuation, and cached
  `deepseek-flash` plus `low` selection without inference.
- Local HTTP catalog fixtures cover success, HTTP error, malformed remote
  JSON, timeout, offline reload, thinking/input capabilities, and no auth
  headers or model-generation endpoints. Bad local configuration/permissions
  fail rather than silently falling back. Offline OAuth availability is
  explicitly verified to issue zero network requests.
- Native package hashes match. `.hitch.1`/`.hitch.2` archive comparison found
  only `package/package.json` changed. Final independent focused review: PASS.
- **Not run:** broad `acceptance:host` / `acceptance:service`, credentialed
  provider generation, production release switch, or live channel delivery.
  No production configuration, database, credentials, or service was changed.

## Deployment and rollback

Deployment remains an attended, separately confirmed step. Preserve the
ongoing WeChat no-inbound test: do not request an IM `!recover` or new message.

1. Back up the production DB, operator authority, prepared model caches,
   configuration, and wake bindings; retain the old release.
2. With service ownership/idle state established, run the remaining host and
   service-constrained acceptance checks safely before switching the release.
3. Verify that startup RPC actually reports the chosen provider/model and
   thinking level. Recover the quarantined session through the backend;
   recovery creates a new session and does not inherit profile/model. Rebind
   or verify wake routing deliberately. Do not replay uncertain old work.
4. Test channel-only outbound delivery separately from model generation,
   recording provider outcome and outbox delivery outcome independently.

Before deployment, rollback is simply not promoting this branch. After a
switch, stop the service and restore the retained release and the relevant
backups as needed. No database migration is added. Do not restore a stale
OAuth backup blindly after a token rotation; operator re-login may be needed.
