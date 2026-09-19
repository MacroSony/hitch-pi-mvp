import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Focused protocol test against the installed, pinned Pi 0.85.1 CLI. It starts
// Pi's public RPC entry with a disposable profile/session and a tiny
// operator-fixture extension, then speaks raw RPC. It deliberately does not
// exercise the Hitch sandbox: the fake-JSONL NativePiRuntime tests cover
// response-envelope and error-path handling. No provider credential and no
// provider request is used: the fixture answers `session_before_compact` with
// a fixed valid compaction, and its provider points at a closed loopback port.
//
// Source review for abort (Pi 0.85.1 `agent-session.js`):
// `session.abort()` awaits `waitForIdle()`, and `isIdle` is false while
// `_compactionAbortController` exists (`isCompacting`). Manual `compact()`
// clears that controller before it emits `compaction_end` and rethrows on the
// cancellation path, and after `appendCompaction` on the success path.
// Therefore `await session.abort()` does wait for an in-flight manual
// compaction to stop being marked in progress, but it is not the same as
// awaiting the compact command's own RPC response. Callers must still await
// the separate compact response.

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const piCodingAgentRoot = join(
  repositoryRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
);
const piAiRoot = join(
  repositoryRoot,
  "node_modules",
  "@earendil-works",
  "pi-ai",
);
const piCli = join(piCodingAgentRoot, "dist", "cli.js");

const FIXTURE_PROVIDER = "hitch-compact-protocol-fixture";
const FIXTURE_MODEL = "fixture-model";
const FIXTURE_SUMMARY = "disposable protocol fixture compaction";
const FIXED_TIMESTAMP = "2024-01-01T00:00:00.000Z";
const MAX_CAPTURED_EVENTS = 200;
const MAX_CAPTURED_STDERR = 4_096;
const SESSION_VERSION = 3;

type RpcRecord = Record<string, unknown>;

interface Fixture {
  readonly root: string;
  readonly profile: string;
  readonly sessions: string;
  readonly workspace: string;
  readonly transcript: string;
  readonly extension: string;
  readonly sessionId: string;
}

interface ClosedResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface PendingResponse {
  readonly resolve: (value: RpcRecord) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly command: string;
}

interface EventWaiter {
  readonly resolve: (value: RpcRecord) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface PiController {
  readonly send: (command: RpcRecord, timeoutMs?: number) => Promise<RpcRecord>;
  readonly waitForEvent: (
    type: string,
    timeoutMs?: number,
  ) => Promise<RpcRecord>;
  readonly close: () => Promise<void>;
  readonly terminate: () => Promise<void>;
  readonly outputOrder: () => readonly string[];
}

function installedVersion(packageRoot: string): unknown {
  const parsed = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  ) as { version?: unknown };
  return parsed.version;
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function fixtureId(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function writeFixtureExtension(root: string): string {
  const extension = join(root, "pi-compact-protocol-extension.mjs");
  writeFileSync(
    extension,
    `export default function (pi) {
  // Disposable operator fixture. The provider entry exists only so
  // set_model can select a model offline. The base URL points at a closed
  // loopback port and the placeholder key is not a credential.
  pi.registerProvider(${JSON.stringify(FIXTURE_PROVIDER)}, {
    name: "Disposable compact protocol fixture",
    baseUrl: "http://127.0.0.1:9",
    apiKey: "disposable-fixture-placeholder",
    api: "openai-completions",
    models: [{
      id: ${JSON.stringify(FIXTURE_MODEL)},
      name: "Disposable compact protocol fixture",
      reasoning: false,
      input: ["text"],
      contextWindow: 100000,
      maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }]
  });
  pi.on("session_before_compact", async (event) => {
    if (process.env.HITCH_PI_COMPACT_PROTOCOL_ABORT === "1") {
      await new Promise((resolve) => {
        if (event.signal.aborted) resolve(undefined);
        else event.signal.addEventListener("abort", () => resolve(undefined), { once: true });
      });
      return { cancel: true };
    }
    return {
      compaction: {
        summary: ${JSON.stringify(FIXTURE_SUMMARY)},
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore
      }
    };
  });
}
`,
    { mode: 0o500 },
  );
  return extension;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "hitch-pi-compact-protocol-"));
  chmodSync(root, 0o700);
  const profile = join(root, "profile");
  const sessions = join(root, "sessions");
  const workspace = join(root, "workspace");
  for (const path of [profile, sessions, workspace]) privateDirectory(path);
  writeFileSync(join(profile, "auth.json"), "{}\n", { mode: 0o600 });
  writeFileSync(join(profile, "models.json"), '{"providers":{}}\n', {
    mode: 0o600,
  });
  writeFileSync(
    join(profile, "settings.json"),
    `${JSON.stringify({
      compaction: {
        enabled: true,
        reserveTokens: 16_384,
        keepRecentTokens: 10,
      },
    })}\n`,
    { mode: 0o600 },
  );
  return {
    root,
    profile,
    sessions,
    workspace,
    transcript: join(root, "session.jsonl"),
    extension: writeFixtureExtension(root),
    sessionId: fixtureId(0xf00d),
  };
}

function writeFixtureSession(path: string, cwd: string): void {
  const entries: RpcRecord[] = [];
  let parentId: string | null = null;
  entries.push({
    type: "session",
    version: SESSION_VERSION,
    id: fixtureId(1),
    timestamp: FIXED_TIMESTAMP,
    cwd,
  });
  for (let index = 0; index < 4; index += 1) {
    const userId = fixtureId(0x100 + index * 2);
    entries.push({
      type: "message",
      id: userId,
      parentId,
      timestamp: FIXED_TIMESTAMP,
      message: {
        role: "user",
        content: `fixture history ${index} `.repeat(64),
        timestamp: Date.parse(FIXED_TIMESTAMP) + index * 1_000,
      },
    });
    parentId = userId;
    const assistantId = fixtureId(0x101 + index * 2);
    entries.push({
      type: "message",
      id: assistantId,
      parentId,
      timestamp: FIXED_TIMESTAMP,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: `fixture answer ${index} `.repeat(64) },
        ],
        api: "openai-completions",
        provider: FIXTURE_PROVIDER,
        model: FIXTURE_MODEL,
        usage: {
          input: 100,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 200,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.parse(FIXED_TIMESTAMP) + index * 1_000 + 1,
      },
    });
    parentId = assistantId;
  }
  writeFileSync(
    path,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    { mode: 0o600 },
  );
}

function readJsonl(path: string): RpcRecord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RpcRecord);
}

function piArguments(
  fixture: Fixture,
  sessionFile: string | undefined,
): string[] {
  return [
    "--mode",
    "rpc",
    "--offline",
    "--no-extensions",
    "--extension",
    fixture.extension,
    "--no-tools",
    "--no-builtin-tools",
    "--exclude-tools",
    "powershell",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--session-dir",
    fixture.sessions,
    ...(sessionFile === undefined
      ? ["--session-id", fixture.sessionId]
      : ["--session", sessionFile]),
  ];
}

function piEnvironment(fixture: Fixture, abort: boolean): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: fixture.profile,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    PI_CODING_AGENT_DIR: fixture.profile,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    ...(abort ? { HITCH_PI_COMPACT_PROTOCOL_ABORT: "1" } : {}),
  };
}

function startPi(
  fixture: Fixture,
  sessionFile: string | undefined,
  abort: boolean,
): PiController {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [piCli, ...piArguments(fixture, sessionFile)],
    {
      cwd: repositoryRoot,
      env: piEnvironment(fixture, abort),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const pending = new Map<string, PendingResponse>();
  const eventWaiters = new Map<string, EventWaiter[]>();
  const events: RpcRecord[] = [];
  const output: string[] = [];
  let stderr = "";
  let buffer = "";
  let closedResult: ClosedResult | undefined;
  let resolveClosed: (value: ClosedResult) => void = () => undefined;
  const closedPromise = new Promise<ClosedResult>((resolve) => {
    resolveClosed = resolve;
  });

  const rejectAll = (error: Error): void => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
    for (const waiters of eventWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    eventWaiters.clear();
  };

  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        rejectAll(new Error("installed Pi emitted invalid JSON on RPC stdout"));
        child.kill("SIGKILL");
        return;
      }
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        rejectAll(new Error("installed Pi emitted a non-object RPC line"));
        child.kill("SIGKILL");
        return;
      }
      const record = parsed as RpcRecord;
      const id = typeof record.id === "string" ? record.id : undefined;
      if (record.type === "response" && id !== undefined) {
        const item = pending.get(id);
        if (item !== undefined) {
          pending.delete(id);
          clearTimeout(item.timer);
          output.push(`response:${item.command}`);
          item.resolve(record);
          continue;
        }
      }
      events.push(record);
      if (events.length > MAX_CAPTURED_EVENTS) events.shift();
      const type = typeof record.type === "string" ? record.type : "";
      output.push(`event:${type}`);
      const waiters = eventWaiters.get(type);
      if (waiters !== undefined) {
        eventWaiters.delete(type);
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(record);
        }
      }
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-MAX_CAPTURED_STDERR);
  });
  child.on("error", (error: Error) => {
    rejectAll(error);
  });
  child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
    closedResult = { code, signal };
    rejectAll(
      new Error(
        `installed Pi closed before the RPC completed (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      ),
    );
    resolveClosed({ code, signal });
  });

  return {
    send(command, timeoutMs = 10_000): Promise<RpcRecord> {
      const id = randomUUID();
      return new Promise<RpcRecord>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              `installed Pi response timed out for ${String(command.type)}`,
            ),
          );
        }, timeoutMs);
        pending.set(id, {
          resolve,
          reject,
          timer,
          command: typeof command.type === "string" ? command.type : "unknown",
        });
        child.stdin.write(
          `${JSON.stringify({ ...command, id })}\n`,
          (error) => {
            if (error === null || error === undefined) return;
            clearTimeout(timer);
            pending.delete(id);
            reject(error);
          },
        );
      });
    },
    waitForEvent(type, timeoutMs = 10_000): Promise<RpcRecord> {
      const existing = events.find((event) => event.type === type);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<RpcRecord>((resolve, reject) => {
        const timer = setTimeout(() => {
          const waiters = eventWaiters.get(type);
          if (waiters !== undefined) {
            const index = waiters.findIndex(
              (waiter) => waiter.resolve === resolve,
            );
            if (index >= 0) waiters.splice(index, 1);
            if (waiters.length === 0) eventWaiters.delete(type);
          }
          reject(new Error(`installed Pi event timed out: ${type}`));
        }, timeoutMs);
        const waiters = eventWaiters.get(type) ?? [];
        waiters.push({ resolve, reject, timer });
        eventWaiters.set(type, waiters);
      });
    },
    async close(): Promise<void> {
      if (closedResult !== undefined) {
        assert.equal(
          closedResult.code,
          0,
          `installed Pi exited non-zero (code=${closedResult.code ?? "null"}): ${stderr}`,
        );
        assert.equal(
          closedResult.signal,
          null,
          `installed Pi was signalled: ${String(closedResult.signal)}`,
        );
        return;
      }
      child.stdin.end();
      const result = await closedPromise;
      assert.equal(
        result.code,
        0,
        `installed Pi exited non-zero (code=${result.code ?? "null"}): ${stderr}`,
      );
      assert.equal(
        result.signal,
        null,
        `installed Pi was signalled: ${String(result.signal)}`,
      );
    },
    async terminate(): Promise<void> {
      if (closedResult === undefined) child.kill("SIGKILL");
      await closedPromise;
    },
    outputOrder(): readonly string[] {
      return [...output];
    },
  };
}

async function selectFixtureModel(controller: PiController): Promise<void> {
  const response = await controller.send({
    type: "set_model",
    provider: FIXTURE_PROVIDER,
    modelId: FIXTURE_MODEL,
  });
  assert.equal(response.type, "response");
  assert.equal(
    response.success,
    true,
    `fixture set_model failed: ${String(response.error)}`,
  );
}

async function assertGetStateUsable(
  controller: PiController,
  transcript?: string,
): Promise<RpcRecord> {
  const response = await controller.send({ type: "get_state" });
  assert.equal(response.type, "response");
  assert.equal(
    response.success,
    true,
    `get_state failed: ${String(response.error)}`,
  );
  const data = response.data as RpcRecord;
  assert.equal(data.isCompacting, false);
  if (transcript !== undefined) {
    assert.equal(data.sessionFile, transcript);
    assert.ok(Number(data.messageCount) > 0);
  }
  return data;
}

test(
  "installed Pi packages match the pinned 0.85.1 protocol",
  { concurrency: false },
  () => {
    assert.equal(installedVersion(piCodingAgentRoot), "0.85.1");
    assert.equal(installedVersion(piAiRoot), "0.85.1");
    assert.equal(existsSync(piCli), true, `missing installed Pi CLI: ${piCli}`);
  },
);

test(
  "pinned Pi 0.85.1 RPC compact returns response.data and appends one compaction entry to the real session JSONL",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const fixture = makeFixture();
    let controller: PiController | undefined;
    try {
      writeFixtureSession(fixture.transcript, fixture.workspace);
      controller = startPi(fixture, fixture.transcript, false);
      await selectFixtureModel(controller);

      const compacted = await controller.send({ type: "compact" });
      assert.equal(compacted.type, "response");
      assert.equal(
        compacted.success,
        true,
        `compact failed: ${String(compacted.error)}`,
      );
      const data = compacted.data as RpcRecord;
      assert.equal(data.summary, FIXTURE_SUMMARY);
      assert.equal(typeof data.firstKeptEntryId, "string");
      assert.equal(typeof data.tokensBefore, "number");
      assert.equal(typeof data.estimatedTokensAfter, "number");
      assert.ok(Number(data.estimatedTokensAfter) >= 0);

      await assertGetStateUsable(controller, fixture.transcript);

      const already = await controller.send({ type: "compact" });
      assert.equal(already.type, "response");
      assert.equal(already.success, false);
      assert.equal(already.error, "Already compacted");
      await assertGetStateUsable(controller, fixture.transcript);

      await controller.close();
      controller = undefined;

      const compactions = readJsonl(fixture.transcript).filter(
        (entry) => entry.type === "compaction",
      );
      assert.equal(compactions.length, 1);
      const compaction = compactions[0];
      assert.ok(compaction !== undefined);
      assert.equal(compaction.summary, FIXTURE_SUMMARY);
      assert.equal(compaction.firstKeptEntryId, data.firstKeptEntryId);
      assert.equal(compaction.tokensBefore, data.tokensBefore);
      assert.equal(compaction.fromHook, true);
    } finally {
      await controller?.terminate();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "pinned Pi 0.85.1 RPC compact reports an empty-session no-op with success:false and remains usable",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const fixture = makeFixture();
    let controller: PiController | undefined;
    try {
      assert.equal(existsSync(fixture.transcript), false);
      controller = startPi(fixture, undefined, false);
      await selectFixtureModel(controller);

      const noop = await controller.send({ type: "compact" });
      assert.equal(noop.type, "response");
      assert.equal(noop.success, false);
      assert.equal(noop.error, "Nothing to compact (session too small)");

      const state = await assertGetStateUsable(controller);
      assert.equal(typeof state.messageCount, "number");
      assert.ok(Number(state.messageCount) >= 0);

      await controller.close();
      controller = undefined;
    } finally {
      await controller?.terminate();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "pinned Pi 0.85.1 RPC abort cancels in-flight manual compaction without appending an entry and leaves the session usable",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const fixture = makeFixture();
    let controller: PiController | undefined;
    try {
      writeFixtureSession(fixture.transcript, fixture.workspace);
      controller = startPi(fixture, fixture.transcript, true);
      await selectFixtureModel(controller);

      const started = controller.waitForEvent("compaction_start");
      const ended = controller.waitForEvent("compaction_end");
      const compactPromise = controller.send({ type: "compact" });
      await started;
      const abortPromise = controller.send({ type: "abort" });
      const [abortResponse, endEvent] = await Promise.all([
        abortPromise,
        ended,
      ]);
      assert.equal(abortResponse.type, "response");
      assert.equal(
        abortResponse.success,
        true,
        `abort failed: ${String(abortResponse.error)}`,
      );
      assert.equal(endEvent.type, "compaction_end");
      assert.equal(endEvent.aborted, true);

      // Pi clears the manual-compaction state before compaction_end here, so
      // the cancel event is emitted before the abort RPC response. The compact
      // command's own response is a separate RPC exchange.
      const order = controller.outputOrder();
      assert.ok(order.includes("event:compaction_end"));
      assert.ok(order.includes("response:abort"));
      assert.ok(
        order.indexOf("event:compaction_end") < order.indexOf("response:abort"),
      );

      // `abort` waits for `waitForIdle()` (and therefore for isCompacting to
      // clear), but it does not return the compact command's result.
      const abortState = await controller.send({ type: "get_state" });
      assert.equal(abortState.type, "response");
      assert.equal(abortState.success, true);
      assert.equal((abortState.data as RpcRecord).isCompacting, false);

      const compactResponse = await compactPromise;
      assert.equal(compactResponse.type, "response");
      assert.equal(compactResponse.success, false);
      assert.equal(compactResponse.error, "Compaction cancelled");

      await assertGetStateUsable(controller, fixture.transcript);
      await controller.close();
      controller = undefined;

      const entries = readJsonl(fixture.transcript);
      assert.equal(
        entries.some((entry) => entry.type === "compaction"),
        false,
      );
      const last = entries.at(-1);
      assert.ok(last !== undefined);
      assert.notEqual(last.type, "compaction");
    } finally {
      await controller?.terminate();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);
