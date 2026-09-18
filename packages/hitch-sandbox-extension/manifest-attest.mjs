// Hitch shared tool-attestation module.
//
// Single source of truth for the tool-set attestation performed by every
// Hitch security extension (hitch-sandbox, pi-web-search, ...). Both the
// per-turn startup attestation and the fail-closed re-attestation before
// every privileged tool execution flow through attestToolSet().
//
// Contract (controller environment, set by the Hitch runtime):
//   HITCH_EXPECTED_TOOLS: JSON string[] — the exact tool set that must be
//     registered after dynamic-source tools are filtered out.
//   HITCH_ACTIVE_TOOLS: JSON string[] — the exact active subset the model
//     may use (already policy-reduced by the runtime).
//   HITCH_DYNAMIC_EXTENSION_PATHS: JSON string[] — absolute extension paths
//     whose tools are exempt from both comparisons. Tools from dynamic
//     sources (e.g. the MCP adapter) may appear and activate asynchronously;
//     they never route through the sandboxed execute() path, so they are
//     excluded by source path rather than enumerated by name.
//
// Every failure mode throws synchronously: fail closed, never warn-and-pass.

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function parseStringList(value, envName) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096)
    throw new Error(`Hitch attestation env ${envName} is missing`);
  const parsed = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length > 256 ||
    parsed.some((item) => typeof item !== "string" || item.length === 0)
  )
    throw new Error(`Hitch attestation env ${envName} is malformed`);
  return parsed;
}

/**
 * The runtime-declared expected tool set (sorted). Extensions use this as
 * the baseline when validating HITCH_ACTIVE_TOOLS membership.
 *
 * @returns {string[]}
 */
export function attestationBaseline() {
  return parseStringList(process.env.HITCH_EXPECTED_TOOLS, "HITCH_EXPECTED_TOOLS")
    .slice()
    .sort();
}

/**
 * Returns the registered and active tool views with dynamic-source tools
 * removed from both.
 *
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 * @returns {{ all: { name: string, path: string | undefined, parameters: unknown }[], active: string[] }}
 */
export function filteredTools(pi) {
  const dynamicPaths = new Set(
    parseStringList(
      process.env.HITCH_DYNAMIC_EXTENSION_PATHS ?? "[]",
      "HITCH_DYNAMIC_EXTENSION_PATHS",
    ),
  );
  const rawAll = pi
    .getAllTools()
    .map((tool) => ({
      name: tool.name,
      path: tool.sourceInfo?.path,
      parameters: tool.parameters,
    }));
  const dynamicNames = new Set(
    rawAll
      .filter((tool) => tool.path !== undefined && dynamicPaths.has(tool.path))
      .map((tool) => tool.name),
  );
  const all = rawAll
    .filter((tool) => !dynamicNames.has(tool.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const active = pi
    .getActiveTools()
    .filter((name) => !dynamicNames.has(name))
    .slice()
    .sort();
  return { all, active };
}

/**
 * Verifies the registered tool world matches the runtime-declared
 * expectation. Throws `${label} tool attestation failed` on any mismatch.
 *
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 * @param {{ label: string, defaultPath: string, pathOverrides?: Record<string, string> }} options
 *   defaultPath: expected sourceInfo.path for tools not in pathOverrides.
 * @returns {{ all: { name: string, path: string | undefined, parameters: unknown }[], active: string[], sourcePaths: (string | undefined)[] }}
 */
export function attestToolSet(pi, options) {
  const { all, active } = filteredTools(pi);
  const expectedAll = parseStringList(
    process.env.HITCH_EXPECTED_TOOLS,
    "HITCH_EXPECTED_TOOLS",
  )
    .slice()
    .sort();
  const expectedActive = parseStringList(
    process.env.HITCH_ACTIVE_TOOLS,
    "HITCH_ACTIVE_TOOLS",
  )
    .slice()
    .sort();
  const overrides = options.pathOverrides ?? {};
  if (
    JSON.stringify(all.map((tool) => tool.name)) !==
      JSON.stringify(expectedAll) ||
    JSON.stringify(active) !== JSON.stringify(expectedActive) ||
    all.some(
      (tool) => tool.path !== (overrides[tool.name] ?? options.defaultPath),
    )
  )
    throw new Error(`Hitch ${options.label} tool attestation failed`);
  return { all, active, sourcePaths: all.map((tool) => tool.path) };
}
