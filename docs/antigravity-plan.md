# AGY-1 — fixed Antigravity provider and first-profile fix

Status: user-authorized implementation; deterministic acceptance passed. Real operator login/model availability is pending.

## Boundary

- Optional strict boolean `config.antigravity`, default false. A fixed provider-only adapter is explicitly loaded for catalog and every turn; no arbitrary plugin path/config/provider framework.
- Use the public pi-agy root registration entry. Only `registerProvider` is forwarded (with runtime login rejected). Account hooks and commands are not forwarded, so the root's additional-account resolver remains empty and no plugin account-store writer runs. Main request credentials come from AUTH-1; its locked refresh transaction invokes the original provider refresh. No private-source imports or OAuth rewrite.
- Prewarm is disabled. Debug dump flags and ambient provider configuration are not inherited. Provider source/version gates and mandatory/host startup attestation fail closed; tool/source/schema attestation stays at the original 8/9 tools. The adapter is trusted operator code, not a JS isolation mechanism.
- Pi coding-agent and pi-ai remain 0.84.1. The whole existing pinned Pi directory, including nested dependencies, is byte-identical to AUTH-1. Additional package dependencies have a locked closure and pass clean offline npm ci.

## Model provenance and behavior

Published npm pi-agy 0.6.1 does **not** list Gemini 3.8. The local desktop 0.6.1 installation has two source patches adding it. `vendor/pi-agy-README.md` and the adjacent patch record the local artifact 0.6.1-hitch.1, with one deliberate difference: Gemini 3.8 cannot silently fall back to 3.7. A real provider 404 is an error, not a renamed older model. The desktop installation is not changed.

Requested profile model is `antigravity/gemini-3.8-flash`, mapped to runtime `gemini-3.8-flash-tiered`. Its advertised thinking levels are low/medium/high, **not off**; the two profiles therefore use low. Static catalog registration does not establish account access or backend availability. Stage defaults separately until operator login and a real request pass.

## Reported profile bug

A new session has no explicit model. A model-less profile carrying thinking=off previously threw before considering the same `models[0]` fallback used by actual turns. The fix validates thinking against that fallback while retaining a null explicit selection; existing explicit session/profile models and manual overrides remain unchanged. Invalid/unsupported/empty-catalog cases roll back atomically. This does not change the separately deferred Pi-global-default versus sorted-catalog-default policy.

## Acceptance

- `npm run check`: 136 total, 119 passed, 17 opt-in skipped, no failures.
- Dedicated namespace-scoped real pinned-CLI RPC suite: 17/17, including AUTH-1 and Mode A/B2 regressions.
- Real pi-agy module + test-only Google transport: shared expired dummy OAuth refreshes and saves access/refresh/project state; 3.8 emits a real sandbox read and consumes the tool response before settling. No account commands/hooks/prewarm; exact original tool surface.
- Required-but-missing provider cannot pass startup attestation. 404 fixture advertises 3.7 but all stream requests remain 3.8 and finish as an error.
- Initial test fetch override was replaced by Pi's undici setup, causing dummy-token requests to leave the fixture and fail. Corrected fixture first denies DNS/HTTP transport and imports the public Pi entry before replacing fetch. Final tests are local and do not use real credentials; do not present the initial 401 as real account acceptance.
- Gemini independently reviewed the parent's provider adapter/vendor and Luna's fixture lane: PASS. Mika completed the interrupted fixture work, removed an interim attestation bypass, integrated the mandatory marker, and ran the suites. No live startup-cleanup test was run.

## Operator login and deployment

Do not copy desktop rotating tokens. Run the fixed package's normal interactive `/login antigravity` in a fresh, private staging Pi directory with no ambient extensions/tools; callback URLs are pasted only into that operator terminal, never chat. This staging login can happen while Hitch is running because it is not Hitch's authority. Exit after login.

Then wait for queue/outbox/scopes to be idle, stop Hitch, take a current schema-4/auth/config/catalog backup, and explicitly import only the staged `antigravity` credential through SharedCredentialStore into the existing authority, preserving other providers. Do not dump the credential or replace the whole auth file with staging contents. Restart, verify the authenticated catalog, make a small real 3.8 request, then activate the two prepared model+low profiles and verify through IM. Preserve the operator staging folder privately until acceptance; never mount it into a workspace.

A provider-enabled release can be installed before login while keeping the current working API-key model and old profile defaults. State that distinction clearly: installed provider != authenticated model != activated Gemini profiles. No schema change in AGY-1. Roll back code/config on the same schema if necessary while preserving newer messages and latest auth; never restore the old schema-3 B2 backup. OAuth revocation, quota/provider restrictions, or real 3.8 unavailability must be reported rather than hidden by fallback.
