# Implementation handoff

Status: trusted-personal MVP reset approved; Phase 1 follows the reviewed plan
baseline commit.

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

After the MVP planning reset is independently reviewed and committed, implement
only Phase 1 from `PLAN.md`:

- Node.js 24 and TypeScript project setup;
- strict JSON configuration with environment secret references;
- the minimal SQLite users/endpoints/sessions/turns/outbox schema;
- static workspace publication and overlap checks; and
- deterministic credential-free boot/restart tests.

Do not build Telegram, Pi RPC, media, or WeChat inside the Phase 1 commit.

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
