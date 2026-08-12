# Hitch Pi MVP

Hitch Pi MVP is a deliberately narrow, self-hosted bridge between private
Telegram/WeChat conversations and sandboxed Pi coding-agent sessions.

The first release is an attended concept test for a small, personally trusted,
statically enrolled user set on one Linux host. Each user receives private
sessions, one configured workspace, native access to providers authenticated in
Pi, sandbox-routed tools, and native image/file delivery in both directions.

This repository starts fresh from the product boundary. It may copy small,
reviewed modules from `../hitch-hub`, but it does not import that repository at
runtime and does not inherit its generalized v2 domain model.

## Planning documents

- [Product scope](docs/product-scope.md)
- [Architecture](docs/architecture.md)
- [Native Pi and sandbox-extension decision](docs/runtime-extension-architecture.md)
- [Security floor](docs/security-floor.md)
- [Phase 0 execution contract](docs/phase-0-inputs.md)
- [Sol plan-review record](docs/plan-review.md)
- [Implementation plan](PLAN.md)
- [Luna implementation handoff](LUNA_HANDOFF.md)

The production service has not yet been scaffolded. Phase 0 evidence under
`spikes/` found four real hardening gaps. The 2026-08-13 trusted-personal MVP
reset accepts two as attended operational risks, excludes the two unsupported
operator extensions, and moves live provider smoke to dogfooding. The smaller
implementation sequence is now authorized in [PLAN.md](PLAN.md); the original
findings remain recorded in
[docs/phase-0-decisions.md](docs/phase-0-decisions.md).
