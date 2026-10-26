import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HitchStore } from "../src/app/store.js";
import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import { openFoundationDatabase } from "../src/foundation/database.js";
import type { RenderedComfyWorkflow } from "../src/comfyui/workflow.js";

const snapshot: RenderedComfyWorkflow = {
  graph: { "1": { class_type: "Test", inputs: {} } },
  outputNodes: ["1"],
};
const source = JSON.stringify({
  messageId: "123456789012345678",
  channelId: "123456789012345679",
  guildId: null,
  authorId: "123456789012345680",
  authorName: "Alice",
  timestamp: "2026-01-01T00:00:00Z",
});

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
  let now = 100_000;
  const store = new HitchStore(foundation.database, undefined, {
    now: () => now,
  });
  let ordinal = 0;
  const turn = (
    id: string,
    state: "running" | "terminal" = "running",
    discordSource: string | null = source,
  ) => {
    db.prepare(
      `INSERT INTO turns(id,user_id,session_id,endpoint_id,idempotency_key,content_digest,prompt_text,discord_source,ordinal,state,created_at,updated_at)
      VALUES(?,?,?,?,?,'digest','Draw a cat',?,?,?,1,1)`,
    ).run(
      id,
      user.id,
      sessionId,
      endpoint.id,
      id,
      discordSource,
      ++ordinal,
      state,
    );
  };
  const job = (id: string) => {
    turn(id);
    return store.createComfyJob("alice", id, "anima", snapshot);
  };
  return {
    foundation,
    dataRoot,
    db,
    store,
    turn,
    job,
    setNow: (value: number) => {
      now = value;
    },
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

test("Comfy jobs are owner-bound, durable, capped, and transition atomically", (t) => {
  const { foundation, dataRoot, store, job } = setup(t);
  const first = job("origin-1");
  assert.match(first.id, /^paint_[A-Za-z0-9_-]{16}$/u);
  assert.equal(store.getComfyJob("bob", first.id), null);
  assert.equal(
    store.markComfyJobSubmitted("alice", first.id, "backend"),
    false,
  );
  assert.equal(store.markComfyJobSubmitting("alice", first.id), true);
  assert.equal(store.markComfyJobSubmitting("alice", first.id), false);
  assert.equal(store.markComfyJobSubmitted("alice", first.id, "backend"), true);
  assert.equal(store.markComfyJobCancelled("alice", first.id), true);
  assert.equal(store.markComfyJobCancelled("alice", first.id), false);
  job("origin-2");
  job("origin-3");
  job("origin-4");
  assert.throws(() => job("origin-5"), /Comfy job limit/u);
  foundation.close();
  const reopenedDatabase = openFoundationDatabase(dataRoot);
  const reopenedStore = new HitchStore(reopenedDatabase, undefined, {
    now: () => 100_001,
  });
  assert.equal(
    reopenedStore.getComfyJob("alice", first.id)?.state,
    "cancelled",
  );
  assert.equal(reopenedStore.getComfyJob("bob", first.id), null);
  reopenedDatabase.close();
});

test("submitted completion creates one audited rich outbox group and rejects repeat", (t) => {
  const { foundation, store, turn, job, db } = setup(t);
  const created = job("origin-finish");
  assert.equal(store.markComfyJobSubmitting("alice", created.id), true);
  assert.equal(
    store.markComfyJobSubmitted("alice", created.id, "backend_1"),
    true,
  );
  turn("origin-finish-terminal", "terminal");
  db.prepare(
    "UPDATE turns SET state='terminal', outcome='succeeded' WHERE id='origin-finish'",
  ).run();
  assert.equal(
    store.finishComfyJob("bob", created.id, "completed", artifact),
    false,
  );
  assert.equal(
    store.finishComfyJob("alice", created.id, "completed", artifact),
    true,
  );
  assert.equal(
    store.finishComfyJob("alice", created.id, "completed", artifact),
    false,
  );
  const completed = store.getComfyJob("alice", created.id)!;
  assert.equal(completed.state, "completed");
  assert.ok(completed.completionTurnId);
  const rows = db
    .prepare("SELECT kind, turn_id FROM outbox WHERE turn_id=? ORDER BY kind")
    .all(completed.completionTurnId) as Array<{
    kind: string;
    turn_id: string;
  }>;
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["artifact", "text"],
  );
  const completion = db
    .prepare("SELECT idempotency_key,prompt_text FROM turns WHERE id=?")
    .get(completed.completionTurnId) as {
    idempotency_key: string;
    prompt_text: string;
  };
  assert.equal(completion.idempotency_key, `paint-result:${created.id}`);
  assert.match(completion.prompt_text, /^\[host event:/u);
  foundation.close();
});

test("startup recovery immediately marks all inflight jobs without replay", (t) => {
  const { foundation, store, job } = setup(t);
  const submitting = job("origin-submitting");
  const prepared = job("origin-prepared");
  store.markComfyJobSubmitting("alice", submitting.id);
  store.recoverComfyJobs();
  assert.equal(
    store.getComfyJob("alice", submitting.id)?.state,
    "submission_unknown",
  );
  assert.equal(store.getComfyJob("alice", prepared.id)?.state, "failed");
  assert.equal(store.markComfyJobSubmitting("alice", submitting.id), false);
  assert.deepEqual(store.pendingComfyJobs(), []);
  foundation.close();
});

test("terminal job metadata is retained to 100 per owner and list bounds are strict", (t) => {
  const { foundation, db, store, job, setNow } = setup(t);
  let oldest = "";
  for (let i = 0; i < 101; i++) {
    setNow(100_000 + i);
    const created = job(`retention-${i}`);
    if (i === 0) oldest = created.id;
    store.markComfyJobSubmitting("alice", created.id);
    store.markComfyJobSubmitted("alice", created.id, `backend_${i}`);
    store.markComfyJobCancelled("alice", created.id);
  }
  assert.equal(store.listComfyJobs("alice").length, 20);
  assert.equal(store.listComfyJobs("alice", 20).length, 20);
  assert.throws(() => store.listComfyJobs("alice", 21));
  assert.throws(() => store.listComfyJobs("alice", Number.NaN));
  assert.equal(store.getComfyJob("alice", oldest), null);
  const count = db
    .prepare(
      "SELECT count(*) AS count FROM comfy_jobs WHERE user_id='alice' AND state IN ('completed','failed','cancelled')",
    )
    .get() as { count: bigint };
  assert.equal(count.count, 100n);
  foundation.close();
});

test("host operator Turn without Discord source can finish as one text-only failure", (t) => {
  const { foundation, db, store, turn } = setup(t);
  turn("operator-turn", "running", null);
  const job = store.createComfyJob("alice", "operator-turn", "anima", snapshot);
  assert.equal(store.markComfyJobSubmitting("alice", job.id), true);
  assert.equal(store.markComfyJobSubmitted("alice", job.id, "backend"), true);
  db.prepare(
    "UPDATE turns SET state='terminal', outcome='succeeded' WHERE id='operator-turn'",
  ).run();
  assert.equal(store.finishComfyJob("alice", job.id, "failed"), true);
  assert.equal(store.finishComfyJob("alice", job.id, "failed"), false);
  const completed = store.getComfyJob("alice", job.id)!;
  assert.equal(completed.state, "failed");
  assert.ok(completed.completionTurnId);
  const turnRow = db
    .prepare("SELECT discord_source FROM turns WHERE id=?")
    .get(completed.completionTurnId) as { discord_source: string | null };
  assert.equal(turnRow.discord_source, null);
  const group = db
    .prepare("SELECT kind,payload_text FROM outbox WHERE turn_id=?")
    .all(completed.completionTurnId) as Array<{
    kind: string;
    payload_text: string | null;
  }>;
  assert.deepEqual(
    group.map(({ kind }) => kind),
    ["text"],
  );
  assert.equal(group[0]?.payload_text, "图像生成失败。");
  foundation.close();
});

test("job creation rejects terminal origins and disabled owners", (t) => {
  const { foundation, db, store, turn } = setup(t);
  turn("origin-terminal", "terminal");
  assert.throws(() =>
    store.createComfyJob("alice", "origin-terminal", "anima", snapshot),
  );
  turn("origin-live");
  const live = store.createComfyJob("alice", "origin-live", "anima", snapshot);
  db.prepare("UPDATE users SET enabled=0 WHERE id='alice'").run();
  assert.equal(store.getComfyJob("alice", live.id), null);
  assert.deepEqual(store.listComfyJobs("alice"), []);
  turn("origin-disabled");
  assert.throws(() =>
    store.createComfyJob("alice", "origin-disabled", "anima", snapshot),
  );
  foundation.close();
});
