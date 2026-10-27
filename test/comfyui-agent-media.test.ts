import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HitchApplication } from "../src/app/application.js";
import { HitchStore } from "../src/app/store.js";
import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import { ComfyService } from "../src/comfyui/service.js";
import { comfyUploadPath } from "../src/comfyui/client.js";
import type { ComfyBackendClient } from "../src/comfyui/client.js";
import { ComfyWorkflowPolicy } from "../src/comfyui/workflow.js";
import { materializeComfyWorkspaceResult } from "../src/comfyui/workspace.js";
import { MediaStore } from "../src/media/media-store.js";
import { FakeAgentRuntime } from "../src/runtime/runtime.js";
import { DiscordWorker, type DiscordClient } from "../src/channels/discord.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
// Transport-only fixture. Decoder correctness is covered by opt-in real video tests.
const video = Buffer.from("000000146674797069736f6d0000020069736f6d", "hex");
const imagePolicy = new ComfyWorkflowPolicy({
  id: "anima",
  graph: {
    "1": { class_type: "Text", inputs: { prompt: "" } },
    "2": { class_type: "SaveImage", inputs: { image: ["1", 0] } },
  },
  variables: {
    prompt: { nodeId: "1", input: "prompt", type: "string", maxLength: 128 },
  },
  outputNodes: ["2"],
});
const videoPolicy = new ComfyWorkflowPolicy({
  id: "h3-fl",
  graph: {
    "1": { class_type: "Text", inputs: { prompt: "" } },
    "2": { class_type: "LoadImage", inputs: { image: "must-be-replaced.png" } },
    "3": {
      class_type: "SaveVideo",
      inputs: { image: ["2", 0], text: ["1", 0] },
    },
  },
  variables: {
    prompt: { nodeId: "1", input: "prompt", type: "string", maxLength: 128 },
  },
  files: { first: { nodeId: "2", input: "image", media: "image" } },
  outputNodes: ["3"],
  outputKind: "video",
});

test("agent image -> inspected workspace -> own-job video -> selected final publication; no intermediate delivery", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hitch-agent-media-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = (name: string) => {
    const p = join(root, name);
    mkdirSync(p, { mode: 0o700 });
    return p;
  };
  const dataRoot = dir("data"),
    workspace = dir("workspace");
  const config = parseConfig({
    schemaVersion: 1,
    dataRoot,
    piProfileDir: dir("pi"),
    minimumFreeBytes: 0,
    telegramAccounts: [],
    wechatAccounts: [],
    discordAccounts: [{ id: "test", botTokenEnv: "UNUSED_TOKEN" }],
    users: [
      {
        id: "alice",
        workspace,
        discord: {
          mode: "dm",
          account: "test",
          userId: "123456789012345680",
          channelId: "123456789012345682",
        },
      },
    ],
  });
  const foundation = bootstrapFoundation(config);
  t.after(() => foundation.close());
  const store = new HitchStore(foundation.database),
    db = foundation.database.connection;
  store.configureComfyContinuation(["alice"]);
  const media = new MediaStore(join(dataRoot, "media"), 0);
  let submits = 0,
    uploads = 0,
    runs = 0,
    inspections = 0,
    sourceJob = "";
  const backend = {
    async submit() {
      return `fixture-${++submits}`;
    },
    async history() {
      return {
        state: "complete",
        images: [{ filename: "fixture.png", type: "output" }],
      };
    },
    async download() {
      return png;
    },
    async upload(bytes: Buffer, mime: string, userId: string) {
      uploads++;
      assert.deepEqual(bytes, png);
      return comfyUploadPath(
        userId,
        createHash("sha256").update(bytes).digest("hex"),
        mime,
      );
    },
    async historyMedia() {
      return {
        state: "complete",
        outputs: [{ filename: "fixture.mp4", type: "output", kind: "video" }],
      };
    },
    async downloadMedia() {
      return video;
    },
  } as unknown as ComfyBackendClient;
  let app: HitchApplication;
  const service = new ComfyService({
    ledger: store,
    media,
    backend,
    workflows: [imagePolicy, videoPolicy],
    enabledUsers: ["alice"],
    deliveryMode: "agent",
    onContinuationReady: (id) => app.dispatchQueuedUser(id),
    async inspectVideo(bytes) {
      inspections++;
      assert.deepEqual(Buffer.from(bytes), video);
      return { width: 16, height: 16, duration: 1, fps: 24, hasAudio: false };
    },
  });
  const runtime = new FakeAgentRuntime(async (turn) => {
    runs++;
    const ctx = { userId: "alice", turnId: turn.turnId };
    if (!turn.comfyContinuation) {
      const job = (await service.execute(ctx, "paint", {
        workflow: "anima",
        prompt: "fixture image",
      })) as { id: string };
      sourceJob = job.id;
      return {
        outcome: "succeeded",
        sessionReusable: true,
        text: "Submitting source",
      };
    }
    assert.equal(turn.comfyContinuation.outcome, "completed");
    assert.equal(turn.artifacts?.length, 1);
    const original = turn.artifacts![0]!;
    const saved = materializeComfyWorkspaceResult({
      userId: "alice",
      workspace,
      artifact: original,
      media,
    });
    const savedBytes = readFileSync(join(workspace, saved.relativePath));
    if (original.mediaKind === "image") {
      assert.deepEqual(savedBytes, png);
      assert.equal(turn.comfyContinuation.jobId, sourceJob);
      await service.execute(ctx, "paint", {
        workflow: "h3-fl",
        prompt: "fixture video",
        input_files: [{ slot: "first", job_id: sourceJob }],
      });
      return {
        outcome: "succeeded",
        sessionReusable: true,
        text: "Intermediate image reviewed; now animate",
      };
    }
    assert.deepEqual(savedBytes, video);
    // Fake runtime's explicit selected-file snapshot; real hitch_publish is covered by native probe.
    const published = await media.ingest(
      "alice",
      (async function* () {
        yield savedBytes;
      })(),
      {
        displayName: "final.mp4",
        advertisedMime: "video/mp4",
        expectImage: false,
      },
    );
    return {
      outcome: "succeeded",
      sessionReusable: true,
      text: "Here is the selected animation.",
      artifacts: [published],
    };
  });
  app = new HitchApplication(
    store,
    runtime,
    undefined,
    media,
    undefined,
    undefined,
    undefined,
    [],
    undefined,
    undefined,
    config.users,
    ["alice"],
  );
  t.after(() => app.stop());
  const endpoint = store.resolveDiscordEndpoint(
    "test",
    "dm",
    "123456789012345680",
    "123456789012345682",
  )!;
  store.admitPrompt(
    { endpoint, idempotencyKey: "media-chain", contentDigest: "fixture" },
    "Make image then video; final only",
  );
  app.start();
  await app.drain();
  const outboxCount = () =>
    Number(
      (db.prepare("SELECT count(*) AS n FROM outbox").get() as { n: bigint }).n,
    );
  assert.equal(outboxCount(), 0);
  await service.tick();
  await app.drain();
  assert.equal(outboxCount(), 0);
  assert.equal(submits, 2);
  assert.equal(uploads, 1);
  await service.tick();
  await app.drain();
  assert.equal(runs, 3);
  assert.equal(inspections, 1);
  assert.equal(outboxCount(), 2);
  await service.tick();
  await app.drain();
  assert.equal(runs, 3);
  let sends = 0;
  const client: DiscordClient = {
    botUserId: "fixture",
    assertHealthy() {},
    async connect() {},
    async close() {},
    async sendTyping() {},
    async fetchReferencedAuthor() {
      return null;
    },
    async downloadAttachment() {
      throw new Error("unused");
    },
    async sendText() {
      assert.fail("must be grouped");
    },
    async sendArtifact() {
      assert.fail("must be grouped");
    },
    async sendRichReply(_channel, text, artifacts, objects) {
      sends++;
      assert.equal(text, "Here is the selected animation.");
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0]!.mimeType, "video/mp4");
      assert.deepEqual(
        readFileSync(objects.verifiedObjectPath(artifacts[0]!)),
        video,
      );
    },
  };
  const worker = new DiscordWorker({ id: "test" }, app, store, {
    client,
    media,
  });
  await worker.deliverPending();
  await worker.deliverPending();
  assert.equal(sends, 1);
  assert.deepEqual(store.pendingDiscordOutbox("test", 20), []);
});
