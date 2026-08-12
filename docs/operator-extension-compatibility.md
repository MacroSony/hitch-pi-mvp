# Operator extension compatibility contract

Status: deferred post-MVP compatibility proposal

## Purpose

The initial trusted-personal MVP loads no optional operator extensions. This
document retains the proposed contracts for a later phase; neither Pi Forge nor
ComfyUI Paint blocks the core concept test. Pi API load compatibility alone is
not enough to expose model-controlled host behavior.

This remains a concrete product contract. It does not introduce a generic
plugin sandbox, connector protocol, permission framework, or marketplace.

## Packaging and publication

Production Hitch loads extensions only from installed, immutable artifacts:

- exact package version and npm integrity, plus the committed Hitch lockfile;
- the package-declared installed entry point, never a sibling repository or
  ad-hoc source-tree import; a compiled distribution is preferred when the
  package publishes one;
- a digest of the installed package artifact and its runtime resources, plus
  lock/integrity evidence for imported dependencies, native binaries, bundled
  workflows, and other runtime inputs;
- operator-owned, read-only paths outside every user workspace; and
- an effective per-user compatibility manifest covering enabled tools,
  commands, providers, resource digests, non-secret configuration, required
  environment names, host paths, and network destinations.

The normal Pi package enable/disable state is inventory evidence only. Hitch
uses its own static per-user extension manifest and never implicitly loads the
operator's interactive Pi package selection.

An extension or resource digest change is published only on restart. Existing
sessions do not silently change behavior: the operator either retains the old
artifact for those sessions or stops/replaces them before selecting the new
profile. The MVP does not build a configuration revision graph.

## Initial certification set

| Extension | Phase 0 target | MVP disposition |
| --- | --- | --- |
| `pi-volcengine-provider` | Installed provider-only artifact | Certify after Pi 0.84.1 inventory, model/thinking, auth, and live smoke evidence |
| `@zihanw/pi-forge` | Installed artifact with the service mode below | Certify the bounded prompt-stack/profile subset |
| `pi-comfyui-paint` | Installed artifact with the service mode below | Certify pinned workflows, owner-bound jobs, and Hitch publication |
| `pi-file-injector` | Current behavior | Excluded; Hitch inbox plus sandboxed file tools replace it |
| `@zihanw/pi-subagent-runtime` process backends | Current behavior | Excluded until a Hitch sandbox backend exists |
| Pi skills such as `pi-web-browse` | Current behavior | Excluded by `--no-skills` |
| `pi-mcp-adapter` | Current behavior | Excluded as a generic connector/runtime and host process surface |
| Other web/host tools | Current behavior | Excluded until individually certified |

## Pi Forge service mode

The service mode must operate while Pi project trust and project resource
discovery remain disabled. It provides Hitch with operator-published prompt
behavior without treating the writable workspace as controller configuration.

### Required controls

- Read prompt stacks and agent profiles only from one operator-owned, read-only
  root supplied by Hitch and included in the extension manifest.
- Do not discover or import project or global Forge code extensions. In
  particular, never import `.pi/forge/extensions` or `~/.pi/forge/extensions`.
- Do not read Forge configuration, prompt stacks, profiles, payloads, or
  imports from the user workspace.
- Do not register `forge_subagent`, `forge_subagent_profiles`, or
  `/forge-agent`; the current subprocess/RPC backends are shared-user host
  processes rather than Hitch sandboxes.
- Do not register `/intercept`, `/payload`, or a provider-payload capture
  handler. Provider requests and responses remain inside Pi's provider
  boundary and are never Forge session state or IM output.
- Do not start the web editor or write, import, migrate, delete, or save Forge
  resources through IM commands.
- Apply tool policy only as a monotonic reduction of Hitch's attested active
  tool set. A Forge stack can never activate, replace, or make visible a tool
  that Hitch did not enable.
- Resolve profile models only against Hitch's allowed-model snapshot. Hitch
  pre-validates every published profile model/thinking pair. For `/profile
  use`, Hitch authorizes the target from the immutable profile manifest,
  observes Pi's native model/thinking result, atomically persists the final
  owner-scoped state, and only then acknowledges the command. A mismatch or
  persistence failure quarantines the session before another Turn.
- Restore stack selection and bounded session variables from the private Pi
  transcript across a fresh controller without reading mutable workspace
  configuration.
- Redact operator root paths from every list, preview, validation, diagnostic,
  notification, status, and command response before RPC or IM delivery.
- Disable regex transforms in MVP service mode. JavaScript regular expressions
  over model-controlled text do not provide a reliable execution deadline.
- Enforce these initial bounds: at most 32 stacks and 32 profiles; 256 KiB
  UTF-8 per resource; 64 KiB of rendered non-history Forge contribution per
  request; 64 persisted variables with 64-byte keys, 8 KiB string scalars,
  depth 8, and 32 KiB serialized total; 64 diagnostics of 512 UTF-8 bytes
  each; and 32 KiB per command response. Exceeding a bound fails closed.

### Supported IM surface

The certification target is:

```text
/preset list|use|preview|validate|diagnostics|status|reload
/profile list|use|preview|validate|status|reload
```

`reload` re-reads the same immutable artifact; it does not publish changed
files. TUI editor, browser UI, payload editor/save, resource mutation/import,
and subagent commands fail with a stable unsupported-operation response.

### Phase 0 acceptance

Phase 0 must prove explicit loading under Pi 0.84.1, the exact tool/command
surface, absence of workspace/global Forge discovery, monotonic tool policy,
allowlisted profile model changes, fresh-controller restoration, unsupported
UI behavior, and clean cancellation/shutdown.

## ComfyUI Paint service mode

ComfyUI Paint is a declared host-authority extension. Its permitted authority
is narrowly limited to configured ComfyUI endpoints, pinned workflows,
owner-bound inputs/jobs/outputs, and the Hitch publication bridge.

### Required controls

- Read configuration only from an operator-owned, read-only artifact supplied
  by Hitch. Ignore global-home and workspace ComfyUI Paint configuration.
- Load workflows only by manifest ID from a hashed operator workflow root.
  Reject absolute paths, relative traversal, project workflow fallback, and
  arbitrary workflow JSON.
- Require a reviewed manifest for every workflow. It pins the workflow graph
  digest, exposed node/input targets, variable types and enum/range/string
  limits, model and LoRA allowlists, file-slot types/count/bytes, output
  node/type/count/bytes, and backend resource caps. Reject every argument,
  target, model, adapter, file, output, or graph field outside that manifest.
- Accept input only through an owner/Turn-bound immutable Hitch snapshot
  handle or an already-open descriptor/stream. Raw paths are never accepted,
  and the extension must not reopen a pathname after Hitch validation. The
  snapshot uses the same canonical no-symlink policy and byte/type bounds as
  Hitch media and tool boundaries.
- Use a unique owner-private job/output root supplied by Hitch; never the
  service-UID-wide default temporary root.
- Bind job lookup, status, cancellation, reconciliation, and output import to
  the authenticated Hitch user. A job id from another owner is indistinguishable
  from an unknown id.
- Do not expose `paint_interrupt` on a shared backend. Only targeted,
  owner-bound cancellation is certifiable.
- Allow host networking only to one statically configured ComfyUI origin and
  the separately reviewed Danbooru origin if that tool is enabled. Redirects
  must remain on the exact origin. Private, link-local, loopback, and cloud
  metadata destinations are rejected except for the exact configured private
  ComfyUI origin.
- Import completed output through Hitch's immutable artifact snapshot bridge.
  Tool results and chat never contain host paths, backend URLs, internal output
  directories, or unbounded inline media.
- Enforce output count, per-object bytes, combined bytes, owner quota, and
  deadline while the backend stream is being consumed, not after buffering.
  On overflow or malformed framing, cancel when safe and remove partial
  snapshots. Before promotion, validate declared MIME, decoded image
  structure/dimensions, and regular-file status; sanitize backend response
  bodies and errors. Only validated bounded artifacts may enter Pi or IM, and
  Hitch artifact delivery is preferred over base64 previews.
- Preserve accepted background jobs across fresh Pi controllers. Synchronous
  waits are short and bounded so one generation cannot occupy the global Pi
  controller slot for minutes.
- Define cancellation honestly: aborting a Turn stops polling and attempts a
  targeted cancel when safe; an already accepted external job may remain
  active and must stay owner-bound and recoverable without automatic replay.

### Supported IM surface

The exact initial tool surface is:

```text
paint_list_workflows
paint_get_details
paint_validate_workflow
paint_server_status
paint_get_models
paint
paint_job_status
paint_job_cancel
```

`paint_get_models` returns only the intersection of sanitized backend inventory
and the published workflow manifests' model/LoRA allowlists; it never returns
backend paths. `paint_interrupt` and `paint_search_danbooru_tags` are not
registered. Enabling the separately reviewed Danbooru origin and tag-search
tool later requires a new pinned manifest and restart. Backend-wide
interruption, arbitrary workflow paths, local configuration UI, job-list
enumeration, and raw host path results are not supported.

### Phase 0 acceptance

Phase 0 must prove two-user job isolation, path and workflow rejection,
configured-endpoint egress, output bounds, immutable publication, background
recovery across fresh controllers, targeted cancellation, and the absence of
host paths or credentials in Pi RPC and IM projections.

## Certification rule

If either service mode cannot fail closed, Hitch omits that extension from the
MVP manifest. The security floor is not weakened to preserve an extension
feature.
