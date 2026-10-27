# Comfy continuation worker handoff

## Integration contract

- `paint.deliveryMode` accepts `agent` / `direct`; omission parses as `direct`.
  `ComfyToolHost.deliveryMode` is optional for existing hosts/doubles.
- Main configures `HitchStore.configureComfyContinuation(currentEnabledUsers)`
  before recovery, including when paint is disabled. This allowlist is separate
  from mode: a previously admitted agent job remains agent after switching the
  operator default back to direct.
- Service passes mode only through the trusted ledger call, never tool JSON.
  A completion-turn parent forces agent mode and supplies its persisted root.
- `finishComfyJob` atomically stores the result, associates it with a completion
  turn's **inbound** artifacts and queues that turn (or records it terminal and
  cancelled when revoked). Agent completion inserts zero outbox rows. Direct
  keeps its old terminal completion, caption and outbound-artifact path.
- `ComfyServiceOptions.onContinuationReady(userId)` invokes
  `HitchApplication.dispatchQueuedUser` after commit. Application start recovers
  durable queued turns even if the callback did not run before shutdown. An
  already-running continuation becomes unknown/quarantined, never replayed.
- Claim supplies trusted
  `RuntimeTurn.comfyContinuation = {jobId,outcome,rootTurnId,remainingJobs}` and
  the generated original in `turn.artifacts`. Prompt names the internal host
  event and retains the original root request; Discord provenance is preserved.
- Parent still owns **all native-runtime guidance and workspace materialization**.
  This change intentionally does not modify `src/runtime/native-runtime.ts`.
- Successful agent source/child turns awaiting generation are silent unless
  they explicitly publish artifacts. Failed/unknown/cancelled turns are not
  suppressed. Agent-enabled users' progress callbacks are not sent; direct
  progress remains unchanged. Explicit publication/final text uses the normal
  immutable-snapshot/outbox path.
- `getComfyResult` indexes agent originals from completion inbound artifacts
  without requiring outbox or terminal continuation state. Direct retains its
  strict source/completion terminal, exactly-one outbound/outbox validation.

## Safety / migration decisions

Existing `completion_turn_id` and `turn_artifacts` suffice for result indexing;
there is no additional result table. Forward-only schema **11** adds job mode,
root turn ID, a sticky continuation revocation flag and a root lookup index.
Schema 10 jobs default to direct, without changing turns/artifacts/outbox.

Agent job metadata is not pruned by the legacy 100-terminal-job retention rule:
the root count must survive cancelled/rejected jobs, branching, restart and
later unrelated requests. Each agent root can reserve at most four jobs,
including failed submissions; a separate original user turn gets a fresh root.
Direct's existing 100-row retention remains independent.

Session selection changes (`!new`, `!switch`, `!use` alias), stop, abort,
quarantine, disabled owner/endpoint or removed paint permission revoke old
continuations. Revocation is sticky even after switching back. Claim cancels
queued continuations, running continuations cannot submit further children or
publish after revocation, and pending successful final outbox rows expire.
Failure notices caused by the continuation's own quarantine are preserved when
the original endpoint/session selection is still valid. Original results stay
available to the enabled owner even if the continuation is cancelled.

## Deterministic evidence

- `test/comfyui-continuation.test.ts`: 43 cases using a fake model runtime and
  in-process fake backend (no GPU/provider/channel calls). Covers no automatic
  publication, original/index/metadata, single asynchronous continuation,
  silent child rounds/progress, FIFO, cross-branch/root budget and restart,
  forged metadata rejection, submitted/queued/running revocation matrix,
  cancelled job/source, failed backend/runtime, atomic rollback/retry,
  legacy direct retrieval, populated schema 10 forward migration, and stale
  final outbox claim denial.
- `test/comfyui-config.test.ts`: mode defaults, exact allowed values and invalid
  values, with existing policy/security checks.
- `test/foundation.test.ts`: prior migration expectations advance to schema 11.
- Full `npm run check`: **492 total / 464 passed / 28 opt-in skipped / 0 failed**
  (format, typecheck, build and deterministic suite). Evidence:
  `/tmp/comfyui-continuation-check.log`. `git diff --check` also passed. Opt-in
  host/live lanes are not asserted as executed.

## Remaining boundaries / review risks

- No native model/media/workspace acceptance is claimed here. Parent integration
  must demonstrate native image inspection, safe workspace materialization,
  chained edit/video references, guidance and model-selected final publish.
- Revocation does not abort a backend GPU job or forcibly kill an already-running
  model merely because selection changes. It blocks subsequent children and
  publication; normal abort/shutdown still uses existing runtime cancellation.
- Already claimed/in-flight channel sends cannot be unsent; transport ambiguity
  retains the existing possible duplicate-delivery limitation.
- Disabled owners/endpoints are not polled by the existing pending-job selector.
  Already downloaded results can be retained atomically even if a route is
  disabled mid-poll. Disabled paint owners are skipped by the service.
- Retaining agent ledger rows and artifacts is deliberate for durable budgets;
  no new garbage-collection/retention platform is introduced. Revocation checks
  use SQL, not loading workflow snapshots into memory.
- Failed commit imports can leave an unreferenced immutable blob until existing
  startup media cleanup; no re-generation occurs on retry. Submission-unknown
  jobs retain existing no-resubmit behavior.
- The worker performed deterministic checks and its own diff review. Independent
  architecture/native-runtime review remains parent-owned; no independent review
  agent was available in this worker's tool interface.
