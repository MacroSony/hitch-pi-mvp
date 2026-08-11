# Repository instructions

Read `docs/product-scope.md`, `docs/security-floor.md`,
`docs/runtime-extension-architecture.md`, `docs/architecture.md`,
`docs/phase-0-inputs.md`, `docs/plan-review.md`, `PLAN.md`, and
`LUNA_HANDOFF.md` before implementation.

This is a deliberately concrete Pi/Telegram/WeChat product. Pi owns providers
and extensions; the mandatory Hitch extension owns model-tool sandbox routing.
Do not introduce a generic agent platform, authorization framework, connector
protocol, plugin marketplace, or configuration revision graph.

Implement one PLAN phase at a time. Keep real credentials and live-channel
tests opt-in, preserve deterministic CI coverage, and never weaken the
non-negotiable controls in `docs/security-floor.md` to make a test pass.
