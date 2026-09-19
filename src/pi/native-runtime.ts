import { reduceForgeTools } from "@zihanw/pi-forge/service";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MediaStore, MAX_OUTBOUND_ARTIFACTS } from "../media/media-store.js";
import { AsyncSemaphore } from "./semaphore.js";
import {
  logPiRuntimeFailure,
  type RuntimeFailurePhase,
} from "./runtime-diagnostics.js";
import {
  SharedCredentialStore,
  SharedCredentialUpdateError,
  validateSharedAuthPath,
} from "./shared-credentials.js";
import {
  normalizeProfilePermissions,
  preparePiProfile,
  preparePiProfiles,
  privateDirectory,
  safeSegment,
  syncPiModelsStore,
  validatePiProfile,
} from "./profile-preparation.js";
import type {
  AgentRuntime,
  RuntimeArtifact,
  RuntimeModel,
  RuntimeResult,
  RuntimeTurn,
  ThinkingLevel,
} from "../runtime/runtime.js";
import type { ForgeCatalog, ForgeResolved } from "../forge/types.js";

const PI_VERSION = "0.85.1";
const PI_TREE_SHA256 =
  "81f52d5ea162080ebc12efb611c5f82ff57d3c47118fcd7c432ced7e9cb3ec86";
const PI_DEPENDENCY_CLOSURE_SHA256 =
  "bf6e1e05ddd83e48e8453b703f175ea1c9af187e4b930b28465d6eee6e36a1ba";
interface ToolsManifest {
  readonly schemaVersion: 1;
  readonly staticTools: readonly string[];
  readonly optionalTools: Readonly<Record<string, { readonly asset: string }>>;
  readonly assets: Readonly<Record<string, string>>;
}

let toolsManifestCache: ToolsManifest | undefined;

// The build-generated manifest is the single source of truth for the
// attestation baseline and the sandbox asset digests. It ships inside the
// release directory, which is the same trust domain as the compiled runtime
// itself (operator-owned, mode 0444 files under a 0700 tree).
function toolsManifest(): ToolsManifest {
  if (toolsManifestCache !== undefined) return toolsManifestCache;
  const path = join(assetRoot(), "tools-manifest.json");
  if (!existsSync(path))
    throw new Error("sandbox tools manifest is missing; run npm run build");
  const metadata = lstatSync(path, { bigint: true });
  const uid = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    (uid !== undefined && metadata.uid !== BigInt(uid)) ||
    (metadata.mode & 0o222n) !== 0n
  )
    throw new Error("sandbox tools manifest has unsafe properties");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const candidate = parsed as Partial<ToolsManifest>;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    candidate.schemaVersion !== 1 ||
    !Array.isArray(candidate.staticTools) ||
    candidate.staticTools.length === 0 ||
    candidate.staticTools.length > 64 ||
    candidate.staticTools.some(
      (tool) => typeof tool !== "string" || !/^[a-z_]+$/.test(tool),
    ) ||
    new Set(candidate.staticTools).size !== candidate.staticTools.length ||
    candidate.assets === null ||
    typeof candidate.assets !== "object" ||
    Object.keys(candidate.assets).length === 0 ||
    Object.entries(candidate.assets).some(
      ([name, digest]) =>
        name.length === 0 ||
        name.length > 128 ||
        typeof digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(digest),
    ) ||
    candidate.optionalTools === null ||
    typeof candidate.optionalTools !== "object"
  )
    throw new Error("sandbox tools manifest is malformed");
  toolsManifestCache = candidate as ToolsManifest;
  return toolsManifestCache;
}

function expectedToolNames(webSearchEnabled: boolean): string[] {
  const manifest = toolsManifest();
  const base = manifest.staticTools;
  if (!webSearchEnabled) return [...base].sort();
  if (manifest.optionalTools["web_search"] === undefined)
    throw new Error("sandbox tools manifest is missing web_search");
  return [...base, "web_search"].sort();
}

const PI_PROFILE_ROOT = "pi-profiles";
const DEFAULT_MAX_CONCURRENT_TURNS = 2;
const MIN_MAX_CONCURRENT_TURNS = 1;
const MAX_MAX_CONCURRENT_TURNS = 8;
const MAX_RPC_BYTES = 8 * 1024 * 1024;
const MAX_RPC_COMMAND_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MODEL_CATALOG_REFRESH_TIMEOUT_MS = 7_000;
const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const SANDBOX_OWNER_PATTERN = /^[a-f0-9]{16}$/u;
const SANDBOX_UNIT_PATTERN =
  /^hitch-p0-(?:[a-f0-9]{24}|[a-f0-9]{16}-[a-f0-9]{24})\.scope$/u;

let activeRunCount = 0;

type JsonRecord = Record<string, unknown>;

export interface NativePiRuntimeOptions {
  readonly dataRoot: string;
  readonly piProfileDir: string;
  readonly userIds?: readonly string[];
  /** Test-only JSONL controller; never accepted by the service composition. */
  readonly testCliPath?: string;
  readonly maxConcurrentTurns?: number;
  readonly turnTimeoutMs?: number;
  readonly mediaStore?: MediaStore;
  readonly webSearch?: {
    readonly apiKey: string;
    readonly enabledUsers: readonly string[];
  };
  readonly forge?: ForgeCatalog;
  readonly antigravity?: boolean;
}

export interface ControllerContext {
  readonly root: string;
  readonly workspace: string;
  readonly inbox: string;
  readonly publishRoot: string;
  readonly log: string;
  readonly controllerNonce: string;
  readonly turnHandle: string;
  readonly userId: string;
  readonly webSearchEnabled: boolean;
  readonly sharedAuthRequired?: boolean;
  readonly antigravityRequired?: boolean;
  readonly activeTools?: readonly string[];
  readonly forgePrompt?: {
    readonly mode: "replace" | "append" | "prepend";
    readonly systemPrompt: string;
  };
}

interface ClosedProcess {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface AssistantSnapshot {
  readonly text: string;
  readonly stopReason: string;
  readonly errorMessage?: string;
}

interface SandboxBackend {
  executeSandboxRequest(
    input: Record<string, unknown>,
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

const PUBLISH_BLOB_PATTERN = /^([a-f0-9]{32})(?:\.([a-z0-9]{1,8}))?\.blob$/u;
const PUBLISH_EXTENSION_ALLOWLIST: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "pdf",
  "txt",
  "md",
  "csv",
  "json",
  "zip",
  "svg",
]);

// The model never chooses publication names; the sandbox only hints the
// workspace extension through the blob filename. Allowlisted extensions make
// deliveries openable (chart.svg over mystery .bin) while the basename stays
// neutral. Non-allowlisted hints fall back to .bin.
export function publishDisplayName(blobName: string): string | undefined {
  const match = PUBLISH_BLOB_PATTERN.exec(blobName);
  if (match === null) return undefined;
  const extension = match[2];
  if (extension === undefined || !PUBLISH_EXTENSION_ALLOWLIST.has(extension))
    return undefined;
  return `published-${match[1]!.slice(0, 12)}.${extension}`;
}

const TOOL_PREVIEW_KEYS = [
  "command",
  "query",
  "path",
  "pattern",
  "url",
] as const;

export function toolArgPreview(args: unknown): string {
  if (args === null || typeof args !== "object" || Array.isArray(args))
    return "";
  const input = args as Record<string, unknown>;
  let candidate: string | undefined;
  for (const key of TOOL_PREVIEW_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      candidate = value;
      break;
    }
  }
  if (candidate === undefined) {
    for (const value of Object.values(input)) {
      if (typeof value === "string" && value.trim().length > 0) {
        candidate = value;
        break;
      }
    }
  }
  if (candidate === undefined) return "";
  const flat = candidate.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  const clipped = chars.length <= 60 ? flat : `${chars.slice(0, 60).join("")}…`;
  return ` · ${clipped}`;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function validateSandboxAssets(assets: string): void {
  for (const [name, expectedDigest] of Object.entries(toolsManifest().assets)) {
    const path = join(assets, name);
    if (!existsSync(path))
      throw new Error("sandbox build assets are missing; run npm run build");
    const metadata = lstatSync(path, { bigint: true });
    const uid = process.getuid?.();
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1n ||
      (uid !== undefined && metadata.uid !== BigInt(uid)) ||
      (metadata.mode & 0o222n) !== 0n ||
      sha256File(path) !== expectedDigest
    ) {
      throw new Error("pinned sandbox build asset drifted");
    }
  }
}

function treeSha256(root: string, includeDependencies: boolean): string {
  const hash = createHash("sha256");
  const visit = (directory: string, prefix = ""): void => {
    for (const name of readdirSync(directory).sort()) {
      if (
        !includeDependencies &&
        prefix.length === 0 &&
        name === "node_modules"
      )
        continue;
      const absolute = join(directory, name);
      const child = prefix.length === 0 ? name : `${prefix}/${name}`;
      const metadata = lstatSync(absolute);
      if (metadata.isDirectory()) {
        hash.update(`d\0${child}\0`);
        visit(absolute, child);
      } else if (metadata.isSymbolicLink()) {
        hash.update(`l\0${child}\0${readlinkSync(absolute)}\0`);
      } else if (metadata.isFile()) {
        hash.update(`f\0${child}\0`);
        hash.update(readFileSync(absolute));
        hash.update("\0");
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

function systemdEnvironment(): NodeJS.ProcessEnv {
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error("native Pi requires a Unix service user");
  const runtime = `/run/user/${uid}`;
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
  };
}

function sandboxUnits(prefix: string | null): readonly string[] | null {
  const result = spawnSync(
    "/usr/bin/systemctl",
    [
      "--user",
      "list-units",
      "hitch-p0-*.scope",
      "--all",
      "--plain",
      "--no-legend",
      "--no-pager",
    ],
    {
      encoding: "utf8",
      env: systemdEnvironment(),
      timeout: 5_000,
    },
  );
  if (result.status !== 0) return null;
  const units = result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s/u)[0])
    .filter((unit): unit is string => unit !== undefined && unit.length > 0);
  if (prefix === null) {
    if (units.some((unit) => !SANDBOX_UNIT_PATTERN.test(unit))) return null;
  } else {
    if (!SANDBOX_OWNER_PATTERN.test(prefix)) return null;
    const pattern = new RegExp(
      `^hitch-p0-${prefix}-[a-f0-9]{24}\\.scope$`,
      "u",
    );
    if (units.some((unit) => !pattern.test(unit))) return null;
  }
  return units;
}

async function cleanupSandboxUnits(prefix: string | null): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const units = sandboxUnits(prefix);
    if (units === null) return false;
    if (units.length === 0) return true;
    for (const unit of units) {
      for (const arguments_ of [
        ["--user", "kill", "--kill-whom=all", "--signal=KILL", unit],
        ["--user", "stop", unit],
      ]) {
        spawnSync("/usr/bin/systemctl", arguments_, {
          encoding: "utf8",
          env: systemdEnvironment(),
          timeout: 5_000,
        });
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  return false;
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function refreshErrorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function isRecoverableCatalogRefreshError(error: unknown): boolean {
  // Pi's public refresh API classifies provider fetch and OAuth transport
  // failures separately from local auth/configuration failures. Some pinned
  // provider fetchers preserve a raw AbortError/HTTP Error, so recognize only
  // those transport-shaped errors here; local storage errors fail closed.
  if (
    error instanceof SharedCredentialUpdateError ||
    refreshErrorCode(error) === "model_source" ||
    refreshErrorCode(error) === "oauth"
  )
    return true;
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    error instanceof SyntaxError ||
    /fetch failed|model catalog request failed|invalid model catalog for provider/iu.test(
      error.message,
    )
  );
}

function warnCatalogRefresh(): void {
  process.stderr.write(
    "Pi model catalog refresh warning: using cached or built-in metadata.\n",
  );
}

function modelUnavailable(): RuntimeResult {
  return {
    outcome: "failed",
    text: "",
    error: "model-unavailable",
    sessionReusable: true,
  };
}

interface NativeModelPreflight {
  readonly model: RuntimeModel;
  readonly thinkingLevel: ThinkingLevel;
  readonly forge?: ForgeResolved;
  readonly activeTools: readonly string[];
}

/** Model-only validation used before any controller or sandbox is created. */
export function preflightNativeModel(
  models: readonly RuntimeModel[],
  turn: RuntimeTurn,
  userId: string,
  forge: ForgeCatalog | undefined,
  baselineTools: readonly string[],
): NativeModelPreflight | RuntimeResult {
  const hasStoredProvider = turn.modelProvider !== undefined;
  const hasStoredModelId = turn.modelId !== undefined;
  if (hasStoredProvider !== hasStoredModelId) return modelUnavailable();

  const storedModel =
    hasStoredProvider && hasStoredModelId
      ? models.find(
          (model) =>
            model.provider === turn.modelProvider && model.id === turn.modelId,
        )
      : undefined;
  if (hasStoredProvider && storedModel === undefined) return modelUnavailable();

  let resolvedForge: ForgeResolved | undefined;
  if (turn.forgeSelection !== undefined) {
    if (forge === undefined || !forge.isEnabled(userId)) {
      return { outcome: "failed", text: "", sessionReusable: true };
    }
    try {
      resolvedForge = forge.resolve(turn.forgeSelection);
    } catch {
      return { outcome: "failed", text: "", sessionReusable: true };
    }
    if (
      (resolvedForge.mode !== "replace" &&
        resolvedForge.mode !== "append" &&
        resolvedForge.mode !== "prepend") ||
      typeof resolvedForge.systemPrompt !== "string" ||
      Buffer.byteLength(resolvedForge.systemPrompt, "utf8") > 32 * 1024
    ) {
      return { outcome: "failed", text: "", sessionReusable: true };
    }
  }

  // A profile without a persisted model uses its resolved model, or the
  // first available Pi model when the profile is model-less. This mirrors
  // the store's selection/fallback rules without starting a controller.
  const forgeModel = resolvedForge?.model;
  const selectedModel =
    storedModel ??
    (forgeModel === undefined
      ? models[0]
      : models.find(
          (model) =>
            model.provider === forgeModel.provider &&
            model.id === forgeModel.id,
        ));
  if (selectedModel === undefined) return modelUnavailable();

  let activeTools: readonly string[] = baselineTools;
  if (resolvedForge !== undefined && turn.forgeSelection !== undefined) {
    try {
      activeTools = reduceForgeTools(baselineTools, resolvedForge.tools);
      resolvedForge = forge!.resolve(turn.forgeSelection, {
        now: new Date(),
        activeTools,
        model: {
          provider: selectedModel.provider,
          id: selectedModel.id,
        },
      });
      if (
        Buffer.byteLength(
          JSON.stringify({
            mode: resolvedForge.mode,
            systemPrompt: resolvedForge.systemPrompt,
          }),
          "utf8",
        ) >
        64 * 1024
      )
        return { outcome: "failed", text: "", sessionReusable: true };
    } catch {
      return { outcome: "failed", text: "", sessionReusable: true };
    }
  }

  const selectedThinking =
    turn.thinkingLevel ??
    resolvedForge?.thinkingLevel ??
    selectedModel.thinkingLevels[0] ??
    "off";
  if (
    !THINKING_LEVELS.includes(selectedThinking) ||
    !selectedModel.thinkingLevels.includes(selectedThinking)
  )
    return modelUnavailable();

  return {
    model: selectedModel,
    thinkingLevel: selectedThinking,
    activeTools,
    ...(resolvedForge === undefined ? {} : { forge: resolvedForge }),
  };
}

function strictText(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("Pi returned invalid catalog text");
  }
  return value;
}

function supportedThinkingLevels(model: JsonRecord): readonly ThinkingLevel[] {
  if (model.reasoning !== true) return ["off"];
  const map = record(model.thinkingLevelMap);
  return THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function parseCatalog(value: unknown): readonly RuntimeModel[] {
  const data = record(value);
  if (!Array.isArray(data?.models) || data.models.length > 512)
    throw new Error("Pi model catalog is invalid or too large");
  const keys = new Set<string>();
  return data.models
    .map((value): RuntimeModel => {
      const model = record(value);
      if (model === null) throw new Error("Pi model catalog entry is invalid");
      const provider = strictText(model.provider, 128);
      const id = strictText(model.id, 128);
      const name = strictText(model.name, 256);
      const key = JSON.stringify([provider, id]);
      if (keys.has(key))
        throw new Error("Pi model catalog contains a duplicate");
      keys.add(key);
      const input = Array.isArray(model.input)
        ? model.input.filter(
            (item): item is "text" | "image" =>
              item === "text" || item === "image",
          )
        : [];
      if (input.length === 0)
        throw new Error("Pi model catalog input capability is invalid");
      return {
        provider,
        id,
        name,
        reasoning: model.reasoning === true,
        input: [...new Set(input)].sort(),
        thinkingLevels: supportedThinkingLevels(model),
      };
    })
    .sort((left, right) =>
      `${left.provider}/${left.id}`.localeCompare(
        `${right.provider}/${right.id}`,
        "en-US",
      ),
    );
}

export { preparePiProfile, preparePiProfiles, validatePiProfile };

function authPreloadPath(): string {
  return fileURLToPath(new URL("./auth-preload.js", import.meta.url));
}

class PiRpcProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<
    string,
    {
      readonly resolve: (value: JsonRecord) => void;
      readonly reject: (error: Error) => void;
      readonly timer: NodeJS.Timeout;
      readonly command: string;
    }
  >();
  readonly #eventWaiters = new Set<{
    readonly predicate: (event: JsonRecord) => boolean;
    readonly resolve: (event: JsonRecord) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();
  readonly #closed: Promise<ClosedProcess>;
  #buffer = "";
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #stderrText = "";
  #nextId = 0;
  #fatal: Error | null = null;
  #closedState: ClosedProcess | null = null;
  #assistant: AssistantSnapshot | null = null;

  public constructor(
    cliPath: string,
    arguments_: readonly string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
    readonly onTextDelta?: (delta: string) => void,
  ) {
    const preload = authPreloadPath();
    this.#child = spawn(
      process.execPath,
      ["--import", preload, cliPath, ...arguments_],
      {
        cwd,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#read(chunk));
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderrBytes += Buffer.byteLength(chunk, "utf8");
      this.#stderrText = `${this.#stderrText}${chunk}`.slice(-4096);
      if (this.#stderrBytes > MAX_STDERR_BYTES)
        this.#fail(new Error("Pi stderr exceeded its bound"));
    });
    this.#closed = new Promise((resolveClosed) => {
      this.#child.once("error", () =>
        this.#fail(new Error("Pi controller failed to start")),
      );
      this.#child.once("close", (code, signal) => {
        this.#closedState = { code, signal };
        const detail =
          this.#stderrText.trim().length === 0
            ? ""
            : `; stderr: ${this.#stderrText.trim().slice(-2000)}`;
        const error =
          this.#fatal ??
          new Error(
            `Pi controller closed before completion (code=${code ?? "null"}, signal=${signal ?? "null"})${detail}`,
          );
        for (const pending of this.#pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.#pending.clear();
        for (const waiter of this.#eventWaiters) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
        this.#eventWaiters.clear();
        resolveClosed({ code, signal });
      });
    });
  }

  public get stderrTail(): string {
    return this.#stderrText.trim().slice(-1500);
  }

  public get exited(): boolean {
    return this.#closedState !== null;
  }

  // RPC-mode extensions may emit UI requests. Fire-and-forget methods
  // (notify/setStatus/setWidget/setTitle/set_editor_text) need no answer and
  // are dropped by design; dialog methods (select/confirm/input/editor) block
  // extension-side until answered, so headless sessions always answer
  // "cancelled" to keep the controller from stalling.
  static readonly #UI_FIRE_AND_FORGET: ReadonlySet<string> = new Set([
    "notify",
    "setStatus",
    "setWidget",
    "setTitle",
    "set_editor_text",
  ]);

  #answerExtensionUi(event: JsonRecord): void {
    const method = typeof event.method === "string" ? event.method : "";
    if (PiRpcProcess.#UI_FIRE_AND_FORGET.has(method)) return;
    const id = typeof event.id === "string" ? event.id : undefined;
    if (id === undefined) return;
    const encoded = `${JSON.stringify({ type: "extension_ui_response", id, cancelled: true })}\n`;
    this.#child.stdin.write(encoded, () => {});
  }

  #fail(error: Error): void {
    if (this.#fatal === null) this.#fatal = error;
    this.#child.kill("SIGKILL");
  }

  #read(chunk: string): void {
    this.#stdoutBytes += Buffer.byteLength(chunk, "utf8");
    if (this.#stdoutBytes > MAX_RPC_BYTES) {
      this.#fail(new Error("Pi RPC output exceeded its Turn bound"));
      return;
    }
    this.#buffer += chunk;
    while (this.#buffer.includes("\n")) {
      const newline = this.#buffer.indexOf("\n");
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      let event: JsonRecord;
      try {
        const parsed = JSON.parse(line) as unknown;
        const candidate = record(parsed);
        if (candidate === null) throw new Error("not an object");
        event = candidate;
      } catch {
        this.#fail(new Error("Pi emitted invalid RPC data"));
        return;
      }
      if (event.type === "extension_ui_request") {
        this.#answerExtensionUi(event);
        return;
      }
      if (event.type === "message_end") {
        const message = record(event.message);
        if (message?.role === "assistant" && Array.isArray(message.content)) {
          const text = message.content
            .map((item) => record(item))
            .filter((item): item is JsonRecord => item?.type === "text")
            .map((item) => (typeof item.text === "string" ? item.text : ""))
            .join("");
          this.#assistant = {
            text,
            stopReason:
              typeof message.stopReason === "string"
                ? message.stopReason
                : "unknown",
            ...(typeof message.errorMessage === "string"
              ? { errorMessage: message.errorMessage.slice(0, 4096) }
              : {}),
          };
        }
      }
      if (event.type === "message_update") {
        const update = record(event.assistantMessageEvent);
        if (
          update?.type === "text_delta" &&
          typeof update.delta === "string" &&
          update.delta.length > 0
        ) {
          this.onTextDelta?.(update.delta);
        }
      }
      if (
        event.type === "tool_execution_start" &&
        typeof event.toolName === "string" &&
        event.toolName.length > 0
      ) {
        // Tool-call visibility for progress messages: a compact synthetic
        // line flows through the same 30s batched, bounded progress path as
        // text deltas. Final responses are assembled from the assistant
        // snapshot, so these lines never contaminate terminal text.
        this.onTextDelta?.(
          `⏳ ${event.toolName}${toolArgPreview(event.args)}\n`,
        );
      }
      if (event.type === "response" && typeof event.id === "string") {
        const pending = this.#pending.get(event.id);
        if (pending !== undefined) {
          this.#pending.delete(event.id);
          clearTimeout(pending.timer);
          if (event.success === true) pending.resolve(event);
          else
            pending.reject(new PiRpcCommandError(pending.command, event.error));
        }
      }
      for (const waiter of [...this.#eventWaiters]) {
        if (!waiter.predicate(event)) continue;
        this.#eventWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      }
    }
  }

  public send(command: JsonRecord, timeoutMs = 10_000): Promise<JsonRecord> {
    if (this.exited || this.#fatal !== null)
      return Promise.reject(new Error("Pi controller is unavailable"));
    const id = `hitch-${String(++this.#nextId)}`;
    const encoded = `${JSON.stringify({ ...command, id })}\n`;
    if (Buffer.byteLength(encoded, "utf8") > MAX_RPC_COMMAND_BYTES)
      return Promise.reject(new Error("Pi RPC command is too large"));
    return new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectResponse(new Error("Pi RPC response timed out"));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: resolveResponse,
        reject: rejectResponse,
        timer,
        command: typeof command.type === "string" ? command.type : "unknown",
      });
      this.#child.stdin.write(encoded, (error) => {
        if (error === null || error === undefined) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        rejectResponse(new Error("Pi RPC write failed"));
      });
    });
  }

  public waitForEvent(
    predicate: (event: JsonRecord) => boolean,
    timeoutMs: number,
  ): Promise<JsonRecord> {
    return new Promise((resolveEvent, rejectEvent) => {
      const waiter = {
        predicate,
        resolve: resolveEvent,
        reject: rejectEvent,
        timer: setTimeout(() => {
          this.#eventWaiters.delete(waiter);
          rejectEvent(new Error("Pi lifecycle event timed out"));
        }, timeoutMs),
      };
      this.#eventWaiters.add(waiter);
    });
  }

  public clearAssistantSnapshot(): void {
    this.#assistant = null;
  }

  public assistantSnapshot(): AssistantSnapshot | null {
    return this.#assistant;
  }

  public kill(): void {
    this.#child.kill("SIGKILL");
  }

  public async closeCleanly(timeoutMs = 5_000): Promise<void> {
    this.#child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.kill();
        reject(new Error("Pi controller close timed out"));
      }, timeoutMs);
    });
    let result: ClosedProcess;
    try {
      result = await Promise.race([this.#closed, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (
      this.#fatal !== null ||
      result.code !== 0 ||
      result.signal !== null ||
      this.#buffer.trim().length !== 0
    ) {
      throw new Error("Pi controller did not close cleanly");
    }
  }

  public async waitClosed(): Promise<void> {
    await this.#closed;
  }
}

class PiRpcCommandError extends Error {
  public readonly command: string;

  public constructor(command: string, responseError: unknown) {
    super(safeRpcRejection(command, responseError));
    this.name = "PiRpcCommandError";
    this.command = command;
  }
}

function safeRpcRejection(command: string, responseError: unknown): string {
  // Pi's response.error is provider-controlled. Do not copy it into logs or
  // chat: it may contain a request body, transcript text, credentials, or a
  // host path. Keep only stable, actionable protocol categories.
  const detail = typeof responseError === "string" ? responseError : "";
  if (command === "compact") {
    if (detail === "Nothing to compact (session too small)")
      return "Pi rejected compact RPC: the session is already compacted or too small";
    if (detail === "Already compacted")
      return "Pi rejected compact RPC: the session is already compacted";
    if (detail === "Compaction cancelled")
      return "Pi rejected compact RPC: compaction was cancelled";
    if (
      /^(?:Summarization|Turn prefix summarization) failed(?::|$)/u.test(detail)
    )
      return "Pi rejected compact RPC: the compaction provider request failed; retry is safe if the session remains active";
  }
  return `Pi rejected ${command} RPC command`;
}

function responseData(response: JsonRecord): JsonRecord {
  const data = record(response.data);
  if (data === null) throw new Error("Pi RPC response data is invalid");
  return data;
}

function assetRoot(): string {
  return fileURLToPath(new URL("../../sandbox/", import.meta.url));
}

function piCliPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
  );
}

export function validatePiPackage(cliPath: string): void {
  const packageRoot = resolve(dirname(cliPath), "..");
  const packagePath = join(packageRoot, "package.json");
  const packageJson = record(
    JSON.parse(readFileSync(packagePath, "utf8")) as unknown,
  );
  if (
    packageJson?.name !== "@earendil-works/pi-coding-agent" ||
    packageJson.version !== PI_VERSION ||
    realpathSync(cliPath) !== cliPath ||
    treeSha256(packageRoot, false) !== PI_TREE_SHA256 ||
    treeSha256(packageRoot, true) !== PI_DEPENDENCY_CLOSURE_SHA256
  ) {
    throw new Error("pinned Pi 0.85.1 is not installed");
  }
}

export function controllerArguments(
  extension: string,
  webSearchExtension: string | undefined,
  session:
    | { readonly kind: "none" }
    | {
        readonly kind: "id";
        readonly id: string;
        readonly directory: string;
      }
    | {
        readonly kind: "path";
        readonly path: string;
        readonly directory: string;
      },
  providerExtension?: string,
  mcpExtension?: string,
): readonly string[] {
  const arguments_ = [
    "--mode",
    "rpc",
    "--offline",
    "--no-extensions",
    "--extension",
    extension,
    ...(webSearchExtension === undefined
      ? []
      : ["--extension", webSearchExtension]),
    ...(providerExtension === undefined
      ? []
      : ["--extension", providerExtension]),
    ...(mcpExtension === undefined ? [] : ["--extension", mcpExtension]),
    "--no-builtin-tools",
    // 0.85.1 adds an inactive PowerShell builtin to the registry. Exclude it
    // entirely so exact eight-tool attestation and no-host-fallback stay intact.
    "--exclude-tools",
    "powershell",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
  ];
  if (session.kind === "none") arguments_.push("--no-session");
  if (session.kind === "id")
    arguments_.push(
      "--session-id",
      session.id,
      "--session-dir",
      session.directory,
    );
  if (session.kind === "path")
    arguments_.push(
      "--session",
      session.path,
      "--session-dir",
      session.directory,
    );
  return arguments_;
}

export async function waitForAttestation(
  controller: { readonly exited: boolean; readonly stderrTail?: string },
  context: ControllerContext,
): Promise<void> {
  const expectedTools = expectedToolNames(context.webSearchEnabled);
  const expectedActiveTools = context.activeTools ?? expectedTools;
  const extensionPath = join(assetRoot(), "hitch-sandbox.ts");
  const webExtensionPath = join(assetRoot(), "pi-web-search.ts");
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (existsSync(context.log)) {
      const metadata = statSync(context.log);
      if (metadata.size > 64 * 1024)
        throw new Error("sandbox attestation log exceeded its bound");
      const entries = readFileSync(context.log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => record(JSON.parse(line) as unknown))
        .filter((item): item is JsonRecord => item !== null);
      const mandatory = entries.filter(
        (item) =>
          item.type === "startup-attestation" &&
          item.ready === true &&
          item.controllerNonce === context.controllerNonce &&
          item.userId === context.userId,
      );
      // One witness, one record: the mandatory sandbox extension attests the
      // whole world (web_search's presence, source path, and schema are all
      // covered by its sourcePaths/schemaDigest fields).
      if (mandatory.length > 1)
        throw new Error("sandbox startup attestation is not unique");
      if (mandatory.length === 1) {
        const standard = mandatory[0];
        if (standard === undefined)
          throw new Error("sandbox startup attestation is missing");
        const check = (item: JsonRecord, source: string): void => {
          if (
            JSON.stringify(item.exactTools) !== JSON.stringify(expectedTools) ||
            JSON.stringify(item.allTools) !== JSON.stringify(expectedTools) ||
            JSON.stringify(item.activeTools) !==
              JSON.stringify(expectedActiveTools) ||
            !Array.isArray(item.sourcePaths) ||
            item.sourcePaths.length !== expectedTools.length ||
            !/^[a-f0-9]{64}$/u.test(String(item.schemaDigest))
          )
            throw new Error("sandbox startup attestation is invalid");
          const sourcePaths = item.sourcePaths;
          const expectedSources = expectedTools.map((name) =>
            name === "web_search" ? webExtensionPath : extensionPath,
          );
          if (JSON.stringify(sourcePaths) !== JSON.stringify(expectedSources))
            throw new Error("sandbox tool source attestation is invalid");
          if (item.sourcePath !== source)
            throw new Error("sandbox extension source attestation is invalid");
        };
        check(standard, extensionPath);
        if (context.sharedAuthRequired === true && standard.sharedAuth !== true)
          throw new Error("shared auth startup attestation is missing");
        if (
          context.antigravityRequired === true &&
          standard.antigravity !== true
        )
          throw new Error(
            "antigravity provider startup attestation is missing",
          );
        if (
          context.antigravityRequired !== true &&
          standard.antigravity === true
        )
          throw new Error("antigravity provider attestation unexpected");
        if (
          standard.extensionDigest !==
          toolsManifest().assets["hitch-sandbox.ts"]
        )
          throw new Error("sandbox extension digest attestation is invalid");
        if (Boolean(standard.webSearchEnabled) !== context.webSearchEnabled)
          throw new Error("sandbox web-search flag attestation is invalid");
        return;
      }
    }
    if (controller.exited || Date.now() >= deadline) {
      let logTail = "(no attestation log)";
      try {
        if (existsSync(context.log))
          logTail = readFileSync(context.log, "utf8").trim().slice(-4500);
      } catch {
        logTail = "(attestation log unreadable)";
      }
      throw new Error(
        `sandbox startup attestation did not arrive; controller stderr: ${controller.stderrTail ?? "(none)"}; log tail: ${logTail}`,
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

function syncTranscript(path: string, sessionDirectory: string): string {
  if (!isAbsolute(path)) throw new Error("Pi transcript path is invalid");
  const canonical = realpathSync(path);
  const child = relative(sessionDirectory, canonical);
  const metadata = lstatSync(canonical, { bigint: true });
  const uid = process.getuid?.();
  if (
    canonical !== path ||
    child === "" ||
    child.startsWith("..") ||
    isAbsolute(child) ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    (uid !== undefined && metadata.uid !== BigInt(uid)) ||
    (metadata.mode & 0o077n) !== 0n
  ) {
    throw new Error("Pi transcript path is unsafe");
  }
  const descriptor = openSync(
    canonical,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    if (!fstatSync(descriptor).isFile())
      throw new Error("Pi transcript is not a regular file");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const parent = openSync(
    dirname(canonical),
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
  );
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
  return canonical;
}

/** Refresh the canonical native catalog once; true means cache fallback was used. */
export async function refreshPiCatalog(
  catalogProfile: string,
  sharedAuthPath: string,
  options: {
    readonly timeoutMs?: number;
    readonly catalogBaseUrl?: string;
  } = {},
): Promise<boolean> {
  // Validate local state before any network fallback can be considered.
  validatePiProfile(catalogProfile);
  const signal = AbortSignal.timeout(
    options.timeoutMs ?? MODEL_CATALOG_REFRESH_TIMEOUT_MS,
  );
  const modelsPath = join(catalogProfile, "models.json");
  const modelsStorePath = join(catalogProfile, "models-store.json");
  const modelRuntime = await ModelRuntime.create({
    credentials: new SharedCredentialStore(sharedAuthPath),
    modelsPath,
    modelsStorePath,
    allowModelNetwork: true,
    refreshOnCreate: false,
    signal,
    ...(options.catalogBaseUrl === undefined
      ? {}
      : { catalogBaseUrl: options.catalogBaseUrl }),
  });
  const local = await modelRuntime.refresh({ allowNetwork: false, signal });
  if (local.errors.size > 0 || modelRuntime.getError() !== undefined)
    throw new Error("Pi model catalog local state is invalid");
  if (local.aborted) return true;
  const result = await modelRuntime.refresh({ allowNetwork: true, signal });
  const fatal = [...result.errors.values()].some(
    (error) => !isRecoverableCatalogRefreshError(error),
  );
  if (fatal || modelRuntime.getError() !== undefined)
    throw new Error("Pi model catalog refresh failed");
  return result.aborted || result.errors.size > 0;
}

export class NativePiRuntime implements AgentRuntime {
  readonly models: readonly RuntimeModel[];
  readonly catalogDigest: string;
  readonly forge?: ForgeCatalog;
  readonly sharedAuthPath: string;
  readonly #runtimeRoot: string;
  readonly #sessionsRoot: string;
  readonly #profiles: ReadonlyMap<string, string>;
  readonly #catalogProfile: string;
  readonly #cli: string;
  readonly #testCliPath: string | undefined;
  readonly #assets: string;
  readonly #turnTimeoutMs: number;
  readonly #media: MediaStore;
  readonly #semaphore: AsyncSemaphore;
  readonly #owner: string;
  readonly #webSearchKey: string | undefined;
  readonly #webSearchUsers: ReadonlySet<string>;
  readonly #antigravity: boolean;
  readonly #sharedProfileDir: string;
  #poisoned = false;

  private constructor(
    options: NativePiRuntimeOptions,
    models: readonly RuntimeModel[],
    profiles: ReadonlyMap<string, string>,
    catalogProfile: string,
    sharedAuthPath: string,
  ) {
    this.models = models;
    this.catalogDigest = stableDigest(models);
    this.sharedAuthPath = sharedAuthPath;
    if (options.forge !== undefined) {
      this.forge = options.forge;
    }
    this.#runtimeRoot = join(options.dataRoot, "pi-runtime");
    this.#sessionsRoot = join(options.dataRoot, "pi-sessions");
    this.#profiles = profiles;
    this.#catalogProfile = catalogProfile;
    this.#cli = options.testCliPath ?? piCliPath();
    this.#testCliPath = options.testCliPath;
    this.#assets = assetRoot();
    this.#turnTimeoutMs = options.turnTimeoutMs ?? 10 * 60 * 1000;
    this.#media = options.mediaStore ?? new MediaStore(options.dataRoot);
    this.#semaphore = new AsyncSemaphore(
      options.maxConcurrentTurns ?? DEFAULT_MAX_CONCURRENT_TURNS,
    );
    this.#owner = randomBytes(8).toString("hex");
    this.#webSearchKey = options.webSearch?.apiKey;
    this.#webSearchUsers = new Set(options.webSearch?.enabledUsers ?? []);
    this.#antigravity = options.antigravity === true;
    this.#sharedProfileDir = options.piProfileDir;
  }

  public static async create(
    options: NativePiRuntimeOptions,
  ): Promise<NativePiRuntime> {
    if (
      options.turnTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.turnTimeoutMs) ||
        options.turnTimeoutMs < 1_000 ||
        options.turnTimeoutMs > 30 * 60 * 1000)
    ) {
      throw new Error("native Pi Turn timeout is invalid");
    }
    if (
      options.maxConcurrentTurns !== undefined &&
      (!Number.isSafeInteger(options.maxConcurrentTurns) ||
        options.maxConcurrentTurns < MIN_MAX_CONCURRENT_TURNS ||
        options.maxConcurrentTurns > MAX_MAX_CONCURRENT_TURNS)
    ) {
      throw new Error(
        `native Pi concurrency limit must be from ${MIN_MAX_CONCURRENT_TURNS} to ${MAX_MAX_CONCURRENT_TURNS}`,
      );
    }
    validatePiProfile(options.piProfileDir);
    const sharedAuthPath = validateSharedAuthPath(
      join(options.piProfileDir, "auth.json"),
    );
    const cli = options.testCliPath ?? piCliPath();
    if (options.testCliPath === undefined) {
      validatePiPackage(cli);
    } else if (process.env.NODE_ENV !== "test") {
      throw new Error("test Pi CLI is only available in test mode");
    }
    const assets = assetRoot();
    validateSandboxAssets(assets);
    const profileRoot = join(options.dataRoot, PI_PROFILE_ROOT);
    privateDirectory(profileRoot);
    const userIds = options.userIds ?? [];
    const configuredUsers = new Set(userIds);
    if (configuredUsers.size !== userIds.length)
      throw new Error("duplicate Pi profile user id");
    if (options.webSearch !== undefined) {
      if (
        typeof options.webSearch.apiKey !== "string" ||
        options.webSearch.apiKey.length === 0 ||
        options.webSearch.enabledUsers.some(
          (userId) => !configuredUsers.has(userId),
        ) ||
        new Set(options.webSearch.enabledUsers).size !==
          options.webSearch.enabledUsers.length
      ) {
        throw new Error("web search users are not prepared for the runtime");
      }
      for (const userId of options.webSearch.enabledUsers)
        safeSegment(userId, "web search user id");
    }
    const { profiles, catalogProfile } = preparePiProfiles(
      options.piProfileDir,
      profileRoot,
      userIds,
    );
    const temporary = new NativePiRuntime(
      options,
      [],
      profiles,
      catalogProfile,
      sharedAuthPath,
    );
    privateDirectory(temporary.#runtimeRoot);
    privateDirectory(temporary.#sessionsRoot);
    if (activeRunCount === 0 && !(await cleanupSandboxUnits(null)))
      throw new Error("sandbox process-tree cleanup could not be confirmed");
    await temporary.#refreshCatalog();
    syncPiModelsStore(catalogProfile, profiles);
    const models = await temporary.#loadCatalog();
    if (models.length === 0)
      throw new Error("Pi profile has no authenticated available model");
    return new NativePiRuntime(
      options,
      models,
      profiles,
      catalogProfile,
      sharedAuthPath,
    );
  }

  #context(
    label: string,
    workspace: string,
    userId: string,
    webSearchEnabled: boolean,
    activeTools?: readonly string[],
    forgePrompt?: {
      readonly mode: "replace" | "append" | "prepend";
      readonly systemPrompt: string;
    },
  ): ControllerContext {
    const root = join(
      this.#runtimeRoot,
      safeSegment(label, "controller label"),
    );
    if (existsSync(root)) throw new Error("native Pi controller root exists");
    privateDirectory(root);
    const inbox = join(root, "inbox");
    const publishRoot = join(root, "publish");
    privateDirectory(inbox);
    privateDirectory(publishRoot);
    return {
      root,
      workspace,
      inbox,
      publishRoot,
      log: join(root, "sandbox.log"),
      controllerNonce: randomBytes(16).toString("hex"),
      turnHandle: randomBytes(16).toString("hex"),
      userId,
      webSearchEnabled,
      sharedAuthRequired: true,
      ...(this.#antigravity ? { antigravityRequired: true } : {}),
      ...(activeTools === undefined ? {} : { activeTools }),
      ...(forgePrompt === undefined ? {} : { forgePrompt }),
    };
  }

  #profileFor(userId: string): string {
    const segment = safeSegment(userId, "runtime user id");
    const directory = this.#profiles.get(segment);
    if (directory === undefined)
      throw new Error(`no Pi profile is prepared for user ${segment}`);
    return directory;
  }

  #controller(
    context: ControllerContext,
    session: Parameters<typeof controllerArguments>[2],
    onTextDelta: ((delta: string) => void) | undefined,
    profileDir: string,
  ): PiRpcProcess {
    validateSandboxAssets(this.#assets);
    const extension = join(this.#assets, "hitch-sandbox.ts");
    const webSearchExtension = join(this.#assets, "pi-web-search.ts");
    const antigravityExtension = join(this.#assets, "pi-antigravity.ts");
    // Opt-in MCP support: the vendored pi-mcp-adapter and its mcp.json config
    // live in the (release-independent) shared profile directory; the per-user
    // profile clone receives mcp.json through the managed sync boundary. The
    // extension itself loads by absolute path from the shared profile.
    const mcpExtension = join(
      this.#sharedProfileDir,
      "mcp",
      "node_modules",
      "pi-mcp-adapter",
      "index.ts",
    );
    const mcpEnabled =
      existsSync(mcpExtension) &&
      existsSync(join(this.#sharedProfileDir, "mcp.json"));
    const worker = join(this.#assets, "sandbox-worker.mjs");
    const helper = join(this.#assets, "secure-bwrap-helper");
    const baseline = expectedToolNames(context.webSearchEnabled);
    const activeTools = context.activeTools ?? baseline;
    const environment: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: context.root,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NO_COLOR: "1",
      PI_CODING_AGENT_DIR: profileDir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      HITCH_SHARED_AUTH_PATH: this.sharedAuthPath,
      HITCH_SHARED_AUTH_REQUIRED: "1",
      HITCH_PI_MODELS_PATH: join(profileDir, "models.json"),
      HITCH_PI_MODELS_STORE_PATH: join(profileDir, "models-store.json"),
      HITCH_P0_WORKSPACE: context.workspace,
      HITCH_P0_INBOX: context.inbox,
      HITCH_P0_PUBLISH_ROOT: context.publishRoot,
      HITCH_P0_WORKER: worker,
      HITCH_P0_HELPER: helper,
      HITCH_P0_LOG: context.log,
      HITCH_P0_TURN_HANDLE: context.turnHandle,
      HITCH_P0_CONTROLLER_NONCE: context.controllerNonce,
      HITCH_P0_USER_ID: context.userId,
      HITCH_P0_EXTENSION_PATH: extension,
      HITCH_P0_UNIT_PREFIX: this.#owner,
      HITCH_P0_WORKER_SHA256: toolsManifest().assets["sandbox-worker.mjs"],
      HITCH_P0_HELPER_SHA256: toolsManifest().assets["secure-bwrap-helper"],
      HITCH_P0_EXTENSION_SHA256: toolsManifest().assets["hitch-sandbox.ts"],
      HITCH_P0_BACKEND_SHA256: toolsManifest().assets["sandbox-backend.mjs"],
      HITCH_ACTIVE_TOOLS: JSON.stringify(activeTools),
      HITCH_EXPECTED_TOOLS: JSON.stringify(baseline),
      HITCH_DYNAMIC_EXTENSION_PATHS: JSON.stringify(
        mcpEnabled ? [mcpExtension] : [],
      ),
      ...(context.forgePrompt !== undefined
        ? {
            HITCH_FORGE_PROMPT: JSON.stringify({
              mode: context.forgePrompt.mode,
              systemPrompt: context.forgePrompt.systemPrompt,
            }),
          }
        : {}),
      ...(context.webSearchEnabled
        ? {
            HITCH_WEB_SEARCH_ENABLED: "1",
            HITCH_WEB_SEARCH_KEY: this.#webSearchKey ?? "",
            HITCH_WEB_SEARCH_EXTENSION_PATH: webSearchExtension,
            HITCH_WEB_SEARCH_EXTENSION_SHA256:
              toolsManifest().assets["pi-web-search.ts"],
          }
        : {}),
      ...(context.antigravityRequired
        ? {
            HITCH_ANTIGRAVITY_ENABLED: "1",
            ANTIGRAVITY_NO_PREWARM: "1",
            HITCH_ANTIGRAVITY_EXTENSION_PATH: antigravityExtension,
            HITCH_ANTIGRAVITY_EXTENSION_SHA256:
              toolsManifest().assets["pi-antigravity.ts"],
          }
        : {}),
      ...(mcpEnabled
        ? {
            HITCH_MCP_ENABLED: "1",
            HITCH_MCP_EXTENSION_PATH: mcpExtension,
            HITCH_MCP_EXTENSION_SHA256: sha256File(mcpExtension),
          }
        : {}),
      // This branch is unreachable from service composition and exists only
      // so the fake JSONL controller can select a deterministic scenario.
      ...(this.#testCliPath === undefined
        ? {}
        : {
            HITCH_FAKE_PI_MODE: process.env.HITCH_FAKE_PI_MODE ?? "success",
            HITCH_FAKE_PI_TRACE: process.env.HITCH_FAKE_PI_TRACE ?? "",
          }),
    };
    return new PiRpcProcess(
      this.#cli,
      controllerArguments(
        extension,
        context.webSearchEnabled ? webSearchExtension : undefined,
        session,
        context.antigravityRequired ? antigravityExtension : undefined,
        mcpEnabled ? mcpExtension : undefined,
      ),
      context.workspace,
      environment,
      onTextDelta,
    );
  }

  async #refreshCatalog(): Promise<void> {
    if (await refreshPiCatalog(this.#catalogProfile, this.sharedAuthPath))
      warnCatalogRefresh();
  }

  async #loadCatalog(): Promise<readonly RuntimeModel[]> {
    const label = `catalog-${randomBytes(8).toString("hex")}`;
    const workspace = join(this.#runtimeRoot, "catalog-workspace");
    privateDirectory(workspace);
    const context = this.#context(label, workspace, "catalog", false);
    const controller = this.#controller(
      context,
      { kind: "none" },
      undefined,
      this.#catalogProfile,
    );
    try {
      await waitForAttestation(controller, context);
      const response = await controller.send({ type: "get_available_models" });
      const models = parseCatalog(responseData(response));
      await controller.closeCleanly();
      return models;
    } catch (error) {
      controller.kill();
      await controller.waitClosed();
      throw error;
    } finally {
      if (!(await cleanupSandboxUnits(this.#owner)))
        throw new Error("sandbox process-tree cleanup could not be confirmed");
      normalizeProfilePermissions(this.#catalogProfile);
      rmSync(context.root, { recursive: true, force: true });
    }
  }

  async #publishOnly(
    turn: RuntimeTurn,
    context: ControllerContext,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    const publishPath = turn.publishPath;
    const artifactId = randomBytes(16).toString("hex");
    try {
      if (publishPath === undefined)
        throw new Error("publication path is missing");
      validateSandboxAssets(this.#assets);
      const backend = (await import(
        pathToFileURL(join(this.#assets, "sandbox-backend.mjs")).href
      )) as SandboxBackend;
      const result = record(
        await backend.executeSandboxRequest(
          {
            workspace: context.workspace,
            inbox: context.inbox,
            publishRoot: context.publishRoot,
            worker: join(this.#assets, "sandbox-worker.mjs"),
            helper: join(this.#assets, "secure-bwrap-helper"),
            log: context.log,
            turnHandle: context.turnHandle,
            unitPrefix: this.#owner,
            workerSha256: toolsManifest().assets["sandbox-worker.mjs"],
            helperSha256: toolsManifest().assets["secure-bwrap-helper"],
            temporaryBytes: 4 * 1024 * 1024,
            memoryBytes: 256 * 1024 * 1024,
            maximumProcesses: 32,
            wallMilliseconds: 8_000,
          },
          {
            operation: "hitch_publish",
            input: { path: publishPath, artifactId },
          },
          signal,
        ),
      );
      if (
        result === null ||
        result.artifactId !== artifactId ||
        !Number.isSafeInteger(result.bytes) ||
        Number(result.bytes) < 0 ||
        Number(result.bytes) > 50 * 1024 * 1024 ||
        typeof result.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(result.sha256)
      ) {
        throw new Error("publication helper returned invalid metadata");
      }
      const artifact = this.#media.promotePublished(
        turn.userId,
        join(context.publishRoot, `${artifactId}.blob`),
        basename(publishPath),
      );
      if (
        artifact.bytes !== Number(result.bytes) ||
        artifact.sha256 !== result.sha256
      ) {
        this.#media.discard(artifact);
        throw new Error("publication helper metadata did not match snapshot");
      }
      return {
        outcome: "succeeded",
        text: `Published ${artifact.displayName}.`,
        sessionReusable: true,
        artifacts: [artifact],
      };
    } catch {
      return {
        outcome: signal.aborted ? "cancelled" : "failed",
        text: "",
        ...(signal.aborted
          ? {}
          : {
              error:
                "publication failed in the sandbox; the path must be a regular file inside the workspace",
            }),
        sessionReusable: true,
      };
    } finally {
      const cleaned = await cleanupSandboxUnits(this.#owner);
      if (!cleaned) {
        this.#poisoned = true;
        logPiRuntimeFailure({ phase: "cleanup", turnId: turn.turnId });
        throw new Error("sandbox process-tree cleanup could not be confirmed");
      }
      rmSync(context.root, { recursive: true, force: true });
    }
  }

  public async run(
    turn: RuntimeTurn,
    signal: AbortSignal,
    onProgress?: (delta: string) => void,
  ): Promise<RuntimeResult> {
    activeRunCount += 1;
    const releaseSlot = await this.#semaphore.acquire();
    try {
      if (this.#poisoned)
        return { outcome: "unknown", text: "", sessionReusable: false };
      if (signal.aborted)
        return {
          outcome: "cancelled",
          text: "",
          sessionReusable: true,
        };
      return await this.#runExclusive(turn, signal, onProgress);
    } catch (error) {
      logPiRuntimeFailure({ phase: "preflight", turnId: turn.turnId, error });
      return { outcome: "unknown", text: "", sessionReusable: false };
    } finally {
      releaseSlot();
      activeRunCount -= 1;
    }
  }

  async #runExclusive(
    turn: RuntimeTurn,
    signal: AbortSignal,
    onProgress?: (delta: string) => void,
  ): Promise<RuntimeResult> {
    const piSessionId = turn.piSessionId?.startsWith("pi_")
      ? turn.piSessionId.slice(3)
      : turn.piSessionId;
    if (
      turn.workspace === undefined ||
      piSessionId === undefined ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        piSessionId,
      )
    ) {
      return { outcome: "unknown", text: "", sessionReusable: false };
    }
    const userId = safeSegment(turn.userId, "runtime user id");
    const isWebEnabled = this.#webSearchUsers.has(userId);
    const baselineTools = expectedToolNames(isWebEnabled);
    const sessionDirectory = join(this.#sessionsRoot, userId);
    privateDirectory(sessionDirectory);
    const session =
      turn.transcriptPath === undefined
        ? ({
            kind: "id",
            id: piSessionId,
            directory: sessionDirectory,
          } as const)
        : ({
            kind: "path",
            path: syncTranscript(turn.transcriptPath, sessionDirectory),
            directory: sessionDirectory,
          } as const);
    const profileDir = this.#profileFor(userId);
    // Pi has no durable history before the first assistant message. Do not
    // start a provider-owning controller just to compact an empty session.
    if (turn.compact === true && turn.transcriptPath === undefined)
      return {
        outcome: "succeeded",
        text: "Nothing to compact yet; this session has no saved conversation.",
        sessionReusable: true,
      };
    const inputArtifacts = turn.artifacts ?? [];
    if (
      inputArtifacts.length > 8 ||
      inputArtifacts.some((artifact) => artifact.userId !== turn.userId) ||
      inputArtifacts.reduce((total, artifact) => total + artifact.bytes, 0) >
        40 * 1024 * 1024
    ) {
      return { outcome: "unknown", text: "", sessionReusable: false };
    }
    // File publication does not invoke a model and must work even if its
    // session's previously selected model has left the current catalog.
    if (turn.publishPath !== undefined) {
      const context = this.#context(
        safeSegment(turn.turnId, "runtime Turn id"),
        turn.workspace,
        userId,
        isWebEnabled,
      );
      return await this.#publishOnly(turn, context, signal);
    }
    const preflight = preflightNativeModel(
      this.models,
      turn,
      userId,
      this.forge,
      baselineTools,
    );
    if ("outcome" in preflight) {
      logPiRuntimeFailure({
        phase: "resolve-model",
        turnId: turn.turnId,
        ...(preflight.error === "model-unavailable"
          ? { code: "model-unavailable" }
          : {}),
      });
      return preflight;
    }
    const {
      model: selectedModel,
      thinkingLevel: selectedThinking,
      activeTools,
      forge: resolvedForge,
    } = preflight;
    const forgePrompt =
      resolvedForge === undefined
        ? undefined
        : {
            mode: resolvedForge.mode,
            systemPrompt: resolvedForge.systemPrompt,
          };
    const context = this.#context(
      safeSegment(turn.turnId, "runtime Turn id"),
      turn.workspace,
      userId,
      isWebEnabled,
      activeTools,
      forgePrompt,
    );
    const nativeImages =
      selectedModel !== undefined && selectedModel.input.includes("image");
    const images: Array<{
      type: "image";
      data: string;
      mimeType: string;
    }> = [];
    const inboxLines: string[] = [];
    try {
      for (const [ordinal, artifact] of inputArtifacts.entries()) {
        if (nativeImages && artifact.mediaKind === "image") {
          images.push({
            type: "image",
            data: this.#media.imageData(artifact),
            mimeType: artifact.mimeType,
          });
        } else {
          const path = this.#media.materializeInbox(
            artifact,
            context.inbox,
            ordinal,
          );
          inboxLines.push(
            `${path} (${artifact.displayName}; ${artifact.mimeType}; ${artifact.bytes} bytes)`,
          );
        }
      }
    } catch {
      rmSync(context.root, { recursive: true, force: true });
      return { outcome: "unknown", text: "", sessionReusable: false };
    }
    const prompt =
      inboxLines.length === 0
        ? turn.prompt
        : `${turn.prompt}\n\nHitch attached these opaque read-only files for this Turn:\n${inboxLines.join("\n")}`;
    const controller = this.#controller(
      context,
      session,
      onProgress,
      profileDir,
    );
    let phase: RuntimeFailurePhase = "attest";
    let timedOut = false;
    let promptSubmitted = false;
    let compactCommandStarted = false;
    let timer: NodeJS.Timeout | undefined;
    let forcedKill: NodeJS.Timeout | undefined;
    let abortRequest: Promise<void> | undefined;
    let abortAcknowledged = false;
    const promoted: RuntimeArtifact[] = [];
    const abort = (): void => {
      if (!promptSubmitted || controller.exited) return;
      abortRequest ??= controller
        .send({ type: "abort" }, 5_000)
        .then(() => {
          abortAcknowledged = true;
        })
        .catch(() => undefined);
      forcedKill ??= setTimeout(() => controller.kill(), 5_000);
    };
    const onExternalAbort = (): void => abort();
    signal.addEventListener("abort", onExternalAbort, { once: true });
    try {
      await waitForAttestation(controller, context);
      phase = "set-model";
      await controller.send({
        type: "set_model",
        provider: selectedModel.provider,
        modelId: selectedModel.id,
      });
      phase = "set-thinking";
      await controller.send({
        type: "set_thinking_level",
        level: selectedThinking,
      });
      if (signal.aborted) {
        await controller.closeCleanly();
        const transcriptPath =
          turn.transcriptPath === undefined
            ? undefined
            : syncTranscript(turn.transcriptPath, sessionDirectory);
        return {
          outcome: "cancelled",
          text: "",
          sessionReusable: true,
          ...(transcriptPath === undefined ? {} : { transcriptPath }),
        };
      }
      if (turn.compact === true) {
        // Pi 0.85.1 returns compaction metadata in response.data. A response
        // envelope is not the result, and a rejected compact command is not
        // automatically an uncertain Turn: Pi reports expected no-op/failure
        // cases while keeping the controller usable.
        phase = "prompt";
        promptSubmitted = true;
        compactCommandStarted = true;
        timer = setTimeout(() => {
          timedOut = true;
          abort();
        }, this.#turnTimeoutMs);
        const compaction = responseData(
          await controller.send({ type: "compact" }, this.#turnTimeoutMs),
        );
        if (timer !== undefined) clearTimeout(timer);
        if (forcedKill !== undefined) clearTimeout(forcedKill);
        if (signal.aborted || timedOut) {
          abort();
          if (abortRequest !== undefined) await abortRequest;
          if (!abortAcknowledged)
            throw new Error("Pi compact abort was not acknowledged");
          if (forcedKill !== undefined) clearTimeout(forcedKill);
          await controller.closeCleanly();
          const compactTranscript =
            turn.transcriptPath === undefined
              ? undefined
              : syncTranscript(turn.transcriptPath, sessionDirectory);
          return {
            outcome: timedOut ? "timed-out" : "cancelled",
            text: "",
            sessionReusable: true,
            ...(compactTranscript === undefined
              ? {}
              : { transcriptPath: compactTranscript }),
          };
        }
        const tokensBefore =
          Number.isSafeInteger(compaction.tokensBefore) &&
          Number(compaction.tokensBefore) >= 0
            ? Number(compaction.tokensBefore)
            : undefined;
        if (
          tokensBefore === undefined ||
          typeof compaction.summary !== "string" ||
          typeof compaction.firstKeptEntryId !== "string" ||
          compaction.firstKeptEntryId.length === 0
        )
          throw new Error("compaction returned invalid metadata");
        const tokensAfter =
          Number.isSafeInteger(compaction.estimatedTokensAfter) &&
          Number(compaction.estimatedTokensAfter) >= 0
            ? Number(compaction.estimatedTokensAfter)
            : undefined;
        await controller.closeCleanly();
        const compactTranscript =
          turn.transcriptPath === undefined
            ? undefined
            : syncTranscript(turn.transcriptPath, sessionDirectory);
        return {
          outcome: "succeeded",
          text: `Context compacted: ~${tokensBefore} tokens before${
            tokensAfter === undefined ? "" : `, ~${tokensAfter} tokens after`
          }.`,
          sessionReusable: true,
          ...(compactTranscript === undefined
            ? {}
            : { transcriptPath: compactTranscript }),
        };
      }
      const settled = controller.waitForEvent(
        (event) => event.type === "agent_settled",
        this.#turnTimeoutMs + 6_000,
      );
      void settled.catch(() => undefined);
      controller.clearAssistantSnapshot();
      promptSubmitted = true;
      phase = "prompt";
      timer = setTimeout(() => {
        timedOut = true;
        abort();
      }, this.#turnTimeoutMs);
      await controller.send(
        {
          type: "prompt",
          message: prompt,
          ...(images.length === 0 ? {} : { images }),
        },
        Math.min(this.#turnTimeoutMs, 30_000),
      );
      phase = "settled";
      await settled;
      if (timer !== undefined) clearTimeout(timer);
      if (forcedKill !== undefined) clearTimeout(forcedKill);
      const assistant = controller.assistantSnapshot();
      const state = responseData(await controller.send({ type: "get_state" }));
      await controller.closeCleanly();

      phase = "transcript";
      const model = record(state.model);
      const modelProvider =
        model === null ? undefined : strictText(model.provider, 128);
      const modelId = model === null ? undefined : strictText(model.id, 128);
      const thinking = state.thinkingLevel;
      if (!THINKING_LEVELS.includes(thinking as ThinkingLevel))
        throw new Error("Pi returned an invalid thinking level");
      let transcriptPath: string | undefined;
      if (
        typeof state.sessionFile === "string" &&
        existsSync(state.sessionFile)
      )
        transcriptPath = syncTranscript(state.sessionFile, sessionDirectory);
      const outcome = timedOut
        ? "timed-out"
        : signal.aborted
          ? "cancelled"
          : (assistant?.stopReason === "stop" ||
                assistant?.stopReason === "length") &&
              assistant.text.length > 0
            ? "succeeded"
            : "failed";
      if (
        (turn.transcriptPath !== undefined &&
          transcriptPath !== turn.transcriptPath) ||
        (outcome === "succeeded" && transcriptPath === undefined)
      ) {
        throw new Error("Pi transcript durability could not be proven");
      }
      const publicationEntries = readdirSync(context.publishRoot).sort();
      if (
        publicationEntries.length > MAX_OUTBOUND_ARTIFACTS ||
        publicationEntries.some((name) => !PUBLISH_BLOB_PATTERN.test(name))
      ) {
        throw new Error("Pi publication output is invalid");
      }
      for (const name of publicationEntries)
        promoted.push(
          this.#media.promotePublished(
            turn.userId,
            join(context.publishRoot, name),
            publishDisplayName(name),
          ),
        );
      if (outcome === "failed") {
        logPiRuntimeFailure({
          phase: "settled",
          turnId: turn.turnId,
          error: assistant?.errorMessage ?? "provider error",
        });
      }
      return {
        outcome,
        text: outcome === "succeeded" ? (assistant?.text ?? "") : "",
        sessionReusable: true,
        ...(transcriptPath === undefined ? {} : { transcriptPath }),
        ...(modelProvider === undefined ? {} : { modelProvider }),
        ...(modelId === undefined ? {} : { modelId }),
        thinkingLevel: thinking as ThinkingLevel,
        ...(promoted.length === 0 ? {} : { artifacts: promoted }),
      };
    } catch (error) {
      if (timer !== undefined) clearTimeout(timer);
      if (forcedKill !== undefined) clearTimeout(forcedKill);
      const compactInterrupted =
        turn.compact === true &&
        compactCommandStarted &&
        (signal.aborted ||
          timedOut ||
          (error instanceof Error && /timed out/iu.test(error.message)));
      if (compactInterrupted) {
        // Abort is an in-band Pi operation. Give it a chance to cancel the
        // compaction before closing; only a clean close plus transcript sync
        // makes this maintenance Turn reusable.
        try {
          abort();
          if (abortRequest !== undefined) await abortRequest;
          if (!abortAcknowledged)
            throw new Error("Pi compact abort was not acknowledged");
          if (forcedKill !== undefined) clearTimeout(forcedKill);
          await controller.closeCleanly();
          const compactTranscript =
            turn.transcriptPath === undefined
              ? undefined
              : syncTranscript(turn.transcriptPath, sessionDirectory);
          return {
            outcome: timedOut ? "timed-out" : "cancelled",
            text: "",
            sessionReusable: true,
            ...(compactTranscript === undefined
              ? {}
              : { transcriptPath: compactTranscript }),
          };
        } catch {
          // Fall through to the fail-closed kill/quarantine path.
        }
      }
      if (
        turn.compact === true &&
        compactCommandStarted &&
        error instanceof PiRpcCommandError &&
        error.command === "compact" &&
        !compactInterrupted
      ) {
        // A rejected compact has no prompt Turn to replay. Pi clears its
        // compaction state before returning this response. It may have already
        // appended an entry if a later extension hook failed; sync the actual
        // leaf after clean shutdown rather than assuming nothing was written.
        try {
          await controller.closeCleanly();
          const compactTranscript =
            turn.transcriptPath === undefined
              ? undefined
              : syncTranscript(turn.transcriptPath, sessionDirectory);
          return {
            outcome: "failed",
            text: "",
            error: error.message,
            sessionReusable: true,
            ...(compactTranscript === undefined
              ? {}
              : { transcriptPath: compactTranscript }),
          };
        } catch {
          // A failed close is ambiguous and must quarantine below.
        }
      }
      logPiRuntimeFailure({ phase, turnId: turn.turnId, error });
      if (phase === "attest")
        console.error(
          JSON.stringify({
            event: "pi-attest-debug",
            turnId: turn.turnId,
            detail: String(error).slice(0, 7000),
          }),
        );
      if (timer !== undefined) clearTimeout(timer);
      if (forcedKill !== undefined) clearTimeout(forcedKill);
      controller.kill();
      await controller.waitClosed();
      for (const artifact of promoted) this.#media.discard(artifact);
      return { outcome: "unknown", text: "", sessionReusable: false };
    } finally {
      signal.removeEventListener("abort", onExternalAbort);
      const cleaned = await cleanupSandboxUnits(this.#owner);
      if (!cleaned) {
        this.#poisoned = true;
        logPiRuntimeFailure({ phase: "cleanup", turnId: turn.turnId });
        throw new Error("sandbox process-tree cleanup could not be confirmed");
      }
      normalizeProfilePermissions(profileDir);
      rmSync(context.root, { recursive: true, force: true });
    }
  }
}
