# Hitch Pi MVP

Hitch Pi MVP is a deliberately narrow, self-hosted bridge between private
Telegram/WeChat conversations and sandboxed Pi coding-agent sessions.

The first release is for a small statically enrolled user set on one Linux
host. Each user receives private sessions, one configured workspace, bounded
Bubblewrap execution, brokered access to one provider/model, and native image
and file delivery in both directions.

This repository starts fresh from the product boundary. It may copy small,
reviewed modules from `../hitch-hub`, but it does not import that repository at
runtime and does not inherit its generalized v2 domain model.

## Planning documents

- [Product scope](docs/product-scope.md)
- [Architecture](docs/architecture.md)
- [Security floor](docs/security-floor.md)
- [Phase 0 execution contract](docs/phase-0-inputs.md)
- [Sol plan-review record](docs/plan-review.md)
- [Implementation plan](PLAN.md)
- [Luna implementation handoff](LUNA_HANDOFF.md)

No implementation has started. The first task is the broker compatibility
spike in Phase 0 of the implementation plan.
