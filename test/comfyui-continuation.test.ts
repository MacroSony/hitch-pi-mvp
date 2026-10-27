import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HitchStore } from "../src/app/store.js";
import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import { openFoundationDatabase } from "../src/foundation/database.js";
import { HitchApplication } from "../src/app/application.js";
import { ComfyService } from "../src/comfyui/service.js";
import type { ComfyBackendClient } from "../src/comfyui/client.js";
import { ComfyWorkflowPolicy } from "../src/comfyui/workflow.js";
import { MediaStore } from "../src/media/media-store.js";
import { FakeAgentRuntime, type RuntimeTurn } from "../src/runtime/runtime.js";
import { parseCommand } from "../src/app/commands.js";
import type { RenderedComfyWorkflow } from "../src/comfyui/workflow.js";

const snapshot: RenderedComfyWorkflow = {
  graph: { "1": { class_type: "Test", inputs: {} } },
  outputNodes: ["1"],
};
const source = {
  messageId: "123456789012345678",
  channelId: "123456789012345682",
  guildId: null,
  authorId: "123456789012345680",
  authorName: "Alice",
  timestamp: "2026-01-01T00:00:00Z",
};

function setup(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "hitch-comfy-jobs-"));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = ["data", "pi", "alice", "bob"].map((part) => join(root, part));
  for (const path of paths) {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  const [dataRoot, piProfileDir, aliceWorkspace, bobWorkspace] = paths as [
    string,
    string,
    string,
    string,
  ];
  const config = parseConfig({
    schemaVersion: 1,
    dataRoot,
    piProfileDir,
    minimumFreeBytes: 0,
    telegramAccounts: [],
    wechatAccounts: [],
    discordAccounts: [{ id: "test", botTokenEnv: "HITCH_TEST_TOKEN" }],
    users: [
      {
        id: "alice",
        workspace: aliceWorkspace,
        discord: {
          mode: "dm",
          account: "test",
          userId: "123456789012345680",
          channelId: "123456789012345682",
        },
      },
      {
        id: "bob",
        workspace: bobWorkspace,
        discord: {
          mode: "dm",
          account: "test",
          userId: "123456789012345681",
          channelId: "123456789012345683",
        },
      },
    ],
  });
  const foundation = bootstrapFoundation(config);
  const db = foundation.database.connection;
  const user = db.prepare("SELECT id FROM users WHERE id='alice'").get() as {
    id: string;
  };
  const endpoint = db
    .prepare("SELECT id FROM channel_endpoints WHERE user_id='alice'")
    .get() as { id: string };
  const sessionId = "job-session";
  db.prepare(
    "INSERT INTO sessions(id,user_id,name,pi_session_id,state,created_at,updated_at) VALUES(?,?,'main','pi','active',1,1)",
  ).run(sessionId, user.id);
  db.prepare(
    "UPDATE channel_endpoints SET selected_session_id = ? WHERE id = ?",
  ).run(sessionId, endpoint.id);
  const store = new HitchStore(foundation.database);
  store.configureComfyContinuation(["alice"]);
  const endpointContext = store.resolveDiscordEndpoint(
    "test",
    "dm",
    "123456789012345680",
    "123456789012345682",
  )!;
  let request = 0;
  const admit = (text = "Draw a cat") =>
    store.admitPrompt(
      {
        endpoint: endpointContext,
        idempotencyKey: `message-${++request}`,
        contentDigest: `digest-${request}`,
        discordSource: source,
      },
      text,
    );
  const command = (text: string) => {
    const parsed = parseCommand(text);
    assert.ok(parsed);
    return store.executeCommand(
      {
        endpoint: endpointContext,
        idempotencyKey: `command-${++request}`,
        contentDigest: `digest-${request}`,
      },
      parsed,
      text,
    );
  };
  return {
    foundation,
    admit,
    command,
    sessionId,
    endpointId: endpoint.id,
    dataRoot,
    db,
    store,
  };
}

const artifact = {
  id: "artifact_123e4567-e89b-42d3-a456-426614174000",
  userId: "alice",
  storageKey: "alice/123e4567-e89b-42d3-a456-426614174000.blob",
  sha256: "a".repeat(64),
  bytes: 42,
  mediaKind: "image" as const,
  mimeType: "image/png",
  displayName: "result.png",
};

const ok = {
  outcome: "succeeded" as const,
  text: "Generating; job ID should not appear",
  sessionReusable: true,
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const policy = new ComfyWorkflowPolicy({
  id: "fixture",
  graph: { "1": { class_type: "Test", inputs: { text: "test" } } },
  variables: {
    prompt: { nodeId: "1", input: "text", type: "string", maxLength: 80 },
  },
  outputNodes: ["1"],
});
function fakeService(
  f: ReturnType<typeof setup>,
  ready?: (userId: string) => void,
  mode: "agent" | "direct" = "agent",
) {
  let submits = 0,
    polls = 0;
  let state: "pending" | "failed" | "complete" = "complete";
  const media = new MediaStore(f.dataRoot, 0);
  const backend = {
    async submit() {
      return `backend_${++submits}`;
    },
    async history() {
      polls++;
      return state === "complete"
        ? {
            state,
            images: [{ filename: "x.png", subfolder: "", type: "output" }],
          }
        : { state };
    },
    async download() {
      return png;
    },
    async cancel() {
      return true;
    },
  } as unknown as ComfyBackendClient;
  const service = new ComfyService({
    ledger: f.store,
    media,
    backend,
    workflows: [policy],
    enabledUsers: ["alice"],
    deliveryMode: mode,
    ...(ready ? { onContinuationReady: ready } : {}),
  });
  return {
    service,
    media,
    submits: () => submits,
    polls: () => polls,
    state: (value: typeof state) => {
      state = value;
    },
  };
}
function startJob(f: ReturnType<typeof setup>) {
  f.admit();
  const turn = f.store.claimNextTurn("alice")!;
  assert.ok(turn);
  const job = f.store.createComfyJob(
    "alice",
    turn.turnId,
    "fixture",
    snapshot,
    "agent",
  );
  f.store.markComfyJobSubmitting("alice", job.id);
  f.store.markComfyJobSubmitted("alice", job.id, "backend");
  return { turn, job };
}
function count(f: ReturnType<typeof setup>, table: string) {
  return Number(
    (
      f.db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
        count: bigint;
      }
    ).count,
  );
}

test("agent completion stores an inbound original, queues once with trusted metadata, never directly publishes", async (t) => {
  const f = setup(t);
  t.after(() => f.foundation.close());
  const fake = fakeService(f);
  f.admit();
  const turn = f.store.claimNextTurn("alice")!;
  const job = (await fake.service.execute(
    { userId: "alice", turnId: turn.turnId },
    "paint",
    { prompt: "cat" },
  )) as { id: string };
  await fake.service.tick();
  assert.equal(fake.polls(), 0);
  f.store.completeTurn(turn, ok);
  assert.equal(count(f, "outbox"), 0, "original submission chatter is silent");
  await Promise.all([fake.service.tick(), fake.service.tick()]);
  const stored = f.store.getComfyJob("alice", job.id)!;
  const result = f.store.getComfyResult("alice", job.id)!;
  assert.ok(result);
  assert.equal(f.store.getComfyResult("bob", job.id), null);
  assert.equal(count(f, "outbox"), 0);
  assert.equal(
    f.store.finishComfyJob("alice", job.id, "completed", result),
    false,
  );
  const next = f.store.claimNextTurn("alice")!;
  assert.equal(next.turnId, stored.completionTurnId);
  assert.equal(
    (
      f.db
        .prepare("SELECT discord_source FROM turns WHERE id=?")
        .get(next.turnId) as { discord_source: string }
    ).discord_source,
    JSON.stringify(source),
  );
  assert.equal(next.sessionId, turn.sessionId);
  assert.equal(next.endpointId, turn.endpointId);
  assert.deepEqual(next.comfyContinuation, {
    jobId: job.id,
    outcome: "completed",
    rootTurnId: turn.turnId,
    remainingJobs: 3,
  });
  assert.deepEqual(next.artifacts, [result]);
  assert.match(next.prompt, /Original request:\nDraw a cat/u);
  assert.ok(
    f.store.getComfyResult("alice", job.id),
    "result available before continuation terminal",
  );
  f.store.completeTurn(next, {
    ...ok,
    text: "Selected final media",
    artifacts: [{ ...result, ...artifact }],
  });
  assert.equal(
    count(f, "outbox"),
    2,
    "explicit publish plus final text uses normal pipeline",
  );
  assert.equal(f.store.claimNextTurn("alice"), null);
  assert.ok(
    f.store.getComfyResult("alice", job.id),
    "published snapshot does not replace immutable result",
  );
  assert.equal(fake.submits(), 1);
});

test("asynchronous completion wakes idle owner queue exactly once, without progress leakage", async (t) => {
  const f = setup(t);
  t.after(() => f.foundation.close());
  const seen: RuntimeTurn[] = [];
  let app: HitchApplication;
  const fake = fakeService(f, (id) => app.dispatchQueuedUser(id));
  const runtime = new FakeAgentRuntime(async (turn, _signal, progress) => {
    seen.push(turn);
    progress("Already generated/sent; internal planning");
    await new Promise((r) => setTimeout(r, 8));
    if (!turn.comfyContinuation) {
      await fake.service.execute(
        { userId: turn.userId, turnId: turn.turnId },
        "paint",
        { prompt: "cat" },
      );
      return ok;
    }
    assert.equal(turn.artifacts?.length, 1);
    return { ...ok, text: "Final chosen answer" };
  });
  app = new HitchApplication(
    f.store,
    runtime,
    undefined,
    undefined,
    1,
    undefined,
    undefined,
    [],
    undefined,
    undefined,
    [],
    ["alice"],
  );
  f.admit();
  app.start();
  await app.drain();
  assert.equal(count(f, "outbox"), 0);
  await fake.service.tick();
  await app.drain();
  await fake.service.tick();
  await app.drain();
  assert.equal(seen.length, 2);
  assert.equal(fake.submits(), 1);
  assert.deepEqual(
    f.db
      .prepare("SELECT payload_text FROM outbox")
      .all()
      .map((r) => r.payload_text),
    ["Final chosen answer"],
  );
  app.stop();
});

test("trusted child branches share a persistent four-job root budget, including rejected children", (t) => {
  const f = setup(t);
  t.after(() => f.foundation.close());
  const { turn, job } = startJob(f);
  f.store.completeTurn(turn, ok);
  assert.equal(
    f.store.finishComfyJob("alice", job.id, "completed", artifact),
    true,
  );
  const childTurn = f.store.claimNextTurn("alice")!;
  const child = f.store.createComfyJob(
    "alice",
    childTurn.turnId,
    "fixture",
    snapshot,
    "direct",
  );
  assert.equal(
    child.deliveryMode,
    "agent",
    "automatic child cannot downgrade persisted mode",
  );
  assert.equal(child.rootTurnId, turn.turnId);
  f.store.markComfyJobRejected("alice", child.id);
  const second = f.store.createComfyJob(
    "alice",
    childTurn.turnId,
    "fixture",
    snapshot,
    "agent",
  );
  f.store.markComfyJobSubmitting("alice", second.id);
  f.store.markComfyJobSubmitted("alice", second.id, "child");
  const third = f.store.createComfyJob(
    "alice",
    childTurn.turnId,
    "fixture",
    snapshot,
    "agent",
  );
  f.store.markComfyJobRejected("alice", third.id);
  assert.throws(
    () =>
      f.store.createComfyJob(
        "alice",
        childTurn.turnId,
        "fixture",
        snapshot,
        "agent",
      ),
    /budget exhausted/u,
  );
  f.store.completeTurn(childTurn, ok);
  f.store.finishComfyJob("alice", second.id, "completed", artifact);
  const grandchild = f.store.claimNextTurn("alice")!;
  assert.equal(grandchild.comfyContinuation?.remainingJobs, 0);
  assert.throws(
    () =>
      f.store.createComfyJob(
        "alice",
        grandchild.turnId,
        "fixture",
        snapshot,
        "agent",
      ),
    /budget exhausted/u,
  );
  f.store.completeTurn(grandchild, { ...ok, text: "Budget exhausted" });
  f.admit("A new user request");
  const fresh = f.store.claimNextTurn("alice")!;
  assert.doesNotThrow(() =>
    f.store.createComfyJob("alice", fresh.turnId, "fixture", snapshot, "agent"),
  );
});

test("automatic intermediate child submission is silent; final text survives", async (t) => {
  const f = setup(t);
  t.after(() => f.foundation.close());
  let app: HitchApplication;
  let calls = 0;
  const fake = fakeService(f, (id) => app.dispatchQueuedUser(id));
  app = new HitchApplication(
    f.store,
    new FakeAgentRuntime(async (turn) => {
      calls++;
      if (calls <= 2) {
        await fake.service.execute(
          { userId: "alice", turnId: turn.turnId },
          "paint",
          { prompt: "cat" },
        );
        return ok;
      }
      return { ...ok, text: "Final" };
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    [],
    undefined,
    undefined,
    [],
    ["alice"],
  );
  f.admit();
  app.start();
  await app.drain();
  await fake.service.tick();
  await app.drain();
  assert.equal(calls, 2);
  assert.equal(count(f, "outbox"), 0);
  await fake.service.tick();
  await app.drain();
  assert.equal(calls, 3);
  assert.equal(fake.submits(), 2);
  assert.equal(count(f, "outbox"), 1);
  app.stop();
});

for (const phase of ["submitted", "queued", "running"] as const) {
  for (const change of [
    "new",
    "use",
    "abort",
    "stop",
    "quarantine",
    "disabled-user",
    "disabled-endpoint",
    "disabled-paint",
  ] as const) {
    test(`agent ${phase} fails closed after ${change}, retaining results`, (t) => {
      const f = setup(t);
      t.after(() => f.foundation.close());
      const { turn, job } = startJob(f);
      f.store.completeTurn(turn, ok);
      if (phase !== "submitted")
        f.store.finishComfyJob("alice", job.id, "completed", artifact);
      const running =
        phase === "running" ? f.store.claimNextTurn("alice")! : null;
      if (change === "new") {
        f.command("!new replacement");
        f.command("!use main");
      }
      if (change === "use") {
        f.db
          .prepare(
            "INSERT INTO sessions(id,user_id,name,pi_session_id,state,created_at,updated_at) VALUES('other','alice','other','pi-other','active',1,1)",
          )
          .run();
        f.command("!use other");
        f.command("!use main");
      }
      if (change === "abort") f.command("!abort");
      if (change === "stop") f.command("!stop");
      if (change === "quarantine")
        f.db
          .prepare("UPDATE sessions SET state='quarantined' WHERE id=?")
          .run(f.sessionId);
      if (change === "disabled-user")
        f.db.prepare("UPDATE users SET enabled=0 WHERE id='alice'").run();
      if (change === "disabled-endpoint")
        f.db
          .prepare("UPDATE channel_endpoints SET enabled=0 WHERE id=?")
          .run(f.endpointId);
      if (change === "disabled-paint") f.store.configureComfyContinuation([]);
      const before = count(f, "outbox");
      if (phase === "submitted")
        assert.equal(
          f.store.finishComfyJob("alice", job.id, "completed", artifact),
          true,
        );
      if (running) {
        assert.throws(() =>
          f.store.createComfyJob(
            "alice",
            running.turnId,
            "fixture",
            snapshot,
            "agent",
          ),
        );
        f.store.completeTurn(running, {
          ...ok,
          text: "Must not leak",
          artifacts: [
            {
              ...artifact,
              id: "artifact_123e4567-e89b-42d3-a456-426614174001",
              storageKey: "alice/123e4567-e89b-42d3-a456-426614174001.blob",
            },
          ],
        });
      }
      assert.equal(f.store.claimNextTurn("alice"), null);
      assert.equal(count(f, "outbox"), before);
      if (change === "disabled-user")
        f.db.prepare("UPDATE users SET enabled=1 WHERE id='alice'").run();
      assert.ok(f.store.getComfyResult("alice", job.id));
    });
  }
}

test("cancelled job never resumes; cancelled source can retain a result without continuation", (t) => {
  const f = setup(t);
  t.after(() => f.foundation.close());
  const first = startJob(f);
  f.store.completeTurn(first.turn, ok);
  assert.equal(f.store.markComfyJobCancelled("alice", first.job.id), true);
  assert.equal(
    f.store.finishComfyJob("alice", first.job.id, "completed", artifact),
    false,
  );
  const second = startJob(f);
  f.store.completeTurn(second.turn, { ...ok, outcome: "cancelled" });
  assert.equal(
    f.store.finishComfyJob("alice", second.job.id, "completed", artifact),
    true,
  );
  assert.ok(f.store.getComfyResult("alice", second.job.id));
  assert.equal(f.store.claimNextTurn("alice"), null);
});

test("backend failure queues a failure continuation once and does not hide its notice", async (t) => {
  const f = setup(t);
  t.after(() => f.foundation.close());
  const fake = fakeService(f);
  const { turn, job } = startJob(f);
  f.store.completeTurn(turn, ok);
  fake.state("failed");
  await fake.service.tick();
  await fake.service.tick();
  const next = f.store.claimNextTurn("alice")!;
  assert.equal(next.comfyContinuation?.outcome, "failed");
  assert.equal(next.artifacts, undefined);
  assert.equal(f.store.getComfyResult("alice", job.id), null);
  f.store.completeTurn(next, {
    outcome: "failed",
    text: "",
    error: "Generation failed",
    sessionReusable: true,
  });
  assert.deepEqual(
    f.db
      .prepare("SELECT payload_text FROM outbox")
      .all()
      .map((r) => r.payload_text),
    ["Generation failed"],
  );
  assert.equal(f.store.claimNextTurn("alice"), null);
});

for (const phase of ["submitted", "queued", "running"] as const) {
  test(`restart recovers ${phase} without replay/duplicate generation or delivery`, async (t) => {
    const f = setup(t);
    const { turn, job } = startJob(f);
    f.store.completeTurn(turn, ok);
    if (phase !== "submitted")
      f.store.finishComfyJob("alice", job.id, "completed", artifact);
    if (phase === "running") assert.ok(f.store.claimNextTurn("alice"));
    f.foundation.close();
    const reopened = openFoundationDatabase(f.dataRoot);
    t.after(() => reopened.close());
    const store = new HitchStore(reopened);
    store.configureComfyContinuation(["alice"]);
    let calls = 0;
    const app = new HitchApplication(
      store,
      new FakeAgentRuntime(() => {
        calls++;
        return { ...ok, text: "Recovered final" };
      }),
    );
    app.start();
    if (phase === "submitted") {
      assert.equal(
        store.finishComfyJob("alice", job.id, "completed", artifact),
        true,
      );
      app.dispatchQueuedUser("alice");
    }
    await app.drain();
    assert.equal(calls, phase === "running" ? 0 : 1);
    assert.ok(store.getComfyResult("alice", job.id));
    assert.equal(
      store.finishComfyJob("alice", job.id, "completed", artifact),
      false,
    );
    assert.equal(store.claimNextTurn("alice"), null);
    app.stop();
  });
}

test("persisted direct job retains legacy strict publication retrieval", async (t) => {
  const f = setup(t);
  t.after(() => f.foundation.close());
  const fake = fakeService(f, undefined, "direct");
  f.admit();
  const turn = f.store.claimNextTurn("alice")!;
  const job = (await fake.service.execute(
    { userId: "alice", turnId: turn.turnId },
    "paint",
    { prompt: "cat" },
  )) as { id: string };
  f.store.completeTurn(turn, ok);
  await fake.service.tick();
  assert.equal(f.store.getComfyJob("alice", job.id)?.deliveryMode, "direct");
  assert.equal(count(f, "outbox"), 3);
  assert.equal(f.store.claimNextTurn("alice"), null);
  assert.ok(f.store.getComfyResult("alice", job.id));
  const completion = f.store.getComfyJob("alice", job.id)!.completionTurnId!;
  f.db
    .prepare("DELETE FROM outbox WHERE turn_id=? AND kind='artifact'")
    .run(completion);
  assert.equal(
    f.store.getComfyResult("alice", job.id),
    null,
    "direct path still requires exact artifact outbox",
  );
});

test("schema 10 forward migration retains populated direct job, source and output state", (t) => {
  const f = setup(t);
  f.admit();
  const turn = f.store.claimNextTurn("alice")!;
  const job = f.store.createComfyJob("alice", turn.turnId, "fixture", snapshot);
  f.store.markComfyJobSubmitting("alice", job.id);
  f.store.markComfyJobSubmitted("alice", job.id, "backend");
  f.store.completeTurn(turn, ok);
  f.store.finishComfyJob("alice", job.id, "completed", artifact);
  // Disposable fixture only: emulate the exact previous schema, then exercise the forward migration.
  f.db
    .exec(`DROP INDEX comfy_jobs_root; ALTER TABLE comfy_jobs DROP COLUMN delivery_mode;
    ALTER TABLE comfy_jobs DROP COLUMN root_turn_id; ALTER TABLE comfy_jobs DROP COLUMN continuation_blocked;
    UPDATE app_meta SET value='hitch-pi-mvp-schema-10' WHERE key='schema_id'; PRAGMA user_version=10;`);
  f.foundation.close();
  const reopened = openFoundationDatabase(f.dataRoot);
  t.after(() => reopened.close());
  const store = new HitchStore(reopened);
  assert.equal(store.getComfyJob("alice", job.id)?.deliveryMode, "direct");
  assert.equal(store.getComfyJob("alice", job.id)?.state, "completed");
  assert.deepEqual(store.getComfyResult("alice", job.id), artifact);
  assert.deepEqual(
    reopened.connection.prepare("PRAGMA foreign_key_check").all(),
    [],
  );
  assert.equal(
    (
      reopened.connection.prepare("PRAGMA user_version").get() as {
        user_version: bigint;
      }
    ).user_version,
    11n,
  );
});

test("model-supplied lineage or delivery overrides are rejected before generation", async (t) => {
  const f = setup(t);
  t.after(() => f.foundation.close());
  const fake = fakeService(f);
  f.admit();
  const turn = f.store.claimNextTurn("alice")!;
  for (const override of [
    { rootTurnId: "forged" },
    { remainingJobs: 99 },
    { deliveryMode: "direct" },
    { parent_job_id: "forged" },
  ]) {
    await assert.rejects(
      fake.service.execute({ userId: "alice", turnId: turn.turnId }, "paint", {
        prompt: "cat",
        ...override,
      }),
    );
  }
  assert.equal(fake.submits(), 0);
  assert.equal(count(f, "comfy_jobs"), 0);
});

test("failed automatic runtime quarantine does not silently lose the error notice", (t) => {
  const f = setup(t);
  t.after(() => f.foundation.close());
  const { turn, job } = startJob(f);
  f.store.completeTurn(turn, ok);
  f.store.finishComfyJob("alice", job.id, "completed", artifact);
  const continuation = f.store.claimNextTurn("alice")!;
  f.store.completeTurn(continuation, {
    outcome: "unknown",
    text: "",
    sessionReusable: false,
  });
  assert.equal(f.store.pendingDiscordOutbox("test").length, 1);
  assert.equal(f.store.claimNextTurn("alice"), null);
  assert.ok(f.store.getComfyResult("alice", job.id));
});

test("a stale final outbox group is expired even when fetched before session selection changes", (t) => {
  const f = setup(t);
  t.after(() => f.foundation.close());
  const { turn, job } = startJob(f);
  f.store.completeTurn(turn, ok);
  f.store.finishComfyJob("alice", job.id, "completed", artifact);
  const continuation = f.store.claimNextTurn("alice")!;
  const selected = {
    ...artifact,
    id: "artifact_123e4567-e89b-42d3-a456-426614174001",
    storageKey: "alice/123e4567-e89b-42d3-a456-426614174001.blob",
  };
  f.store.completeTurn(continuation, {
    ...ok,
    text: "Final",
    artifacts: [selected],
  });
  const rows = f.store.pendingDiscordOutbox("test");
  assert.equal(rows.length, 2);
  f.command("!new replacement");
  assert.equal(f.store.claimDiscordOutboxGroup(rows), false);
  assert.equal(f.store.claimOutbox(rows[0]!), false);
  assert.ok(f.store.getComfyResult("alice", job.id));
});

for (const agent of [false, true]) {
  test(`progress callback ${agent ? "disabled for agent-enabled user" : "unchanged for direct user"}`, async (t) => {
    const f = setup(t);
    t.after(() => f.foundation.close());
    let progressWrites = 0;
    f.store.insertTurnProgress = () => {
      progressWrites++;
    };
    const app = new HitchApplication(
      f.store,
      new FakeAgentRuntime(async (_turn, _signal, progress) => {
        progress("Internal reasoning; already sent");
        await new Promise((r) => setTimeout(r, 10));
        return { ...ok, text: "Final" };
      }),
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      [],
      agent ? ["alice"] : [],
    );
    f.admit();
    app.start();
    await app.drain();
    app.stop();
    assert.equal(progressWrites, agent ? 0 : 1);
  });
}

test("continuations join ordinary owner FIFO and do not overtake a queued user request", (t) => {
  const f = setup(t);
  t.after(() => f.foundation.close());
  const { turn, job } = startJob(f);
  const second = f.admit("Another user request");
  f.store.completeTurn(turn, ok);
  f.store.finishComfyJob("alice", job.id, "completed", artifact);
  const userTurn = f.store.claimNextTurn("alice")!;
  assert.equal(userTurn.turnId, second.turnId);
  assert.equal(userTurn.comfyContinuation, undefined);
  assert.equal(
    f.store.claimNextTurn("alice"),
    null,
    "one active Turn per owner",
  );
  f.store.completeTurn(userTurn, { ...ok, text: "Second user answer" });
  const continuation = f.store.claimNextTurn("alice")!;
  assert.equal(continuation.comfyContinuation?.jobId, job.id);
});

test("branch budget survives restart and is shared by separate completion turns", (t) => {
  const f = setup(t);
  f.admit();
  const origin = f.store.claimNextTurn("alice")!;
  const submit = (turnId: string) => {
    const job = f.store.createComfyJob(
      "alice",
      turnId,
      "fixture",
      snapshot,
      "agent",
    );
    f.store.markComfyJobSubmitting("alice", job.id);
    f.store.markComfyJobSubmitted("alice", job.id, "backend");
    return job;
  };
  const branchA = submit(origin.turnId),
    branchB = submit(origin.turnId);
  f.store.completeTurn(origin, ok);
  f.store.finishComfyJob("alice", branchA.id, "completed", artifact);
  f.store.finishComfyJob("alice", branchB.id, "completed", artifact);
  const nextA = f.store.claimNextTurn("alice")!;
  assert.equal(nextA.comfyContinuation?.remainingJobs, 2);
  const childA = submit(nextA.turnId),
    childB = submit(nextA.turnId);
  f.store.markComfyJobCancelled("alice", childA.id);
  f.store.markComfyJobCancelled("alice", childB.id);
  f.store.completeTurn(nextA, { ...ok, text: "Branch A complete" });
  f.foundation.close();
  const reopened = openFoundationDatabase(f.dataRoot);
  t.after(() => reopened.close());
  const store = new HitchStore(reopened);
  store.configureComfyContinuation(["alice"]);
  store.recoverAfterRestart();
  const nextB = store.claimNextTurn("alice")!;
  assert.equal(nextB.comfyContinuation?.jobId, branchB.id);
  assert.equal(nextB.comfyContinuation?.remainingJobs, 0);
  assert.throws(
    () =>
      store.createComfyJob("alice", nextB.turnId, "fixture", snapshot, "agent"),
    /budget exhausted/u,
  );
});

test("completion commit failures are observable, rollback atomically, and retry without re-generation", async (t) => {
  const f = setup(t);
  t.after(() => f.foundation.close());
  const fake = fakeService(f);
  f.admit();
  const turn = f.store.claimNextTurn("alice")!;
  const job = (await fake.service.execute(
    { userId: "alice", turnId: turn.turnId },
    "paint",
    { prompt: "cat" },
  )) as { id: string };
  f.store.completeTurn(turn, ok);
  f.db.exec(
    "CREATE TRIGGER fail_comfy_finish BEFORE UPDATE OF completion_turn_id ON comfy_jobs BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END;",
  );
  await assert.rejects(fake.service.tick(), /fixture commit failure/u);
  assert.equal(f.store.getComfyJob("alice", job.id)?.state, "submitted");
  assert.equal(count(f, "turns"), 1);
  assert.equal(count(f, "artifacts"), 0);
  assert.equal(count(f, "outbox"), 0);
  f.db.exec("DROP TRIGGER fail_comfy_finish;");
  await fake.service.tick();
  assert.equal(f.store.getComfyJob("alice", job.id)?.state, "completed");
  assert.equal(count(f, "turns"), 2);
  assert.equal(fake.submits(), 1);
});
