# Implementation handoff

## Post-MVP increment: user-default and MCP isolation checks (2026-09-19)

Completed a bounded offline-readiness increment: automatic per-user Forge
default evidence, owner-only sandbox cleanup/read-only startup inspection,
suffixed publication snapshot recovery, and a restricted trusted MCP wrapper.
Independent code review passed after closing the generic gateway policy bypass.
Final deterministic check: 310 total / 286 passed / 24 opt-in skipped; the full
selected host/MCP lanes subsequently passed 49/49 with no skips, and constrained
service acceptance passed 12/12. Counts overlap, not unique scenario totals.
No live model, market-data service, account enrollment, or production deployment
is implied. See [profile acceptance](docs/dad-default-profile-review-20260919.md),
[sandbox acceptance](docs/dad-sandbox-review-20260919.md), and the
[MCP boundary/upgrade requirements](docs/hitch-mcp-service-boundary.md).

The original MVP handoff below is retained as historical phase context.

Status: all six trusted-personal MVP phases are implemented and independently
reviewed. Deterministic, direct-host, and service-constrained acceptance pass;
credentialed provider/Telegram/WeChat checks remain honestly opt-in for the
operator's attended concept test.

## Objective

Deliver a quick, attended Pi/Telegram/WeChat concept test for a few statically
configured and personally trusted users. Follow this authority order:

1. `docs/product-scope.md`
2. `docs/security-floor.md`
3. `docs/runtime-extension-architecture.md`
4. `docs/architecture.md`
5. `PLAN.md`
6. retained Phase 0 evidence and input documents

Do not turn this into a generic agent platform, connector framework, plugin
marketplace, configuration graph, or public multi-tenant service.

## Current assignment

The planned MVP implementation is complete. The next action is operator-led
setup and attended concept acceptance from `docs/operator-guide.md`:

- install the pinned host prerequisites and run all three acceptance commands;
- authenticate one Pi provider and at least one intended private channel;
- enroll exact Telegram/WeChat private identities and start the supplied user
  service; and
- execute the short attended checklist, recording only integrations actually
  exercised.

Do not expand the codebase before this concept test demonstrates a concrete
need. The known post-MVP items remain deferred in `PLAN.md` and the operator
guide.

## Review and commit rule

At the end of every PLAN phase:

1. run focused tests and the complete deterministic check;
2. request an independent subagent review of the phase diff and relevant
   safety requirements;
3. resolve every blocking finding and rerun affected checks; and
4. make one phase-bounded commit only after review passes.

Review is for catching concrete MVP defects, not expanding the phase into
production hardening. Non-blocking improvements should be deferred unless they
are trivial and reduce complexity.

## Working rules

- Prefer a working vertical path and standard Node facilities over frameworks.
- Keep real credentials and live channel/provider operations opt-in.
- Treat human users as trusted, but model commands, workspaces, inbound files,
  and chat content as untrusted execution input.
- Keep Pi provider behavior in Pi and sandbox routing in the mandatory Hitch
  extension.
- Disable built-ins and discovery, then attest the replacement tool surface.
- Use one global Pi controller slot and never automatically replay uncertain
  work.
- Preserve owner scope in every state mutation and delivery.
- Copy only bounded old-Hitch modules with provenance; never import the sibling
  repository at runtime.
- Record accepted limitations plainly instead of constructing elaborate
  abstractions to hide them.

## Accepted MVP limitations

- operator backup/re-login recovery for a crash-corrupted Pi auth profile;
- no kernel project quota on the initial filesystem;
- possible duplicate channel delivery after an ambiguous response;
- no Forge, ComfyUI Paint, arbitrary operator extensions, skills, or MCP in the
  initial product; and
- only available provider/channel accounts receive live acceptance.

## Stop conditions

Stop and report if a standard file/shell or direct bash path can execute on the
host, a provider/channel credential reaches the tool sandbox or user output, a
private endpoint can select another owner, cancellation leaves the sandbox
scope alive, or uncertain agent work would be replayed automatically.
