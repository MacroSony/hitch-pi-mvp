# Hitch MCP service boundary

Hitch does not expose a general-purpose MCP proxy call channel. The `mcp`
gateway is for status, search, describe, connect, and list against configured
static servers only. It accepts no `tool` or `args` call fields, and no
installation, authentication, URL, target, instructions, or UI-management
fields.

## Wrapper-owned controls

The Hitch wrapper rewrites the owner-private MCP config before the installed
adapter sees it:

- every static server gets `directTools: "search"` (real direct tools are
  registered, but start inactive until a matching `mcp({ search })`);
- the global and per-server tool prefix is fixed to `"mcp"`, so direct tools
  have one consistent `mcp__<serverNamespace>_<tool>` shape;
- `MCP_DIRECT_TOOLS` is removed so the adapter's environment override cannot
  select eager, subset, or proxy-only surfaces;
- `scriptMode` is forced off and `mcpScript` is never registered;
- namespace-proxy names for configured static servers are hard-denied using the
  adapter's own namespace formatting rule, independent of the Forge allow/deny
  policy.

The static server definitions are otherwise retained: `allow`/`deny`,
`includeTools`/`excludeTools`, auth, env, lifecycle, and disabled state still
come from the operator config. `directTools` and `toolPrefix` are wrapper-owned
display/registration policy, not authorization. Authorization remains the real
Forge policy applied to the actual registered direct tool name and again on
execute.

## Operator workflow

1. Discover: `mcp({ search: "query" })`.
2. Inspect: `mcp({ describe: "mcp__server_tool" })`.
3. Call the activated direct tool by its exact name, for example
   `mcp__server_tool(...)`.

There is no `mcp({ tool: "...", args: {...} })` protocol, and no namespace
proxy such as `mcp__server` that forwards `{tool, args}`. If a direct tool is
denied, it is not registered, cannot be executed, and cannot be recovered by a
late search activation.

## Trusted host and upgrade boundary

The wrapper, adapter and configured servers execute as trusted host code, not
inside the file-tool Bubblewrap sandbox. Servers may inherit controller
environment and possess their own credentials. A restricted model entry point
is not credential isolation or server-side authorization.

The runtime checks the immutable wrapper and the owner-controlled adapter entry
SHA; the third-party dependency closure remains operator-trusted, not completely
hash-attested. Adapter code may be public-readable, but its entry must not be
group/world writable, symlinked or multiply linked. The per-profile MCP config
must remain owner-private. Prepare and review secure installed code/dependencies
before deploying this change; do not relax those checks to reuse unsafe modes.

The real local acceptance uses Pi's jiti extension loader and an installed
adapter code copy with a synthetic SDK stdio server. It verifies discovery,
late activation, direct execution, source attestation, and rejection of scripts
and management calls. It does not validate production credentials, remote
server behavior, market-data entitlements, or live channel delivery.
