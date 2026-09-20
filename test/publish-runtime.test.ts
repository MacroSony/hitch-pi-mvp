import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NativePiRuntime } from "../src/pi/native-runtime.js";
import type { RuntimeTurn } from "../src/runtime/runtime.js";

// NativePiRuntime deliberately permits a JSONL CLI only through this explicit
// test-only option. The fake Pi publishes through the real sandbox backend so
// these tests exercise the production descriptor-confined helper without a
// provider or production channel.
process.env.NODE_ENV = "test";

const HOST_SANDBOX_TESTS = process.env.HITCH_RUN_SANDBOX_TESTS === "1";

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function makeFakePi(root: string): string {
  const cli = join(root, "fake-pi.mjs");
  writeFileSync(
    cli,
    `import { appendFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const mode = process.env.HITCH_FAKE_PI_MODE;
const trace = process.env.HITCH_FAKE_PI_TRACE;
const log = process.env.HITCH_P0_LOG;
const extension = process.env.HITCH_P0_EXTENSION_PATH;
const expected = JSON.parse(process.env.HITCH_EXPECTED_TOOLS ?? "[]");
const sourcePaths = expected.map(() => extension);
writeFileSync(log, JSON.stringify({
  type: "startup-attestation",
  ready: true,
  controllerNonce: process.env.HITCH_P0_CONTROLLER_NONCE,
  userId: process.env.HITCH_P0_USER_ID,
  exactTools: expected,
  allTools: expected,
  activeTools: expected,
  sourcePaths,
  sourcePath: extension,
  schemaDigest: "0000000000000000000000000000000000000000000000000000000000000000",
  extensionDigest: process.env.HITCH_P0_EXTENSION_SHA256,
  sharedAuth: true,
  webSearchEnabled: false,
  antigravity: false
}) + "\\n");

const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const reply = (command, value) => send({ id: command.id, type: "response", command: command.type, ...value });
const remember = (type) => { if (trace) appendFileSync(trace, type + "\\n"); };

async function publishWorkspaceFile() {
  const workspace = process.env.HITCH_P0_WORKSPACE;
  const files = readdirSync(workspace).filter((name) => statSync(join(workspace, name)).isFile());
  if (files.length !== 1) throw new Error("fixture workspace must hold exactly one file");
  const backend = await import(pathToFileURL(join(dirname(process.env.HITCH_P0_WORKER), "sandbox-backend.mjs")).href);
  const artifactId = randomBytes(16).toString("hex");
  const result = await backend.executeSandboxRequest({
    workspace,
    inbox: process.env.HITCH_P0_INBOX,
    publishRoot: process.env.HITCH_P0_PUBLISH_ROOT,
    worker: process.env.HITCH_P0_WORKER,
    helper: process.env.HITCH_P0_HELPER,
    log: process.env.HITCH_P0_LOG,
    turnHandle: process.env.HITCH_P0_TURN_HANDLE,
    unitPrefix: process.env.HITCH_P0_UNIT_PREFIX,
    workerSha256: process.env.HITCH_P0_WORKER_SHA256,
    helperSha256: process.env.HITCH_P0_HELPER_SHA256,
    temporaryBytes: 4 * 1024 * 1024,
    memoryBytes: 256 * 1024 * 1024,
    maximumProcesses: 32,
    wallMilliseconds: 8_000
  }, { operation: "hitch_publish", input: { path: files[0], artifactId } });
  if (mode === "publish-unexpected")
    writeFileSync(join(process.env.HITCH_P0_PUBLISH_ROOT, "unexpected.bin"), "unexpected", { mode: 0o600 });
  if (trace) appendFileSync(trace, JSON.stringify({ artifactId, result }) + "\\n");
}

const handle = async (line) => {
  const command = JSON.parse(line);
  remember(command.type);
  if (command.type === "get_available_models") {
    reply(command, { success: true, data: { models: [{ provider: "fixture", id: "fake", name: "Fake", reasoning: false, input: ["text"] }] } });
  } else if (command.type === "set_model" || command.type === "set_thinking_level") {
    reply(command, { success: true });
  } else if (command.type === "get_session_stats") {
    reply(command, { success: true, data: { contextUsage: { tokens: null, contextWindow: 100000, percent: null } } });
  } else if (command.type === "get_state") {
    reply(command, { success: true, data: { model: { provider: "fixture", id: "fake" }, thinkingLevel: "off", sessionFile: process.argv[process.argv.indexOf("--session") + 1] } });
  } else if (command.type === "prompt") {
    reply(command, { success: true });
    if (mode === "publish" || mode === "publish-unexpected") await publishWorkspaceFile();
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Published" } });
    send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } });
    send({ type: "agent_settled" });
  }
};
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  handle(line).catch((error) => {
    if (trace) appendFileSync(trace, JSON.stringify({ failure: String(error?.message ?? error) }) + "\\n");
    process.exitCode = 2;
    input.close();
  });
});
input.on("close", () => process.exit(process.exitCode ?? 0));
`,
    { mode: 0o500 },
  );
  return cli;
}

interface Fixture {
  readonly root: string;
  readonly dataRoot: string;
  readonly workspace: string;
  readonly profile: string;
  readonly transcript: string;
  readonly runtime: NativePiRuntime;
}

async function fixture(
  mode: "publish" | "publish-unexpected",
): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "hitch-publish-runtime-"));
  chmodSync(root, 0o700);
  const dataRoot = join(root, "data");
  const workspace = join(root, "workspace");
  const profile = join(root, "profile");
  for (const path of [dataRoot, workspace, profile]) privateDirectory(path);
  writeFileSync(join(profile, "auth.json"), "{}\n", { mode: 0o600 });
  writeFileSync(join(profile, "models.json"), '{"providers":{}}\n', {
    mode: 0o600,
  });
  const cli = makeFakePi(root);
  process.env.HITCH_FAKE_PI_MODE = mode;
  process.env.HITCH_FAKE_PI_TRACE = join(root, "trace.log");
  // Avoid a provider/catalog network call while retaining the native profile
  // refresh path. NativePiRuntime falls back to Pi's local built-in catalog.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed: deterministic fake Pi");
  };
  let runtime: NativePiRuntime;
  try {
    runtime = await NativePiRuntime.create({
      dataRoot,
      piProfileDir: profile,
      userIds: ["alice"],
      testCliPath: cli,
      turnTimeoutMs: 20_000,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const sessionDirectory = join(dataRoot, "pi-sessions", "alice");
  privateDirectory(sessionDirectory);
  const transcript = join(sessionDirectory, "session.jsonl");
  writeFileSync(transcript, '{"type":"session","version":3}\n', {
    mode: 0o600,
  });
  return { root, dataRoot, workspace, profile, transcript, runtime };
}

function turn(
  fixtureValue: Fixture,
  changes: Partial<RuntimeTurn>,
): RuntimeTurn {
  return {
    turnId: "publish-turn",
    userId: "alice",
    sessionId: "session-1",
    piSessionId: "123e4567-e89b-12d3-a456-426614174000",
    transcriptPath: fixtureValue.transcript,
    workspace: fixtureValue.workspace,
    prompt: "publish the fixture file",
    modelProvider: "fixture",
    modelId: "fake",
    thinkingLevel: "off",
    ...changes,
  };
}

function dispose(fixtureValue: Fixture): void {
  rmSync(fixtureValue.root, { recursive: true, force: true });
}

function clearWorkspace(fixtureValue: Fixture): void {
  for (const name of readdirSync(fixtureValue.workspace))
    rmSync(join(fixtureValue.workspace, name), {
      recursive: true,
      force: true,
    });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const EXTENSION_CASES = [
  {
    name: "result.txt",
    body: "publication-txt",
    modelDisplay: /^published-[a-f0-9]{12}\.txt$/u,
    sendDisplay: "result.txt",
  },
  {
    name: "chart.svg",
    body: "<svg>publication</svg>",
    modelDisplay: /^published-[a-f0-9]{12}\.svg$/u,
    sendDisplay: "chart.svg",
  },
  {
    name: "report",
    body: "publication-no-extension",
    modelDisplay: /^published-[a-f0-9]{12}\.bin$/u,
    sendDisplay: "report",
  },
] as const;

test(
  "model publications promote extension-hinted snapshots and !send resolves them",
  { skip: !HOST_SANDBOX_TESTS, concurrency: false },
  async () => {
    const value = await fixture("publish");
    try {
      for (const entry of EXTENSION_CASES) {
        clearWorkspace(value);
        writeFileSync(join(value.workspace, entry.name), entry.body, {
          mode: 0o600,
        });
        const bytes = Buffer.byteLength(entry.body);
        const sha256 = digest(entry.body);

        // Model path: the fake Pi publishes through the real backend, then the
        // runtime promotes the blob it found in the publication directory.
        const model = await value.runtime.run(
          turn(value, { turnId: `model-${entry.name}` }),
          new AbortController().signal,
        );
        assert.equal(
          model.outcome,
          "succeeded",
          `${entry.name} model: ${model.error ?? ""}`,
        );
        assert.equal(model.artifacts?.length, 1, `${entry.name} model`);
        const modelArtifact = model.artifacts?.[0];
        assert.ok(modelArtifact, `${entry.name} model artifact`);
        assert.match(modelArtifact.displayName, entry.modelDisplay);
        assert.equal(modelArtifact.bytes, bytes);
        assert.equal(modelArtifact.sha256, sha256);

        // !send path: NativePiRuntime snapshots directly and must resolve the
        // renamed blob for both the extension and legacy no-extension names.
        const send = await value.runtime.run(
          turn(value, {
            turnId: `send-${entry.name}`,
            publishPath: entry.name,
          }),
          new AbortController().signal,
        );
        assert.equal(
          send.outcome,
          "succeeded",
          `${entry.name} send: ${send.error ?? ""}`,
        );
        assert.equal(send.artifacts?.length, 1, `${entry.name} send`);
        const sendArtifact = send.artifacts?.[0];
        assert.ok(sendArtifact, `${entry.name} send artifact`);
        assert.equal(sendArtifact.displayName, entry.sendDisplay);
        assert.equal(sendArtifact.bytes, bytes);
        assert.equal(sendArtifact.sha256, sha256);
      }
    } finally {
      dispose(value);
    }
  },
);

test(
  "an unexpected publication directory entry fails the model turn closed",
  { skip: !HOST_SANDBOX_TESTS, concurrency: false },
  async () => {
    const value = await fixture("publish-unexpected");
    try {
      writeFileSync(join(value.workspace, "report.txt"), "publication", {
        mode: 0o600,
      });
      const result = await value.runtime.run(
        turn(value, { turnId: "unexpected-snapshot" }),
        new AbortController().signal,
      );
      assert.equal(result.outcome, "unknown");
      assert.equal(result.sessionReusable, false);
      assert.equal(result.artifacts, undefined);
    } finally {
      dispose(value);
    }
  },
);
