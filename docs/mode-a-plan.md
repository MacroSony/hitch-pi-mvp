# Mode A — Pi Forge prompt-only integration

Status: implemented and code-accepted, following Mode B commit be49dda.
Attended live Mode A deployment remains pending; dogfood still runs B2.
Development is isolated from the live B2 release. No Mode D/subagents, generic
loader, workspace discovery, remote editor, credentials, or live deployment
are authorized by this phase alone.

## Concrete route

1. Add an intentional pure `@zihanw/pi-forge/service` entry in an independent
   Forge worktree. Reuse Forge codecs/compiler/policy, not a second parser.
   The entry consumes supplied JSON documents and host-neutral runtime inputs;
   it performs no filesystem discovery, UI, extension loading, or provider work.
2. Hitch reads only an explicit operator-owned resource root at startup, creates
   an immutable catalog, and enables it for named configured users. Resource
   selectors are IDs, never model/chat-selected host paths. Freeze publication
   until restart, bound file/catalog/render sizes, and reject roots overlapping
   user workspaces/private service or credential trees.
3. Expose `!preset` and `!profile` list/use/preview/status/clear operations.
   Store the selection per owner/session, carry it to fresh Turn controllers,
   reject changes while the session has active or queued work, and atomically
   validate/apply profile model/thinking selection against Pi's catalog.
4. An explicit fixed Hitch prompt-only extension changes system prompts, never
   registers model tools. Keep full tool source attestation, but compare active
   tools to the resolved subset. Reduced tools cannot be re-enabled mid-Turn.
   Every standard/direct shell path still enters the sandbox. Web search stays
   gated by both operator enablement and the selected tool subset.
5. Initial supported Forge subset: system-role blocks and safe supplied-data
   system slots; one unmodified chat-history slot preserves Pi's natural
   context. Static parameters are supported. No regex/history rewriting,
   project files/skills/imports/custom JS/macros, synthetic user/assistant
   messages, or subagent fields. Unsupported features fail explicitly rather
   than being silently ignored. Full desktop Forge UI/stack compatibility is
   not claimed. The system-prompt subset is sufficient for persona/profile use.

## Evidence required

- Forge public-entry tests reuse normal Forge-format resources and verify no
  root/global discovery or custom runtime loading; package import works.
- Hitch config/root limits, command grammar, two-owner persistence and restart,
  atomic invalid-profile rejection, busy-session rejection, and clear semantics.
- Real pinned Pi RPC with deterministic provider: actual received system prompt,
  session selection reused on a second controller, unchanged all-tools sources,
  active subset including web interaction, denied mutation/disabled tools.
- Deterministic full suite, independent review, explicit deferred live acceptance.
- No global startup-cleanup host suite beside live dogfood; fixtures only clean
  their own namespaced sandbox scopes. No API keys or live IM calls in tests.

## Model precedence

Applying a profile sets its model/thinking defaults once, atomically; explicit
later `!model`/`!thinking` commands remain authoritative. The stored profile
selects its prompt/tool policy thereafter, not a repeated model reset. Clearing
Forge removes prompt/tool selection without resetting explicitly chosen model.
The existing default-model selection issue is separate unless a minimal tested
fix fits; it must not be concealed by Forge profile application.

## Reviewed semantic clarifications

- Preset/profile share one selection, but a clear command only clears its own
  matching kind; clearing the other kind leaves the current selection intact.
- A valid empty/whitespace compiled prompt preserves Pi's base, as Forge's own
  compiler does (e.g. model-only profiles). The hook still attests the tool
  subset. This is not a fallback after parse/load failure; malformed config
  produces no startup attestation. Both paths have separate real RPC tests.

## Final code acceptance

- Hitch `npm run check`: 109 tests; 97 passed, 12 opt-in skipped, no failures.
- Dedicated `HITCH_RUN_SANDBOX_TESTS=1 node --test dist/test/web-search-runtime.test.js`:
  12/12 passed, no skips. Includes actual Pi provider-observed prompt mode,
  denied tool/RPC bash calls, same JSONL across fresh controllers, later tool
  mutation rejection, valid empty prompt versus malformed config, and B2 search.
- Forge `npm run verify`: 372 unit tests and 21 browser tests passed, plus
  typecheck/docs/generated assets/package and main-only packed import. Optional
  subagent paired-package smoke is not part of this Mode A acceptance.
- Clean offline Hitch npm ci passed with the committed tarball/lockfile.
- Independent cross-review passed after matching-kind clear and explicit
  empty-rendering semantics were resolved and regression-tested.
- Profile/session persistence has deterministic two-owner and database-reopen
  tests. Full IM/persona usability remains an attended deployment check, not
  something the offline fixtures claim to prove.
- No live service, credential file, current release, or production database was
  changed during this phase. Default-model first-catalog behavior remains a
  separate known follow-up; no generic Mode C/D or full Forge loader was added.
