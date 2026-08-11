# Luna implementation handoff

## Objective

Implement the private multi-user Pi IM MVP defined by:

1. `docs/product-scope.md`
2. `docs/security-floor.md`
3. `docs/architecture.md`
4. `docs/phase-0-inputs.md`
5. `docs/plan-review.md`
6. `PLAN.md`

When documents disagree, that order controls. Do not expand the product to
solve hypothetical future needs.

## First assignment

Implement only Phase 0. Do not scaffold the full service until the broker and
Pi session-continuity decisions are recorded and reviewed.

The deterministic work may begin immediately. Live acceptance cannot be
declared complete while any provider field in `docs/phase-0-inputs.md` is
`UNRESOLVED`.

Phase 0 must answer:

- Can the selected Pi version resume one stable session across fresh processes?
- Can it prove a durable terminal/flush boundary after graceful cancellation,
  and does forced termination leave the session quarantined?
- Can a fixed custom provider send normal agent-loop requests, SSE, tools, and
  images through a local HTTP-to-UDS proxy using only an opaque Turn token?
- Can that proxy run with the worker's external network namespace denied?
- Which existing Hitch modules can be copied narrowly, and what assumptions do
  their tests make?

Write `docs/phase-0-decisions.md` with commands, versions, input hashes,
observed behavior, retry/disconnect evidence, transcript crash results, the
selected broker path, and rejected alternatives. Commit the spike evidence
separately from production code.

## Working rules

- Prefer a working vertical path over a reusable framework.
- Use concrete `Pi`, `Telegram`, and `WeChat` names in code where behavior is
  product-specific.
- Keep trusted channel credentials and provider credentials in the host
  process only.
- Treat Bubblewrap, broker setup, and resource enforcement failures as fatal;
  never fall back to direct execution.
- Do not accept a live-provider proof until the exact provider block in
  `docs/phase-0-inputs.md` is resolved by the operator.
- Preserve user ownership in every database query rather than relying on an
  earlier lookup.
- Use `apply_patch` for manual edits and preserve unrelated work.
- Run the narrowest relevant test during development and the full check before
  each phase handoff.
- Update `PLAN.md` only when evidence changes sequencing, estimates, or scope.

## Stop conditions

Stop and report rather than improvising if:

- the selected provider cannot work through the minimal proxy;
- Pi requires a real provider credential inside the worker;
- secure session continuity requires mounting another user's or host-global Pi
  state;
- WeChat identity metadata cannot distinguish the configured private peer;
- an implementation requires group/shared-session authority;
- the security floor conflicts with a required product behavior; or
- a proposed shortcut would permit unsandboxed execution, cross-user access,
  provider-secret exposure, or uncertain execution replay.
