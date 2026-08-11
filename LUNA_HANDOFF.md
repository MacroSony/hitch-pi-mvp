# Luna implementation handoff

## Objective

Implement the private multi-user Pi IM MVP in this order of authority:

1. `docs/product-scope.md`
2. `docs/security-floor.md`
3. `docs/runtime-extension-architecture.md`
4. `docs/architecture.md`
5. `docs/phase-0-inputs.md`
6. `PLAN.md`

The original provider-broker plan is superseded. Do not implement it unless a
future reviewed decision moves the whole Pi controller back into the sandbox.

## First assignment

Implement only Phase 0. Do not scaffold the production service first.

Phase 0 must answer with executable evidence:

- Does Pi 0.84.1 enumerate and select every available native/extension provider
  and thinking level through RPC using the dedicated operator profile?
- Can multiple Pi processes share/refresh the profile safely, or must the MVP
  retain one global provider-controller lock?
- Can explicit pinned extensions load while all discovery is disabled?
- Can the mandatory extension replace every built-in file/shell tool and direct
  RPC/user bash without any host fallback?
- Does the Bubblewrap backend satisfy the complete Turn contract using bounded
  reviewed code from the old repository?
- If QEMU is provisioned, does Gondolin materially improve the result enough to
  justify its runtime/assets/DoS surface?
- Can images, inbox paths, `hitch_publish`, abort, timeout, and process cleanup
  cross the extension boundary safely?
- Can Pi resume a stable session across fresh controllers, and does every
  forced/ambiguous close quarantine it?
- Which Telegram/WeChat transport pieces are safe to copy narrowly?

Record commands, timings, versions, hashes, catalog/extension manifests,
sandbox choice, adversarial results, and rejected alternatives in
`docs/phase-0-decisions.md`. Commit spike evidence separately.

## Working rules

- Prefer one working vertical path over a framework.
- Keep Hitch core focused on IM/session/media; provider and sandbox mechanics
  stay in Pi and the extension/backend respectively.
- Treat Pi and approved operator extensions as trusted provider-owning code.
- Treat workspace/chat/model output as untrusted and never load project
  extensions.
- Disable built-ins first, then attest the complete replacement tool set.
- Sandbox initialization or attestation failure is fatal; no direct execution.
- Preserve user ownership in every database operation.
- Copy only bounded old-Hitch modules with provenance/tests; no runtime import.
- Run focused tests continuously and the full deterministic check before each
  phase handoff.

## Stop conditions

Stop and report if:

- explicit extension loading cannot coexist with disabled discovery;
- any built-in/direct shell or extension tool executes model-controlled work on
  the host unexpectedly;
- a desired third-party extension requires workspace installation or exposes
  provider credentials through a tool/UI result;
- provider/model discovery requires Hitch to implement provider protocols;
- neither Bubblewrap nor reviewed Gondolin can prove fail-closed cleanup and
  resource bounds;
- WeChat metadata cannot distinguish the configured private peer; or
- the requested behavior requires group/shared-session authority, cross-user
  mounts, uncertain replay, or user-installed trusted code.
