# Hitch extension power modes

Status: power-mode design; only the concrete Mode B implementation is shipped.
B1 provides controlled HTTP and B2 adds explicit per-user Tavily search with
attended WeChat acceptance. There is no general manifest/extension loader.
Modes A/C/D and declaration-based loading below remain proposals. See
`mode-b-plan.md` for implementation and acceptance evidence. This document
supersedes the old per-extension design direction; historical
`operator-extension-compatibility.md` is retained as reference, not a second
implementation requirement. The security floor is unchanged.

## Problem with the per-extension contract approach

The previous compatibility contract required a bespoke reviewed service mode
per operator extension: hashed resource roots, per-dimension numeric bounds,
per-user compatibility manifests, and a dedicated Phase 0 acceptance. That
scales to two extensions and collapses at ten. It also makes the project
unreasonable to open source: no user will hand-write a digest manifest to
install a plugin.

A manifest is metadata and is not an isolation boundary. The approach
conflated two separate questions:

1. **Is the extension code trustworthy?** The operator selected and installed
   it, exactly as when running extensions in an interactive desktop Pi. Code
   trust needs no ceremony beyond installation.
2. **How much host authority can model-controlled arguments reach?** This is
   the only question Hitch must answer, and it can be answered
   *mechanically* instead of by per-extension review.

Model output remains the untrusted input: chat content, inbound files, and
fetched web content can all inject instructions that become tool-call
arguments. Hitch's irreducible security value is one sentence:

> Model-controlled parameters cannot reach host authority that was not
> declared in operator configuration.

## Power modes

Extensions are proposed as four power modes. A declaration alone does not
provide enforcement: the extension must use the corresponding implemented
Hitch entry point. B1 implements only the Mode B client.

### Mode A — prompt-only

The extension contributes prompts, personas, session variables, and tool
policy *reductions* only. It registers no tools with host authority.

- Enforcement (already present): monotonic reduction of Hitch's attested tool
  set; a stack can never activate or expose a tool Hitch did not enable.
- Global bounds: per-resource and per-render caps, variable count/size/depth
  caps, response caps. One default set for all Mode A extensions; per-extension
  overrides only when justified.
- Reads operator-owned read-only roots supplied by Hitch; never discovers or
  reads workspace or global-home configuration.
- Example: Pi Forge prompt stacks and profiles (`/preset`, `/profile`
  list/use/preview/validate/status). Forge subagent commands are **not**
  Mode A; see Mode D.

### Mode B — fixed-egress HTTP

The extension calls external HTTP APIs and returns bounded data. It must use a
Hitch-provided controlled client; it does not receive a raw socket. B1 supplies
that client as a policy entry point for trusted extension code. Only requests
that actually use the entry point receive its technical guarantees.

- Operator configuration declares the exact complete origin per service.
- The client enforces mechanically: exact normalized origin match, same-origin
  redirects, DNS/IP checks with a pinned connection address, private-destination
  policy, bounded request/response sizes and deadlines, and sanitized response
  text.
- Provider/API credentials for the remote service are trusted constructor
  inputs, never model parameters; they must not enter workspaces, SQLite, logs,
  chat, or the tool sandbox.
- Examples: web search (`pi-lovely-web` behind a search API), a stock quote
  tool, Danbooru tag search. Each is one config entry, not one contract
  chapter.

### Mode C — owner-bound job system

The extension runs long jobs against a fixed endpoint and produces artifact
files (image/video generation, rendering, batch exports). Hitch provides the
shared job service; the extension declares an endpoint and limits.

Shared Hitch infrastructure provides:

- unique owner-private job/output roots per Hitch user, supplied by Hitch;
- owner-bound job lookup, status, targeted cancellation, and reconciliation —
  another owner's job id is indistinguishable from an unknown id;
- input accepted only as owner/Turn-bound immutable snapshot handles or open
  descriptors, never raw pathnames;
- completed output imported through the immutable artifact snapshot bridge,
  with MIME/structure/dimension validation and count/byte/quota/deadline
  bounds enforced *while streaming*, not after buffering;
- accepted background jobs surviving fresh Pi controllers; synchronous waits
  stay short and bounded;
- egress restricted to the single configured endpoint origin via the same
  proxy machinery as Mode B.

Workflow pinning (manifest-declared workflow IDs, typed variables with
enum/range/string limits, model/LoRA allowlists) remains a Mode C
*configuration* concern for generative backends: it constrains what
model-controlled arguments can select, and lives in the extension's
operator-owned config rather than a reviewed contract.

- Example: ComfyUI Paint. The old contract's Paint chapter becomes: this
  mode, plus one endpoint, plus one workflow config file.

### Mode D — full-trust host extension

The extension executes with host authority comparable to the controller
itself. This is an explicit, per-extension operator opt-in and is never part
of default configuration.

- The operator guide states plainly: enabling a Mode D extension is
  equivalent to trusting that code with the host, the same exposure as
  installing an extension in interactive desktop Pi.
- Mode D extensions must not be reachable from group-facing or otherwise
  semi-trusted admission paths.
- Example: Forge subagent backends (`forge_subagent`, RPC/subprocess process
  backends) remain uncertifiable below Mode D until a Hitch-sandboxed
  backend exists. There is no plan to weaken this.

## Capability declaration and validation

In the proposal, an extension declares its mode in package metadata. This is
not a sandbox or isolation mechanism; the trusted client and its call path are
the technical boundary. B1 does not load or validate these manifests yet:

```jsonc
// package.json
"hitch": {
  "mode": "egress",               // "prompt-only" | "egress" | "job-system" | "host"
  "origins": ["https://api.brave.com:443"], // mode B/C: complete origins
  "endpoint": "http://127.0.0.1:8188", // mode C, explicit private origin
  "tools": ["web_search"]         // declared tool surface
}
```

Operator configuration enables it:

```jsonc
"extensions": {
  "pi-forge":          { "mode": "prompt-only" },
  "pi-web-search":     { "mode": "egress", "origins": ["https://api.brave.com:443"] },
  "pi-comfyui-paint":  { "mode": "job-system", "endpoint": "http://127.0.0.1:8188" }
}
```

A future integration may validate at startup:

- the declared mode in package metadata matches the operator-configured mode;
- every tool the extension registers is within its declared tool surface;
- the controlled client/job entry point is configured before the extension
  loads; trusted adapters must route model-controlled requests through it.
  Metadata validation cannot prove that arbitrary same-process JavaScript
  has no direct network calls; adapter implementation and tests establish
  this compliance, not the manifest;
- Mode D extensions are individually named in configuration, never enabled by
  glob or default.

Any mismatch fails closed: the extension is not loaded and startup reports
why. Per-user access is an enable boolean per configured user, defaulting to
off for B/C/D.

## What changes from the old contract

| Old contract element | Disposition |
| --- | --- |
| Sandbox no-network default, egress allowlisting | **Kept.** B1 adds the controlled Mode B client foundation; Mode C reuse remains proposal. |
| Owner binding of sessions/jobs/artifacts | **Kept.** Core multi-user value; enforced by Mode C infrastructure. |
| Immutable snapshot bridge for files in/out | **Kept.** Generalized into the shared Mode C job service. |
| Monotonic tool policy reduction | **Kept.** Already attested; the whole of Mode A enforcement. |
| Fail-closed startup on extension/attestation faults | **Kept.** Extended to mode/tool-surface mismatch. |
| Full digest/integrity pinning of extensions and resources | **Simplified.** Optional "strict mode" for deployments that want it; restart-time publication remains the default integrity point. |
| Per-dimension numeric bound tables per extension | **Simplified.** One default bound set per mode; per-extension overrides only. |
| Per-user compatibility manifests (tools, digests, env, paths, destinations) | **Simplified.** Operator-level config plus per-user enable boolean. |
| Danbooru origin review chapter | **Dissolved.** One Mode B egress entry. |
| Bespoke Phase 0 acceptance per extension | **Dissolved.** Mode infrastructure is tested once; extensions inherit. New modes get new tests; new extensions in existing modes get config validation. |
| Ban on regex transforms over model-controlled text | **Kept.** Applies to all modes. |
| Exclusion of `paint_interrupt`-style backend-wide authority | **Kept.** Mode C permits targeted owner-bound cancellation only. |

## Explicitly unchanged

- The security floor (`security-floor.md`) is untouched: exact endpoint
  allowlisting, mandatory sandboxed file/shell execution with no host
  fallback, credential separation, bounded everything, quarantine over
  replay.
- Pi project/global discovery, skills, workspace settings, and arbitrary
  user-installed extensions stay disabled. Operator extensions load only
  from operator-owned installed artifacts.
- Provider login remains an attended host action, never an IM command.

## Rollout plan

1. **Mode B integration**: wire the B1 controlled client into static
   extension enablement and add one reviewed real web adapter. B1 itself is
   not a generic loader or a provider/channel integration.
2. **Mode C infrastructure**: generalize the existing publication helper and
   Paint service-mode design into the shared owner-bound job service.
3. **Certify by declaration**: after concrete tests, Forge as Mode A
   (stacks/profiles only), `pi-lovely-web` (or a search-API tool) as Mode B,
   and ComfyUI Paint as Mode C. Each still needs its own implementation and
   operator decision; declaration alone is not isolation.
4. On acceptance, rewrite `operator-extension-compatibility.md` to point
   here and archive the bespoke chapters as historical record.

Mode D exists so the system has an honest answer for full-trust extensions.
It is expected to stay empty in the stock configuration.
