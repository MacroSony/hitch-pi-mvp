# Plan review record

Date: 2026-08-11

Sol reviewed the original whole-Pi-sandbox plus single-provider-broker plan. It
first returned `REVISE`; after its security, recovery, bounds, testing, and
schedule findings were incorporated, it returned `GO-WITH-CONDITION`.

The retained findings were requirements in the earlier hardened plan:

- exact Pi/runtime/dependency pinning;
- exact Telegram/WeChat identity tuples;
- fail-closed tool/sandbox startup and forced-close quarantine;
- streaming media intake and descriptor-based publication;
- immutable configuration, quotas, retention, and sanitized failures;
- deterministic CI separated from live acceptance; and
- a committed planning baseline before implementation.

The trusted-personal MVP reset below supersedes the hard-quota, automated
retention, and full-certification interpretation of that list. Identity,
sandbox fail-closed behavior, bounded media, recovery, pinning, deterministic
tests, and sanitized failures remain current requirements.

## Superseding architecture change

The operator subsequently prioritized all Pi-authenticated providers and
first-class extension support. `docs/runtime-extension-architecture.md`
therefore supersedes the reviewed provider broker:

- Pi is now the trusted native provider/controller process;
- approved operator extensions share that trusted credential boundary; and
- one mandatory extension routes model tools to Bubblewrap or Gondolin.

The earlier Sol verdict does not constitute independent approval of this new
trust boundary. Phase 0 is intentionally a proof gate. A fresh independent
review is recommended before promoting Phase 0 code into the production
foundation.

## Trusted-personal MVP reset

Date: 2026-08-13

The operator subsequently prioritized a quick attended concept test for a few
personally trusted users over production-style hardening. Phase 0 produced
useful evidence, but its four final blockers are now handled as follows:

- recover a corrupt Pi profile through private backup or operator re-login;
- use application bounds, free-space checks, and monitoring without claiming a
  hard workspace quota;
- exclude Forge and ComfyUI Paint from the initial manifest; and
- run available real-provider checks during opt-in dogfooding.

The mandatory tool sandbox, exact private identity mapping, owner-scoped state,
credential separation, bounded execution, cancellation cleanup, and no replay
of uncertain Turns remain required. `PLAN.md` is the superseding delivery plan.
Each implementation phase receives an independent subagent review before its
commit.

### MVP reset review

Independent reviewer: `/root/phase0_mvp_reset_review`

- Cycle 1: `REVISE` for JSON/example, workspace-wording, and historical
  quota/retention consistency issues.
- Cycle 2: `PASS` after all three findings were resolved. No remaining blocker
  to the Phase 1 foundation was found.
