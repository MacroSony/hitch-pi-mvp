import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { HitchStore } from "../src/app/store.js";
import { ComfyBackendClient } from "../src/comfyui/client.js";
import { ComfyService } from "../src/comfyui/service.js";
import { ComfyWorkflowPolicy } from "../src/comfyui/workflow.js";
import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import { MediaStore } from "../src/media/media-store.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const source = JSON.stringify({
  messageId: "123456789012345678",
  channelId: "123456789012345679",
  guildId: null,
  authorId: "123456789012345680",
  authorName: "Alice",
  timestamp: "2026-01-01T00:00:00Z",
});

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "hitch-comfy-input-"));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = ["data", "pi", "alice", "bob"].map((x) => join(root, x));
  for (const d of dirs) {
    mkdirSync(d, { mode: 0o700 });
    chmodSync(d, 0o700);
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
  t.after(() => foundation.close());
  const db = foundation.database.connection;
  const endpoint = db
    .prepare("SELECT id FROM channel_endpoints WHERE user_id='alice'")
    .get() as { id: string };
  db.prepare(
    "INSERT INTO sessions(id,user_id,name,pi_session_id,state,created_at,updated_at) VALUES('input-session','alice','main','pi','active',1,1)",
  ).run();
  db.prepare(
    "INSERT INTO turns(id,user_id,session_id,endpoint_id,idempotency_key,content_digest,prompt_text,discord_source,ordinal,state,created_at,updated_at) VALUES('input-turn','alice','input-session',?,'input-turn','digest','Draw',?,0,'running',1,1)",
  ).run(endpoint.id, source);
  const store = new HitchStore(foundation.database);
  const media = new MediaStore(join(dataRoot, "media"), 0);
  const policy = new ComfyWorkflowPolicy({
    id: "qwen",
    graph: {
      "1": { class_type: "Text", inputs: { prompt: "base" } },
      "2": { class_type: "LoadImage", inputs: { image: "placeholder.png" } },
      "3": { class_type: "SaveImage", inputs: { images: ["2", 0] } },
    },
    variables: {
      prompt: { nodeId: "1", input: "prompt", type: "string", maxLength: 100 },
    },
    files: { image: { nodeId: "2", input: "image", media: "image" } },
    outputNodes: ["3"],
  });
  let uploads = 0,
    posts = 0,
    failUpload = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const body = Buffer.concat(chunks);
    if (req.url === "/upload/image") {
      uploads++;
      const text = body.toString("latin1");
      assert.match(text, /Content-Type: image\/png/u);
      assert.ok(body.includes(png));
      if (failUpload) {
        res.writeHead(500);
        res.end();
        return;
      }
      const match = /filename="([^"]+)"/u.exec(text)!;
      res.end(
        JSON.stringify({ name: match[1], subfolder: "hitch", type: "input" }),
      );
    } else if (req.url === "/prompt") {
      posts++;
      const graph = JSON.parse(body.toString()).prompt;
      assert.equal(
        graph["2"].inputs.image,
        `hitch/${createHash("sha256")
          .update(`alice:${createHash("sha256").update(png).digest("hex")}`)
          .digest("hex")}.png`,
      );
      res.end(JSON.stringify({ prompt_id: "backend1" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  );
  return once(server, "listening").then(async () => {
    const a = server.address();
    assert.ok(a && typeof a !== "string");
    const backend = new ComfyBackendClient({
      key: "fake",
      origin: `http://127.0.0.1:${a.port}`,
      allowPrivate: true,
    });
    const service = new ComfyService({
      ledger: store,
      media,
      backend,
      workflows: [policy],
      enabledUsers: ["alice", "bob"],
    });
    const artifact = await media.ingest(
      "alice",
      (async function* () {
        yield png;
      })(),
      { advertisedMime: "image/png", expectImage: true },
    );
    return {
      root,
      store,
      media,
      service,
      artifact,
      db,
      endpoint,
      counts: () => ({ uploads, posts }),
      setFailure: (v: boolean) => {
        failUpload = v;
      },
      server,
    };
  });
}

test("real Store current input routes verified binary upload before planned-path prompt graph", async (t) => {
  const f = await fixture(t);
  const result = (await f.service.execute(
    {
      userId: "alice",
      turnId: "input-turn",
      inputs: [{ id: "input_1", artifact: f.artifact }],
    },
    "paint",
    { prompt: "paint", input_files: [{ slot: "image", input_id: "input_1" }] },
  )) as { id: string; state: string };
  assert.equal(result.state, "submitted");
  assert.deepEqual(f.counts(), { uploads: 1, posts: 1 });
  assert.equal(f.store.getComfyJob("alice", result.id)?.state, "submitted");
});

test("own completed job result is a valid source; foreign job ids reject before upload", async (t) => {
  const f = await fixture(t);
  const job = f.store.createComfyJob("alice", "input-turn", "qwen", {
    graph: {},
    outputNodes: [],
  });
  assert.equal(f.store.markComfyJobSubmitting("alice", job.id), true);
  assert.equal(f.store.markComfyJobSubmitted("alice", job.id, "backend"), true);
  f.db
    .prepare(
      "UPDATE turns SET state='terminal',outcome='succeeded' WHERE id='input-turn'",
    )
    .run();
  assert.equal(
    f.store.finishComfyJob("alice", job.id, "completed", f.artifact),
    true,
  );
  assert.deepEqual(f.store.getComfyResult("alice", job.id), f.artifact);
  f.db
    .prepare(
      "INSERT INTO turns(id,user_id,session_id,endpoint_id,idempotency_key,content_digest,prompt_text,discord_source,ordinal,state,created_at,updated_at) VALUES('input-next','alice','input-session',?,'input-next','digest','Draw',?,2,'running',2,2)",
    )
    .run(f.endpoint.id, source);
  const result = (await f.service.execute(
    { userId: "alice", turnId: "input-next" },
    "paint",
    { prompt: "x", input_files: [{ slot: "image", job_id: job.id }] },
  )) as { state: string };
  assert.equal(result.state, "submitted");
  await assert.rejects(
    f.service.execute({ userId: "bob", turnId: "input-next" }, "paint", {
      prompt: "x",
      input_files: [{ slot: "image", job_id: job.id }],
    }),
  );
  assert.deepEqual(f.counts(), { uploads: 1, posts: 1 });
});

test("missing required input, invalid references, MIME mismatch and strict unknowns reject before requests", async (t) => {
  const f = await fixture(t);
  for (const input of [
    { prompt: "x" },

    { prompt: "x", input_files: [{ slot: "bogus", input_id: "input_1" }] },
    {
      prompt: "x",
      input_files: [{ slot: "image", input_id: "input_1", job_id: "x" }],
    },
    { prompt: "x", input_files: [{ slot: "image", path: "/etc/passwd" }] },
  ])
    await assert.rejects(
      f.service.execute(
        {
          userId: "alice",
          turnId: "input-turn",
          inputs: [{ id: "input_1", artifact: f.artifact }],
        },
        "paint",
        input,
      ),
    );
  await assert.rejects(
    f.service.execute(
      {
        userId: "alice",
        turnId: "input-turn",
        inputs: [
          {
            id: "input_1",
            artifact: { ...f.artifact, mimeType: "image/jpeg" },
          },
        ],
      },
      "paint",
      { prompt: "x", input_files: [{ slot: "image", input_id: "input_1" }] },
    ),
  );
  assert.deepEqual(f.counts(), { uploads: 0, posts: 0 });
});

test("upload failure marks prepared job failed without generation and abort stops before generation", async (t) => {
  const f = await fixture(t);
  f.setFailure(true);
  await assert.rejects(
    f.service.execute(
      {
        userId: "alice",
        turnId: "input-turn",
        inputs: [{ id: "input_1", artifact: f.artifact }],
      },
      "paint",
      { prompt: "x", input_files: [{ slot: "image", input_id: "input_1" }] },
    ),
  );
  assert.deepEqual(f.counts(), { uploads: 1, posts: 0 });
  assert.equal(f.store.listComfyJobs("alice")[0]?.state, "failed");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.service.execute(
      {
        userId: "alice",
        turnId: "input-turn",
        inputs: [{ id: "input_1", artifact: f.artifact }],
      },
      "paint",
      { prompt: "x", input_files: [{ slot: "image", input_id: "input_1" }] },
      controller.signal,
    ),
  );
  assert.deepEqual(f.counts(), { uploads: 1, posts: 0 });
});

test("a lost prepared-to-submitting CAS never posts generation", async (t) => {
  const f = await fixture(t);
  f.store.markComfyJobSubmitting = () => false;
  const result = (await f.service.execute(
    {
      userId: "alice",
      turnId: "input-turn",
      inputs: [{ id: "input_1", artifact: f.artifact }],
    },
    "paint",
    { prompt: "x", input_files: [{ slot: "image", input_id: "input_1" }] },
  )) as { state: string };
  assert.equal(result.state, "prepared");
  assert.deepEqual(f.counts(), { uploads: 1, posts: 0 });
});
