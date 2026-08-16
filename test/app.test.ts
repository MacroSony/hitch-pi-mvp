import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HitchApplication } from "../src/app/application.js";
import {
  HitchStore,
  type IdSource,
  type MessageIdentity,
} from "../src/app/store.js";
import {
  TelegramBotClient,
  TelegramError,
  TelegramWorker,
} from "../src/channels/telegram.js";
import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import type { Clock } from "../src/foundation/database.js";
import {
  FakeAgentRuntime,
  type AgentRuntime,
  type RuntimeArtifact,
  type RuntimeModel,
  type RuntimeResult,
  type RuntimeTurn,
} from "../src/runtime/runtime.js";

class Sequence implements IdSource, Clock {
  #value = 0;

  public next(kind: "session" | "pi" | "turn" | "outbox"): string {
    this.#value += 1;
    return `${kind}_${String(this.#value).padStart(8, "0")}`;
  }

  public now(): number {
    this.#value += 1;
    return this.#value;
  }
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "hitch-app-test-"));
  chmodSync(root, 0o700);
  const paths = {
    dataRoot: join(root, "data"),
    piProfileDir: join(root, "pi"),
    wechat: join(root, "wechat"),
    alice: join(root, "alice"),
    bob: join(root, "bob"),
  };
  for (const path of [paths.piProfileDir, paths.wechat, paths.alice, paths.bob])
    privateDirectory(path);
  const config = parseConfig({
    schemaVersion: 1,
    dataRoot: paths.dataRoot,
    piProfileDir: paths.piProfileDir,
    minimumFreeBytes: 0,
    telegramAccounts: [{ id: "primary", botTokenEnv: "HITCH_TEST_TOKEN" }],
    wechatAccounts: [{ id: "primary", stateDir: paths.wechat }],
    users: [
      {
        id: "alice",
        workspace: paths.alice,
        telegram: { account: "primary", userId: "101", privateChatId: "101" },
      },
      {
        id: "bob",
        workspace: paths.bob,
        telegram: { account: "primary", userId: "202", privateChatId: "202" },
      },
    ],
  });
  const foundation = bootstrapFoundation(config);
  const sequence = new Sequence();
  const store = new HitchStore(foundation.database, sequence, sequence);
  return { foundation, store, paths, sequence };
}

function update(
  updateId: number,
  userId: string,
  text: string,
  options: { chatId?: string; chatType?: string } = {},
) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 100,
      chat: {
        id: options.chatId ?? userId,
        type: options.chatType ?? "private",
      },
      from: { id: userId },
      text,
    },
  };
}

test("two Telegram users remain isolated and duplicate prompts do not rerun", async () => {
  const environment = setup();
  const calls: RuntimeTurn[] = [];
  const runtime = new FakeAgentRuntime((turn) => {
    calls.push(turn);
    return {
      outcome: "succeeded",
      text: `answer for ${turn.userId}`,
      sessionReusable: true,
    };
  });
  const app = new HitchApplication(environment.store, runtime);
  app.start();

  assert.equal(
    app.receiveTelegram("primary", update(1, "101", "alice prompt")).accepted,
    true,
  );
  assert.equal(
    app.receiveTelegram("primary", update(2, "202", "bob prompt")).accepted,
    true,
  );
  assert.equal(
    app.receiveTelegram(
      "primary",
      update(3, "101", "group", { chatType: "group" }),
    ).accepted,
    false,
  );
  assert.equal(
    app.receiveTelegram(
      "primary",
      update(4, "202", "wrong tuple", { chatId: "101" }),
    ).accepted,
    false,
  );
  await app.drain();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ userId }) => userId).sort(), ["alice", "bob"]);
  assert.equal(environment.store.count("turns", "alice"), 1);
  assert.equal(environment.store.count("turns", "bob"), 1);
  assert.equal(environment.store.pendingTelegramOutbox("primary").length, 2);

  const duplicate = app.receiveTelegram(
    "primary",
    update(1, "101", "alice prompt"),
  );
  assert.equal(duplicate.accepted, true);
  assert.equal(duplicate.duplicate, true);
  await app.drain();
  assert.equal(calls.length, 2);

  const conflict = app.receiveTelegram(
    "primary",
    update(1, "101", "changed prompt"),
  );
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.category, "rejected");
  assert.equal(environment.store.count("turns", "alice"), 1);
  environment.foundation.close();
});

test("session commands are durable, idempotent, and owner scoped", () => {
  const environment = setup();
  const app = new HitchApplication(environment.store, new FakeAgentRuntime());
  app.start();
  const first = app.receiveTelegram(
    "primary",
    update(10, "101", "!new project"),
  );
  assert.equal(first.accepted, true);
  assert.equal(environment.store.count("sessions", "alice"), 1);
  const duplicate = app.receiveTelegram(
    "primary",
    update(10, "101", "!new project"),
  );
  assert.equal(duplicate.duplicate, true);
  assert.equal(environment.store.count("sessions", "alice"), 1);

  assert.equal(
    app.receiveTelegram("primary", update(16, "101", "!new second")).accepted,
    true,
  );
  const project = environment.foundation.database.connection
    .prepare("SELECT id FROM sessions WHERE user_id = ? AND name = ?")
    .get("alice", "project") as { id: string };
  const selector = project.id.startsWith("session_")
    ? project.id.slice(8, 16)
    : project.id.slice(0, 8);
  assert.equal(
    app.receiveTelegram("primary", update(17, "101", `!switch ${selector}`))
      .accepted,
    true,
  );

  assert.equal(
    app.receiveTelegram("primary", update(11, "202", "!new bob-only")).accepted,
    true,
  );
  const crossOwner = app.receiveTelegram(
    "primary",
    update(12, "101", "!switch bob-only"),
  );
  assert.equal(crossOwner.accepted, false);
  assert.equal(crossOwner.category, "rejected");

  assert.equal(
    app.receiveTelegram("primary", update(13, "101", "!sessions")).accepted,
    true,
  );
  assert.equal(
    app.receiveTelegram("primary", update(14, "101", "!status")).accepted,
    true,
  );
  assert.equal(
    app.receiveTelegram("primary", update(15, "101", "!stop")).accepted,
    true,
  );
  assert.equal(environment.store.pendingTelegramOutbox("primary").length, 7);
  environment.foundation.close();
});

test("help lists commands and send validates workspace files before dispatch", () => {
  const environment = setup();
  writeFileSync(join(environment.paths.alice, "hello.txt"), "hello");
  mkdirSync(join(environment.paths.alice, "subdir"), { mode: 0o700 });
  const app = new HitchApplication(environment.store, new FakeAgentRuntime());
  app.start();

  assert.equal(
    app.receiveTelegram("primary", update(40, "101", "!help")).accepted,
    true,
  );
  const help = environment.store
    .pendingTelegramOutbox("primary")
    .map(({ text }) => text)
    .join("\n");
  assert.match(help, /!send <relative-path>/u);
  assert.match(help, /!recover/u);

  assert.equal(
    app.receiveTelegram("primary", update(41, "101", "!send hello.txt"))
      .accepted,
    true,
  );
  const missing = app.receiveTelegram(
    "primary",
    update(42, "101", "!send missing.txt"),
  );
  assert.equal(missing.accepted, false);
  assert.equal(missing.category, "rejected");
  assert.match(missing.message ?? "", /does not exist/u);

  const escaping = app.receiveTelegram(
    "primary",
    update(43, "101", "!send ../outside.txt"),
  );
  assert.equal(escaping.accepted, false);
  assert.equal(escaping.category, "rejected");
  assert.match(escaping.message ?? "", /inside the workspace/u);

  const directory = app.receiveTelegram(
    "primary",
    update(44, "101", "!send subdir"),
  );
  assert.equal(directory.accepted, false);
  assert.equal(directory.category, "rejected");
  assert.match(directory.message ?? "", /not a regular file/u);

  environment.foundation.close();
});

test("text-trigger stages media-only messages and merges them with the next text", async () => {
  const environment = setup();
  const artifact: RuntimeArtifact = {
    id: "artifact_00000000-0000-4000-8000-000000000001",
    userId: "alice",
    storageKey: "alice/00000000-0000-4000-8000-000000000001.blob",
    sha256: "a".repeat(64),
    bytes: 10,
    mediaKind: "file",
    mimeType: "text/plain",
    displayName: "notes.txt",
  };
  environment.foundation.database.connection
    .prepare(
      `INSERT INTO artifacts(
         id, user_id, storage_key, sha256, bytes, media_kind, mime_type,
         display_name, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      artifact.id,
      artifact.userId,
      artifact.storageKey,
      artifact.sha256,
      artifact.bytes,
      artifact.mediaKind,
      artifact.mimeType,
      artifact.displayName,
      1,
    );
  const turns: RuntimeTurn[] = [];
  const runtime = new FakeAgentRuntime(async (turn) => {
    turns.push(turn);
    return { outcome: "succeeded", text: "done", sessionReusable: true };
  });
  const application = new HitchApplication(
    environment.store,
    runtime,
    "text-trigger",
  );
  application.start();

  const staged = application.receiveTelegram(
    "primary",
    {
      update_id: 60,
      message: {
        message_id: 160,
        chat: { id: "101", type: "private" },
        from: { id: "101" },
        document: {
          file_id: "file-notes",
          file_size: 10,
          file_name: "notes.txt",
          mime_type: "text/plain",
        },
      },
    },
    [artifact],
  );
  assert.equal(staged.accepted, true);
  assert.equal(environment.store.count("turns", "alice"), 0);
  assert.equal(environment.store.stagedArtifactCount("alice"), 1);
  assert.match(
    environment.store
      .pendingTelegramOutbox("primary")
      .map(({ text }) => text)
      .join("\n"),
    /Saved 1 attachment/u,
  );

  const combined = application.receiveTelegram(
    "primary",
    update(61, "101", "read it now"),
  );
  assert.equal(combined.accepted, true);
  await application.drain();
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.artifacts?.length, 1);
  assert.equal(turns[0]?.artifacts?.[0]?.id, artifact.id);
  assert.equal(environment.store.stagedArtifactCount("alice"), 0);
  environment.foundation.close();
});

test("staging enforces count, byte, and TTL bounds", () => {
  const environment = setup();
  const endpoint = environment.foundation.database.connection
    .prepare(
      "SELECT id FROM channel_endpoints WHERE user_id = ? AND kind = 'telegram'",
    )
    .get("alice") as { id: string };
  const insert = environment.foundation.database.connection.prepare(
    `INSERT INTO artifacts(
       id, user_id, storage_key, sha256, bytes, media_kind, mime_type,
       display_name, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const makeArtifact = (index: number, bytes: number): RuntimeArtifact => ({
    id: `artifact_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    userId: "alice",
    storageKey: `alice/${String(index).padStart(32, "0")}.blob`,
    sha256: "b".repeat(64),
    bytes,
    mediaKind: "file",
    mimeType: "text/plain",
    displayName: `file-${index}.txt`,
  });
  const many: RuntimeArtifact[] = [];
  for (let index = 1; index <= 8; index += 1) {
    const artifact = makeArtifact(index, 1);
    insert.run(
      artifact.id,
      artifact.userId,
      artifact.storageKey,
      artifact.sha256,
      artifact.bytes,
      artifact.mediaKind,
      artifact.mimeType,
      artifact.displayName,
      1,
    );
    many.push(artifact);
    environment.store.stageArtifacts("alice", endpoint.id, [artifact], 1_000);
  }
  assert.equal(environment.store.stagedArtifactCount("alice"), 8);
  const ninth = makeArtifact(9, 1);
  insert.run(
    ninth.id,
    ninth.userId,
    ninth.storageKey,
    ninth.sha256,
    ninth.bytes,
    ninth.mediaKind,
    ninth.mimeType,
    ninth.displayName,
    1,
  );
  assert.throws(
    () =>
      environment.store.stageArtifacts("alice", endpoint.id, [ninth], 1_000),
    /too many staged attachments/u,
  );
  const big = makeArtifact(10, 41 * 1024 * 1024);
  insert.run(
    big.id,
    big.userId,
    big.storageKey,
    big.sha256,
    big.bytes,
    big.mediaKind,
    big.mimeType,
    big.displayName,
    1,
  );
  assert.throws(
    () => environment.store.stageArtifacts("alice", endpoint.id, [big], 1_000),
    /staged attachments exceed MVP limits/u,
  );

  const takenExisting = environment.store.takeStagedArtifacts("alice", 2_000);
  assert.equal(takenExisting.artifacts.length, 8);

  const expired = makeArtifact(11, 1);
  insert.run(
    expired.id,
    expired.userId,
    expired.storageKey,
    expired.sha256,
    expired.bytes,
    expired.mediaKind,
    expired.mimeType,
    expired.displayName,
    1,
  );
  environment.store.stageArtifacts("alice", endpoint.id, [expired], 2_000);
  const taken = environment.store.takeStagedArtifacts(
    "alice",
    2_000 + 10 * 60 * 1000 + 1,
  );
  assert.equal(taken.artifacts.length, 0);
  assert.equal(taken.expired.length, 1);
  assert.equal(taken.expired[0]?.id, expired.id);
  assert.equal(environment.store.stagedArtifactCount("alice"), 0);
  environment.foundation.close();
});

test("Telegram worker sends typing while a Turn is running", async () => {
  const environment = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = new FakeAgentRuntime(async () => {
    await gate;
    return { outcome: "succeeded", text: "done", sessionReusable: true };
  });
  const application = new HitchApplication(environment.store, runtime);
  application.start();
  application.receiveTelegram("primary", update(50, "101", "long work"));

  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/getUpdates"))
      return Response.json({ ok: true, result: [] });
    if (url.endsWith("/sendChatAction")) {
      const body = JSON.parse(String(init?.body)) as { action: string };
      calls.push(body.action);
      return Response.json({ ok: true, result: true });
    }
    if (url.endsWith("/sendMessage"))
      return Response.json({ ok: true, result: { message_id: 1 } });
    throw new Error(`unexpected test URL: ${url}`);
  };
  const worker = new TelegramWorker(
    "primary",
    new TelegramBotClient("fixture-token", fetcher),
    application,
    environment.store,
  );
  const controller = new AbortController();
  const running = worker.run(controller.signal);
  await new Promise<void>((resolve) => setTimeout(resolve, 120));
  assert.ok(
    calls.includes("typing"),
    "the worker must send a typing action while the Turn runs",
  );
  release();
  await application.drain();
  controller.abort();
  await running;
  environment.foundation.close();
});

test("model and thinking commands persist a catalog-validated session selection", async () => {
  const environment = setup();
  const models: readonly RuntimeModel[] = [
    {
      provider: "fixture",
      id: "plain",
      name: "Fixture Plain",
      reasoning: false,
      input: ["text"],
      thinkingLevels: ["off"],
    },
    {
      provider: "fixture",
      id: "reasoner",
      name: "Fixture Reasoner",
      reasoning: true,
      input: ["text"],
      thinkingLevels: ["off", "low", "high"],
    },
  ];
  const calls: RuntimeTurn[] = [];
  const transcript = join(environment.paths.alice, "synthetic-session.jsonl");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = new FakeAgentRuntime(async (turn) => {
    calls.push(turn);
    await gate;
    return {
      outcome: "succeeded",
      text: "selected response",
      sessionReusable: true,
      transcriptPath: transcript,
      ...(turn.modelProvider === undefined
        ? {}
        : { modelProvider: turn.modelProvider }),
      ...(turn.modelId === undefined ? {} : { modelId: turn.modelId }),
      ...(turn.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: turn.thinkingLevel }),
    };
  }, models);
  const app = new HitchApplication(environment.store, runtime);
  app.start();

  assert.equal(
    app.receiveTelegram("primary", update(18, "101", "!models reason"))
      .accepted,
    true,
  );
  assert.equal(
    app.receiveTelegram("primary", update(19, "101", "!model fixture/reasoner"))
      .accepted,
    true,
  );
  assert.equal(
    app.receiveTelegram("primary", update(20, "101", "!thinking high"))
      .accepted,
    true,
  );
  const unsupported = app.receiveTelegram(
    "primary",
    update(21, "101", "!thinking minimal"),
  );
  assert.equal(unsupported.accepted, false);
  assert.equal(unsupported.category, "model-unavailable");
  assert.equal(
    app.receiveTelegram("primary", update(22, "101", "use selection")).accepted,
    true,
  );
  while (app.activeTurnIds().length === 0)
    await new Promise((resolve) => setImmediate(resolve));
  const activeSelection = app.receiveTelegram(
    "primary",
    update(23, "101", "!model fixture/plain"),
  );
  assert.equal(activeSelection.accepted, false);
  assert.equal(activeSelection.category, "busy");
  release();
  await app.drain();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.modelProvider, "fixture");
  assert.equal(calls[0]?.modelId, "reasoner");
  assert.equal(calls[0]?.thinkingLevel, "high");
  assert.equal(calls[0]?.workspace, environment.paths.alice);
  const session = environment.foundation.database.connection
    .prepare(
      `SELECT transcript_path, model_provider, model_id, thinking_level
       FROM sessions WHERE user_id = ?`,
    )
    .get("alice") as {
    transcript_path: string;
    model_provider: string;
    model_id: string;
    thinking_level: string;
  };
  assert.deepEqual(
    { ...session },
    {
      transcript_path: transcript,
      model_provider: "fixture",
      model_id: "reasoner",
      thinking_level: "high",
    },
  );
  assert.equal(environment.store.count("sessions", "bob"), 0);
  assert.equal(
    app.receiveTelegram("primary", update(24, "101", "!stop")).accepted,
    true,
  );
  const stoppedSelection = app.receiveTelegram(
    "primary",
    update(25, "101", "!model fixture/plain"),
  );
  assert.equal(stoppedSelection.accepted, false);
  assert.equal(stoppedSelection.category, "session-quarantined");
  environment.foundation.close();
});

test("per-user capacity allows one active plus three queued", async () => {
  const environment = setup();
  const runtime = new FakeAgentRuntime(async (turn) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { outcome: "succeeded", text: turn.prompt, sessionReusable: true };
  });
  const app = new HitchApplication(environment.store, runtime);
  app.start();
  for (let index = 0; index < 4; index += 1) {
    assert.equal(
      app.receiveTelegram(
        "primary",
        update(20 + index, "101", `prompt ${index}`),
      ).accepted,
      true,
    );
  }
  const busy = app.receiveTelegram(
    "primary",
    update(24, "101", "one too many"),
  );
  assert.equal(busy.accepted, false);
  assert.equal(busy.category, "busy");
  await app.drain();
  assert.equal(environment.store.count("turns", "alice"), 4);
  assert.equal(environment.store.pendingTelegramOutbox("primary").length, 4);
  environment.foundation.close();
});

test("abort cancels the active fake Turn without quarantining its session", async () => {
  const environment = setup();
  const runtime: AgentRuntime = {
    run: async (_turn, signal): Promise<RuntimeResult> =>
      await new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () =>
            resolve({ outcome: "cancelled", text: "", sessionReusable: true }),
          { once: true },
        );
      }),
  };
  const app = new HitchApplication(environment.store, runtime);
  app.start();
  assert.equal(
    app.receiveTelegram("primary", update(30, "101", "long prompt")).accepted,
    true,
  );
  while (app.activeTurnIds().length === 0)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    app.receiveTelegram("primary", update(31, "101", "!abort")).accepted,
    true,
  );
  await app.drain();
  const database = environment.foundation.database.connection;
  const prompt = database
    .prepare("SELECT outcome FROM turns WHERE prompt_text = ?")
    .get("long prompt") as {
    outcome: string;
  };
  const session = database
    .prepare("SELECT state FROM sessions WHERE user_id = ?")
    .get("alice") as { state: string };
  assert.equal(prompt.outcome, "cancelled");
  assert.equal(session.state, "active");
  environment.foundation.close();
});

test("a timed-out Turn is terminal and quarantines rather than replaying", async () => {
  const environment = setup();
  const app = new HitchApplication(
    environment.store,
    new FakeAgentRuntime(() => ({
      outcome: "timed-out",
      text: "partial output must not escape",
      sessionReusable: false,
    })),
  );
  app.start();
  assert.equal(
    app.receiveTelegram("primary", update(35, "101", "slow prompt")).accepted,
    true,
  );
  await app.drain();
  const database = environment.foundation.database.connection;
  const turn = database
    .prepare("SELECT state, outcome, result_text FROM turns WHERE user_id = ?")
    .get("alice") as {
    state: string;
    outcome: string;
    result_text: string;
  };
  const session = database
    .prepare("SELECT state FROM sessions WHERE user_id = ?")
    .get("alice") as { state: string };
  assert.deepEqual(
    { ...turn },
    {
      state: "terminal",
      outcome: "timed-out",
      result_text: "agent-failed: the model Turn timed out.",
    },
  );
  assert.equal(session.state, "quarantined");
  assert.equal(environment.store.hasDispatchableTurn("alice"), false);
  environment.foundation.close();
});

test("restart quarantines running work and never dispatches its queued successor", async () => {
  const environment = setup();
  const endpoint = environment.store.resolveTelegramEndpoint(
    "primary",
    "101",
    "101",
  );
  assert.ok(endpoint !== null);
  const firstIdentity: MessageIdentity = {
    endpoint,
    idempotencyKey: "first",
    contentDigest: "digest-first",
  };
  const secondIdentity: MessageIdentity = {
    endpoint,
    idempotencyKey: "second",
    contentDigest: "digest-second",
  };
  environment.store.admitPrompt(firstIdentity, "first prompt");
  const claimed = environment.store.claimNextTurn("alice");
  assert.ok(claimed !== null);
  environment.store.admitPrompt(secondIdentity, "queued prompt");
  environment.foundation.close();

  const reopened = bootstrapFoundation(
    parseConfig({
      schemaVersion: 1,
      dataRoot: environment.paths.dataRoot,
      piProfileDir: environment.paths.piProfileDir,
      minimumFreeBytes: 0,
      telegramAccounts: [{ id: "primary", botTokenEnv: "HITCH_TEST_TOKEN" }],
      wechatAccounts: [{ id: "primary", stateDir: environment.paths.wechat }],
      users: [
        {
          id: "alice",
          workspace: environment.paths.alice,
          telegram: { account: "primary", userId: "101", privateChatId: "101" },
        },
        {
          id: "bob",
          workspace: environment.paths.bob,
          telegram: { account: "primary", userId: "202", privateChatId: "202" },
        },
      ],
    }),
  );
  const sequence = new Sequence();
  const store = new HitchStore(reopened.database, sequence, sequence);
  const calls: RuntimeTurn[] = [];
  const app = new HitchApplication(
    store,
    new FakeAgentRuntime((turn) => {
      calls.push(turn);
      return {
        outcome: "succeeded",
        text: "unexpected",
        sessionReusable: true,
      };
    }),
  );
  app.start();
  await app.drain();
  assert.equal(calls.length, 0);
  const database = reopened.database.connection;
  const outcomes = (
    database
      .prepare(
        "SELECT prompt_text, state, outcome FROM turns WHERE user_id = ? ORDER BY ordinal",
      )
      .all("alice") as unknown as Array<{
      prompt_text: string;
      state: string;
      outcome: string | null;
    }>
  ).map((row) => ({ ...row }));
  assert.deepEqual(outcomes, [
    { prompt_text: "first prompt", state: "terminal", outcome: "unknown" },
    { prompt_text: "queued prompt", state: "queued", outcome: null },
  ]);
  assert.equal(
    app.receiveTelegram("primary", update(40, "101", "!recover")).accepted,
    true,
  );
  const queued = database
    .prepare("SELECT state, outcome FROM turns WHERE prompt_text = ?")
    .get("queued prompt") as {
    state: string;
    outcome: string;
  };
  assert.deepEqual({ ...queued }, { state: "terminal", outcome: "cancelled" });
  reopened.close();
});

test("Telegram worker persists its cursor, ignores unknown peers, and delivers durable outbox text", async () => {
  const environment = setup();
  const app = new HitchApplication(environment.store, new FakeAgentRuntime());
  app.start();
  const requestBodies: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  let updateBatch = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestBodies.push(body);
    if (url.endsWith("/getUpdates")) {
      const result =
        updateBatch++ === 0
          ? [update(1, "101", "!status"), update(2, "999", "unknown peer")]
          : [];
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    assert.match(url, /\/sendMessage$/u);
    sent.push(body);
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 1 } }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
  const worker = new TelegramWorker(
    "primary",
    new TelegramBotClient("synthetic-token", fetcher),
    app,
    environment.store,
  );
  assert.equal(await worker.pollOnce(), 2);
  assert.equal(environment.store.getTelegramOffset("primary"), 3);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.chat_id, "101");
  assert.match(String(sent[0]?.text), /Session session-1/u);
  assert.equal(await worker.pollOnce(), 0);
  assert.equal(requestBodies.at(-1)?.offset, 3);
  environment.foundation.close();
});

test("unknown Telegram peers are rejected before message content is read", () => {
  const environment = setup();
  const app = new HitchApplication(environment.store, new FakeAgentRuntime());
  app.start();
  const unknownPeer = update(49, "999", "must not be read");
  Object.defineProperty(unknownPeer.message, "text", {
    get() {
      throw new Error("message content was read");
    },
  });

  const result = app.receiveTelegram("primary", unknownPeer);
  assert.equal(result.accepted, false);
  assert.equal(result.category, "rejected");
  assert.equal(result.message, "Telegram private endpoint is not configured");
  assert.equal(result.replyPrivateChatId, undefined);
  assert.equal(environment.store.count("turns", "alice"), 0);
  assert.equal(environment.store.count("turns", "bob"), 0);
  environment.foundation.close();
});

test("a failed busy reply cannot make the Telegram update execute later", async () => {
  const environment = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: RuntimeTurn[] = [];
  const app = new HitchApplication(
    environment.store,
    new FakeAgentRuntime(async (turn) => {
      calls.push(turn);
      await gate;
      return { outcome: "succeeded", text: turn.prompt, sessionReusable: true };
    }),
  );
  app.start();
  for (let index = 0; index < 4; index += 1) {
    assert.equal(
      app.receiveTelegram(
        "primary",
        update(60 + index, "101", `accepted ${index}`),
      ).accepted,
      true,
    );
  }

  const rejectedUpdate = update(64, "101", "must stay rejected");
  const failedReplyFetch: typeof fetch = async (input) => {
    if (String(input).endsWith("/getUpdates"))
      return new Response(
        JSON.stringify({ ok: true, result: [rejectedUpdate] }),
      );
    return new Response("ambiguous failure", { status: 500 });
  };
  const firstWorker = new TelegramWorker(
    "primary",
    new TelegramBotClient("synthetic-token", failedReplyFetch),
    app,
    environment.store,
  );
  await assert.rejects(() => firstWorker.pollOnce(), TelegramError);
  assert.equal(environment.store.getTelegramOffset("primary"), 65);

  release();
  await app.drain();
  let repolledOffset: unknown;
  const retryFetch: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/getUpdates")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      repolledOffset = body.offset;
      const result = Number(body.offset) <= 64 ? [rejectedUpdate] : [];
      return new Response(JSON.stringify({ ok: true, result }));
    }
    return new Response(JSON.stringify({ ok: true, result: {} }));
  };
  const secondWorker = new TelegramWorker(
    "primary",
    new TelegramBotClient("synthetic-token", retryFetch),
    app,
    environment.store,
  );
  assert.equal(await secondWorker.pollOnce(), 0);
  assert.equal(repolledOffset, 65);
  assert.equal(calls.length, 4);
  assert.equal(environment.store.count("turns", "alice"), 4);
  environment.foundation.close();
});

test("terminal text is capped to sixteen Telegram chunks", async () => {
  const environment = setup();
  const app = new HitchApplication(
    environment.store,
    new FakeAgentRuntime(() => ({
      outcome: "succeeded",
      text: "x".repeat(70_000),
      sessionReusable: true,
    })),
  );
  app.start();
  assert.equal(
    app.receiveTelegram("primary", update(70, "101", "large result")).accepted,
    true,
  );
  await app.drain();

  const chunks: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { text: string };
    chunks.push(body.text);
    return new Response(JSON.stringify({ ok: true, result: {} }));
  };
  const worker = new TelegramWorker(
    "primary",
    new TelegramBotClient("synthetic-token", fetcher),
    app,
    environment.store,
  );
  assert.equal(await worker.deliverOnce(), 1);
  assert.equal(chunks.length, 16);
  assert.equal(chunks.join("").length, 64_000);
  environment.foundation.close();
});

test("ambiguous Telegram send becomes retryable without rerunning its command", async () => {
  const environment = setup();
  const app = new HitchApplication(environment.store, new FakeAgentRuntime());
  app.start();
  assert.equal(
    app.receiveTelegram("primary", update(50, "101", "!status")).accepted,
    true,
  );
  const failingFetch: typeof fetch = async () =>
    new Response("failure", { status: 500 });
  const failing = new TelegramWorker(
    "primary",
    new TelegramBotClient("synthetic-token", failingFetch),
    app,
    environment.store,
  );
  await assert.rejects(() => failing.deliverOnce(), TelegramError);
  const database = environment.foundation.database.connection;
  const retryable = database
    .prepare("SELECT state, attempts FROM outbox")
    .get() as {
    state: string;
    attempts: bigint;
  };
  assert.deepEqual({ ...retryable }, { state: "retryable", attempts: 1n });

  let sends = 0;
  const successFetch: typeof fetch = async () => {
    sends += 1;
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const succeeding = new TelegramWorker(
    "primary",
    new TelegramBotClient("synthetic-token", successFetch),
    app,
    environment.store,
  );
  assert.equal(await succeeding.deliverOnce(), 1);
  assert.equal(sends, 1);
  const sentRow = database
    .prepare("SELECT state, attempts FROM outbox")
    .get() as {
    state: string;
    attempts: bigint;
  };
  assert.deepEqual({ ...sentRow }, { state: "sent", attempts: 2n });
  assert.equal(environment.store.count("turns", "alice"), 1);
  environment.foundation.close();
});
