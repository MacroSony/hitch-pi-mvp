# Hitch Pi MVP

Hitch Pi MVP is a deliberately narrow, self-hosted bridge between private
Telegram/WeChat conversations and sandboxed Pi coding-agent sessions.

The first release is for a small statically enrolled user set on one Linux
host. Each user receives private sessions, one configured workspace, native
access to the providers authenticated in Pi, pinned operator extensions,
sandbox-routed tools, and native image/file delivery in both directions.

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

No implementation has started. The first task is the native-provider and
sandbox-extension proof in Phase 0.
