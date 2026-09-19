import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NativePiRuntime } from "../src/pi/native-runtime.js";
import type { RuntimeResult, RuntimeTurn } from "../src/runtime/runtime.js";

// NativePiRuntime deliberately permits a JSONL CLI only through this explicit
// test-only option. The fake still exercises PiRpcProcess, response envelopes,
// clean stdin shutdown, and the NativePiRuntime turn path.
process.env.NODE_ENV = "test";

type FakeMode =
  | "success"
  | "noop"
  | "reject"
  | "unknown-reject"
  | "malformed"
  | "crash"
  | "close-fail"
  | "hang"
  | "abort-fail";

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function makeFakePi(root: string): string {
  const cli = join(root, "fake-pi.mjs");
  writeFileSync(
    cli,
    `import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

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
let compactSeen = false;
let pendingCompact;
const handle = (line) => {
  const command = JSON.parse(line);
  remember(command.type);
  if (command.type === "get_available_models") {
    reply(command, { success: true, data: { models: [{ provider: "fixture", id: "fake", name: "Fake", reasoning: false, input: ["text"] }] } });
  } else if (command.type === "set_model" || command.type === "set_thinking_level") {
    reply(command, { success: true });
  } else if (command.type === "abort") {
    if (mode === "abort-fail") { reply(command, { success: false, error: "fixture abort failure" }); return; }
    if (pendingCompact) reply(pendingCompact, { success: false, error: "Compaction cancelled" });
    reply(command, { success: true });
  } else if (command.type === "compact") {
    compactSeen = true;
    if (mode === "hang" || mode === "abort-fail") { pendingCompact = command; return; }
    if (mode === "crash") process.kill(process.pid, "SIGKILL");
    if (mode === "noop") {
      reply(command, { success: false, error: "Nothing to compact (session too small)" });
    } else if (mode === "reject") {
      reply(command, { success: false, error: "Summarization failed: bearer secret=fixture-secret transcript=private text " + "provider detail ".repeat(10000) });
    } else if (mode === "unknown-reject") {
      reply(command, { success: false, error: "provider body: Nothing to compact (session too small) bearer fixture-secret private text" });
    } else if (mode === "malformed") {
      reply(command, { success: true, data: { tokensBefore: "not-a-number" } });
    } else {
      reply(command, { success: true, data: { summary: "fixture summary", firstKeptEntryId: "entry-1", tokensBefore: 120, estimatedTokensAfter: 40 } });
    }
  }
};
const input = createInterface({ input: process.stdin });
input.on("line", (line) => { try { handle(line); } catch { process.exitCode = 2; input.close(); } });
input.on("close", () => { process.exit(mode === "close-fail" && compactSeen ? 1 : 0); });
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
  readonly trace: string;
  readonly cli: string;
  readonly runtime: NativePiRuntime;
}

async function fixture(
  mode: FakeMode,
  turnTimeoutMs = 2_000,
): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "hitch-compact-runtime-"));
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
  const trace = join(root, "trace.log");
  process.env.HITCH_FAKE_PI_MODE = mode;
  process.env.HITCH_FAKE_PI_TRACE = trace;
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
      turnTimeoutMs,
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
  return {
    root,
    dataRoot,
    workspace,
    profile,
    transcript,
    trace,
    cli,
    runtime,
  };
}

function turn(fixture: Fixture): RuntimeTurn {
  return {
    turnId: "compact-turn",
    userId: "alice",
    sessionId: "session-1",
    piSessionId: "123e4567-e89b-12d3-a456-426614174000",
    transcriptPath: fixture.transcript,
    workspace: fixture.workspace,
    prompt: "not sent for compact maintenance turns",
    modelProvider: "fixture",
    modelId: "fake",
    thinkingLevel: "off",
    compact: true,
  };
}

function dispose(fixture: Fixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function runFixture(
  mode: FakeMode,
  changes: Partial<RuntimeTurn> = {},
  turnTimeoutMs = 2_000,
): Promise<{ readonly fixture: Fixture; readonly result: RuntimeResult }> {
  const fixtureValue = await fixture(mode, turnTimeoutMs);
  try {
    const result = await fixtureValue.runtime.run(
      { ...turn(fixtureValue), ...changes },
      new AbortController().signal,
    );
    return { fixture: fixtureValue, result };
  } catch (error) {
    dispose(fixtureValue);
    throw error;
  }
}

test(
  "compact consumes Pi 0.85.1 response.data and durably closes the controller",
  { concurrency: false },
  async () => {
    const { fixture: value, result } = await runFixture("success");
    try {
      assert.deepEqual(result, {
        outcome: "succeeded",
        text: "Context compacted: ~120 tokens before, ~40 tokens after.",
        sessionReusable: true,
        transcriptPath: value.transcript,
      });
      assert.match(readFileSafe(value.trace), /compact/u);
      assert.equal(
        readFileSync(value.transcript, "utf8"),
        '{"type":"session","version":3}\n',
      );
    } finally {
      dispose(value);
    }
  },
);

test(
  "clean rejected/no-op compaction is actionable and keeps the session reusable",
  { concurrency: false },
  async () => {
    const { fixture: value, result } = await runFixture("noop");
    try {
      assert.equal(result.outcome, "failed");
      assert.equal(result.sessionReusable, true);
      assert.match(result.error ?? "", /already compacted or too small/u);
      assert.doesNotMatch(
        result.error ?? "",
        /fixture-secret|private text|transcript/iu,
      );
    } finally {
      dispose(value);
    }
  },
);

test(
  "provider rejection remains safe when Pi closes cleanly",
  { concurrency: false },
  async () => {
    const { fixture: value, result } = await runFixture("reject");
    try {
      assert.equal(result.outcome, "failed");
      assert.equal(result.sessionReusable, true);
      assert.match(result.error ?? "", /retry is safe/u);
      assert.ok((result.error ?? "").length <= 200);
      assert.doesNotMatch(
        result.error ?? "",
        /fixture-secret|private text|provider detail/iu,
      );
    } finally {
      dispose(value);
    }
  },
);

test(
  "malformed metadata, a crashed Pi, or a failed close quarantines safely",
  { concurrency: false },
  async () => {
    for (const mode of ["malformed", "crash", "close-fail"] as const) {
      const { fixture: value, result } = await runFixture(mode);
      try {
        assert.equal(result.outcome, "unknown", mode);
        assert.equal(result.sessionReusable, false, mode);
      } finally {
        dispose(value);
      }
    }
  },
);

test(
  "a missing previously durable transcript fails closed before compact RPC",
  { concurrency: false },
  async () => {
    const value = await fixture("success");
    try {
      const result = await value.runtime.run(
        {
          ...turn(value),
          transcriptPath: join(value.root, "missing-session.jsonl"),
        },
        new AbortController().signal,
      );
      assert.deepEqual(result, {
        outcome: "unknown",
        text: "",
        sessionReusable: false,
      });
      assert.doesNotMatch(readFileSafe(value.trace), /compact/u);
    } finally {
      dispose(value);
    }
  },
);

test("a new session without history does not invoke compact or quarantine", async () => {
  const value = await fixture("success");
  try {
    const { transcriptPath: _unused, ...emptyTurn } = turn(value);
    const result = await value.runtime.run(
      emptyTurn,
      new AbortController().signal,
    );
    assert.equal(result.outcome, "succeeded");
    assert.equal(result.sessionReusable, true);
    assert.match(result.text, /Nothing to compact yet/u);
    assert.doesNotMatch(readFileSafe(value.trace), /compact/u);
  } finally {
    dispose(value);
  }
});

test("compact timeout requires acknowledged abort plus clean close to reuse", async () => {
  for (const mode of ["hang", "abort-fail"] as const) {
    const { fixture: value, result } = await runFixture(mode, {}, 1_000);
    try {
      assert.equal(
        result.outcome,
        mode === "hang" ? "timed-out" : "unknown",
        mode,
      );
      assert.equal(result.sessionReusable, mode === "hang", mode);
      assert.match(readFileSafe(value.trace), /abort/u);
    } finally {
      dispose(value);
    }
  }
});

test("compact external cancellation remains reusable only after quiescence", async () => {
  const value = await fixture("hang");
  const controller = new AbortController();
  try {
    const run = value.runtime.run(turn(value), controller.signal);
    const deadline = Date.now() + 2_000;
    while (!readFileSafe(value.trace).split("\n").includes("compact")) {
      if (Date.now() > deadline) {
        controller.abort();
        await run;
        assert.fail("compact did not start");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    const result = await run;
    assert.equal(result.outcome, "cancelled");
    assert.equal(result.sessionReusable, true);
    assert.equal(result.transcriptPath, value.transcript);
  } finally {
    dispose(value);
  }
});

test("unknown compact rejection is safe and embedded no-op text is not classified", async () => {
  const { fixture: value, result } = await runFixture("unknown-reject");
  try {
    assert.equal(result.outcome, "failed");
    assert.equal(result.sessionReusable, true);
    assert.equal(result.error, "Pi rejected compact RPC command");
    assert.doesNotMatch(
      result.error ?? "",
      /fixture-secret|private text|too small/u,
    );
  } finally {
    dispose(value);
  }
});
