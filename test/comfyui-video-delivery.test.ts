import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HitchStore } from "../src/app/store.js";
import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import { openFoundationDatabase } from "../src/foundation/database.js";
import { ComfyService } from "../src/comfyui/service.js";
import { ComfyWorkflowPolicy } from "../src/comfyui/workflow.js";
import { MediaStore } from "../src/media/media-store.js";
import type { RenderedComfyWorkflow } from "../src/comfyui/workflow.js";
import type { ComfyJob, ComfyJobLedger } from "../src/comfyui/types.js";
import type { RuntimeArtifact } from "../src/runtime/runtime.js";

const mp4 = Buffer.from("fixture-mp4-exact-bytes");
const policy = new ComfyWorkflowPolicy({
  id: "video",
  graph: {
    "1": { class_type: "Text", inputs: { prompt: "", duration: 2 } },
    "2": { class_type: "SaveVideo", inputs: { video: ["1", 0] } },
  },
  variables: {
    prompt: { nodeId: "1", input: "prompt", type: "string", maxLength: 128 },
    duration: {
      nodeId: "1",
      input: "duration",
      type: "number",
      min: 0.5,
      max: 15,
    },
  },
  outputNodes: ["2"],
  outputKind: "video",
});

function harness(
  options: {
    readonly outputs?: readonly unknown[];
    readonly downloaded?: Buffer;
    readonly inspect?: (
      bytes: Uint8Array,
      signal?: AbortSignal,
    ) => Promise<unknown>;
    readonly finish?: (artifact?: RuntimeArtifact) => boolean;
    readonly useRealInspector?: boolean;
  } = {},
) {
  const jobs = new Map<string, ComfyJob>();
  let serial = 0;
  let finishCount = 0;
  let historyKind = "";
  let downloadCount = 0;
  let inspected: Uint8Array | undefined;
  let receivedArtifact: RuntimeArtifact | undefined;
  const ledger: ComfyJobLedger = {
    createComfyJob(userId, turnId, workflowId, snapshot) {
      const job: ComfyJob = {
        id: `job${++serial}`,
        userId,
        turnId,
        workflowId,
        snapshot,
        state: "prepared",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      jobs.set(job.id, job);
      return job;
    },
    getComfyJob(userId, id) {
      const job = jobs.get(id);
      return job?.userId === userId ? job : null;
    },
    listComfyJobs() {
      return [...jobs.values()];
    },
    pendingComfyJobs() {
      return [...jobs.values()].filter((job) => job.state === "submitted");
    },
    markComfyJobSubmitting(user, id) {
      return update(user, id, { state: "submitting" });
    },
    markComfyJobSubmitted(user, id, backendPromptId) {
      return update(user, id, { state: "submitted", backendPromptId });
    },
    markComfyJobUnknown(user, id) {
      return update(user, id, { state: "submission_unknown" });
    },
    markComfyJobRejected(user, id) {
      return update(user, id, { state: "failed" });
    },
    markComfyJobCancelled(user, id) {
      return update(user, id, { state: "cancelled" });
    },
    recoverComfyJobs() {},
    finishComfyJob(user, id, outcome, artifact) {
      finishCount++;
      if (outcome === "completed") receivedArtifact = artifact;
      if (options.finish && outcome === "completed")
        return options.finish(artifact);
      return update(user, id, { state: outcome });
    },
  };
  function update(user: string, id: string, patch: Partial<ComfyJob>): boolean {
    const job = jobs.get(id);
    if (!job || job.userId !== user) return false;
    jobs.set(id, { ...job, ...patch });
    return true;
  }
  const backend = {
    async submit() {
      return "backend1";
    },
    async historyMedia(_id: string, _nodes: readonly string[], kind: string) {
      historyKind = kind;
      return {
        state: "complete" as const,
        outputs: options.outputs ?? [
          { filename: "result.mp4", type: "output", kind: "video" },
        ],
      };
    },
    async downloadMedia() {
      downloadCount++;
      return options.downloaded ?? mp4;
    },
    async history() {
      throw new Error("image history must not be used");
    },
    async download() {
      throw new Error("image download must not be used");
    },
  };
  const root = mkdtempSync(join(tmpdir(), "comfy-video-delivery-"));
  const media = new MediaStore(root);
  const service = new ComfyService({
    ledger,
    media,
    backend: backend as never,
    workflows: [policy],
    enabledUsers: ["alice"],
    ...(options.useRealInspector
      ? {}
      : {
          inspectVideo: async (bytes: Uint8Array, signal?: AbortSignal) => {
            inspected = bytes;
            await options.inspect?.(bytes, signal);
            return {
              width: 64,
              height: 64,
              duration: 1,
              fps: 24,
              hasAudio: true,
            };
          },
        }),
  });
  return {
    root,
    media,
    service,
    jobs,
    details: () => ({
      finishCount,
      historyKind,
      downloadCount,
      inspected,
      receivedArtifact,
    }),
  };
}

async function submit(
  h: ReturnType<typeof harness>,
  input: Record<string, unknown> = { prompt: "make a clip", duration: 1 },
) {
  const result = (await h.service.execute(
    { userId: "alice", turnId: "turn1" },
    "paint",
    input,
  )) as { id: string };
  return h.jobs.get(result.id)!;
}

test("video workflows are listed with output kind; bounded duration is rendered only by a policy that defines it", async (t) => {
  const h = harness();
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const list = await h.service.execute(
    { userId: "alice", turnId: "turn" },
    "paint_list_workflows",
    {},
  );
  assert.deepEqual(list, [
    {
      id: "video",
      output_kind: "video",
      variables: [
        { name: "prompt", type: "string", maxLength: 128 },
        { name: "duration", type: "number", min: 0.5, max: 15 },
      ],
    },
  ]);
  for (const duration of [NaN, Infinity, 0.49, 15.01, "2"]) {
    await assert.rejects(
      h.service.execute({ userId: "alice", turnId: "turn" }, "paint", {
        prompt: "x",
        duration,
      }),
    );
  }
  const job = await submit(h);
  assert.equal(job.snapshot.outputKind, "video");
  assert.equal(job.snapshot.graph["1"]!.inputs.duration, 1);
});

test("video tick downloads one raw output, inspects and stores byte-identical MP4 as a file", async (t) => {
  const h = harness();
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const job = await submit(h);
  await h.service.tick();
  const detail = h.details();
  assert.equal(detail.historyKind, "video");
  assert.equal(detail.downloadCount, 1);
  assert.deepEqual(Buffer.from(detail.inspected!), mp4);
  assert.equal(job.state, "submitted"); // The created object itself is an immutable pre-tick snapshot.
  const actual = h.jobs.get(job.id)!;
  assert.equal(actual.state, "completed");
  assert.equal(detail.receivedArtifact?.mediaKind, "file");
  assert.equal(detail.receivedArtifact?.mimeType, "video/mp4");
  assert.equal(detail.receivedArtifact?.displayName, `paint-${job.id}.mp4`);
  assert.equal(
    detail.receivedArtifact?.sha256,
    createHash("sha256").update(mp4).digest("hex"),
  );
  assert.deepEqual(
    readFileSync(h.media.verifiedObjectPath(detail.receivedArtifact!)),
    mp4,
  );
});

test(
  "opt-in video service uses the real isolated inspector for a CPU H.264/AAC output",
  { skip: process.env.HITCH_RUN_SANDBOX_TESTS !== "1", timeout: 90_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "comfy-video-fixture-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "valid.mp4");
    const child = spawn(
      "/usr/bin/ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=64x64:r=24:d=0.5",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=44100:cl=stereo",
        "-t",
        "0.5",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        "-y",
        path,
      ],
      { env: {}, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, stderr);
    const bytes = readFileSync(path);
    assert.ok(bytes.length <= 10 * 1024 * 1024);
    const h2 = harness({ downloaded: bytes, useRealInspector: true });
    t.after(() => rmSync(h2.root, { recursive: true, force: true }));
    const job = await submit(h2);
    await h2.service.tick();
    assert.equal(h2.jobs.get(job.id)?.state, "completed");
    assert.equal(h2.details().receivedArtifact?.mimeType, "video/mp4");
    assert.deepEqual(
      readFileSync(h2.media.verifiedObjectPath(h2.details().receivedArtifact!)),
      bytes,
    );
  },
);

test("real Store persists an owner-only video result and atomically groups its caption and exact artifact", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hitch-video-result-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  const profile = join(root, "pi");
  const workspace = join(root, "alice");
  const { mkdirSync, chmodSync } = await import("node:fs");
  for (const dir of [dataRoot, profile, workspace]) {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const config = parseConfig({
    schemaVersion: 1,
    dataRoot,
    piProfileDir: profile,
    minimumFreeBytes: 0,
    telegramAccounts: [],
    wechatAccounts: [],
    discordAccounts: [{ id: "test", botTokenEnv: "HITCH_TEST_TOKEN" }],
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
  const db = foundation.database.connection;
  const endpoint = db
    .prepare("SELECT id FROM channel_endpoints WHERE user_id='alice'")
    .get() as { id: string };
  db.prepare(
    "INSERT INTO sessions(id,user_id,name,pi_session_id,state,created_at,updated_at) VALUES('video-session','alice','main','pi','active',1,1)",
  ).run();
  db.prepare(
    `INSERT INTO turns(id,user_id,session_id,endpoint_id,idempotency_key,content_digest,prompt_text,ordinal,state,created_at,updated_at)
    VALUES('video-origin','alice','video-session',?,'origin','digest','Create video',0,'running',1,1)`,
  ).run(endpoint.id);
  const store = new HitchStore(foundation.database);
  const snapshot: RenderedComfyWorkflow = {
    graph: { "1": { class_type: "SaveVideo", inputs: {} } },
    outputNodes: ["1"],
    outputKind: "video",
  };
  const job = store.createComfyJob("alice", "video-origin", "video", snapshot);
  assert.equal(store.markComfyJobSubmitting("alice", job.id), true);
  assert.equal(
    store.markComfyJobSubmitted("alice", job.id, "backend-video"),
    true,
  );
  db.prepare(
    "UPDATE turns SET state='terminal', outcome='succeeded' WHERE id='video-origin'",
  ).run();
  const media = new MediaStore(join(dataRoot, "media"), 0);
  const artifact = await media.ingest(
    "alice",
    (async function* () {
      yield mp4;
    })(),
    {
      displayName: `paint-${job.id}.mp4`,
      advertisedMime: "video/mp4",
      expectImage: false,
    },
  );
  assert.equal(artifact.mediaKind, "file");
  assert.equal(
    store.finishComfyJob("alice", job.id, "completed", artifact),
    true,
  );
  assert.equal(store.getComfyResult("bob", job.id), null);
  assert.deepEqual(store.getComfyResult("alice", job.id), artifact);
  foundation.close();

  const reopened = openFoundationDatabase(dataRoot);
  const reopenedStore = new HitchStore(reopened);
  assert.deepEqual(reopenedStore.getComfyResult("alice", job.id), artifact);
  assert.equal(reopenedStore.getComfyResult("bob", job.id), null);
  const completionTurn = reopenedStore.getComfyJob(
    "alice",
    job.id,
  )!.completionTurnId!;
  const rows = reopened.connection
    .prepare(
      "SELECT kind, payload_text FROM outbox WHERE turn_id=? ORDER BY kind",
    )
    .all(completionTurn) as Array<{
    kind: string;
    payload_text: string | null;
  }>;
  assert.equal(rows.filter((row) => row.kind === "text").length, 1);
  assert.equal(rows.filter((row) => row.kind === "artifact").length, 1);
  assert.equal(
    rows.find((row) => row.kind === "text")?.payload_text,
    "你的视频已生成。",
  );
  const groupedArtifact = reopened.connection
    .prepare(
      "SELECT artifact_id FROM turn_artifacts WHERE turn_id=? AND direction='outbound'",
    )
    .get(completionTurn) as { artifact_id: string };
  assert.equal(groupedArtifact.artifact_id, artifact.id);
  assert.equal(artifact.sha256, createHash("sha256").update(mp4).digest("hex"));
  assert.deepEqual(readFileSync(media.verifiedObjectPath(artifact)), mp4);
  reopened.close();
});

test("invalid outputs and failed validation finalize without publishing artifacts; inspection abort leaves submitted for recovery", async (t) => {
  for (const testCase of [
    {
      name: "multiple",
      outputs: [
        { filename: "a.mp4", type: "output", kind: "video" },
        { filename: "b.mp4", type: "output", kind: "video" },
      ],
    },
    { name: "oversize", downloaded: Buffer.alloc(10 * 1024 * 1024 + 1) },
    {
      name: "invalid",
      inspect: async () => {
        throw new Error("invalid");
      },
    },
  ]) {
    const h = harness(testCase);
    t.after(() => rmSync(h.root, { recursive: true, force: true }));
    const job = await submit(h);
    await h.service.tick();
    assert.equal(h.jobs.get(job.id)?.state, "failed", testCase.name);
    assert.equal(h.details().receivedArtifact, undefined, testCase.name);
    const userRoot = join(h.root, "alice");
    const files = existsSync(userRoot)
      ? readdirSync(userRoot, { recursive: true })
      : [];
    assert.equal(files.length, 0, testCase.name);
  }
  const controller = new AbortController();
  const h = harness({
    inspect: async (_bytes, signal) => {
      assert.ok(signal?.aborted);
      throw new Error("aborted");
    },
  });
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const job = await submit(h);
  const ticking = h.service.tick(controller.signal);
  controller.abort();
  await ticking;
  assert.equal(h.jobs.get(job.id)?.state, "submitted");
  assert.equal(h.details().finishCount, 0);
  assert.equal(existsSync(join(h.root, "alice")), false);
});
