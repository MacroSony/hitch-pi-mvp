# Mode B rollout plan

Status: B1 and B2 implemented, code-reviewed, and deployed to attended dogfood.
The controlled HTTP client, Tavily adapter, static per-user enablement, and
explicit Pi tool integration are implemented. Real Tavily and WeChat search /
delivery acceptance passed on 2026-09-07; final-answer citation links remain
a prompt-quality follow-up, not an HTTP integration failure.

## B1 — shared controlled HTTP client

B1 is a small client for trusted operator extension code. It uses Node's
standard `http`/`https` transport and accepts only:

- a configured service key;
- a root-relative path and query (the client constructs the URL from the
  configured complete origin); and
- `GET` or `POST`, with a bounded UTF-8 text body.

A service has one normalized origin, trusted fixed headers and secret values,
and an explicit `allowPrivate` decision. HTTPS is the default public posture;
HTTP and private/loopback/link-local destinations require explicit private
configuration. Model parameters cannot provide an authority, headers,
authentication, or a proxy setting.

The client applies one global default set of request/response byte limits,
whole-operation deadline, and redirect count (with `maxRedirects: 0` explicitly
supported to disable redirect following). `maxRequestBytes` bounds the combined
byte length of the request path/query and request body prior to Buffer
allocation; it does not count trusted fixed HTTP headers. Tests may override
those limits through the trusted constructor. Every redirect is rechecked
against the exact normalized origin. For hostnames, every hop resolves and
validates its address before the socket lookup uses that address; IP literal
origins bypass DNS lookup directly so that configured literals cannot be
overwritten by a custom resolver. Private, special, metadata, multicast,
unspecified, IPv4 test subnets (e.g. 192.0.2.0/24), IPv4-compatible IPv6
(including `::127.0.0.1` and `::169.254.169.254`), and IPv4-mapped IPv6 answers
are rejected by default. Under explicit `allowPrivate: true`, loopback (`127.0.0.1`
and `::1`) and private ranges are permitted, whereas unspecified, multicast,
metadata, IPv4-compatible IPv6, and IPv4-mapped destinations remain strictly
blocked. Configured fixed headers are validated using Node header token and
value checks without exposing unhandled sync errors or leaking raw header/secret
data. There is no environment proxy inheritance.

Responses require identity/no compression, are counted while streaming, and
are returned only as a bounded status plus sanitized UTF-8 text. Dangerous
control characters are removed, configured secrets are replaced by literal
(non-regex) substitution, and transport/DNS details are reduced to short
error categories. Response bodies are never logged. This is bounded text
handling, not HTML sanitization or a prompt-injection defense.

### B1 acceptance

The credential-free test suite uses local HTTP IPv4/IPv6 servers and focused unit
fixtures. It covers real Node transport for GET and POST, default and custom
resolvers, fixed headers validation and secret concealment, exact origin/port,
relative and protocol-relative URL handling, same-origin redirect behavior,
`maxRedirects: 0` behavior, POST redirect refusal, private DNS and test net
rejection, address pinning, IPv4-compatible and IPv4-mapped IPv6 rejection,
`::1` loopback support under `allowPrivate`, bounded combined request path/body
and chunked response handling, deadline, cancellation, UTF-8/control-character
handling, compression refusal, and secret-free standardized error codes.
No provider, web API, channel, or other live integration is called.

Test execution statistics from independent worktree verification:
- `npm run check` (formatter, TypeScript compiler, full test suite): 61 total tests (59 passed, 2 opt-in sandbox acceptance tests skipped in standard runner, 0 failed).
- `npm run acceptance:host` (bubblewrap sandbox host acceptance): 4 tests (4 passed, 0 skipped, 0 failed).

B1 adds no configuration publication, `main` wiring, native runtime changes,
mandatory extension changes, JS sandbox, IPC broker, generic plugin platform,
or network access to the tool sandbox. The existing security floor remains
unchanged.

## B2 — smallest product integration route

B2 implements the concrete product web search integration:

1. **Static configuration (B2-A)**: `AppConfig.webSearch` specifies `provider: "tavily"`,
   an environment variable reference `apiKeyEnv` (no raw secret stored or persisted),
   and an explicit `enabledUsers` list (empty `[]` disables search).
2. **Tavily search adapter (B2-A)**: `TavilySearchAdapter` wraps `EgressClient` with
   fixed `https://api.tavily.com` origin (overrideable only for trusted local testing),
   fixed `POST /search`, Authorization Bearer header, and registered secret redaction.
   It enforces strict query length (<= 512 UTF-8 bytes) and limit bounds (1..5), validates
   response schema, rejects URLs with userinfo, control characters, or non-http(s)
   schemes, bounds the complete serialized result to 16 KiB, and rejects unknown model
   fields at runtime. JSON-decoded text receives a second literal secret-redaction
   pass; URLs containing configured secrets are discarded.
3. **Mandatory extension & tool binding (B2-B)**: Expose the tool surface through the
   mandatory Hitch extension and native runtime attestation for enabled users.
4. **Acceptance**: Offline deterministic fake-server suite plus opt-in attended operator
   verification recording real service reachability.

### B2 verified evidence

- Parent reran `npm run check`: 79 tests, 74 passed, 5 opt-in tests skipped,
  zero failures. Includes formatting, typecheck, fresh build, and all ordinary tests.
- Parent reran `HITCH_RUN_SANDBOX_TESTS=1 node --test dist/test/web-search-runtime.test.js`:
  5/5 passed, no skips. Uses real pinned Pi RPC processes, production staged
  extensions and adapter/client, and the production `waitForAttestation` gate.
- Enabled fixture completes `web_search` and reaches `agent_settled`; disabled
  fixture has only eight tools and produces no search request. Wrong-source and
  missing registrations are rejected by the host gate before prompt submission.
- The dedicated fixture-only preload redirects Tavily DNS/HTTPS to a local HTTP
  server. This proves Pi/tool/adapter round-trip behavior, **not** real Tavily TLS,
  credentials, quota, or public-network reachability. It is never loaded in production.
- Fixtures clean only their own randomly namespaced sandbox scopes. B2 verification
  deliberately did not run the older global-startup-cleanup host suite alongside
  the active dogfood service.
- Independent cross-review found no remaining code blocker; a final pre-commit
  review also passed. Development did not overwrite the original main build.
- With explicit operator authorization, a real Tavily search returned the Node.js
  official source. A separate immutable build snapshot was then deployed with a
  private credential environment file and an explicit user enablement list.
- WeChat acceptance: seven successful `web_search` calls, 35 returned items, a
  normally completed search Turn in about 26 seconds, and first-attempt delivery.
  Four post-switch replies were delivered; no service restart was observed.
- Final answer contained no source URLs despite tool results containing them.
  Citation presentation and news accuracy/freshness are not claimed as passed.
- Dogfood remains runtime-only (not enabled at boot); the old build/config remain
  available for rollback. No credentials or conversation content are recorded here.

## Not done in Mode B

There is no manifest loader or generic extension loader, no JS sandbox, IPC
broker, plugin marketplace, Mode C job system, Mode D host extension, web
crawler, HTML sanitizer, JSON-schema framework, or provider proxy. Modes A, C,
and D remain proposals. A manifest describes
intent; it is not an isolation boundary. Only requests that actually use the
controlled B1 entry point have the documented HTTP policy guarantees.
