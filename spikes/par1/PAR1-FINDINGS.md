# PAR-1: two Pi controllers with independent profile directories can run concurrently

Status: spike evidence recorded; production parallelization still blocked by one
non-Pi global cleanup.

## Goal

Verify the specific hypothesis behind `NativePiRuntime.run()`'s global promise
gate: the only reason one provider-owning Pi controller may run at a time is
the shared Pi profile directory (`auth.json` and friends), and that cloning the
operator profile into two private directories is enough to run two Turn
controllers concurrently.

The spike deliberately does **not** modify production code. It bypasses the
`NativePiRuntime` gate by spawning two direct Pi 0.84.1 RPC controllers with
independent profile directories, independent session directories, independent
workspaces, and independent `HOME`s.

## How to run

Default deterministic run (no real credentials, no network):

```sh
node spikes/par1/run-par1.mjs
```

The runner:

1. builds a synthetic operator profile (fake API-key auth + fake provider
   extension) or, when `HITCH_PAR1_SOURCE_PROFILE` is set, clones the real
   operator profile into two private temporary directories;
2. starts both Pi RPC controllers, waits until **both** have selected a model,
   then releases a barrier so both prompts overlap in time;
3. waits for `agent_settled` + clean exit in both controllers;
4. calls the production `validatePiProfile` on both clones after the run;
5. proves no cross-write with unique per-clone owner markers plus an identical
   post-run file-path set; and
6. records a content-free evidence manifest in `PAR1-EVIDENCE.json`.

Real provider calls are opt-in and require an explicit operator profile:

```sh
HITCH_PAR1_SOURCE_PROFILE=/path/to/pi-profile HITCH_PAR1_REAL=1 \
  node spikes/par1/run-par1.mjs
```

Real mode still copies that profile to two private temporary clones, runs the
same concurrent barrier, and performs real provider calls. It was not run in CI
or in this commit (no operator profile was available), so the default fake-mode
result is the recorded evidence.

## Result

- Both controllers completed their Turns: prompt response success,
  `agent_settled`, matching assistant text, session file created.
- Both cloned profile directories passed the production `validatePiProfile`
  after the run.
- No cross-write: each clone retained its unique owner marker, no file in one
  clone contained the other clone's marker, and both clones had identical file
  paths afterward.
- The two provider streams overlapped in time (both started at the same
  barrier release; both ran a synthetic 800 ms delayed stream).
- With separate profile dirs and separate session dirs, Pi's own file locks
  and auth writes did not contend. `proper-lockfile` locks are per-path, and
  each controller was a separate OS process, so Pi's in-process module-level
  auth/models cache is also isolated.

## Honest blockers and caveats

### 1. Replacing the promise gate is not sufficient in production

`NativePiRuntime` does not only serialize on `#gate`. Its sandbox cleanup
(`cleanupSandboxUnits()`) scans and kills **all** `hitch-p0-*.scope` units
globally. Two `NativePiRuntime` instances (or one runtime with the gate
removed) running concurrently would kill each other's active Bubblewrap units.
Removing or per-instance-izing the promise gate therefore also requires
per-runtime ownership of sandbox units (scope name namespacing, only cleaning
units owned by this runtime, or centralized capacity ownership). This is a
Hitch-side blocker, not a Pi-auth blocker.

### 2. Same Pi transcript is still unsafe

This spike does **not** revisit the already-recorded Phase 0 finding: two
processes opening the same Pi JSONL transcript create sibling branches with
only one Turn on the selected leaf. The PAR-1 result is valid only when each
controller also owns a distinct session directory (`--session-dir`) and never
shares a transcript. The spike enforces that separation.

### 3. Pi creates `settings.json` during a Turn

Each controller wrote `settings.json` (default provider/model) into its own
profile on `set_model`. The spike sets `umask 0o077` before launching Pi so
that file is created `0600` and `validatePiProfile` passes after the run. If a
production service runs with a looser umask, `validatePiProfile` will reject
the newly created `settings.json`; the service should either force a restrictive
umask before spawning Pi or normalize file modes after Pi writes.

### 4. Real-provider opt-in is not part of this recorded evidence

Only the deterministic fake-provider path is recorded in
`PAR1-EVIDENCE.json`. Real OAuth refresh may legitimately mutate a clone's
`auth.json`; the spike's cross-write proof (owner markers + identical path
sets) remains valid, but exact file digests are intentionally not required in
real mode.

## Files

- `run-par1.mjs` — runner and concurrent controller harness.
- `provider-fixture.ts` — local, offline, delayed fake provider for the default run.
- `PAR1-EVIDENCE.json` — sanitized run manifest.
