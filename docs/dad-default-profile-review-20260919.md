# User-default Forge profile — 2026-09-19 acceptance

## Result

A configured user's first ordinary turn automatically uses `users[].forgeProfile`
when the session has no explicit Forge selection. The user does **not** need to
run `!profile`, activate a desktop preset, or understand an internal command.
This is Hitch's service-library resolution, not the interactive Forge plugin's
`default.json` activation mechanism.

`test/dad-default-profile.test.ts` follows real config parsing, `forgeDefaults`,
`HitchStore.enqueue/claimNextTurn`, and native Forge preflight/compilation with
synthetic parent/dad users and an owned temporary catalog. It checks:

1. No explicit session profile: the first claimed dad turn resolves its user
   default, desired synthetic model/thinking, prompt and tool policy.
2. An explicit session profile or preset wins over the user default.
3. Clearing an explicit selection restores the user default on the next turn.
4. A separately selected session model still wins; clearing a profile does not
   erase that model.
5. The fallback does not persist a new selection into session Forge fields.
6. Raw supported inline preset payloads also retain explicit precedence.

The selected developer tests passed in the final default suite: **310 total,
286 passed, 24 opt-in skipped**. The complete selected host/MCP lanes subsequently
passed **49/49 with no skips**, and constrained service acceptance passed
**12/12**. These suites overlap and must not be added as unique scenario counts.

The operator's actual dad profile/prompt source was also compiled offline from
a private temporary catalog, confirming its configured model/thinking and its
static tools (no bash). That source remains operator-maintained material outside
this repository, not a bundled default or an activated production account.

## Automatic does not mean provisioned

The config must actually include the user/default and enable the relevant Forge
and search users. The operator must separately install the intended immutable
catalog, provision the distinct workspace and seed, configure trusted MCP
servers, and complete the channel binding. Hitch does not copy a seed or create
a schedule just because a profile exists.

Changing the operator source files is not a hot update of the running catalog.
Existing explicit model/profile selections can explain a different result and
must not be silently erased to force the default.

## MCP and host boundaries

Dynamic MCP tools are not expanded in the initial static Forge baseline. Their
actual registered names are checked against the resolved Forge tool policy by
the Hitch MCP wrapper, again at execute time. Discovery may activate allowed
direct methods later; it cannot restore a denied method. Scripts and generic
proxy calls are unconditionally unavailable, even when a broad `mcp*` glob is
allowed. See [the MCP service boundary](hitch-mcp-service-boundary.md).

The default-profile tests do not by themselves prove filesystem isolation,
model availability, authentic prices, or IM delivery. The dedicated
[sandbox review](dad-sandbox-review-20260919.md) records the actual host evidence
and its same-UID/trusted-extension limits. No live provider or production user
was activated by these checks.
