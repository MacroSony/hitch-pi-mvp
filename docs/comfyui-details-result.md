# ComfyUI `paint_get_details` — local result

Added the sixth optional, manifest-attested Paint tool. Call
`paint_list_workflows`, then `paint_get_details({ workflow: "anima" })` using an
exact configured short ID. Missing IDs, unknown IDs, filenames, paths, backend
selectors and extra fields are rejected. Disabled owners cannot call it.

## Public projection

- `id`, optional operator `description`, `notes`, `notesTruncated`;
- policy-allowlisted variables: names, types, limits and validated graph defaults;
- file slot names/media/optional flags and `output_kind` (image by default).

`notes` comes from the **actual loaded operator graph**: nodes whose
`_meta.title` starts with `[NOTE]`, reading string `inputs.value ?? inputs.text`
in graph order. Thus Anima's real NOTE is readable when present in its configured
graph; it is **not** a second copy maintained in `description`. A missing NOTE is
legal. Policies are immutable startup snapshots: operator file changes take
effect after reload/restart, not by reading model-selected paths. No live Anima
configuration or `/data` was inspected in this task; the offline fixture verifies
that changing graph NOTE changes details while description stays unchanged.

No full graph, node IDs, bindings, class names, fixed model/steps, file defaults,
backend, host paths or headers are projected. `[VAR]` annotations do not grant
new controls; only existing policy bindings are described, and paint's accepted
arguments are unchanged. NOTE, description, variable names/enum values and bound
defaults are explicitly **operator-public metadata**: do not put secrets or
private paths in those fields. The tool does not discover desktop configuration,
query backends, create jobs, or add drawing/material prompts.

## Bounds and evidence

The complete details JSON is at most **24 KiB**, including JSON escaping; all
NOTE text shares an **8 KiB** serialized-string budget and truncates on code-point
boundaries with `notesTruncated`. Defaults are exact (never invented or shortened):
values over **1 KiB**, or beyond remaining total budget, have `defaultOmitted`.
An enum list that cannot fit has `valuesOmitted`; numeric/string limits remain.
The existing 32 KiB control bridge limit is unchanged.

Commands (offline dependencies installed locally with `npm ci --offline`, no
node_modules symlink):

```sh
npm run check
node --disable-warning=ExperimentalWarning --test dist/test/comfyui-{details,service,bridge,runtime-assets}.test.js
```

Final full check: **455 tests / 427 passed / 28 opt-in skipped / 0 failed**.
Coverage includes NOTE text/value precedence, missing/malformed NOTE, graph-only
updates, private-field exclusion, defaults/limits, aggregate escaped-byte bounds,
owner and exact-input rejection, Unix bridge routing, actual extension schema
registration, six-tool manifest membership and existing hardcoded Pi tool sets.
Opt-in host/service/real-Pi lanes and independent subagent review were not run.
No external model, image generation, Discord, production/data/auth/memory change,
publish/completion/workspace redesign or push was performed.
