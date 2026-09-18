import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  waitForAttestation,
  type ControllerContext,
} from "../src/pi/native-runtime.js";

const repository = join(dirname(fileURLToPath(import.meta.url)), "../..");
const assets = join(repository, "dist", "sandbox");

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("web-search runtime assets are staged read-only with their relative closure", () => {
  const extension = join(assets, "pi-web-search.ts");
  const adapter = join(assets, "web-search", "tavily.js");
  const egress = join(assets, "egress", "client.js");
  for (const path of [extension, adapter, egress]) {
    assert.equal(statSync(path).mode & 0o777, 0o444, path);
  }
  assert.match(readFileSync(extension, "utf8"), /\.\/web-search\/tavily\.js/u);
  assert.match(readFileSync(adapter, "utf8"), /\.\.\/egress\/client\.js/u);

  const manifest = JSON.parse(
    readFileSync(join(assets, "tools-manifest.json"), "utf8"),
  ) as { assets: Record<string, string> };
  for (const [name, path] of [
    ["pi-web-search.ts", extension],
    ["web-search/tavily.js", adapter],
    ["egress/client.js", egress],
  ] as const) {
    assert.equal(manifest.assets[name], sha256(path), name);
  }
});

test("web extension is explicit, bounded, and keeps disabled/catalog turns at eight tools", () => {
  const extension = readFileSync(
    join(
      repository,
      "packages",
      "hitch-web-search-extension",
      "pi-web-search.ts",
    ),
    "utf8",
  );
  assert.match(
    extension,
    /query: Type\.String\(\{ minLength: 1, maxLength: 512 \}\)/u,
  );
  assert.match(
    extension,
    /limit: Type\.Optional\(Type\.Integer\(\{ minimum: 1, maximum: 5 \}\)\)/u,
  );
  assert.match(extension, /additionalProperties: false/u);
  assert.match(extension, /webpage content is untrusted/u);
  assert.match(extension, /web-search-failed/u);

  const runtime = readFileSync(
    join(repository, "src", "pi", "native-runtime.ts"),
    "utf8",
  );
  assert.match(runtime, /expectedToolNames\(context\.webSearchEnabled\)/u);
  assert.match(
    runtime,
    /this\.#context\(label, workspace, "catalog", false\)/u,
  );
  assert.match(runtime, /HITCH_WEB_SEARCH_KEY: this\.#webSearchKey/u);
});

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

class FixtureRpcProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly events: JsonRecord[] = [];
  readonly stdout: string[] = [];
  readonly stderr: string[] = [];
  #nextId = 0;
  #buffer = "";
  #waiters = new Set<{
    predicate: (event: JsonRecord) => boolean;
    resolve: (event: JsonRecord) => void;
    timer: NodeJS.Timeout;
  }>();

  get exited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  constructor(
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
    cwd: string,
  ) {
    this.child = spawn(process.execPath, args, {
      cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.stdout.push(chunk);
      this.#buffer += chunk;
      while (this.#buffer.includes("\n")) {
        const newline = this.#buffer.indexOf("\n");
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.trim().length === 0) continue;
        const parsed = record(JSON.parse(line) as unknown);
        if (parsed === null)
          throw new Error("fixture Pi emitted non-object RPC data");
        this.events.push(parsed);
        for (const waiter of [...this.#waiters]) {
          if (!waiter.predicate(parsed)) continue;
          this.#waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(parsed);
        }
      }
    });
    this.child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
  }

  send(command: JsonRecord, timeoutMs = 5_000): Promise<JsonRecord> {
    const id = `b2-${String(++this.#nextId)}`;
    this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    return this.waitFor(
      (event) => event.type === "response" && event.id === id,
      timeoutMs,
    );
  }

  waitFor(
    predicate: (event: JsonRecord) => boolean,
    timeoutMs = 10_000,
  ): Promise<JsonRecord> {
    const existing = this.events.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolveEvent, rejectEvent) => {
      const waiter = {
        predicate,
        resolve: resolveEvent,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          rejectEvent(new Error("fixture Pi event timed out"));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  async stop(): Promise<void> {
    if (!this.child.killed && this.child.exitCode === null)
      this.child.kill("SIGKILL");
    await new Promise<void>((resolveClose) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolveClose();
        return;
      }
      this.child.once("close", () => resolveClose());
    });
    for (const waiter of this.#waiters) clearTimeout(waiter.timer);
    this.#waiters.clear();
  }
}

interface FixtureServer {
  readonly server: ReturnType<typeof createServer>;
  readonly port: number;
  readonly requests: Array<{
    method: string | undefined;
    url: string | undefined;
    authorization: string | undefined;
    body: string;
  }>;
}

async function startFixtureServer(): Promise<FixtureServer> {
  const requests: FixtureServer["requests"] = [];
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          method: request.method,
          url: request.url,
          authorization:
            typeof request.headers.authorization === "string"
              ? request.headers.authorization
              : undefined,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            results: [
              {
                title: "Fixture source",
                url: "https://fixture.invalid/HITCH_B2_SOURCE_SENTINEL",
                content: "HITCH_B2_SOURCE_SENTINEL",
              },
            ],
          }),
        );
      });
    },
  );
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("fixture server did not bind");
  return { server, port: address.port, requests };
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function assetDigest(path: string): string {
  return sha256(path);
}

function userSystemdEnvironment(): NodeJS.ProcessEnv {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("B2 requires a Unix user");
  const runtime = `/run/user/${uid}`;
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
  };
}

function ownSandboxUnits(prefix: string): string[] | null {
  const result = spawnSync(
    "/usr/bin/systemctl",
    [
      "--user",
      "list-units",
      `hitch-p0-${prefix}-*.scope`,
      "--all",
      "--plain",
      "--no-legend",
      "--no-pager",
    ],
    { encoding: "utf8", env: userSystemdEnvironment(), timeout: 5_000 },
  );
  if (result.status !== 0) return null;
  return result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s/u)[0] ?? "")
    .filter((unit) =>
      new RegExp(`^hitch-p0-${prefix}-[a-f0-9]{24}\\.scope$`, "u").test(unit),
    );
}

async function cleanOwnSandboxUnits(prefix: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const units = ownSandboxUnits(prefix);
    if (units === null)
      throw new Error("B2 could not inspect its own sandbox units");
    if (units.length === 0) return;
    for (const unit of units) {
      for (const command of [
        ["--user", "kill", "--kill-whom=all", "--signal=KILL", unit],
        ["--user", "stop", unit],
      ]) {
        spawnSync("/usr/bin/systemctl", command, {
          encoding: "utf8",
          env: userSystemdEnvironment(),
          timeout: 5_000,
        });
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error("B2 own sandbox cleanup did not settle");
}

interface FixtureRun {
  readonly root: string;
  readonly workspace: string;
  readonly inbox: string;
  readonly publishRoot: string;
  readonly log: string;
  readonly controllerNonce: string;
  readonly turnHandle: string;
  readonly userId: string;
  readonly webSearchEnabled: boolean;
  readonly antigravity: boolean;
  readonly activeTools: readonly string[];
  readonly forgePrompt:
    | {
        readonly mode: "replace" | "append" | "prepend";
        readonly systemPrompt: string;
      }
    | undefined;
  readonly providerLog: string;
  readonly refreshLog: string | undefined;
  readonly prefix: string;
  readonly sessionPath: string | undefined;
  readonly context: ControllerContext;
  readonly rpc: FixtureRpcProcess;
  readonly server: FixtureServer;
}

function logEntries(path: string): JsonRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => record(JSON.parse(line) as unknown))
    .filter((entry): entry is JsonRecord => entry !== null);
}

async function launchFixture(
  server: FixtureServer,
  options: {
    readonly web: boolean;
    readonly antigravity?: boolean;
    readonly antigravityMode?: "stream" | "404";
    readonly missingProvider?: boolean;
    readonly registerWeb?: boolean;
    readonly webExtension?: string;
    readonly providerMode?: string;
    readonly activeTools?: readonly string[];
    readonly forgePrompt?: {
      readonly mode: "replace" | "append" | "prepend";
      readonly systemPrompt: string;
    };
    readonly forgePromptRaw?: string;
    readonly sessionPath?: string;
    /** An absolute auth.json shared by independently launched Pi processes. */
    readonly sharedAuth?: string;
    readonly modelsStore?: Record<string, unknown>;
    readonly omitSharedAuthPreload?: boolean;
  },
): Promise<FixtureRun> {
  const root = mkdtempSync(join(tmpdir(), "hitch-b2-rpc-"));
  chmodSync(root, 0o700);
  const data = join(root, "data");
  const profile = join(root, "profile");
  const workspace = join(root, "workspace");
  const inbox = join(root, "inbox");
  const publishRoot = join(root, "publish");
  for (const path of [data, profile, workspace, inbox, publishRoot])
    privateDirectory(path);
  writeFileSync(
    join(profile, "auth.json"),
    options.sharedAuth === undefined
      ? "{}\n"
      : `${JSON.stringify({
          [options.antigravity ? "antigravity" : "hitch-b2-fixture"]: {
            type: "oauth",
            access: options.antigravity
              ? "HITCH_ANTIGRAVITY_PER_USER_OLD_ACCESS"
              : "HITCH_B2_WRONG_ACCESS",
            refresh: options.antigravity
              ? "HITCH_ANTIGRAVITY_PER_USER_OLD_REFRESH"
              : "HITCH_B2_WRONG_REFRESH",
            expires: Date.now() + 60 * 60 * 1000,
            ...(options.antigravity
              ? { projectId: "per-user-old-project" }
              : {}),
          },
        })}\n`,
    { mode: 0o600 },
  );
  if (options.modelsStore !== undefined)
    writeFileSync(
      join(profile, "models-store.json"),
      JSON.stringify(options.modelsStore),
      { mode: 0o600 },
    );
  writeFileSync(join(inbox, "input.txt"), "fixture inbox\n", { mode: 0o600 });
  const log = join(root, "sandbox.log");
  const providerLog = join(root, "provider.log");
  const refreshLog =
    options.sharedAuth === undefined
      ? undefined
      : join(dirname(options.sharedAuth), "refresh.log");
  const prefix = randomBytes(8).toString("hex");
  const turnHandle = randomBytes(16).toString("hex");
  const controllerNonce = randomBytes(16).toString("hex");
  const userId = "b2-fixture-user";
  const webSearchEnabled = options.web;
  const antigravity = options.antigravity === true;
  const baselineTools = [
    "bash",
    "edit",
    "find",
    "grep",
    "hitch_publish",
    "ls",
    "read",
    "write",
    ...(webSearchEnabled ? ["web_search"] : []),
  ].sort();
  const activeTools = [...(options.activeTools ?? baselineTools)].sort();
  const assetsRoot = join(repository, "dist", "sandbox");
  const mandatory = join(assetsRoot, "hitch-sandbox.ts");
  const web = join(assetsRoot, "pi-web-search.ts");
  const provider = join(repository, "test", "fixtures", "provider-fixture.mjs");
  const preload = join(
    repository,
    "test",
    "fixtures",
    antigravity ? "antigravity-network-preload.mjs" : "network-preload.mjs",
  );
  const environment: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    HOME: root,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    PI_CODING_AGENT_DIR: profile,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    HITCH_PI_MODELS_PATH: join(profile, "models.json"),
    HITCH_PI_MODELS_STORE_PATH: join(profile, "models-store.json"),
    NODE_OPTIONS: `--import ${preload}`,
    HITCH_B2_FIXTURE_PORT: String(server.port),
    HITCH_B2_PROVIDER_MODE: options.providerMode ?? "web-search",
    HITCH_B2_PROVIDER_LOG: providerLog,
    ...(antigravity
      ? { HITCH_ANTIGRAVITY_FIXTURE_MODE: options.antigravityMode ?? "stream" }
      : {}),
    ...(options.sharedAuth === undefined
      ? {}
      : {
          HITCH_B2_SHARED_AUTH: "1",
          HITCH_SHARED_AUTH_PATH: options.sharedAuth,
          HITCH_SHARED_AUTH_REQUIRED: "1",
          HITCH_B2_REFRESH_LOG: refreshLog,
        }),
    HITCH_ACTIVE_TOOLS: JSON.stringify(activeTools),
    ...(options.forgePromptRaw !== undefined
      ? { HITCH_FORGE_PROMPT: options.forgePromptRaw }
      : options.forgePrompt === undefined
        ? {}
        : { HITCH_FORGE_PROMPT: JSON.stringify(options.forgePrompt) }),
    HITCH_P0_WORKSPACE: workspace,
    HITCH_P0_INBOX: inbox,
    HITCH_P0_PUBLISH_ROOT: publishRoot,
    HITCH_P0_WORKER: join(assetsRoot, "sandbox-worker.mjs"),
    HITCH_P0_HELPER: join(assetsRoot, "secure-bwrap-helper"),
    HITCH_P0_LOG: log,
    HITCH_P0_TURN_HANDLE: turnHandle,
    HITCH_P0_CONTROLLER_NONCE: controllerNonce,
    HITCH_P0_USER_ID: userId,
    HITCH_P0_EXTENSION_PATH: mandatory,
    HITCH_P0_UNIT_PREFIX: prefix,
    HITCH_P0_WORKER_SHA256: assetDigest(join(assetsRoot, "sandbox-worker.mjs")),
    HITCH_P0_HELPER_SHA256: assetDigest(
      join(assetsRoot, "secure-bwrap-helper"),
    ),
    HITCH_P0_EXTENSION_SHA256: assetDigest(mandatory),
    HITCH_P0_BACKEND_SHA256: assetDigest(
      join(assetsRoot, "sandbox-backend.mjs"),
    ),
  };
  if (antigravity) {
    environment.HITCH_ANTIGRAVITY_ENABLED = "1";
    environment.ANTIGRAVITY_NO_PREWARM = "1";
    environment.HITCH_ANTIGRAVITY_EXTENSION_PATH = join(
      assetsRoot,
      "pi-antigravity.ts",
    );
    environment.HITCH_ANTIGRAVITY_EXTENSION_SHA256 = assetDigest(
      join(assetsRoot, "pi-antigravity.ts"),
    );
  }
  if (options.web) {
    environment.HITCH_WEB_SEARCH_ENABLED = "1";
    environment.HITCH_WEB_SEARCH_KEY = "fixture-key";
    environment.HITCH_WEB_SEARCH_EXTENSION_PATH = web;
    environment.HITCH_WEB_SEARCH_EXTENSION_SHA256 = assetDigest(web);
  }
  const args = [
    ...(options.sharedAuth === undefined ||
    options.omitSharedAuthPreload === true
      ? []
      : ["--import", join(repository, "dist", "src", "pi", "auth-preload.js")]),
    join(
      repository,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    ),
    "--mode",
    "rpc",
    "--offline",
    "--no-extensions",
    "--extension",
    mandatory,
    ...(options.web && options.registerWeb !== false
      ? ["--extension", options.webExtension ?? web]
      : options.webExtension === undefined
        ? []
        : ["--extension", options.webExtension]),
    ...(antigravity
      ? options.missingProvider === true
        ? []
        : ["--extension", join(assetsRoot, "pi-antigravity.ts")]
      : ["--extension", provider]),
    "--no-builtin-tools",
    "--exclude-tools",
    "powershell",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    ...(options.sessionPath === undefined
      ? ["--no-session"]
      : [
          "--session",
          options.sessionPath,
          "--session-dir",
          dirname(options.sessionPath),
        ]),
  ];
  const rpc = new FixtureRpcProcess(args, environment, workspace);
  const context = {
    root,
    workspace,
    inbox,
    publishRoot,
    log,
    controllerNonce,
    turnHandle,
    userId,
    webSearchEnabled,
    activeTools,
    ...(options.forgePrompt === undefined
      ? {}
      : { forgePrompt: options.forgePrompt }),
    ...(options.sharedAuth === undefined ? {} : { sharedAuthRequired: true }),
    ...(antigravity ? { antigravityRequired: true } : {}),
  };
  return {
    root,
    workspace,
    inbox,
    publishRoot,
    log,
    controllerNonce,
    turnHandle,
    userId,
    webSearchEnabled,
    antigravity,
    activeTools,
    forgePrompt: options.forgePrompt,
    providerLog,
    refreshLog,
    prefix,
    sessionPath: options.sessionPath,
    context,
    rpc,
    server,
  };
}

async function stopFixture(run: FixtureRun): Promise<void> {
  await run.rpc.stop();
  await cleanOwnSandboxUnits(run.prefix);
  rmSync(run.root, { recursive: true, force: true });
}

function directoryText(path: string): string {
  let text = "";
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) text += directoryText(child);
    else if (entry.isFile()) text += readFileSync(child, "utf8");
  }
  return text;
}

function assertNoSecret(run: FixtureRun, secret: string): void {
  const text = [
    ...run.rpc.stdout,
    ...run.rpc.stderr,
    existsSync(run.log) ? readFileSync(run.log, "utf8") : "",
    existsSync(run.providerLog) ? readFileSync(run.providerLog, "utf8") : "",
    run.refreshLog !== undefined && existsSync(run.refreshLog)
      ? readFileSync(run.refreshLog, "utf8")
      : "",
    directoryText(run.workspace),
  ].join("\n");
  assert.doesNotMatch(text, new RegExp(secret, "u"));
}

test(
  "B2 real RPC shares OAuth credentials across isolated controllers and sandboxes",
  { skip: process.env.HITCH_RUN_SANDBOX_TESTS !== "1", timeout: 180_000 },
  async () => {
    const server = await startFixtureServer();
    const sharedRoot = mkdtempSync(join(tmpdir(), "hitch-b2-shared-auth-"));
    privateDirectory(sharedRoot);
    const sharedAuth = join(sharedRoot, "auth.json");
    const refreshLog = join(sharedRoot, "refresh.log");
    writeFileSync(
      sharedAuth,
      `${JSON.stringify({
        "hitch-b2-fixture": {
          type: "oauth",
          access: "HITCH_B2_DUMMY_ACCESS_EXPIRED",
          refresh: "HITCH_B2_DUMMY_REFRESH",
          expires: 0,
        },
      })}\n`,
      { mode: 0o600 },
    );
    chmodSync(sharedAuth, 0o600);
    const sessionRoot = mkdtempSync(join(tmpdir(), "hitch-b2-auth-sessions-"));
    privateDirectory(sessionRoot);
    const runs: FixtureRun[] = [];
    const launchOne = launchFixture(server, {
      web: false,
      providerMode: "shared-auth",
      sharedAuth,
      sessionPath: join(sessionRoot, "one.jsonl"),
    });
    const launchTwo = launchFixture(server, {
      web: false,
      providerMode: "shared-auth",
      sharedAuth,
      sessionPath: join(sessionRoot, "two.jsonl"),
    });
    try {
      const launched = await Promise.allSettled([launchOne, launchTwo]);
      for (const result of launched) {
        if (result.status === "fulfilled") runs.push(result.value);
      }
      for (const result of launched) {
        if (result.status === "rejected") throw result.reason;
      }
      assert.equal(runs.length, 2);
      await Promise.all(
        runs.map((run) => waitForAttestation(run.rpc, run.context)),
      );
      for (const run of runs) {
        const attestation = logEntries(run.log).find(
          (entry) => entry.type === "startup-attestation",
        );
        assert.ok(attestation);
        assert.equal(attestation.sharedAuth, true);
        const available = await run.rpc.send({ type: "get_available_models" });
        assert.equal(available.success, true);
        const models = record(available.data)?.models;
        assert.ok(Array.isArray(models));
        assert.ok(
          models.some(
            (item) =>
              record(item)?.provider === "hitch-b2-fixture" &&
              record(item)?.id === "b2-web-search",
          ),
        );
        const perUserAuth = JSON.parse(
          readFileSync(join(run.root, "profile", "auth.json"), "utf8"),
        )["hitch-b2-fixture"];
        assert.equal(perUserAuth.access, "HITCH_B2_WRONG_ACCESS");
        assert.equal(perUserAuth.refresh, "HITCH_B2_WRONG_REFRESH");
      }

      await Promise.all(
        runs.map(async (run) => {
          assert.equal(
            (
              await run.rpc.send({
                type: "set_model",
                provider: "hitch-b2-fixture",
                modelId: "b2-web-search",
              })
            ).success,
            true,
          );
          assert.equal(
            (
              await run.rpc.send({
                type: "prompt",
                message: "shared OAuth fixture prompt",
              })
            ).success,
            true,
          );
        }),
      );
      await Promise.all(
        runs.map((run) =>
          run.rpc.waitFor((event) => event.type === "agent_settled", 30_000),
        ),
      );
      for (const run of runs) {
        assert.equal(
          record((await run.rpc.send({ type: "get_last_assistant_text" })).data)
            ?.text,
          "HITCH_B2_SHARED_AUTH_SETTLED",
        );
        assert.ok(
          logEntries(run.providerLog).some(
            (entry) => entry.sharedAuthApiKeyValid === true,
          ),
        );
      }
      assert.equal(
        existsSync(refreshLog)
          ? readFileSync(refreshLog, "utf8")
              .split("\n")
              .filter((line) => line === "refreshed").length
          : 0,
        1,
      );
      const savedAuth = JSON.parse(readFileSync(sharedAuth, "utf8"))[
        "hitch-b2-fixture"
      ];
      assert.equal(savedAuth.access, "HITCH_B2_DUMMY_ACCESS_REFRESHED");
      assert.equal(savedAuth.refresh, "HITCH_B2_DUMMY_REFRESH_ROTATED");

      const parentPid = runs[0]?.rpc.child.pid;
      assert.ok(parentPid !== undefined);
      const probe = await runs[0]!.rpc.send({
        type: "bash",
        command: [
          `if [ -r ${JSON.stringify(sharedAuth)} ]; then exit 41; fi`,
          'if [ -n "$HITCH_SHARED_AUTH_PATH" ]; then exit 42; fi',
          "if env | /usr/bin/grep -Eq 'HITCH_B2_DUMMY_(ACCESS|REFRESH)'; then exit 43; fi",
          `if [ -e /proc/${parentPid} ]; then exit 44; fi`,
          "printf HITCH_B2_SHARED_AUTH_SANDBOX_PROBE_OK",
        ].join("; "),
      });
      assert.equal(probe.success, true);
      assert.equal(record(probe.data)?.exitCode, 0);
      assert.equal(
        record(probe.data)?.output,
        "HITCH_B2_SHARED_AUTH_SANDBOX_PROBE_OK",
      );

      for (const run of runs) {
        assertNoSecret(run, "HITCH_B2_DUMMY_ACCESS_EXPIRED");
        assertNoSecret(run, "HITCH_B2_DUMMY_ACCESS_REFRESHED");
        assertNoSecret(run, "HITCH_B2_DUMMY_REFRESH");
      }
      await Promise.all(runs.splice(0).map((run) => stopFixture(run)));
      const third = await launchFixture(server, {
        web: false,
        providerMode: "shared-auth",
        sharedAuth,
        sessionPath: join(sessionRoot, "three.jsonl"),
      });
      runs.push(third);
      await waitForAttestation(third.rpc, third.context);
      assert.equal(
        (
          await third.rpc.send({
            type: "set_model",
            provider: "hitch-b2-fixture",
            modelId: "b2-web-search",
          })
        ).success,
        true,
      );
      assert.equal(
        (await third.rpc.send({ type: "prompt", message: "fresh reuse" }))
          .success,
        true,
      );
      await third.rpc.waitFor(
        (event) => event.type === "agent_settled",
        30_000,
      );
      assert.equal(
        record((await third.rpc.send({ type: "get_last_assistant_text" })).data)
          ?.text,
        "HITCH_B2_SHARED_AUTH_SETTLED",
      );
      assert.equal(
        readFileSync(refreshLog, "utf8")
          .split("\n")
          .filter((line) => line === "refreshed").length,
        1,
      );
      for (const run of runs) {
        assertNoSecret(run, "HITCH_B2_DUMMY_ACCESS_EXPIRED");
        assertNoSecret(run, "HITCH_B2_DUMMY_ACCESS_REFRESHED");
        assertNoSecret(run, "HITCH_B2_DUMMY_REFRESH");
      }
    } finally {
      for (const run of runs) await stopFixture(run);
      rmSync(sessionRoot, { recursive: true, force: true });
      rmSync(sharedRoot, { recursive: true, force: true });
      server.server.close();
    }
  },
);

test(
  "Antigravity fixture uses the pinned provider, shared OAuth, and a real sandbox tool loop",
  { skip: process.env.HITCH_RUN_SANDBOX_TESTS !== "1", timeout: 120_000 },
  async () => {
    const server = await startFixtureServer();
    const sharedRoot = mkdtempSync(join(tmpdir(), "hitch-antigravity-auth-"));
    privateDirectory(sharedRoot);
    const sharedAuth = join(sharedRoot, "auth.json");
    writeFileSync(
      sharedAuth,
      `${JSON.stringify({
        antigravity: {
          type: "oauth",
          access: "HITCH_ANTIGRAVITY_ACCESS_EXPIRED",
          refresh: "HITCH_ANTIGRAVITY_REFRESH",
          expires: 0,
          projectId: "fixture-project",
        },
      })}\n`,
      { mode: 0o600 },
    );
    const run = await launchFixture(server, {
      web: false,
      antigravity: true,
      sharedAuth,
    });
    writeFileSync(
      join(run.workspace, "HITCH_ANTIGRAVITY_READ_SENTINEL"),
      "HITCH_ANTIGRAVITY_READ_SENTINEL\n",
      { mode: 0o600 },
    );
    try {
      await waitForAttestation(run.rpc, run.context);
      assert.equal(
        logEntries(run.log).find((e) => e.type === "startup-attestation")
          ?.antigravity,
        true,
      );
      assert.equal(run.antigravity, true);
      assert.equal(logEntries(run.providerLog).length, 0);

      const available = await run.rpc.send({ type: "get_available_models" });
      assert.equal(available.success, true);
      const models = record(available.data)?.models;
      assert.ok(Array.isArray(models));
      const antigravityModel = models.find(
        (item) =>
          record(item)?.provider === "antigravity" &&
          record(item)?.id === "gemini-3.8-flash",
      );
      assert.ok(antigravityModel);
      assert.deepEqual(record(antigravityModel)?.thinkingLevelMap, {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
        max: null,
      });
      assert.deepEqual(
        record(
          (await run.rpc.send({ type: "get_available_thinking_levels" })).data,
        )?.levels,
        ["low", "medium", "high"],
      );

      assert.equal(
        (
          await run.rpc.send({
            type: "set_model",
            provider: "antigravity",
            modelId: "gemini-3.8-flash",
          })
        ).success,
        true,
      );
      const thinking = await run.rpc.send({
        type: "set_thinking_level",
        level: "low",
      });
      assert.equal(thinking.success, true);
      assert.deepEqual(
        record(
          (await run.rpc.send({ type: "get_available_thinking_levels" })).data,
        )?.levels,
        ["low", "medium", "high"],
      );
      assert.equal(
        (
          await run.rpc.send({
            type: "prompt",
            message: "read the fixture marker",
          })
        ).success,
        true,
      );
      await run.rpc.waitFor((event) => event.type === "agent_settled", 30_000);
      const readEnd = run.rpc.events.find(
        (event) =>
          event.type === "tool_execution_end" && event.toolName === "read",
      );
      assert.ok(
        readEnd,
        JSON.stringify({
          observations: logEntries(run.providerLog),
          errors: run.rpc.events
            .filter((e) => e.type === "message_end")
            .map((e) => record(e.message)?.errorMessage),
        }),
      );
      assert.equal(readEnd.isError, false);
      assert.equal(
        record((await run.rpc.send({ type: "get_last_assistant_text" })).data)
          ?.text,
        "HITCH_ANTIGRAVITY_STREAM_TOOL_LOOP_SETTLED",
      );

      const observations = logEntries(run.providerLog);
      assert.deepEqual(
        observations.map((entry) => ({
          kind: entry.kind,
          tokenValid: entry.tokenValid,
          model: entry.model,
          toolSeen: entry.toolSeen,
        })),
        [
          {
            kind: "token",
            tokenValid: true,
            model: undefined,
            toolSeen: undefined,
          },
          {
            kind: "stream",
            tokenValid: true,
            model: "gemini-3.8-flash-tiered",
            toolSeen: false,
          },
          {
            kind: "stream",
            tokenValid: true,
            model: "gemini-3.8-flash-tiered",
            toolSeen: true,
          },
        ],
      );
      for (const entry of observations) {
        assert.deepEqual(
          Object.keys(entry).sort(),
          [
            "kind",
            ...(entry.kind === "token"
              ? ["tokenValid"]
              : ["model", "tokenValid", "toolSeen"]),
          ].sort(),
        );
      }
      const saved = JSON.parse(readFileSync(sharedAuth, "utf8")).antigravity;
      assert.equal(saved.access, "HITCH_ANTIGRAVITY_ACCESS_REFRESHED");
      assert.equal(saved.refresh, "HITCH_ANTIGRAVITY_REFRESH_ROTATED");
      assert.equal(saved.projectId, "fixture-project");
      assert.equal(
        JSON.parse(readFileSync(join(run.root, "profile", "auth.json"), "utf8"))
          .antigravity.access,
        "HITCH_ANTIGRAVITY_PER_USER_OLD_ACCESS",
      );
      assert.equal(server.requests.length, 0);
      for (const secret of [
        "HITCH_ANTIGRAVITY_ACCESS_EXPIRED",
        "HITCH_ANTIGRAVITY_ACCESS_REFRESHED",
        "HITCH_ANTIGRAVITY_REFRESH",
        "HITCH_ANTIGRAVITY_REFRESH_ROTATED",
      ])
        assertNoSecret(run, secret);
    } finally {
      await stopFixture(run);
      rmSync(sharedRoot, { recursive: true, force: true });
      server.server.close();
    }
  },
);

test(
  "Antigravity required launch fails closed when its provider attestation is absent",
  { skip: process.env.HITCH_RUN_SANDBOX_TESTS !== "1", timeout: 45_000 },
  async () => {
    const server = await startFixtureServer();
    const root = mkdtempSync(join(tmpdir(), "hitch-antigravity-missing-"));
    privateDirectory(root);
    const auth = join(root, "auth.json");
    writeFileSync(
      auth,
      `${JSON.stringify({
        antigravity: {
          type: "oauth",
          access: "HITCH_ANTIGRAVITY_ACCESS_VALID",
          refresh: "HITCH_ANTIGRAVITY_REFRESH",
          expires: Date.now() + 60 * 60 * 1000,
          projectId: "fixture-project",
        },
      })}\n`,
      { mode: 0o600 },
    );
    const run = await launchFixture(server, {
      web: false,
      antigravity: true,
      missingProvider: true,
      sharedAuth: auth,
    });
    try {
      await assert.rejects(
        waitForAttestation(run.rpc, run.context),
        /startup attestation (is missing|did not arrive)/u,
      );
      assert.equal(logEntries(run.providerLog).length, 0);
    } finally {
      await stopFixture(run);
      rmSync(root, { recursive: true, force: true });
      server.server.close();
    }
  },
);

test(
  "Antigravity 3.8 404 reports an error without requesting the forbidden 3.7 fallback",
  { skip: process.env.HITCH_RUN_SANDBOX_TESTS !== "1", timeout: 120_000 },
  async () => {
    const server = await startFixtureServer();
    const root = mkdtempSync(join(tmpdir(), "hitch-antigravity-404-"));
    privateDirectory(root);
    const auth = join(root, "auth.json");
    writeFileSync(
      auth,
      `${JSON.stringify({
        antigravity: {
          type: "oauth",
          access: "HITCH_ANTIGRAVITY_ACCESS_VALID",
          refresh: "HITCH_ANTIGRAVITY_REFRESH",
          expires: Date.now() + 60 * 60 * 1000,
          projectId: "fixture-project",
        },
      })}\n`,
      { mode: 0o600 },
    );
    const run = await launchFixture(server, {
      web: false,
      antigravity: true,
      antigravityMode: "404",
      sharedAuth: auth,
    });
    try {
      await waitForAttestation(run.rpc, run.context);
      assert.equal(
        (
          await run.rpc.send({
            type: "set_model",
            provider: "antigravity",
            modelId: "gemini-3.8-flash",
          })
        ).success,
        true,
      );
      assert.equal(
        (await run.rpc.send({ type: "set_thinking_level", level: "low" }))
          .success,
        true,
      );
      assert.equal(
        (await run.rpc.send({ type: "prompt", message: "404 fixture" }))
          .success,
        true,
      );
      await run.rpc.waitFor((event) => event.type === "agent_settled", 30_000);
      const streams = logEntries(run.providerLog).filter(
        (entry) => entry.kind === "stream",
      );
      assert.ok(
        streams.length >= 1,
        JSON.stringify({
          observations: logEntries(run.providerLog),
          errors: run.rpc.events
            .filter((e) => e.type === "message_end")
            .map((e) => record(e.message)?.errorMessage),
        }),
      );
      assert.ok(
        streams.every((entry) => entry.model === "gemini-3.8-flash-tiered"),
      );
      assert.equal(
        streams.some((entry) => entry.model === "gemini-3.7-flash-tiered"),
        false,
      );
      assert.ok(
        run.rpc.events.some(
          (event) =>
            event.type === "message_end" &&
            record(event.message)?.stopReason === "error",
        ),
      );
      assert.equal(server.requests.length, 0);
    } finally {
      await stopFixture(run);
      rmSync(root, { recursive: true, force: true });
      server.server.close();
    }
  },
);

test(
  "B2 real pinned Pi RPC performs web_search through production egress and settles",
  { skip: process.env.HITCH_RUN_SANDBOX_TESTS !== "1", timeout: 120_000 },
  async () => {
    const server = await startFixtureServer();
    const run = await launchFixture(server, { web: true });
    try {
      await waitForAttestation(run.rpc, run.context);
      const entries = logEntries(run.log);
      const mandatory = entries.find(
        (entry) => entry.type === "startup-attestation",
      );
      const web = entries.find(
        (entry) => entry.type === "web-search-attestation",
      );
      assert.ok(mandatory);
      assert.ok(web);
      const expectedTools = [
        "bash",
        "edit",
        "find",
        "grep",
        "hitch_publish",
        "ls",
        "read",
        "web_search",
        "write",
      ];
      assert.deepEqual(web.allTools, expectedTools);
      assert.deepEqual(web.activeTools, expectedTools);
      assert.deepEqual(
        web.sourcePaths,
        expectedTools.map((name) =>
          name === "web_search"
            ? join(repository, "dist", "sandbox", "pi-web-search.ts")
            : join(repository, "dist", "sandbox", "hitch-sandbox.ts"),
        ),
      );
      assert.equal(
        web.sourcePath,
        join(repository, "dist", "sandbox", "pi-web-search.ts"),
      );
      assert.equal(
        web.extensionDigest,
        assetDigest(join(repository, "dist", "sandbox", "pi-web-search.ts")),
      );
      assert.deepEqual(mandatory.allTools, [
        "bash",
        "edit",
        "find",
        "grep",
        "hitch_publish",
        "ls",
        "read",
        "web_search",
        "write",
      ]);
      assert.equal(mandatory.webSearchEnabled, true);

      const modelResponse = await run.rpc.send({
        type: "set_model",
        provider: "hitch-b2-fixture",
        modelId: "b2-web-search",
      });
      assert.equal(modelResponse.success, true);
      const promptResponse = await run.rpc.send({
        type: "prompt",
        message: "perform the fixture search",
      });
      assert.equal(promptResponse.success, true);
      await run.rpc.waitFor((event) => event.type === "agent_settled", 30_000);
      const toolEnd = run.rpc.events.find(
        (event) =>
          event.type === "tool_execution_end" &&
          event.toolName === "web_search",
      );
      assert.ok(toolEnd);
      const result = record(toolEnd.result);
      assert.ok(result);
      assert.equal(toolEnd.isError, false);
      const content = Array.isArray(result.content) ? result.content : [];
      assert.match(JSON.stringify(content), /HITCH_B2_SOURCE_SENTINEL/u);
      const finalText = await run.rpc.send({ type: "get_last_assistant_text" });
      assert.equal(
        record(finalText.data)?.text,
        "HITCH_B2_WEB_RESULT_SENTINEL",
      );
      assert.equal(server.requests.length, 1);
      const request = server.requests[0];
      assert.equal(request?.method, "POST");
      assert.equal(request?.url, "/search");
      assert.equal(request?.authorization, "Bearer fixture-key");
      assert.deepEqual(JSON.parse(request?.body ?? "{}"), {
        query: "fixture query",
        max_results: 1,
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false,
      });
      assertNoSecret(run, "fixture-key");
    } finally {
      await stopFixture(run);
      server.server.close();
    }
  },
);

test(
  "B2 disabled RPC keeps eight tools and an unknown web tool never reaches egress",
  { skip: process.env.HITCH_RUN_SANDBOX_TESTS !== "1", timeout: 120_000 },
  async () => {
    const server = await startFixtureServer();
    const run = await launchFixture(server, {
      web: false,
      providerMode: "unknown-web",
    });
    try {
      await waitForAttestation(run.rpc, run.context);
      const entries = logEntries(run.log);
      assert.equal(
        entries.some((entry) => entry.type === "web-search-attestation"),
        false,
      );
      const mandatory = entries.find(
        (entry) => entry.type === "startup-attestation",
      );
      assert.deepEqual(mandatory?.allTools, [
        "bash",
        "edit",
        "find",
        "grep",
        "hitch_publish",
        "ls",
        "read",
        "write",
      ]);
      assert.equal(mandatory?.webSearchEnabled, false);
      assert.equal(
        (
          await run.rpc.send({
            type: "set_model",
            provider: "hitch-b2-fixture",
            modelId: "b2-web-search",
          })
        ).success,
        true,
      );
      assert.equal(
        (
          await run.rpc.send({
            type: "prompt",
            message: "try the unavailable web tool",
          })
        ).success,
        true,
      );
      await run.rpc.waitFor((event) => event.type === "agent_settled", 30_000);
      const final = await run.rpc.send({ type: "get_last_assistant_text" });
      assert.equal(record(final.data)?.text, "HITCH_B2_DISABLED_UNKNOWN_TOOL");
      assert.equal(server.requests.length, 0);
    } finally {
      await stopFixture(run);
      server.server.close();
    }
  },
);

test(
  "Mode A real RPC compiles a full allowlist and preserves replace/append/prepend prompt order",
  { skip: process.env.HITCH_RUN_SANDBOX_TESTS !== "1", timeout: 120_000 },
  async () => {
    const server = await startFixtureServer();
    const baseline = [
      "bash",
      "edit",
      "find",
      "grep",
      "hitch_publish",
      "ls",
      "read",
      "write",
    ];
    const cases = ["replace", "append", "prepend"] as const;
    try {
      for (const mode of cases) {
        const prompt = `HITCH_MODE_A_PROMPT_SENTINEL ${mode}`;
        const run = await launchFixture(server, {
          web: false,
          providerMode: `mode-a-${mode}`,
          activeTools: baseline,
          forgePrompt: { mode, systemPrompt: prompt },
        });
        try {
          await waitForAttestation(run.rpc, run.context);
          const attestation = logEntries(run.log).find(
            (entry) => entry.type === "startup-attestation",
          );
          assert.deepEqual(attestation?.activeTools, baseline);
          assert.deepEqual(attestation?.allTools, baseline);
          assert.equal(
            (
              await run.rpc.send({
                type: "set_model",
                provider: "hitch-b2-fixture",
                modelId: "b2-web-search",
              })
            ).success,
            true,
          );
          assert.equal(
            (
              await run.rpc.send({
                type: "prompt",
                message: `check Mode A ${mode}`,
              })
            ).success,
            true,
          );
          await run.rpc.waitFor(
            (event) => event.type === "agent_settled",
            30_000,
          );
          const final = await run.rpc.send({ type: "get_last_assistant_text" });
          assert.equal(
            record(final.data)?.text,
            "HITCH_MODE_A_PROMPT_PROVIDER_SENTINEL",
          );
          const observations = logEntries(run.providerLog);
          assert.equal(observations.length, 1);
          const observation = observations[0];
          assert.equal(observation?.promptHasSentinel, true);
          assert.equal(observation?.toolNamesExact, true);
          assert.deepEqual(observation?.toolNames, baseline);
          assert.equal(observation?.promptShape, mode);
          assert.equal(
            observation?.promptOrder,
            mode === "replace"
              ? "replace"
              : mode === "append"
                ? "default-before-forge"
                : "forge-before-default",
          );
          assert.equal(observation?.promptIsExactForge, mode === "replace");
          assert.equal(
            observation?.promptStartsWithForge,
            mode === "prepend" || mode === "replace",
          );
          assert.equal(
            observation?.promptEndsWithForge,
            mode === "append" || mode === "replace",
          );
          assert.doesNotMatch(
            readFileSync(run.providerLog, "utf8"),
            /HITCH_MODE_A_PROMPT_SENTINEL (replace|append|prepend)/u,
          );
          assert.equal(server.requests.length, 0);
        } finally {
          await stopFixture(run);
        }
      }
    } finally {
      server.server.close();
    }
  },
);

test(
  "Mode A real RPC denies web_search and bash despite provider tool calls",
  { skip: process.env.HITCH_RUN_SANDBOX_TESTS !== "1", timeout: 120_000 },
  async () => {
    const server = await startFixtureServer();
    const marker = "HITCH_MODE_A_MUTATION_HOST_EXECUTED";
    const run = await launchFixture(server, {
      web: true,
      providerMode: "mode-a-disabled-tools",
      activeTools: ["read"],
      forgePrompt: {
        mode: "replace",
        systemPrompt: "HITCH_MODE_A_PROMPT_SENTINEL disabled",
      },
    });
    try {
      await waitForAttestation(run.rpc, run.context);
      assert.equal(
        (
          await run.rpc.send({
            type: "set_model",
            provider: "hitch-b2-fixture",
            modelId: "b2-web-search",
          })
        ).success,
        true,
      );
      assert.equal(
        (
          await run.rpc.send({
            type: "prompt",
            message: "try both disabled tools",
          })
        ).success,
        true,
      );
      await run.rpc.waitFor((event) => event.type === "agent_settled", 30_000);
      const executions = run.rpc.events.filter(
        (event) => event.type === "tool_execution_end",
      );
      assert.deepEqual(
        executions.map((event) => event.toolName),
        ["web_search", "bash"],
      );
      for (const execution of executions) {
        assert.equal(execution.isError, true);
        assert.match(
          JSON.stringify(execution.result),
          /sandbox-failed|disabled|not found/u,
        );
      }
      assert.equal(
        record((await run.rpc.send({ type: "get_last_assistant_text" })).data)
          ?.text,
        "HITCH_MODE_A_DISABLED_TOOLS_SETTLED",
      );
      assert.equal(existsSync(join(run.workspace, marker)), false);
      assert.equal(server.requests.length, 0);
      assert.ok(
        logEntries(run.providerLog).every((entry) => entry.valid === true),
      );
    } finally {
      await stopFixture(run);
      server.server.close();
    }
  },
);

test(
  "Mode A disabled RPC bash returns exit 125 and cannot touch the host workspace",
  { skip: process.env.HITCH_RUN_SANDBOX_TESTS !== "1", timeout: 120_000 },
  async () => {
    const server = await startFixtureServer();
    const run = await launchFixture(server, {
      web: false,
      providerMode: "mode-a-rpc-bash",
      activeTools: [],
      forgePrompt: {
        mode: "replace",
        systemPrompt: "HITCH_MODE_A_PROMPT_SENTINEL rpc",
      },
    });
    try {
      await waitForAttestation(run.rpc, run.context);
      const response = await run.rpc.send({
        type: "bash",
        command: "touch HITCH_MODE_A_MUTATION_HOST_EXECUTED",
      });
      assert.equal(response.success, true);
      assert.equal(record(response.data)?.exitCode, 125);
      assert.equal(
        existsSync(join(run.workspace, "HITCH_MODE_A_MUTATION_HOST_EXECUTED")),
        false,
      );
      assert.equal(server.requests.length, 0);
    } finally {
      await stopFixture(run);
      server.server.close();
    }
  },
);

test(
  "Mode A re-injects the same compiled selection into two fresh Pi processes on one JSONL session",
  { skip: process.env.HITCH_RUN_SANDBOX_TESTS !== "1", timeout: 120_000 },
  async () => {
    const server = await startFixtureServer();
    const sessionRoot = mkdtempSync(join(tmpdir(), "hitch-mode-a-session-"));
    privateDirectory(sessionRoot);
    const sessionPath = join(sessionRoot, "selection.jsonl");
    const selection = {
      mode: "replace" as const,
      systemPrompt: "HITCH_MODE_A_PROMPT_SENTINEL session",
    };
    const runs: FixtureRun[] = [];
    try {
      const first = await launchFixture(server, {
        web: false,
        providerMode: "mode-a-session",
        activeTools: ["read", "write"],
        forgePrompt: selection,
        sessionPath,
      });
      runs.push(first);
      await waitForAttestation(first.rpc, first.context);
      assert.equal(
        (
          await first.rpc.send({
            type: "set_model",
            provider: "hitch-b2-fixture",
            modelId: "b2-web-search",
          })
        ).success,
        true,
      );
      assert.equal(
        (
          await first.rpc.send({
            type: "prompt",
            message: "session first turn",
          })
        ).success,
        true,
      );
      await first.rpc.waitFor(
        (event) => event.type === "agent_settled",
        30_000,
      );
      const firstJsonl = readFileSync(sessionPath, "utf8");
      assert.ok(firstJsonl.length > 0);
      const firstObservation = logEntries(first.providerLog)[0];
      assert.equal(firstObservation?.valid, true);
      await first.rpc.stop();
      await cleanOwnSandboxUnits(first.prefix);

      const second = await launchFixture(server, {
        web: false,
        providerMode: "mode-a-session",
        activeTools: ["read", "write"],
        forgePrompt: selection,
        sessionPath,
      });
      runs.push(second);
      await waitForAttestation(second.rpc, second.context);
      assert.equal(
        (
          await second.rpc.send({
            type: "set_model",
            provider: "hitch-b2-fixture",
            modelId: "b2-web-search",
          })
        ).success,
        true,
      );
      assert.equal(
        (
          await second.rpc.send({
            type: "prompt",
            message: "session second turn",
          })
        ).success,
        true,
      );
      await second.rpc.waitFor(
        (event) => event.type === "agent_settled",
        30_000,
      );
      const secondJsonl = readFileSync(sessionPath, "utf8");
      assert.ok(secondJsonl.startsWith(firstJsonl));
      const secondObservation = logEntries(second.providerLog)[0];
      assert.equal(secondObservation?.valid, true);
      assert.deepEqual(
        {
          toolNames: secondObservation?.toolNames,
          promptShape: secondObservation?.promptShape,
          promptOrder: secondObservation?.promptOrder,
          promptHasSentinel: secondObservation?.promptHasSentinel,
          toolNamesExact: secondObservation?.toolNamesExact,
        },
        {
          toolNames: firstObservation?.toolNames,
          promptShape: firstObservation?.promptShape,
          promptOrder: firstObservation?.promptOrder,
          promptHasSentinel: firstObservation?.promptHasSentinel,
          toolNamesExact: firstObservation?.toolNamesExact,
        },
      );
    } finally {
      for (const run of runs) await stopFixture(run);
      rmSync(sessionRoot, { recursive: true, force: true });
      server.server.close();
    }
  },
);

test(
  "Mode A execute gate rejects a provider extension restoring the baseline after startup",
  { skip: process.env.HITCH_RUN_SANDBOX_TESTS !== "1", timeout: 120_000 },
  async () => {
    const server = await startFixtureServer();
    const marker = "HITCH_MODE_A_MUTATION_HOST_EXECUTED";
    const run = await launchFixture(server, {
      web: true,
      providerMode: "mode-a-mutation",
      activeTools: ["read"],
      forgePrompt: {
        mode: "replace",
        systemPrompt: "HITCH_MODE_A_PROMPT_SENTINEL mutation",
      },
    });
    try {
      await waitForAttestation(run.rpc, run.context);
      assert.equal(
        (
          await run.rpc.send({
            type: "set_model",
            provider: "hitch-b2-fixture",
            modelId: "b2-web-search",
          })
        ).success,
        true,
      );
      assert.equal(
        (
          await run.rpc.send({
            type: "prompt",
            message: "mutation must not execute",
          })
        ).success,
        true,
      );
      await run.rpc.waitFor((event) => event.type === "agent_settled", 30_000);
      const toolEnd = run.rpc.events.find(
        (event) =>
          event.type === "tool_execution_end" && event.toolName === "bash",
      );
      assert.ok(toolEnd);
      assert.equal(toolEnd.isError, true);
      assert.match(
        JSON.stringify(toolEnd.result),
        /sandbox-failed|disabled|not found/u,
      );
      assert.equal(existsSync(join(run.workspace, marker)), false);
      assert.equal(server.requests.length, 0);
    } finally {
      await stopFixture(run);
      server.server.close();
    }
  },
);

test(
  "Mode A malformed HITCH_FORGE_PROMPT never produces startup attestation",
  { skip: process.env.HITCH_RUN_SANDBOX_TESTS !== "1", timeout: 120_000 },
  async () => {
    const server = await startFixtureServer();
    const run = await launchFixture(server, {
      web: false,
      providerMode: "mode-a-replace",
      activeTools: ["read"],
      forgePromptRaw: "{not-json",
    });
    try {
      await assert.rejects(waitForAttestation(run.rpc, run.context));
      assert.equal(
        logEntries(run.log).some(
          (entry) => entry.type === "startup-attestation",
        ),
        false,
      );
      assert.equal(server.requests.length, 0);
    } finally {
      await stopFixture(run);
      server.server.close();
    }
  },
);

test(
  "B2 web attestation rejects a wrong source and a missing web registration before prompting",
  { skip: process.env.HITCH_RUN_SANDBOX_TESTS !== "1", timeout: 120_000 },
  async () => {
    const server = await startFixtureServer();
    try {
      for (const scenario of ["wrong", "missing"] as const) {
        const wrong = join(
          repository,
          "test",
          "fixtures",
          "wrong-web-extension.mjs",
        );
        const run = await launchFixture(server, {
          web: true,
          ...(scenario === "wrong"
            ? { webExtension: wrong }
            : { registerWeb: false }),
        });
        try {
          await assert.rejects(waitForAttestation(run.rpc, run.context));
          assert.equal(server.requests.length, 0);
        } finally {
          await stopFixture(run);
        }
      }
    } finally {
      server.server.close();
    }
  },
);

test(
  "Mode A valid empty rendering explicitly preserves Pi base without widening tools",
  { skip: process.env.HITCH_RUN_SANDBOX_TESTS !== "1", timeout: 30000 },
  async () => {
    const server = await startFixtureServer();
    const run = await launchFixture(server, {
      web: false,
      providerMode: "mode-a-empty",
      activeTools: ["read"],
      forgePrompt: { mode: "replace", systemPrompt: "   " },
    });
    try {
      await waitForAttestation(run.rpc, run.context);
      assert.equal(
        (
          await run.rpc.send({
            type: "set_model",
            provider: "hitch-b2-fixture",
            modelId: "b2-web-search",
          })
        ).success,
        true,
      );
      assert.equal(
        (
          await run.rpc.send({
            type: "prompt",
            message: "check valid empty rendering",
          })
        ).success,
        true,
      );
      await run.rpc.waitFor((e) => e.type === "agent_settled", 10000);
      const observed = logEntries(run.providerLog)[0];
      assert.equal(observed?.valid, true);
      assert.equal(observed?.defaultPromptPresent, true);
      assert.deepEqual(observed?.toolNames, ["read"]);
      assert.equal(server.requests.length, 0);
    } finally {
      await stopFixture(run);
      server.server.close();
    }
  },
);

test(
  "shared auth required: missing bootstrap or invalid authority never passes host attestation",
  { skip: process.env.HITCH_RUN_SANDBOX_TESTS !== "1", timeout: 45000 },
  async () => {
    const server = await startFixtureServer();
    const root = mkdtempSync(join(tmpdir(), "hitch-auth-negative-"));
    privateDirectory(root);
    const auth = join(root, "auth.json");
    writeFileSync(auth, "{}", { mode: 0o600 });
    try {
      for (const scenario of ["missing-bootstrap", "missing-file"] as const) {
        const run = await launchFixture(server, {
          web: false,
          sharedAuth:
            scenario === "missing-file" ? join(root, "absent.json") : auth,
          omitSharedAuthPreload: scenario === "missing-bootstrap",
        });
        try {
          await assert.rejects(waitForAttestation(run.rpc, run.context));
          assert.equal(
            logEntries(run.log).some((e) => e.type === "startup-attestation"),
            false,
          );
          assert.equal(server.requests.length, 0);
        } finally {
          await stopFixture(run);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      server.server.close();
    }
  },
);

test(
  "offline real RPC consumes refreshed native metadata and accepts deepseek-flash + low without inference",
  {
    skip: process.env.HITCH_RUN_SANDBOX_TESTS !== "1",
    timeout: 30_000,
  },
  async () => {
    const server = await startFixtureServer();
    const root = mkdtempSync(join(tmpdir(), "hitch-cached-rpc-"));
    privateDirectory(root);
    const auth = join(root, "auth.json");
    writeFileSync(
      auth,
      JSON.stringify({
        deepseek: { type: "api_key", key: "fixture-no-provider-transport" },
      }),
      { mode: 0o600 },
    );
    const run = await launchFixture(server, {
      web: false,
      sharedAuth: auth,
      modelsStore: {
        deepseek: {
          checkedAt: Date.now(),
          lastModified: Date.UTC(2099, 0, 1),
          models: [
            {
              id: "deepseek-flash",
              provider: "deepseek",
              name: "Fixture Flash",
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:1/no-inference",
              input: ["text", "image"],
              reasoning: true,
              contextWindow: 8192,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              thinkingLevelMap: {
                off: null,
                minimal: null,
                low: "low",
                medium: null,
                high: "high",
                xhigh: null,
                max: "max",
              },
            },
          ],
        },
      },
    });
    try {
      await waitForAttestation(run.rpc, run.context);
      const catalog = record(
        (await run.rpc.send({ type: "get_available_models" })).data,
      );
      assert.ok(Array.isArray(catalog?.models));
      assert.ok(
        catalog.models.some(
          (value: unknown) => record(value)?.id === "deepseek-flash",
        ),
      );
      assert.equal(
        (
          await run.rpc.send({
            type: "set_model",
            provider: "deepseek",
            modelId: "deepseek-flash",
          })
        ).success,
        true,
      );
      assert.equal(
        (await run.rpc.send({ type: "set_thinking_level", level: "low" }))
          .success,
        true,
      );
      const state = record((await run.rpc.send({ type: "get_state" })).data);
      assert.equal(record(state?.model)?.id, "deepseek-flash");
      assert.equal(state?.thinkingLevel, "low");
      assert.equal(server.requests.length, 0);
      assert.equal(logEntries(run.providerLog).length, 0);
      assertNoSecret(run, "fixture-no-provider-transport");
    } finally {
      await stopFixture(run);
      rmSync(root, { recursive: true, force: true });
      server.server.close();
    }
  },
);
