/**
 * Focused Hitch MCP entry point.
 *
 * This is deliberately a small policy wrapper, not an MCP implementation. It
 * loads the operator-installed adapter factory only after the runtime has
 * attested that file as owner-controlled code and the per-profile config as an
 * owner-private regular file.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";
import { reduceForgeTools } from "@zihanw/pi-forge/service";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const MAX_CONFIG_BYTES = 1 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

type AnyTool = ToolDefinition<any, any, any>;
type ForgeToolsPolicy = {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
};
type AdapterFactory = (options: {
  readonly config: Record<string, unknown>;
}) => (pi: ExtensionAPI) => void | Promise<void>;

type AdapterModule = {
  readonly createMcpAdapter?: AdapterFactory;
  /**
   * The adapter's own namespace formatter, when this version exports it. The
   * wrapper uses it to deny proxy-only namespace routes exactly rather than
   * guessing from a prefix.
   */
  readonly namespaceProxyName?: (serverName: string) => string;
};

type JitiModule = {
  readonly import: (path: string) => Promise<unknown>;
};

type JitiLoader = {
  readonly createJiti: (
    url: string,
    options: {
      readonly moduleCache: boolean;
      readonly alias: Readonly<Record<string, string>>;
    },
  ) => JitiModule;
};

function requiredPathEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || !value.startsWith("/")) {
    throw new Error(`Hitch MCP ${name} is missing`);
  }
  return value;
}

function requiredDigestEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Hitch MCP ${name} is missing`);
  }
  return value;
}

function ownerUid(): bigint | undefined {
  const uid = process.getuid?.();
  return uid === undefined ? undefined : BigInt(uid);
}

function validateMcpFile(
  path: string,
  label: string,
  maxBytes: number,
  forbiddenModeBits: bigint,
): void {
  const metadata = lstatSync(path, { bigint: true });
  const uid = ownerUid();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size > BigInt(maxBytes) ||
    (uid !== undefined && metadata.uid !== uid) ||
    (metadata.mode & forbiddenModeBits) !== 0n ||
    realpathSync(path) !== path
  ) {
    throw new Error(`Hitch MCP ${label} is unsafe`);
  }
}

function validateMcpAdapterFile(
  path: string,
  label: string,
  maxBytes: number,
): void {
  // Adapter code is public code: group/world read is fine. It must still be
  // owner-owned, non-symlinked, single-link, realpath-stable, and not
  // group/world-writable before its digest is accepted.
  validateMcpFile(path, label, maxBytes, 0o022n);
}

function validatePrivateMcpConfigFile(
  path: string,
  label: string,
  maxBytes: number,
): void {
  // The per-profile config can contain bearer tokens and command environment
  // values. Keep it owner-private.
  validateMcpFile(path, label, maxBytes, 0o077n);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parsePolicy(): ForgeToolsPolicy | undefined {
  const raw = process.env.HITCH_FORGE_TOOLS_POLICY;
  if (raw === undefined) return undefined;
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024)
    throw new Error("Hitch MCP Forge policy is too large");
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Hitch MCP Forge policy is malformed");
  const candidate = parsed as Record<string, unknown>;
  const policy: { allow?: readonly string[]; deny?: readonly string[] } = {};
  for (const key of ["allow", "deny"] as const) {
    const value = candidate[key];
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      value.some(
        (item) => typeof item !== "string" || item.length === 0 || item.length > 256,
      )
    )
      throw new Error("Hitch MCP Forge policy is malformed");
    policy[key] = [...value];
  }
  if (Object.keys(candidate).some((key) => key !== "allow" && key !== "deny"))
    throw new Error("Hitch MCP Forge policy is malformed");
  return policy;
}

function policyAllows(name: string, policy: ForgeToolsPolicy | undefined): boolean {
  return reduceForgeTools([name], policy).includes(name);
}

/**
 * Apply the existing Forge glob policy to the actual registered tool name.
 * MCP direct tools are already registered as `mcp__<server>_<tool>`; do not
 * invent a virtual alias that could bypass a specific deny. `mcpScript` is
 * always outside the allowed surface, even if a malformed policy matches it.
 */
function mcpToolAllowed(name: string, policy: ForgeToolsPolicy | undefined): boolean {
  if (name === "mcpScript") return false;
  return policyAllows(name, policy);
}

function parseConfig(path: string): Record<string, unknown> {
  validatePrivateMcpConfigFile(path, "config", MAX_CONFIG_BYTES);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Hitch MCP config is malformed");
  const config = structuredClone(parsed) as Record<string, unknown>;
  const settings = config.settings;
  const safeSettings =
    settings !== null && typeof settings === "object" && !Array.isArray(settings)
      ? { ...(settings as Record<string, unknown>) }
      : {};
  // The operator config is input data only. The Hitch wrapper owns these
  // controls; config cannot turn scripts back on, opt out of the gateway, use
  // another tool prefix, or select eager/proxy tool surfaces. Every static
  // server's own auth/env/include/exclude/disabled settings are preserved.
  safeSettings.scriptMode = false;
  safeSettings.toolPrefix = "mcp";
  safeSettings.directTools = "search";
  safeSettings.disableProxyTool = false;
  config.settings = safeSettings;

  const servers = config.mcpServers;
  if (servers !== null && typeof servers === "object" && !Array.isArray(servers)) {
    for (const [serverName, definition] of Object.entries(servers)) {
      if (
        definition === null ||
        typeof definition !== "object" ||
        Array.isArray(definition)
      )
        continue;
      (servers as Record<string, unknown>)[serverName] = {
        ...(definition as Record<string, unknown>),
        directTools: "search",
        toolPrefix: "mcp",
      };
    }
  }
  return config;
}

const ENCODED_SERVER_NAMESPACE_MARKER = "_mcpns_";
// Provider tool-name limit (64) minus the `mcp__` proxy prefix.
const MAX_SERVER_NAMESPACE_LENGTH = 59;

/**
 * Exact copy of the installed adapter's `formatServerNamespace` rule. It is
 * used as a fallback when the adapter does not expose `namespaceProxyName`.
 * Do not replace this with a prefix check: namespace names are encoded when a
 * server name contains anything other than letters, digits, and underscores.
 */
function encodeServerNamespace(name: string): string {
  return Array.from(name, (character) => {
    if (character === "_") return "__";
    return /^[A-Za-z0-9]$/u.test(character)
      ? character
      : `_${character.codePointAt(0)!.toString(16)}_`;
  }).join("");
}

function formatServerNamespace(serverName: string): string {
  const normalized = serverName.replace(/-/gu, "_");
  const safe =
    /^[A-Za-z0-9_]*$/u.test(normalized) &&
    !normalized.startsWith(ENCODED_SERVER_NAMESPACE_MARKER);
  const body = safe ? normalized : encodeServerNamespace(normalized);
  const namespace = safe ? body : `${ENCODED_SERVER_NAMESPACE_MARKER}${body}`;
  if (namespace.length <= MAX_SERVER_NAMESPACE_LENGTH) return namespace;
  // Hash the ASCII encoding, not the raw name: lone surrogates and U+FFFD
  // share UTF-8 bytes.
  const digest = createHash("sha256")
    .update(namespace, "utf8")
    .digest("hex")
    .slice(0, 16);
  const hashPrefix = `${ENCODED_SERVER_NAMESPACE_MARKER}_h_`;
  const head = body.slice(
    0,
    MAX_SERVER_NAMESPACE_LENGTH - hashPrefix.length - digest.length - 1,
  );
  return `${hashPrefix}${head}_${digest}`;
}

function configuredServers(config: Record<string, unknown>): ReadonlySet<string> {
  const servers = config.mcpServers;
  if (servers === null || typeof servers !== "object" || Array.isArray(servers))
    throw new Error("Hitch MCP config has no static server map");
  return new Set(Object.keys(servers));
}

const safeGatewayParameters = Type.Object(
  {
    connect: Type.Optional(
      Type.String({
        description: "Configured static server name to connect and refresh.",
      }),
    ),
    describe: Type.Optional(Type.String()),
    search: Type.Optional(Type.String()),
    regex: Type.Optional(Type.Boolean()),
    includeSchemas: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Number({ minimum: 1 })),
    offset: Type.Optional(Type.Number({ minimum: 0 })),
    server: Type.Optional(
      Type.String({
        description: "Configured static server name to list/search/describe.",
      }),
    ),
  },
  { additionalProperties: false },
);

const safeGatewayKeys = new Set([
  "connect",
  "describe",
  "search",
  "regex",
  "includeSchemas",
  "limit",
  "offset",
  "server",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function restrictedApi(
  pi: ExtensionAPI,
  policy: ForgeToolsPolicy | undefined,
  servers: ReadonlySet<string>,
  namespaceProxyNames: ReadonlySet<string>,
): ExtensionAPI {
  const blocked = new Set<string>();

  const registerTool = (tool: AnyTool): void => {
    // Every tool registered by the operator adapter is an MCP-sourced tool.
    // Denied tools never enter Pi's registry, rather than merely disappearing
    // from the model prompt. Namespace proxies are always denied because Hitch
    // does not expose a generic `{tool, args}` call path.
    if (
      tool.name === "mcpScript" ||
      namespaceProxyNames.has(tool.name) ||
      !mcpToolAllowed(tool.name, policy)
    ) {
      blocked.add(tool.name);
      return;
    }
    const wrapped: AnyTool = {
      ...tool,
      ...(tool.name === "mcp"
        ? {
            description:
              "MCP gateway for status, search, describe, connect, and list configured static servers. Generic tool calls, installation, authentication, UI management, URLs, scripts, and namespace proxies are unavailable; call activated direct MCP tools by name instead.",
            promptSnippet:
              "MCP gateway — status, search, describe, connect, and list configured servers",
            parameters: safeGatewayParameters,
          }
        : {}),
      execute: async (
        toolCallId,
        params,
        signal,
        onUpdate,
        context,
      ) => {
        if (tool.name === "mcpScript")
          throw new Error("mcpScript is disabled by Hitch");
        if (namespaceProxyNames.has(tool.name))
          throw new Error("MCP namespace proxies are disabled by Hitch");
        if (!mcpToolAllowed(tool.name, policy))
          throw new Error("MCP tool denied by the active Forge policy");
        if (tool.name === "mcp") {
          const input = isRecord(params) ? params : {};
          if (input.tool !== undefined || input.args !== undefined)
            throw new Error(
              "MCP generic tool calls are disabled by Hitch; call the activated direct tool instead",
            );
          if (
            input.action !== undefined ||
            input.url !== undefined ||
            input.target !== undefined ||
            input.instructions !== undefined
          )
            throw new Error("MCP management actions are disabled by Hitch");
          for (const key of Object.keys(input)) {
            if (!safeGatewayKeys.has(key))
              throw new Error(
                "MCP gateway only supports status, search, describe, connect, and list",
              );
          }
          for (const key of ["connect", "server"] as const) {
            const value = input[key];
            if (
              value !== undefined &&
              (typeof value !== "string" || !servers.has(value))
            )
              throw new Error("MCP server is not a configured static server");
          }
        }
        return tool.execute(toolCallId, params, signal, onUpdate, context);
      },
    };
    pi.registerTool(wrapped);
  };

  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") return registerTool;
      // The adapter's prompts and auth/setup commands are all management
      // surfaces. A no-op is intentional: it also prevents late activation
      // from creating a slash-command bypass.
      if (property === "registerCommand") return () => undefined;
      if (property === "registerFlag") return () => undefined;
      if (property === "setActiveTools") {
        return (names: string[]) => {
          target.setActiveTools(
            names.filter(
              (name) =>
                !blocked.has(name) &&
                !namespaceProxyNames.has(name) &&
                name !== "mcpScript",
            ),
          );
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const adapterPath = requiredPathEnvironment("HITCH_MCP_ADAPTER_PATH");
const adapterDigest = requiredDigestEnvironment("HITCH_MCP_ADAPTER_SHA256");
const configPath = requiredPathEnvironment("HITCH_MCP_CONFIG_PATH");
const wrapperDigest = requiredDigestEnvironment("HITCH_MCP_EXTENSION_SHA256");
if (!SHA256.test(adapterDigest) || !SHA256.test(wrapperDigest))
  throw new Error("Hitch MCP digest is invalid");
validateMcpAdapterFile(adapterPath, "adapter", 8 * 1024 * 1024);
if (sha256File(adapterPath) !== adapterDigest)
  throw new Error("Hitch MCP adapter digest mismatch");
const selfPath = fileURLToPath(import.meta.url);
if (sha256File(selfPath) !== wrapperDigest)
  throw new Error("Hitch MCP wrapper digest mismatch");
const config = parseConfig(configPath);
// The wrapper-owned config is authoritative. Remove the adapter's direct-tool
// environment override so it cannot select eager, subset, or proxy-only
// surfaces behind the wrapper's back.
delete process.env.MCP_DIRECT_TOOLS;
const servers = configuredServers(config);
const policy = parsePolicy();
// The pinned Pi extension loader uses jiti for TypeScript extensions. Use the
// same loader for the operator adapter: native Node intentionally refuses to
// strip TypeScript below node_modules, while jiti preserves the adapter's
// public factory boundary and relative imports.
const piLoaderPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js",
);
const piRequire = createRequire(piLoaderPath);
const piPackageRoot = resolve(dirname(piLoaderPath), "..", "..", "..");
function firstExisting(paths: readonly string[], label: string): string {
  const found = paths.find((path) => existsSync(path));
  if (found === undefined)
    throw new Error(`Hitch MCP host ${label} is unavailable`);
  return found;
}
const piAiPath = firstExisting(
  [
    resolve(piPackageRoot, "../../@earendil-works/pi-ai/dist/index.js"),
    resolve(piPackageRoot, "node_modules/@earendil-works/pi-ai/dist/index.js"),
  ],
  "pi-ai",
);
const piTuiPath = firstExisting(
  [
    resolve(piPackageRoot, "node_modules/@earendil-works/pi-tui/dist/index.js"),
    resolve(piPackageRoot, "../../@earendil-works/pi-tui/dist/index.js"),
  ],
  "pi-tui",
);
const jitiPath = resolve(dirname(piRequire.resolve("jiti")), "jiti-static.mjs");
const { createJiti } = (await import(pathToFileURL(jitiPath).href)) as JitiLoader;
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": resolve(
      dirname(piLoaderPath),
      "../../index.js",
    ),
    "@earendil-works/pi-ai": piAiPath,
    "@earendil-works/pi-tui": piTuiPath,
    typebox: piRequire.resolve("typebox"),
    "typebox/value": piRequire.resolve("typebox/value"),
    "typebox/compile": piRequire.resolve("typebox/compile"),
  },
});
const adapterModule = (await jiti.import(adapterPath)) as AdapterModule;
if (typeof adapterModule.createMcpAdapter !== "function")
  throw new Error("Hitch MCP adapter factory is unavailable");

function resolveNamespaceProxyName(serverName: string): string {
  const adapterNamespaceProxyName = adapterModule.namespaceProxyName;
  if (typeof adapterNamespaceProxyName === "function") {
    const name = adapterNamespaceProxyName(serverName);
    if (typeof name !== "string" || name.length === 0)
      throw new Error("Hitch MCP adapter namespace formatter is invalid");
    return name;
  }
  return `mcp__${formatServerNamespace(serverName)}`;
}

// Deny the actual namespace-proxy route names for every configured static
// server. The installed adapter normally omits these because the wrapper
// forces directTools: "search", but a real adapter could still register one;
// this is a hard deny independent of the Forge allow/deny policy.
const namespaceProxyNames = new Set(
  [...servers].map(resolveNamespaceProxyName),
);
const install = adapterModule.createMcpAdapter({ config });

export default function hitchMcp(pi: ExtensionAPI): void | Promise<void> {
  return install(restrictedApi(pi, policy, servers, namespaceProxyNames));
}

export { mcpToolAllowed, policyAllows };
