# Dad sandbox isolation review — 2026-09-19

## Result and evidence layers

This increment was tested with synthetic identities, workspaces, auth sentinels
and MCP responses. No production credentials, user files, live provider, real
market-data quota or IM delivery were used. These are development results,
not a claim that the running service was upgraded.

- Default `npm run check`: **310 total, 286 passed, 24 opt-in skipped**.
- All opt-in lanes together with real local Pi/bwrap/systemd and an
  operator-installed adapter code copy: **49/49 passed, 0 skipped**. This covers
  every default-skipped case, plus the selected files' deterministic cases.
- Service-constrained acceptance: **12/12 passed** in a uniquely named
  temporary systemd user service.
- The MCP test uses the official SDK over local stdio, fixed synthetic results
  and a fake provider transport; it is not a real stock-price or channel test.

See [the default-profile evidence](dad-default-profile-review-20260919.md) and
[the MCP service boundary](hitch-mcp-service-boundary.md).

## Isolation actually exercised

`test/dad-sandbox.test.ts` checks distinct synthetic parent/dad workspace rows
and the composite foreign-key refusal of cross-owner session selection. Its
host lane exercises the production helper/backend, not a mocked filesystem:

- only the selected workspace, read-only inbox and scoped publication bridge
  are mounted; unmounted host and other-user sentinels/socket are inaccessible;
- traversal and absolute file-tool arguments fail; file and directory symlinks
  do not expose host paths; inbox writes fail;
- bash sees the sandbox cwd and bounded environment, not host auth/environment;
  external networking is denied;
- systemd cgroup controls are checked, and abort removes the owned scope before
  success is reported.

The complete RPC lanes additionally check pinned extension/source attestation,
shared synthetic auth persistence, Forge prompt order, disabled tool execution,
RPC bash interception, later tool-surface mutation, malformed prompts, missing
bootstrap, and model catalog refresh without inference. The new MCP RPC lane
loads the actual wrapper through Pi's jiti loader, verifies source paths and
late activation, executes a synthetic direct tool, and rejects management calls.

## Scope cleanup defects fixed

The previous startup path could invoke `cleanupSandboxUnits(null)` and kill
all matching current-UID scopes. The owner-scoped path also queried a global
glob and treated foreign units as its own cleanup failure.

`src/pi/sandbox-units.ts` now enumerates and kills only a validated owner
prefix. Startup inspection is read-only: existing or unconfirmable scopes
cause a fail-closed operator-recovery error rather than a global kill. This
conservatively prevents starting a new runtime beside unconfirmed same-UID
scopes; it is not automatic orphan recovery. Deterministic tests verify command
targets and zero mutation on invalid/foreign/startup-unknown cases.

Do **not** attribute all historical startup timeouts to the global sweep. A
separate confirmed fixture defect omitted `HITCH_EXPECTED_TOOLS` after the
manifest contract changed. The opt-in fixture now supplies the same expected
world/dynamic-path contract as production, without weakening attestation or
increasing its timeout. The complete host lane passed after these fixes.

## Publication regression fixed

The helper could produce `<id>.<ext>.blob` while the user `!send` path still
opened `<id>.blob`. The host test reproduced ENOENT. The runtime now requires
exactly one valid snapshot matching the requested artifact identity, then
retains regular-file, size and digest verification. Both model publication and
`!send` runtime paths passed txt/svg/no-extension fixtures against the real
backend; unexpected output remains fail-closed. No real channel delivery is
implied by this runtime evidence.

## Boundaries that remain

- Pi, selected extensions and configured MCP servers are trusted **host** code,
  not Bubblewrap guests. The new wrapper closes model-facing scripts and
  management/proxy bypasses, but does not sandbox the servers themselves.
- Adapter entry SHA verification is not an attestation of its whole dependency
  closure. The operator remains responsible for the installed code and server
  capabilities, environment and credentials.
- A same-UID host process can pre-place a hardlink in a workspace. The fixture
  deliberately demonstrates its readable synthetic contents; this is not a
  hostile same-UID filesystem boundary. Never pre-place cross-user/private
  material in an allowed workspace.
- A persona's request not to edit workflow files is behavioral guidance, not a
  read-only filesystem mount. Per-user workspaces are distinct, but sessions
  belonging to one user share that user's workspace.
- Exact channel bindings, real market data, quota behavior and received
  reminders still require attended acceptance for the intended account.
