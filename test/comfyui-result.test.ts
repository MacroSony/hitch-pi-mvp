import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HitchStore } from "../src/app/store.js";
import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import { openFoundationDatabase } from "../src/foundation/database.js";
import { MediaStore } from "../src/media/media-store.js";
import type { RenderedComfyWorkflow } from "../src/comfyui/workflow.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
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

test("real store resolves only the unique completed owner result across reopen", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hitch-comfy-result-"));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = ["data", "pi", "alice", "bob"].map((name) => join(root, name));
  for (const dir of dirs) {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const [dataRoot, piProfileDir, aliceWorkspace, bobWorkspace] = dirs as [
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
  const endpoint = db
    .prepare("SELECT id FROM channel_endpoints WHERE user_id='alice'")
    .get() as { id: string };
  db.prepare(
    "INSERT INTO sessions(id,user_id,name,pi_session_id,state,created_at,updated_at) VALUES('result-session','alice','main','pi','active',1,1)",
  ).run();
  db.prepare(
    `INSERT INTO turns(id,user_id,session_id,endpoint_id,idempotency_key,content_digest,prompt_text,discord_source,ordinal,state,created_at,updated_at)
    VALUES('result-origin','alice','result-session',?,'origin','digest','Draw',?,0,'running',1,1)`,
  ).run(endpoint.id, source);
  const store = new HitchStore(foundation.database);
  const job = store.createComfyJob("alice", "result-origin", "anima", snapshot);
  assert.equal(store.getComfyResult("alice", job.id), null);
  assert.equal(store.getComfyResult("bob", job.id), null);
  assert.equal(store.getComfyResult("alice", "random"), null);
  assert.equal(store.markComfyJobSubmitting("alice", job.id), true);
  assert.equal(
    store.markComfyJobSubmitted("alice", job.id, "backend-secret"),
    true,
  );
  db.prepare(
    "UPDATE turns SET state='terminal', outcome='succeeded' WHERE id='result-origin'",
  ).run();
  const media = new MediaStore(join(dataRoot, "media"), 0);
  const artifact = await media.ingest(
    "alice",
    (async function* () {
      yield png;
    })(),
    {
      displayName: "result.png",
      advertisedMime: "image/png",
      expectImage: true,
    },
  );
  assert.equal(
    store.finishComfyJob("alice", job.id, "completed", artifact),
    true,
  );
  const result = store.getComfyResult("alice", job.id);
  assert.deepEqual(result, artifact);
  assert.equal(typeof result?.bytes, "number");
  assert.ok(Object.isFrozen(result));
  foundation.close();

  const reopened = openFoundationDatabase(dataRoot);
  const reopenedStore = new HitchStore(reopened);
  assert.deepEqual(reopenedStore.getComfyResult("alice", job.id), artifact);
  assert.equal(reopenedStore.getComfyResult("bob", job.id), null);
  const completionId = reopenedStore.getComfyJob(
    "alice",
    job.id,
  )!.completionTurnId!;
  const reopenedDb = reopened.connection;
  const resultEndpoint = dbEndpoint(reopenedDb, completionId);
  const extraId = "artifact_123e4567-e89b-42d3-a456-426614174001";
  reopenedDb
    .prepare(
      `INSERT INTO artifacts(id,user_id,storage_key,sha256,bytes,media_kind,mime_type,display_name,created_at)
    VALUES(?,?,?,?,?,'image','image/png','extra.png',1)`,
    )
    .run(
      extraId,
      artifact.userId,
      "alice/123e4567-e89b-42d3-a456-426614174001.blob",
      artifact.sha256,
      artifact.bytes,
    );
  reopenedDb
    .prepare(
      `INSERT INTO turn_artifacts(turn_id,user_id,artifact_id,direction,ordinal) VALUES(?, 'alice', ?, 'outbound', 1)`,
    )
    .run(completionId, extraId);
  assert.equal(reopenedStore.getComfyResult("alice", job.id), null);
  reopenedDb
    .prepare("DELETE FROM turn_artifacts WHERE turn_id=? AND ordinal=1")
    .run(completionId);
  reopenedDb.prepare("DELETE FROM artifacts WHERE id=?").run(extraId);
  reopenedDb
    .prepare(
      `INSERT INTO outbox(id,user_id,endpoint_id,turn_id,artifact_id,kind,payload_text,state,created_at,updated_at)
    VALUES('extra-artifact-outbox','alice',?,?,?,'artifact',NULL,'pending',1,1)`,
    )
    .run(resultEndpoint, completionId, artifact.id);
  assert.equal(reopenedStore.getComfyResult("alice", job.id), null);
  reopenedDb
    .prepare("DELETE FROM outbox WHERE id='extra-artifact-outbox'")
    .run();
  reopenedDb.prepare("UPDATE users SET enabled=0 WHERE id='alice'").run();
  assert.equal(reopenedStore.getComfyResult("alice", job.id), null);
  reopened.close();
});

function dbEndpoint(
  db: import("node:sqlite").DatabaseSync,
  turnId: string,
): string {
  return (
    db.prepare("SELECT endpoint_id FROM turns WHERE id=?").get(turnId) as {
      endpoint_id: string;
    }
  ).endpoint_id;
}
