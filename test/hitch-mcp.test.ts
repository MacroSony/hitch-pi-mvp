import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const wrapper = join(repository, "dist", "sandbox", "hitch-mcp.ts");
// The synthetic stdio fixture below is loaded from the repository's own copy
// of the official SDK so it does not depend on the operator adapter's tree.
const sdkEsmRoot = join(
  repository,
  "node_modules",
  "@modelcontextprotocol",
  "sdk",
  "dist",
  "esm",
);

const DEFAULT_INITIAL_TOOLS = [
  "mcp",
  "mcpScript",
  "mcp__mock_read",
  "other_tool",
] as const;

const DEFAULT_CONFIG = {
  settings: { scriptMode: true },
  mcpServers: {
    mock: { command: "mock" },
    blocked: { command: "blocked" },
  },
};

interface WrapperRun {
  readonly tools: string[];
  readonly commands: string[];
  readonly active: string[];
  readonly scriptPresent: boolean;
  readonly factoryScriptMode: unknown;
  readonly factoryConfig: unknown;
  readonly envDirectTools: string | undefined;
  readonly managementErrors: string[];
  readonly unknownServerErrors: Array<string | null>;
  readonly knownServerCallWorked: boolean;
  readonly directCallWorked: boolean;
  readonly gatewayToolCallError: string | null;
  readonly eventNames: string[];
}

interface RunOptions {
  readonly policy?: unknown;
  readonly initialTools?: readonly string[];
  readonly lateTools?: readonly string[];
  readonly adapterSource?: string;
  readonly config?: unknown;
  readonly adapterMode?: number;
  readonly configMode?: number;
  readonly adapterDigestOverride?: string;
  readonly wrapperDigestOverride?: string;
  readonly mcpDirectTools?: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureAdapterSource(
  initialTools: readonly string[],
  lateTools: readonly string[],
): string {
  return `
export function createMcpAdapter(options) {
  globalThis.__hitchFactoryScriptMode = options?.config?.settings?.scriptMode;
  globalThis.__hitchFactoryConfig = {
    settings: options?.config?.settings,
    servers: options?.config?.mcpServers,
  };
  globalThis.__hitchEnvDirectTools = process.env.MCP_DIRECT_TOOLS;
  return async (pi) => {
    pi.registerCommand("mcp", {});
    const tool = (name) => ({
      name,
      label: name,
      description: name,
      parameters: {},
      async execute(_id, params) {
        if (name === "mcpScript") throw new Error("fixture script reached");
        if (name === "mcp" && params?.action)
          throw new Error("fixture management reached");
        return { content: [{ type: "text", text: name }], details: {} };
      },
    });
    const initial = ${JSON.stringify(initialTools)};
    for (const name of initial) pi.registerTool(tool(name));
    pi.setActiveTools(initial);
    const late = ${JSON.stringify(lateTools)};
    if (late.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (const name of late) pi.registerTool(tool(name));
      pi.setActiveTools([...initial, ...late, "mcpScript"]);
    }
  };
}
`;
}

function childScript(wrapperPath: string): string {
  return `
const tools = [];
const commands = [];
const events = {};
let active = [];
const pi = {
  registerTool(tool) { tools.push(tool); },
  registerCommand(name) { commands.push(name); },
  registerFlag() {},
  setActiveTools(names) { active = [...names]; },
  getActiveTools() { return active; },
  getAllTools() { return tools; },
  on(name, handler) { events[name] = handler; },
  events: { on() {}, emit() {} },
};
const mod = await import(${JSON.stringify(wrapperPath)});
await mod.default(pi);
const find = (name) => tools.find((tool) => tool.name === name);
async function callTool(name, params) {
  const tool = find(name);
  if (!tool) return "missing";
  try {
    await tool.execute("call", params, undefined, undefined, {});
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
const management = [
  { action: "install" },
  { action: "auth-start" },
  { action: "auth-complete" },
  { action: "ui-messages" },
  { url: "https://example.invalid/secret" },
  { target: "project" },
  { instructions: "mock" },
];
const managementErrors = [];
for (const params of management) {
  const error = await callTool("mcp", params);
  if (error === "missing") break;
  managementErrors.push(error ?? "ALLOWED");
}
const unknownServerErrors = [
  await callTool("mcp", { connect: "unknown" }),
  await callTool("mcp", { server: "unknown" }),
];
const knownServerCallWorked =
  (await callTool("mcp", { connect: "mock" })) === null &&
  (await callTool("mcp", { server: "mock" })) === null;
const directCallWorked = (await callTool("mcp__mock_read", {})) === null;
const gatewayToolCallError = await callTool("mcp", {
  tool: "mcp__mock_read",
  args: {},
});
console.log(JSON.stringify({
  tools: tools.map((tool) => tool.name),
  commands,
  active,
  scriptPresent: tools.some((tool) => tool.name === "mcpScript"),
  factoryScriptMode: globalThis.__hitchFactoryScriptMode,
  factoryConfig: globalThis.__hitchFactoryConfig,
  envDirectTools: globalThis.__hitchEnvDirectTools,
  managementErrors,
  unknownServerErrors,
  knownServerCallWorked,
  directCallWorked,
  gatewayToolCallError,
  eventNames: Object.keys(events),
}));
`;
}

function execWrapperChild(
  root: string,
  adapterPath: string,
  configPath: string,
  script: string,
  policy?: unknown,
): RealAdapterRun {
  mkdirSync(join(root, "agent"), { recursive: true, mode: 0o700 });
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: root,
    PI_CODING_AGENT_DIR: join(root, "agent"),
    HITCH_MCP_ADAPTER_PATH: adapterPath,
    HITCH_MCP_ADAPTER_SHA256: sha256(readFileSync(adapterPath)),
    HITCH_MCP_CONFIG_PATH: configPath,
    HITCH_MCP_EXTENSION_SHA256: sha256(readFileSync(wrapper)),
    ...(policy === undefined
      ? {}
      : { HITCH_FORGE_TOOLS_POLICY: JSON.stringify(policy) }),
  };
  try {
    return JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: repository,
        env: environment,
        encoding: "utf8",
        timeout: 25_000,
        maxBuffer: 4 * 1024 * 1024,
      }),
    ) as RealAdapterRun;
  } catch (error) {
    const executionError = error as Error & { stderr?: Buffer | string };
    const stderr =
      typeof executionError.stderr === "string"
        ? executionError.stderr
        : (executionError.stderr?.toString("utf8") ?? "");
    throw new Error(`${executionError.message}\n${stderr}`);
  }
}

function runWrapper(options: RunOptions = {}): WrapperRun {
  const root = mkdtempSync(join(tmpdir(), "hitch-mcp-fixture-"));
  try {
    chmodSync(root, 0o700);
    const adapter = join(root, "adapter.mjs");
    const config = join(root, "mcp.json");
    const adapterMode = options.adapterMode ?? 0o600;
    const configMode = options.configMode ?? 0o600;
    writeFileSync(
      adapter,
      options.adapterSource ??
        fixtureAdapterSource(
          options.initialTools ?? DEFAULT_INITIAL_TOOLS,
          options.lateTools ?? [],
        ),
      { mode: 0o600 },
    );
    chmodSync(adapter, adapterMode);
    writeFileSync(config, JSON.stringify(options.config ?? DEFAULT_CONFIG), {
      mode: 0o600,
    });
    chmodSync(config, configMode);
    mkdirSync(join(root, "agent"), { mode: 0o700 });

    const script = childScript(wrapper);
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      PI_CODING_AGENT_DIR: join(root, "agent"),
      HITCH_MCP_ADAPTER_PATH: adapter,
      HITCH_MCP_ADAPTER_SHA256:
        options.adapterDigestOverride ?? sha256(readFileSync(adapter)),
      HITCH_MCP_CONFIG_PATH: config,
      HITCH_MCP_EXTENSION_SHA256:
        options.wrapperDigestOverride ?? sha256(readFileSync(wrapper)),
      ...(options.policy === undefined
        ? {}
        : { HITCH_FORGE_TOOLS_POLICY: JSON.stringify(options.policy) }),
      ...(options.mcpDirectTools === undefined
        ? {}
        : { MCP_DIRECT_TOOLS: options.mcpDirectTools }),
    };
    try {
      return JSON.parse(
        execFileSync(process.execPath, ["--input-type=module", "-e", script], {
          cwd: repository,
          env: environment,
          encoding: "utf8",
          timeout: 15_000,
          maxBuffer: 4 * 1024 * 1024,
        }),
      ) as WrapperRun;
    } catch (error) {
      const executionError = error as Error & { stderr?: Buffer | string };
      const stderr =
        typeof executionError.stderr === "string"
          ? executionError.stderr
          : (executionError.stderr?.toString("utf8") ?? "");
      throw new Error(`${executionError.message}\n${stderr}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("mcpScript is never registered and deny mcp* closes the whole MCP surface", () => {
  const denied = runWrapper({
    initialTools: ["mcp", "mcpScript", "mcp__mock_read"],
    policy: { deny: ["mcp*"] },
  });
  assert.deepEqual(denied.tools, []);
  assert.deepEqual(denied.commands, []);
  assert.deepEqual(denied.active, []);
  assert.equal(denied.scriptPresent, false);
});

test("allow only read closes all MCP-prefixed adapter tools", () => {
  const readOnly = runWrapper({
    initialTools: ["mcp", "mcpScript", "mcp__mock_read"],
    policy: { allow: ["read"] },
  });
  assert.deepEqual(readOnly.tools, []);
  assert.deepEqual(readOnly.commands, []);
  assert.deepEqual(readOnly.active, []);
  assert.equal(readOnly.scriptPresent, false);
});

test("allow mcp* admits the gateway and actual direct tools only", () => {
  const allowed = runWrapper({
    initialTools: ["mcp", "mcpScript", "mcp__mock_read", "other_tool"],
    policy: { allow: ["mcp*"] },
  });
  assert.deepEqual(allowed.tools, ["mcp", "mcp__mock_read"]);
  assert.deepEqual(allowed.commands, []);
  assert.deepEqual(allowed.active, ["mcp", "mcp__mock_read"]);
  assert.equal(allowed.scriptPresent, false);
});

test("a specific deny matches the registered name without a virtual alias bypass", () => {
  const denied = runWrapper({
    initialTools: ["mcp", "mcpScript", "mcp__mock_read"],
    policy: { deny: ["mcp__mock_read"] },
  });
  assert.deepEqual(denied.tools, ["mcp"]);
  assert.deepEqual(denied.active, ["mcp"]);
  assert.equal(denied.scriptPresent, false);
});

test("allowing only one MCP tool family does not require the mcp gateway name", () => {
  const namespace = runWrapper({
    initialTools: ["mcp", "mcpScript", "mcp__mock_read", "mcp__mock_write"],
    policy: { allow: ["mcp__mock_*"] },
  });
  assert.deepEqual(namespace.tools, ["mcp__mock_read", "mcp__mock_write"]);
  assert.deepEqual(namespace.active, ["mcp__mock_read", "mcp__mock_write"]);
  assert.equal(namespace.scriptPresent, false);
});

test("denying one tool family leaves the gateway and other tools available", () => {
  const namespace = runWrapper({
    initialTools: ["mcp", "mcpScript", "mcp__mock_read", "mcp__blocked_secret"],
    policy: { deny: ["mcp__blocked_*"] },
  });
  assert.deepEqual(namespace.tools, ["mcp", "mcp__mock_read"]);
  assert.deepEqual(namespace.active, ["mcp", "mcp__mock_read"]);
  assert.equal(namespace.scriptPresent, false);
});

test("late activation is policy-filtered and cannot re-add mcpScript or denied tools", () => {
  const late = runWrapper({
    initialTools: ["mcp", "mcpScript", "mcp__mock_read"],
    lateTools: ["mcp__mock_late", "mcp__blocked_secret"],
    policy: { deny: ["mcp__blocked_*"] },
  });
  assert.deepEqual(late.tools, ["mcp", "mcp__mock_read", "mcp__mock_late"]);
  assert.deepEqual(late.active, ["mcp", "mcp__mock_read", "mcp__mock_late"]);
  assert.equal(late.scriptPresent, false);
});

test("gateway rejects install/auth/URL/actions and unknown static servers", () => {
  const run = runWrapper({
    initialTools: ["mcp", "mcpScript", "mcp__mock_read"],
    policy: { allow: ["mcp*"] },
  });
  assert.deepEqual(run.managementErrors, [
    "MCP management actions are disabled by Hitch",
    "MCP management actions are disabled by Hitch",
    "MCP management actions are disabled by Hitch",
    "MCP management actions are disabled by Hitch",
    "MCP management actions are disabled by Hitch",
    "MCP management actions are disabled by Hitch",
    "MCP management actions are disabled by Hitch",
  ]);
  assert.deepEqual(run.unknownServerErrors, [
    "MCP server is not a configured static server",
    "MCP server is not a configured static server",
  ]);
  assert.equal(run.knownServerCallWorked, true);
  assert.equal(run.directCallWorked, true);
  assert.equal(
    run.gatewayToolCallError,
    "MCP generic tool calls are disabled by Hitch; call the activated direct tool instead",
  );
});

test("namespace proxy names are hard denied for every configured static server", () => {
  const run = runWrapper({
    initialTools: [
      "mcp",
      "mcpScript",
      "mcp__mock",
      "mcp__blocked_server",
      "mcp___mcpns_blocked_2e_server",
    ],
    policy: { allow: ["mcp*"] },
    config: {
      settings: { scriptMode: true },
      mcpServers: {
        mock: { command: "mock" },
        "blocked-server": { command: "blocked-server" },
        "blocked.server": { command: "blocked.server" },
      },
    },
  });
  assert.deepEqual(run.tools, ["mcp"]);
  assert.deepEqual(run.active, ["mcp"]);
  assert.equal(run.scriptPresent, false);
});

test("factory config forces scriptMode false, search direct tools, and the mcp prefix", () => {
  const run = runWrapper({
    initialTools: ["mcp", "mcpScript", "mcp__mock_read"],
    policy: { allow: ["mcp*"] },
    config: {
      settings: { scriptMode: true, toolPrefix: "server", directTools: true },
      mcpServers: { mock: { command: "mock", directTools: true } },
    },
    mcpDirectTools: "__none__",
  });
  assert.equal(run.factoryScriptMode, false);
  assert.equal(run.envDirectTools, undefined);
  const factoryConfig = run.factoryConfig as {
    settings?: Record<string, unknown>;
    servers?: Record<string, Record<string, unknown>>;
  };
  assert.equal(factoryConfig.settings?.scriptMode, false);
  assert.equal(factoryConfig.settings?.toolPrefix, "mcp");
  assert.equal(factoryConfig.settings?.directTools, "search");
  assert.equal(factoryConfig.settings?.disableProxyTool, false);
  assert.equal(factoryConfig.servers?.mock?.directTools, "search");
  assert.equal(factoryConfig.servers?.mock?.toolPrefix, "mcp");
  assert.equal(run.scriptPresent, false);
  assert.deepEqual(run.commands, []);
});

test("adapter and wrapper digest mismatches are rejected", () => {
  assert.throws(
    () =>
      runWrapper({
        initialTools: ["mcp"],
        adapterDigestOverride: "0".repeat(64),
      }),
    /Hitch MCP adapter digest mismatch/u,
  );
  assert.throws(
    () =>
      runWrapper({
        initialTools: ["mcp"],
        wrapperDigestOverride: "0".repeat(64),
      }),
    /Hitch MCP wrapper digest mismatch/u,
  );
});

test("adapter accepts 0644 public code but rejects group/world-writable code and 0644 config", () => {
  const publicCode = runWrapper({
    initialTools: ["mcp"],
    adapterMode: 0o644,
    policy: { allow: ["mcp"] },
  });
  assert.deepEqual(publicCode.tools, ["mcp"]);

  assert.throws(
    () => runWrapper({ initialTools: ["mcp"], adapterMode: 0o664 }),
    /Hitch MCP adapter is unsafe/u,
  );
  assert.throws(
    () => runWrapper({ initialTools: ["mcp"], configMode: 0o644 }),
    /Hitch MCP config is unsafe/u,
  );
});

interface RealAdapterRun {
  readonly tools: string[];
  readonly commands: string[];
  readonly active: string[];
  readonly quotePresent: boolean;
  readonly otherPresent: boolean;
  readonly namespacePresent: boolean;
  readonly searchOtherError: string | null;
  readonly searchOtherText: string | null;
  readonly activeAfterOtherSearch: string[];
  readonly otherText: string | null;
  readonly otherError: string | null;
  readonly searchQuoteError: string | null;
  readonly searchQuoteText: string | null;
  readonly activeAfterQuoteSearch: string[];
  readonly quoteText: string | null;
  readonly quoteError: string | null;
  readonly gatewayToolCallError: string | null;
  readonly namespaceCallError: string | null;
  readonly managementErrors: string[];
  readonly scriptPresent: boolean;
  readonly scriptError: string;
  readonly hasSessionStart: boolean;
  readonly hasSessionShutdown: boolean;
  readonly diagnostics: string[];
}

/**
 * A synthetic, private stdio MCP server. It speaks the official
 * `@modelcontextprotocol/sdk` protocol over stdin/stdout only: no sockets, no
 * network, no credentials, and fixed `synthetic_quote` / `synthetic_other`
 * values that are deliberately not real market data.
 */
function mockStdioServerSource(): string {
  const serverEntry = pathToFileURL(
    join(sdkEsmRoot, "server", "index.js"),
  ).href;
  const stdioEntry = pathToFileURL(join(sdkEsmRoot, "server", "stdio.js")).href;
  const typesEntry = pathToFileURL(join(sdkEsmRoot, "types.js")).href;
  return `
import { Server } from ${JSON.stringify(serverEntry)};
import { StdioServerTransport } from ${JSON.stringify(stdioEntry)};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(typesEntry)};

const server = new Server(
  { name: "hitch-synthetic-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "quote",
      description:
        "Synthetic local test fixture; returns a fixed value, not market data.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "other",
      description:
        "Synthetic local test fixture; returns a second fixed value, not market data.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "quote") {
    return { content: [{ type: "text", text: "synthetic_quote" }] };
  }
  if (request.params.name === "other") {
    return { content: [{ type: "text", text: "synthetic_other" }] };
  }
  throw new Error("unknown synthetic tool: " + request.params.name);
});
await server.connect(new StdioServerTransport());
`;
}

function realAdapterChildScript(wrapperPath: string): string {
  return `
const tools = [];
const commands = [];
const events = {};
let active = [];
const diagnostics = [];
console.error = (...args) => {
  diagnostics.push(
    args
      .map((value) => (value instanceof Error ? value.message : String(value)))
      .join(" "),
  );
};
const pi = {
  registerTool(tool) {
    const index = tools.findIndex((existing) => existing.name === tool.name);
    if (index >= 0) tools[index] = tool;
    else tools.push(tool);
  },
  registerCommand(name) { commands.push(name); },
  registerFlag() {},
  setActiveTools(names) { active = [...names]; },
  getActiveTools() { return active; },
  getAllTools() { return tools; },
  on(name, handler) { events[name] = handler; },
  events: { on() {}, emit() {} },
};
const mod = await import(${JSON.stringify(wrapperPath)});
await mod.default(pi);
const ctx = {
  mode: "print",
  hasUI: false,
  cwd: ${JSON.stringify(repository)},
  model: undefined,
  modelRegistry: undefined,
  signal: undefined,
  sessionManager: undefined,
  ui: undefined,
  reload: async () => {},
};
if (events.session_start) await events.session_start({}, ctx);
const find = (name) => tools.find((tool) => tool.name === name);
const textOf = (result) => {
  const content = result && Array.isArray(result.content) ? result.content : [];
  return content
    .filter((part) => part && part.type === "text")
    .map((part) => part.text)
    .join("\\n");
};
const run = async (name, params) => {
  const tool = name === null ? undefined : find(name);
  if (!tool) return { ok: false, error: "missing" };
  try {
    const result = await tool.execute("call", params, undefined, undefined, ctx);
    return { ok: true, text: textOf(result) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
const otherName = "mcp__mock_other";
const quoteName = "mcp__mock_quote";
const namespaceName = "mcp__mock";
const deadline = Date.now() + 12_000;
while (!find(otherName) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const names = tools.map((tool) => tool.name);
const searchOther = await run("mcp", { search: "other" });
const activeAfterOtherSearch = [...active];
const otherCall = await run(otherName, {});
const searchQuote = await run("mcp", { search: "quote" });
const activeAfterQuoteSearch = [...active];
const quoteCall = await run(quoteName, {});
const gatewayToolCall = await run("mcp", { tool: otherName, args: {} });
const namespaceCall = await run(namespaceName, { tool: "quote", args: {} });
const managementErrors = [];
for (const params of [
  { action: "install" },
  { action: "auth-start" },
  { action: "auth-complete" },
  { action: "ui-messages" },
  { url: "https://example.invalid/secret" },
  { target: "project" },
  { instructions: "mock" },
]) {
  const outcome = await run("mcp", params);
  managementErrors.push(outcome.ok ? "ALLOWED" : outcome.error);
}
const scriptCall = await run("mcpScript", {});
if (events.session_shutdown) await events.session_shutdown({}, ctx);
console.log(JSON.stringify({
  tools: names,
  commands,
  active,
  quotePresent: names.includes(quoteName),
  otherPresent: names.includes(otherName),
  namespacePresent: names.includes(namespaceName),
  searchOtherText: searchOther.ok ? searchOther.text : null,
  searchOtherError: searchOther.ok ? null : searchOther.error,
  activeAfterOtherSearch,
  otherText: otherCall.ok ? otherCall.text : null,
  otherError: otherCall.ok ? null : otherCall.error,
  searchQuoteText: searchQuote.ok ? searchQuote.text : null,
  searchQuoteError: searchQuote.ok ? null : searchQuote.error,
  activeAfterQuoteSearch,
  quoteText: quoteCall.ok ? quoteCall.text : null,
  quoteError: quoteCall.ok ? null : quoteCall.error,
  gatewayToolCallError: gatewayToolCall.ok ? "ALLOWED" : gatewayToolCall.error,
  namespaceCallError: namespaceCall.ok ? "ALLOWED" : namespaceCall.error,
  managementErrors,
  scriptPresent: names.includes("mcpScript"),
  scriptError: scriptCall.ok ? "ALLOWED" : scriptCall.error,
  hasSessionStart: "session_start" in events,
  hasSessionShutdown: "session_shutdown" in events,
  diagnostics,
}));
`;
}

function runRealAdapter(policy: unknown): RealAdapterRun {
  const realAdapterDirectory = process.env.HITCH_REAL_MCP_ADAPTER_DIR as string;
  const root = mkdtempSync(join(tmpdir(), "hitch-mcp-real-"));
  try {
    chmodSync(root, 0o700);
    const copiedAdapterDirectory = join(root, "pi-mcp-adapter");
    cpSync(realAdapterDirectory, copiedAdapterDirectory, { recursive: true });
    chmodSync(join(copiedAdapterDirectory, "index.ts"), 0o644);
    symlinkSync(
      dirname(realAdapterDirectory),
      join(root, "node_modules"),
      "dir",
    );

    const mockServer = join(root, "synthetic-mcp-stdio.mjs");
    writeFileSync(mockServer, mockStdioServerSource(), { mode: 0o600 });
    chmodSync(mockServer, 0o600);

    const config = join(root, "mcp.json");
    writeFileSync(
      config,
      JSON.stringify({
        settings: { scriptMode: true, toolPrefix: "mcp", directTools: true },
        mcpServers: {
          mock: {
            command: process.execPath,
            args: [mockServer],
            cwd: root,
            env: {},
            inheritEnv: true,
            lifecycle: "eager",
            directTools: true,
          },
        },
      }),
      { mode: 0o600 },
    );
    chmodSync(config, 0o600);

    return execWrapperChild(
      root,
      join(copiedAdapterDirectory, "index.ts"),
      config,
      realAdapterChildScript(wrapper),
      policy,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const REAL_ADAPTER_SKIP =
  process.env.HITCH_REAL_MCP_ADAPTER_DIR === undefined ||
  !existsSync(join(process.env.HITCH_REAL_MCP_ADAPTER_DIR, "index.ts"));

test(
  "real installed pi-mcp-adapter exposes direct tools and rejects the generic gateway call",
  { skip: REAL_ADAPTER_SKIP, timeout: 30_000 },
  () => {
    const result = runRealAdapter({ allow: ["mcp*"] });
    assert.equal(result.hasSessionStart, true);
    assert.equal(result.hasSessionShutdown, true);
    assert.equal(result.scriptPresent, false);
    assert.equal(result.scriptError, "missing");
    assert.deepEqual(result.commands, []);
    assert.equal(result.namespacePresent, false);
    assert.equal(result.quotePresent, true);
    assert.equal(result.otherPresent, true);
    assert.equal(result.searchOtherError, null);
    assert.ok(result.activeAfterOtherSearch.includes("mcp__mock_other"));
    assert.equal(
      result.otherError,
      null,
      `allowed direct MCP tool failed: ${result.otherError}\n${JSON.stringify(result.diagnostics)}`,
    );
    assert.match(result.otherText ?? "", /synthetic_other/u);
    assert.equal(
      result.quoteError,
      null,
      `allowed direct MCP tool failed: ${result.quoteError}\n${JSON.stringify(result.diagnostics)}`,
    );
    assert.match(result.quoteText ?? "", /synthetic_quote/u);
    assert.equal(
      result.gatewayToolCallError,
      "MCP generic tool calls are disabled by Hitch; call the activated direct tool instead",
    );
    assert.equal(result.namespaceCallError, "missing");
    assert.deepEqual(
      result.managementErrors,
      new Array(7).fill("MCP management actions are disabled by Hitch"),
    );
  },
);

test(
  "real adapter deny of one direct tool cannot be reached through gateway, namespace, or late search",
  { skip: REAL_ADAPTER_SKIP, timeout: 30_000 },
  () => {
    const result = runRealAdapter({
      deny: ["mcp__mock_quote"],
    });
    assert.equal(result.scriptPresent, false);
    assert.equal(result.scriptError, "missing");
    assert.deepEqual(result.commands, []);
    assert.equal(result.namespacePresent, false);
    assert.equal(result.quotePresent, false);
    assert.equal(result.otherPresent, true);
    assert.equal(result.searchOtherError, null);
    assert.equal(result.otherError, null);
    assert.match(result.otherText ?? "", /synthetic_other/u);
    assert.equal(result.quoteError, "missing");
    assert.ok(!result.activeAfterQuoteSearch.includes("mcp__mock_quote"));
    assert.equal(
      result.gatewayToolCallError,
      "MCP generic tool calls are disabled by Hitch; call the activated direct tool instead",
    );
    assert.equal(result.namespaceCallError, "missing");
    assert.deepEqual(
      result.managementErrors,
      new Array(7).fill("MCP management actions are disabled by Hitch"),
    );
  },
);
